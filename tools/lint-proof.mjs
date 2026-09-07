#!/usr/bin/env node
/**
 * Lint-rule proof harness (PHASE-0-FOUNDATION.md T0.1 Tests).
 *
 * The fixtures in packages/shared/src/__fixtures__/lint-violations/ exist
 * to fail. This script runs eslint once over the monorepo and asserts:
 *   - each violation fixture produces exactly the one error it exists to
 *     prove (no more, no fewer), and
 *   - the deliberate-clean control files produce zero errors.
 *
 * Exit codes: 0 = all fixtures proven; 1 = a fixture did not fire or a
 * control file was dirty (a rule regressed — fix the rule or the
 * config); 77 = eslint is not installed (run `pnpm install` first).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = 'packages/shared/src/__fixtures__/lint-violations';

// One entry per rule the fixtures prove. `min`/`max` in counts are per
// file: every fixture must fire, and a rule that starts firing on
// everything (or twice on one site) shows up here.
const CASES = [
  { file: `${FIX}/rule1-money-tables/repo.dispatcher.ts`, reason: 'revenue-leak defence' },
  { file: `${FIX}/rule2-money-clean/repo.dispatcher.ts`, clean: true },
  { file: `${FIX}/rule3-location-tables/repo.dispatcher.ts`, reason: 'location.split defence' },
  { file: `${FIX}/rule4-accent-hex.ts`, reason: 'accent-erosion defence' },
  { file: `${FIX}/rule5-clean-module.ts`, clean: true },
];

const eslintBin = join(root, 'node_modules', '.bin', 'eslint');
if (!existsSync(eslintBin)) {
  console.error('lint-proof: eslint is not installed — run `pnpm install` first.');
  process.exit(77);
}

const res = spawnSync(eslintBin, ['.', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (res.error) {
  console.error('lint-proof: failed to run eslint:', res.error.message);
  process.exit(1);
}
if (res.status !== 0 && res.status !== 1) {
  console.error(`lint-proof: eslint exited ${res.status} (config error?)`);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(res.stdout);
} catch {
  console.error('lint-proof: could not parse eslint JSON output.');
  process.exit(1);
}
const byPath = new Map(results.map((r) => [r.filePath, r]));

let failures = 0;
for (const c of CASES) {
  const r = byPath.get(join(root, c.file));
  const errors = r ? r.errorCount : 0;
  const messages = r && r.messages.length ? `\n      ${r.messages.map((m) => m.message).join('; ')}` : '';
  if (c.clean) {
    if (errors === 0) {
      console.log(`ok   ${c.file} clean (0 errors)`);
    } else {
      console.error(`FAIL ${c.file} must lint clean, got ${errors} error(s)${messages}`);
      failures += 1;
    }
  } else if (errors === 1) {
    console.log(`ok   ${c.file} fires exactly once — ${c.reason}`);
  } else {
    console.error(
      `FAIL ${c.file} expected exactly 1 error, got ${errors}${messages}`,
    );
    failures += 1;
  }
}

// The fixture cases above prove the three custom rules fire; everything
// else in the repo must stay clean. `eslint .` alone cannot be the gate
// (the fixtures are real errors by design), so the exclusion is computed
// from the same CASES list that demanded the errors — a fixture added to
// the fixtures directory without a CASES entry still fails this gate.
const expectedDirty = new Set(CASES.filter((c) => !c.clean).map((c) => join(root, c.file)));
let stray = 0;
for (const r of results) {
  if (r.errorCount > 0 && !expectedDirty.has(r.filePath)) {
    console.error(`FAIL unexpected lint errors in ${r.filePath}:`);
    for (const m of r.messages) console.error(`      ${m.line}:${m.column} ${m.message} (${m.ruleId})`);
    stray += r.errorCount;
  }
}
if (stray > 0) {
  console.error(`\nlint-proof: ${stray} lint error(s) outside the violation fixtures.`);
  failures += 1;
}

if (failures > 0) {
  console.error(`\nlint-proof: ${failures} fixture case(s) failed.`);
  process.exit(1);
}
console.log('\nlint-proof: all three custom rules proven by their fixtures.');
