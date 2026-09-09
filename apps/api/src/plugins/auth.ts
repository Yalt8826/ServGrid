import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@servgrid/shared';
import { AppError } from './errors.js';

/**
 * Auth plugin (PLAN-BACKEND.md §2 layout, §4): access-token sign/verify
 * and the `requireAuth` preHandler that attaches `request.context.actor`.
 *
 * The access token is a JWT (HS256, 15 minutes) with claims
 * `{ sub, role, deviceId, jti }`. HS256 is hand-rolled on `node:crypto`
 * on purpose: the algorithm is nine lines, a signing bug is caught by
 * the auth suite on the first run, and the dependency budget stays
 * spent on things that are hard to get right (Postgres, argon2).
 *
 * Stateless by design — `requireAuth` does not re-read the employee row.
 * A deactivated employee's access token therefore lives out its 15
 * minutes; deactivation (T0.8) revokes refresh tokens, which caps the
 * session at the next expiry. Role changes likewise take effect at the
 * next refresh, which re-issues from the current DB row.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Input to `signAccessToken`; `jti` defaults to a fresh random id. */
export interface AccessTokenInput {
  sub: string;
  role: Role;
  deviceId: string;
  jti?: string;
}

export interface AccessTokenClaims extends AccessTokenInput {
  jti: string;
  iat: number;
  exp: number;
}

/**
 * The one message the access-token path sends on any 401 (§4). This is a
 * backend obligation, not a courtesy: the outbox drain treats
 * `UNAUTHENTICATED` as "refresh, then retry once", so the body must read
 * as a recoverable pause — never a logout directive, never a prompt to
 * discard queued work. Keeping it a single constant makes that property
 * structural: every verify failure path says exactly this.
 */
export const UNAUTHENTICATED_MESSAGE =
  'Your session could not be verified and may have expired. Nothing you queued was lost — the app will refresh your sign-in automatically.';

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(data: string, jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update(data, 'utf8').digest('base64url');
}

export function signAccessToken(
  input: AccessTokenInput,
  jwtSecret: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    ...input,
    jti: input.jti ?? randomUUID(),
    iat,
    exp: iat + ttlSeconds,
  };
  const encoded = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(claims)}`;
  return `${encoded}.${sign(encoded, jwtSecret)}`;
}

/**
 * Verify a signed access token, throwing `UNAUTHENTICATED` (the one
 * message, see above) on a malformed signature, wrong algorithm, or
 * expired `exp`. Every other interpretation of a bad token is a bug —
 * there is no "probably fine" here.
 */
export function verifyAccessToken(token: string, jwtSecret: string): AccessTokenClaims {
  const fail = (): AppError => new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  const parts = token.split('.');
  if (parts.length !== 3) throw fail();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${headerPart}.${payloadPart}`, jwtSecret), 'base64url');
  const given = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw fail();

  let header: { alg?: string };
  let claims: Partial<AccessTokenClaims>;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    throw fail();
  }
  if (header.alg !== 'HS256') throw fail();
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.role !== 'string' ||
    typeof claims.deviceId !== 'string' ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw fail();
  }
  return claims as AccessTokenClaims;
}

export interface AuthPluginOptions {
  jwtSecret: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Attach to a route as `preHandler` — verifies the bearer token and sets actor/device. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    /** Verified access-token claims; null until `requireAuth` runs. */
    auth: AccessTokenClaims | null;
  }
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app, opts) => {
    app.decorateRequest('auth', null);

    app.decorate('requireAuth', async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      const token =
        typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);

      const claims = verifyAccessToken(token, opts.jwtSecret);
      request.auth = claims;
      // Signed claims outrank the client's own headers for audit context.
      request.context.actor = { id: claims.sub, role: claims.role };
      request.context.deviceId = claims.deviceId;
    });
  },
  { name: 'auth', fastify: '5.x', dependencies: ['request-context', 'errors'] },
);
