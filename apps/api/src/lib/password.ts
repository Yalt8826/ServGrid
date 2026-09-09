import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (PLAN-BACKEND.md §4): argon2id at `m=19456, t=2, p=1`
 * — the OWASP baseline. The parameters are a system decision, not a
 * per-hash choice: every hash in `employees.password_hash` is written
 * here and nowhere else, so bumping the baseline is a one-file change
 * plus a rehash-on-login migration, never a scan for call sites.
 *
 * `@node-rs/argon2` was chosen over the built-in `node:crypto` argon2
 * because CI (`.nvmrc`) runs a Node line without it. It emits the
 * standard PHC string, so the stored hash self-describes its parameters:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`.
 */

export const ARGON2ID_PARAMS = {
  memoryCost: 19456, // KiB — 19 MiB
  timeCost: 2, // passes
  parallelism: 1,
} as const;

/**
 * The exact prefix every stored hash must carry. Tests assert this from
 * the database row, not from the module constant — the parameters live
 * in the hash itself precisely so they can be checked after the fact.
 */
export const ARGON2ID_HASH_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID_PARAMS);
}

/**
 * False, never a throw, for a wrong password *or* a malformed stored
 * hash — login fails closed either way, and the caller does not have to
 * distinguish "bad credential" from "corrupt row" to say no.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
