/**
 * Lint-rule fixtures (PHASE-0-FOUNDATION.md T0.1 Tests). This directory
 * exists to fail lint — each violation file must produce exactly its one
 * error, each control file must stay clean; tools/lint-proof.mjs
 * asserts both as part of `pnpm lint`. Fixtures are TypeScript files
 * because that is what the codebase ships; the rules they prove are the
 * three guarantees in PLAN-BACKEND.md §13.
 *
 * The two SQL rules are scoped to files named repo.dispatcher.ts, so
 * their violation and control fixtures each live in their own directory
 * carrying that basename; rule4 (accent) has no filename condition.
 *
 *    rule1  money tables in repo.dispatcher.ts     → revenue-leak defence
 *    rule2  (control) dispatcher file, clean SQL
 *    rule3  location tables in repo.dispatcher.ts  → location.split defence
 *    rule4  literal accent hex outside theme.ts    → accent-erosion defence
 *    rule5  (control) ordinary module
 */

// ── rule1-money-tables/repo.dispatcher.ts — must fire ────────────────
// A dispatcher repo module must never read the revenue tables; its
// queries read the dispatcher views only.

/** Deliberate violation: dispatcher repo reading money. */
export const completedTotals = `
  SELECT jc.amount
  FROM job_completions jc
  WHERE jc.job_card_id = $1
`;
