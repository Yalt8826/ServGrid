import { readFileSync } from 'node:fs';
import { hashPassword } from '../src/lib/password.js';

/**
 * Print an argon2id PHC hash for seed/001_owner.sql and the break-glass
 * reset (PLAN-DATA-MODEL.md §8). The parameters come from
 * lib/password.ts — the one file that owns hashing — so a hash made
 * here verifies against `verifyPassword` by construction.
 *
 * The password is read from STDIN, never argv: a temporary credential
 * on a command line lands in the shell history, which is exactly how
 * PLAN-BACKEND.md §4.1 says passwords must not travel.
 *
 *   openssl rand -base64 18 | pnpm -F api exec tsx tools/hash-password.ts
 */
async function main(): Promise<void> {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (password.length < 8) {
    console.error('hash-password: refusing — the password is under 8 characters.');
    process.exit(1);
  }
  process.stdout.write(await hashPassword(password) + '\n');
}

main().catch((error: unknown) => {
  console.error('hash-password: FAILED —', error instanceof Error ? error.message : error);
  process.exit(1);
});
