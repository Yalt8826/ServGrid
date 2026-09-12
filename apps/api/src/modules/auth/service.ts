import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ulid } from 'ulid';
import {
  evaluateFeatureFlags,
  permissionsSnapshot,
  type AuthMeResponse,
  type ConsentState,
  type LoginRequest,
  type LoginResponse,
  type PasswordChangeRequest,
  type RefreshResponse,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE, signAccessToken } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import * as flagsRepo from '../flags/repo.js';
import * as repo from './repo.js';

/**
 * Auth service (PLAN-BACKEND.md §4). Business rules live here; SQL in
 * repo.ts; HTTP + zod in routes.ts.
 *
 * Two invariants shape the whole file:
 *
 * **Rotation with reuse detection.** The refresh token is opaque,
 * 256-bit, sha256-stored, 60 days, rotated on every use. 60 days is long
 * on purpose — a technician re-entering a password on a 6" screen in the
 * sun to clear a queued outbox is a failure of the design. The
 * mitigation is that presenting a *revoked* refresh token revokes the
 * entire chain and forces a fresh login, so a stolen copy on a shared
 * handset is worth little.
 *
 * **401 means "recoverable".** The outbox drain treats
 * `UNAUTHENTICATED` as "refresh, then retry once" — so no 401 body may
 * carry anything a naive client could read as terminal (§4). Access-path
 * failures all say exactly one thing (UNAUTHENTICATED_MESSAGE);
 * refresh-path failures tell the technician to sign in again, which is
 * the correct terminal action *for the refresh call itself*.
 */

/**
 * The version of the consent copy this build ships (PLAN.md §7, §4):
 * the date string of the revision. Rewording the screen means bumping
 * this, which re-prompts every employee — so it bumps for a change in
 * what is being consented to, never for a typo fix. T0.9's consent
 * endpoints read the same constant.
 */
export const CURRENT_CONSENT_VERSION = '2026-09-01';

const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days — see the header.

/** No user enumeration: both halves of a failed login say the same sentence. */
const LOGIN_FAILED_MESSAGE = 'Username or password is not correct.';

const REUSE_MESSAGE =
  'For safety this session has been ended — its credentials were used from more than one place. Sign in again to continue.';

const REFRESH_GONE_MESSAGE = 'Your session has expired or is no longer valid. Sign in again to continue.';

function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Opaque 256-bit random; only its sha256 is stored (§3.1 refresh_tokens). */
function mintRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A hash of a password nobody knows, verified against on unknown
 * usernames so "no such user" and "wrong password" take the same road
 * through the argon2 work and a timing side channel cannot enumerate
 * the roster. Initialised lazily — one argon2 run, then reused.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID());
  return dummyHashPromise;
}

export interface AuthServiceDeps {
  jwtSecret: string;
}

export interface RequestContextInfo {
  ip: string;
  userAgent: string | null;
}

