#!/usr/bin/env node
/**
 * CI red-path probe. The `test` job runs this (via the deliberately
 * unregistered tools/fail-check fixture package, whose `pnpm test` always
 * exits 1 with a marker line). The wrapper asserts the marker arrives:
 *
 *   fixture exits 1 + marker  -> gate is capable of going red -> exit 0
 *   anything else             -> the gate is a rubber stamp     -> exit 1
 *
 * T0.2/T0.5 replace this probe with real suites; the fail-check fixture
 * is deleted then. A gate that has never been watched failing is a gate
 * nobody has proven fires.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fail-check');
const MARKER = 'fail-check: deliberate failure (fixture)';

const res = spawnSync('pnpm', ['test'], { cwd: fixture, encoding: 'utf8' });
const out = `${res.stdout || ''}${res.stderr || ''}`;
if (res.status === 1 && out.includes(MARKER)) {
  console.log('ok   fail-check: failing suite is red with marker — test-gate red path proven.');
  process.exit(0);
}
console.error('FAIL fail-check: expected exit 1 with the marker line; got status', res.status);
console.error('--- captured output ---');
console.error(out.trim() || '(none)');
process.exit(1);
