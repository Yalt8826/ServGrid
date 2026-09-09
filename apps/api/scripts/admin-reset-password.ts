import { randomBytes } from 'node:crypto';
import { loadDotEnv } from '../src/config.js';
import { closePool, getPool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { hashPassword } from '../src/lib/password.js';
import * as authRepo from '../src/modules/auth/repo.js';
import * as employeesRepo from '../src/modules/employees/repo.js';

/**
 * Break-glass password reset (PLAN-BACKEND.md §4, PLAN-GAPS.md G16).
 *
 *   pnpm -F api admin:reset-password -- --username <u>
 *
 * Accounts are owner-created, there is no email and no reset flow, and
 * there is one owner — this CLI is the answer when the second
 * owner-role account is lost too. It runs only where DATABASE_URL
 * reaches the database, which in practice means shell access to the
 * VPS: anyone who can run this can already read the volume, so the CLI
 * adds accountability rather than attack surface.
 *
 * One transaction: set a fresh temporary hash with
 * `must_change_password`, revoke every refresh token for the account,
 * and write exactly one audit_log row — all of it or none of it. The
 * temporary password is printed to the terminal (never logged, never
 * stored in clear) and must travel by voice or in person, exactly like
 * the seed flow in seed/001_owner.sql.
 *
 * A username that does not exist exits non-zero before any write: a
 * typo must not look like a reset.
 */

const USAGE = 'usage: admin:reset-password -- --username <username>';

function parseUsername(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--username') return argv[i + 1] ?? null;
    if (arg.startsWith('--username=')) return arg.slice('--username='.length) || null;
  }
  return null;
}

/** 16 base64url chars from 12 bytes — comfortably past the 8-character floor, typeable from a phone call. */
function mintTempPassword(): string {
  return randomBytes(12).toString('base64url');
}

class ResetFailed extends Error {}

export async function resetPassword(username: string): Promise<{
  employeeId: string;
  tempPassword: string;
  tokensRevoked: number;
  auditRowId: string;
}> {
  return withTransaction(async (client) => {
    const employee = await authRepo.findEmployeeByUsername(client, username);
    if (!employee) {
      // Thrown before any write — the transaction has nothing to roll back.
      throw new ResetFailed(`no employee named '${username}' — nothing was changed`);
    }

    const tempPassword = mintTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    await employeesRepo.updatePasswordForReset(client, employee.id, passwordHash);
    const tokensRevoked = await authRepo.revokeAllForEmployee(client, employee.id);
    const auditRowId = await employeesRepo.insertAuditRow(client, {
      action: 'password.reset.break_glass',
      employeeId: employee.id,
      actor: 'break-glass',
      details: { tokensRevoked, via: 'admin:reset-password' },
    });

    return { employeeId: employee.id, tempPassword, tokensRevoked, auditRowId };
  });
}

async function main(): Promise<void> {
  const username = parseUsername(process.argv.slice(2));
  if (!username) {
    console.error(USAGE);
    process.exit(1);
  }

  loadDotEnv(); // existing env wins — an exported DATABASE_URL is never overridden
  if (!process.env.DATABASE_URL) {
    console.error('admin-reset-password: DATABASE_URL is not set — source the VPS .env or export it.');
    process.exit(1);
  }

  getPool({ connectionString: process.env.DATABASE_URL });
  const result = await resetPassword(username);

  // The one output that matters, labelled so it can be read over a phone
  // call and lifted out of a terminal buffer intact.
  console.log(`admin-reset-password: reset complete for '${username}'`);
  console.log(`temp-password: ${result.tempPassword}`);
  console.log(`tokens-revoked: ${result.tokensRevoked}`);
  console.log(`audit-row: ${result.auditRowId}`);
  console.log('must_change_password is set — the employee picks a new password at the next sign-in.');
}

const invokedDirectly = process.argv[1]?.endsWith('admin-reset-password.ts') ?? false;
if (invokedDirectly) {
  main()
    .then(() => closePool())
    .catch((error: unknown) => {
      const message = error instanceof ResetFailed ? error.message : error instanceof Error ? error.message : String(error);
      console.error(`admin-reset-password: FAILED — ${message}`);
      void closePool().finally(() => process.exit(1));
    });
}