export function createAuthService(deps: AuthServiceDeps) {
  const toEmployeePublic = (row: repo.EmployeeRecord) => ({
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  });

  const consentState = async (employeeId: string): Promise<ConsentState> => ({
    required: !(await repo.hasAcceptedConsent(getPool(), employeeId, CURRENT_CONSENT_VERSION)),
    version: CURRENT_CONSENT_VERSION,
  });

  async function login(input: LoginRequest, ctx: RequestContextInfo): Promise<LoginResponse> {
    const employee = await repo.findEmployeeByUsername(getPool(), input.username);
    // Always one argon2 verify, even for an unknown username — see dummyHash.
    const ok = await verifyPassword(input.password, employee?.password_hash ?? (await dummyHash()));
    if (!ok || !employee || !employee.is_active) {
      throw new AppError('UNAUTHENTICATED', LOGIN_FAILED_MESSAGE);
    }

    const { accessToken, refreshToken } = await withTransaction(async (client) => {
      const deviceId = await repo.upsertDevice(client, {
        employeeId: employee.id,
        installId: input.device.installId,
        appVersion: input.device.appVersion,
        osVersion: input.device.osVersion,
        manufacturer: input.device.manufacturer,
        model: input.device.model,
      });
      const refreshToken = mintRefreshToken();
      await repo.insertRefreshToken(client, {
        tokenHash: sha256Hex(refreshToken),
        employeeId: employee.id,
        deviceId,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: ctx.userAgent,
      });
      await repo.touchLastLogin(client, employee.id);
      const accessToken = signAccessToken(
        { sub: employee.id, role: employee.role, deviceId, jti: ulid() },
        deps.jwtSecret,
      );
      return { accessToken, refreshToken };
    });

    return {
      accessToken,
      refreshToken,
      employee: toEmployeePublic(employee),
      mustChangePassword: employee.must_change_password,
      consent: await consentState(employee.id),
    };
  }

  /**
   * Rotation + reuse detection. The branch work happens inside the
   * transaction but the refusals are thrown *after* it commits — the
   * chain revocation must survive the very request that reports the
   * reuse, so a rollback must not eat it.
   */
  async function refresh(rawToken: string, ctx: RequestContextInfo): Promise<RefreshResponse> {
    let failure: 'gone' | 'reused' | 'inactive' | null = null;
    let payload: RefreshResponse | null = null;

    await withTransaction(async (client) => {
      const row = await repo.findRefreshTokenForUpdate(client, sha256Hex(rawToken));
      if (!row) {
        failure = 'gone';
        return;
      }
      if (row.revoked_at !== null) {
        // Reuse. Revoke everything downstream, then tell the caller.
        await repo.revokeChainFrom(client, row.id);
        failure = 'reused';
        return;
      }
      if (row.expires_at.getTime() <= Date.now()) {
        failure = 'gone';
        return;
      }
      if (!row.is_active) {
        // Deactivation landed between rotations; clean up and refuse.
        await repo.revokeAllForEmployee(client, row.employee_id);
        failure = 'inactive';
        return;
      }

      // Rotate: new row first, then the old row points at it — a crash
      // between the two statements rolls both back, leaving the old
      // token valid rather than leaving a half-rotation.
      const refreshToken = mintRefreshToken();
      const newId = await repo.insertRefreshToken(client, {
        tokenHash: sha256Hex(refreshToken),
        employeeId: row.employee_id,
        deviceId: row.device_id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: ctx.userAgent,
      });
      await repo.markReplaced(client, row.id, newId);
      payload = {
        accessToken: signAccessToken(
          { sub: row.employee_id, role: row.role, deviceId: row.device_id ?? '', jti: ulid() },
          deps.jwtSecret,
        ),
        refreshToken,
      };
    });

    if (failure === 'reused') throw new AppError('TOKEN_REUSED', REUSE_MESSAGE);
    if (failure !== null) throw new AppError('UNAUTHENTICATED', REFRESH_GONE_MESSAGE);
    return payload!;
  }

  /** Logout revokes exactly the presented token; best-effort and repeatable. */
  async function logout(rawToken: string): Promise<{ ok: boolean }> {
    await repo.revokeByHash(getPool(), sha256Hex(rawToken));
    return { ok: true };
  }

  /**
   * Self-service password change. A wrong *current* password is 422
   * VALIDATION_FAILED, not 401: 401 is reserved for token problems so
   * the outbox drain's "refresh and retry" never fires for a typo.
   */
  async function changePassword(employeeId: string, input: PasswordChangeRequest): Promise<void> {
    const employee = await repo.findEmployeeById(getPool(), employeeId);
    if (!employee || !employee.is_active) {
      throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    }
    const ok = await verifyPassword(input.currentPassword, employee.password_hash);
    if (!ok) {
      throw new AppError('VALIDATION_FAILED', 'Your current password is not correct.');
    }

    const passwordHash = await hashPassword(input.newPassword);
    await withTransaction(async (client) => {
      await repo.updatePassword(client, employeeId, passwordHash);
      // Every refresh token for this employee dies — including the
      // caller's own. The client re-logins with the new password; that
      // is the point (T0.14's forced flow reads must_change_password).
      await repo.revokeAllForEmployee(client, employeeId);
    });
  }

  /** Actor, role, permissions snapshot, feature flags, consent state (§4). */
  async function me(employeeId: string): Promise<AuthMeResponse> {
    const employee = await repo.findEmployeeById(getPool(), employeeId);
    if (!employee || !employee.is_active) {
      throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    }
    // Flags are the T0 rollback instrument (PLAN-EXECUTION.md §3): the
    // owner's per-employee overrides ride every /auth/me answer, so a
    // flag turned off reaches the handset on its next foreground.
    const overrides = await flagsRepo.listForEmployee(getPool(), employeeId);
    return {
      employee: toEmployeePublic(employee),
      permissions: permissionsSnapshot(employee.role),
      featureFlags: evaluateFeatureFlags(Object.fromEntries(overrides.map((o) => [o.flag, o.enabled]))),
      consent: await consentState(employee.id),
    };
  }

  return { login, refresh, logout, changePassword, me };
}

export type AuthService = ReturnType<typeof createAuthService>;
