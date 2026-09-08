/**
 * Contrast suite (T0.12). Every ratio is **computed** from the token
 * values by `contrast.ts` and asserted with the measured figure in the
 * message — the doc table (`UI/plan-2/01-FOUNDATIONS.md` §1.5) is the
 * expectation, never the source. A failing assertion here means a
 * token is wrong; do not soften a floor to make a test pass.
 *
 * Runs under `node --test` (shared) — see `packages/shared/package.json`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contrastRatio, round2 } from './contrast.ts';
import { COLORS, SEMANTIC, SLATE, STATUS } from './tokens.ts';

const fmt = (fg: string, bg: string, measured: number, floor: string): string =>
  `computed ${round2(contrastRatio(fg, bg))}:1 (measured ${measured}:1) ${floor}`;

describe('contrast — floors from UI/plan-2/01-FOUNDATIONS.md §1.5', () => {
  it('slate.900 on surface ≥ 7:1 (body text, measured 16.16)', () => {
    const r = contrastRatio(SLATE[900], SEMANTIC.bg.app);
    assert.ok(r >= 7, `slate.900/surface ${round2(r)}:1 — below the 7:1 body floor`);
    assert.equal(round2(r), 16.16);
  });

  it('slate.500 on surface ≥ 4.5:1 (secondary text, measured 5.39)', () => {
    const r = contrastRatio(SLATE[500], SEMANTIC.bg.app);
    assert.ok(r >= 4.5, `slate.500/surface ${round2(r)}:1 — below the 4.5:1 secondary floor`);
    assert.equal(round2(r), 5.39);
  });

  it('slate.500 on surfaceDense ≥ 4.5:1 (measured 4.98)', () => {
    const r = contrastRatio(SLATE[500], SEMANTIC.bg.dense);
    assert.ok(r >= 4.5, `slate.500/surfaceDense ${round2(r)}:1 — below the 4.5:1 secondary floor`);
    assert.equal(round2(r), 4.98);
  });

  it('slate.400 on surface ≥ 3:1 (placeholders, stale inset, measured 3.43)', () => {
    const r = contrastRatio(SLATE[400], SEMANTIC.bg.app);
    assert.ok(r >= 3, `slate.400/surface ${round2(r)}:1 — below the 3:1 placeholder floor`);
    assert.equal(round2(r), 3.43);
  });

  it('slate.400 on surfaceDense ≥ 3:1 (measured 3.17)', () => {
    const r = contrastRatio(SLATE[400], SEMANTIC.bg.dense);
    assert.ok(r >= 3, `slate.400/surfaceDense ${round2(r)}:1 — below the 3:1 placeholder floor`);
    assert.equal(round2(r), 3.17);
  });

  it('slate.400 is the lightest slate clearing 3:1 on both backgrounds', () => {
    // The whole point of the §1.5 correction: slate.300 failed, so
    // placeholders moved to slate.400. Assert the boundary holds.
    assert.ok(contrastRatio(SLATE[300], SEMANTIC.bg.app) < 3, 'slate.300 should fail on surface');
    assert.ok(contrastRatio(SLATE[300], SEMANTIC.bg.dense) < 3, 'slate.300 should fail on dense');
    assert.ok(contrastRatio(SLATE[400], SEMANTIC.bg.app) >= 3);
    assert.ok(contrastRatio(SLATE[400], SEMANTIC.bg.dense) >= 3);
  });

  it('slate.300 (disabled) is the documented bounded exception, 2.39:1', () => {
    // WCAG exempts inactive controls; the low contrast IS the signal.
    const r = contrastRatio(SLATE[300], SEMANTIC.bg.app);
    assert.ok(r < 3);
    assert.equal(round2(r), 2.39);
  });

  it('slate.900 on accent ≥ 7:1 (text on the primary button, measured 9.79)', () => {
    const r = contrastRatio(SLATE[900], COLORS.accent);
    assert.ok(r >= 7, `slate.900/accent ${round2(r)}:1 — below the 7:1 on-accent floor`);
    assert.equal(round2(r), 9.79);
  });

  it('white on accent < 2:1 — guard, so nobody ever ships it (measured 1.68)', () => {
    const r = contrastRatio('#FFFFFF', COLORS.accent);
    assert.ok(r < 2, `white/accent ${round2(r)}:1 — must never be shipped`);
    assert.equal(round2(r), 1.68);
  });

  it('borders against surface are 1.28:1 — a divider, never an information carrier', () => {
    const r = contrastRatio(SLATE[200], SEMANTIC.bg.app);
    assert.equal(round2(r), 1.28);
  });
});

describe('contrast — status rails §1.6 (never the sole carrier of state)', () => {
  const SURFACE = SEMANTIC.bg.app;
  const DENSE = SEMANTIC.bg.dense;

  it('cancelled / completed / unassigned rails clear 3:1 on both grounds', () => {
    for (const [name, hex] of [
      ['cancelled', STATUS.cancelled],
      ['completed', STATUS.completed],
      ['unassigned', STATUS.unassigned],
    ] as const) {
      assert.ok(contrastRatio(hex, SURFACE) >= 3, `${name} on surface ${round2(contrastRatio(hex, SURFACE))}:1`);
      assert.ok(contrastRatio(hex, DENSE) >= 3, `${name} on dense ${round2(contrastRatio(hex, DENSE))}:1`);
    }
  });

  it('en_route and in_progress rails sit below the floor — the doc figure, kept honest', () => {
    // These two are the reason the rail is never the sole carrier of
    // state and carries the 1px slate.900 outer edge at desk density.
    assert.ok(contrastRatio(STATUS.en_route, SURFACE) < 3);
    assert.ok(contrastRatio(STATUS.in_progress, SURFACE) < 3);
    assert.equal(round2(contrastRatio(STATUS.en_route, SURFACE)), 2.72);
    assert.equal(round2(contrastRatio(STATUS.in_progress, SURFACE)), 1.65);
    assert.equal(round2(contrastRatio(STATUS.en_route, DENSE)), 2.51);
    assert.equal(round2(contrastRatio(STATUS.in_progress, DENSE)), 1.53);
  });

  it('the status word alone always carries the state at 16.16:1', () => {
    // Every StatusPill / JobCard pairs the rail with the status word in
    // slate.900 on surface — the highest contrast in the system.
    assert.equal(round2(contrastRatio(SLATE[900], SURFACE)), 16.16);
  });
});

describe('contrast — StatusPill ink table (03-COMPONENTS.md)', () => {
  // No single ink works across the five status fills — the arithmetic
  // is why the pill is dot-and-word, never filled.
  it('white ink: passes only on cancelled (6.54), fails green (4.36)', () => {
    assert.ok(contrastRatio('#FFFFFF', STATUS.cancelled) >= 4.5);
    assert.equal(round2(contrastRatio('#FFFFFF', STATUS.cancelled)), 6.54);
    assert.ok(contrastRatio('#FFFFFF', STATUS.completed) < 4.5);
    assert.equal(round2(contrastRatio('#FFFFFF', STATUS.completed)), 4.36);
  });

  it('slate.900 ink: passes on en_route (5.95) and in_progress (9.79), fails red (2.52)', () => {
    assert.ok(contrastRatio(SLATE[900], STATUS.en_route) >= 4.5);
    assert.equal(round2(contrastRatio(SLATE[900], STATUS.en_route)), 5.95);
    assert.ok(contrastRatio(SLATE[900], STATUS.in_progress) >= 4.5);
    assert.equal(round2(contrastRatio(SLATE[900], STATUS.in_progress)), 9.79);
    assert.ok(contrastRatio(SLATE[900], STATUS.cancelled) < 4.5);
    assert.equal(round2(contrastRatio(SLATE[900], STATUS.cancelled)), 2.52);
  });

  it('green passes with neither ink — the dot-and-word pill sidesteps the set', () => {
    assert.ok(contrastRatio('#FFFFFF', STATUS.completed) < 4.5);
    assert.ok(contrastRatio(SLATE[900], STATUS.completed) < 4.5);
  });

  it('rail/word pairing figures carry their measured values in messages', () => {
    // Spec discipline: a failure message must quote the measurement,
    // e.g. fmt(slate900, surface, 16.16, 'body floor 7:1').
    const msg = fmt(SLATE[900], SEMANTIC.bg.app, 16.16, 'body floor 7:1');
    assert.match(msg, /16\.16:1/);
    assert.match(msg, /7:1/);
  });
});
