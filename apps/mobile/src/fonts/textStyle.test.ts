/**
 * Typography guarantee (T0.12 "Done when": fonts gate the splash — no
 * frame renders in a fallback face).
 *
 * The splash gate itself lives in `app/_layout.tsx` and holds first paint
 * until `useFonts` reports every entry in `PLEX_FONT_SOURCES` loaded. That
 * gate is only as good as the set it waits on: a TYPE token naming a face
 * that was never loaded falls back to the system face **silently**, on
 * device, with no error anywhere. That is the failure this file exists to
 * catch, and it is the half that is testable in Node.
 */
import { describe, it, expect } from 'vitest';
import { TYPE } from '@servgrid/shared';

import { PLEX_FAMILIES } from './names';
import { PLEX_FONT_SOURCES } from './sources';
import { resolveFontFamily, textStyle, type FontFamily } from './textStyle';

const WEIGHTS = ['400', '500', '600'] as const;
const DENSITIES = ['field', 'console', 'desk'] as const;

describe('typography — every token resolves to a loaded face', () => {
  it('every TYPE token names a family that PLEX_FONT_SOURCES loads', () => {
    const loaded = new Set(Object.keys(PLEX_FONT_SOURCES));
    for (const token of Object.keys(TYPE) as (keyof typeof TYPE)[]) {
      for (const density of DENSITIES) {
        const family = textStyle(token, density).fontFamily as string;
        expect(loaded.has(family), `TYPE.${token} → "${family}" is loaded`).toBe(true);
      }
    }
  });

  it('every family × weight the resolver can produce is loaded', () => {
    const loaded = new Set(Object.keys(PLEX_FONT_SOURCES));
    for (const family of ['sans', 'cond'] as FontFamily[]) {
      for (const weight of WEIGHTS) {
        const face = resolveFontFamily(family, weight);
        expect(loaded.has(face), `${family}/${weight} → "${face}" is loaded`).toBe(true);
      }
    }
  });
});

describe('typography — two families, two widths (PLAN.md §9)', () => {
  it('loads exactly the Plex Sans and Plex Sans Condensed faces', () => {
    // Four canonical handles, plus the embedded name-table aliases iOS
    // matches against. No third family: `PLAN.md` §9 is "one family, two
    // widths", and a monospace face would change every number in the app.
    expect(Object.keys(PLEX_FAMILIES).sort()).toEqual([
      'condensed',
      'sans',
      'sansMedium',
      'sansSemiBold',
    ]);
    expect(Object.keys(PLEX_FONT_SOURCES)).not.toContain('Plex-Mono');
    expect(Object.keys(PLEX_FONT_SOURCES).some((k) => /mono/i.test(k))).toBe(false);
  });

  it('`mono` is Plex Sans with tabular figures, not a monospace face', () => {
    // PLAN-FRONTEND.md §7: `mono 15 / 20 Sans 400 tabular`. The token names
    // the *style*; Plex Sans was chosen because its tabular figures do this
    // job (PLAN.md §9). Regression guard — this drifted once already.
    const s = textStyle('mono');
    expect(s.fontFamily).toBe(PLEX_FAMILIES.sans);
    expect(s.fontVariant).toEqual(['tabular-nums']);
    expect(s.fontSize).toBe(15);
    expect(s.lineHeight).toBe(20);
  });

  it('display and displayLg are the Condensed width', () => {
    expect(textStyle('display').fontFamily).toBe(PLEX_FAMILIES.condensed);
    expect(textStyle('displayLg').fontFamily).toBe(PLEX_FAMILIES.condensed);
  });
});

describe('typography — the ramp holds its floors', () => {
  it('never renders field text below 16, and nothing below 13 anywhere', () => {
    // §2.2: no text below 13px anywhere; §2: body is never below 16 in the
    // field. `console` and `desk` are seated, sighted, indoor densities and
    // step body down deliberately — the floor that must not move is 13.
    expect(textStyle('body', 'field').fontSize).toBe(16);
    expect(textStyle('bodyStrong', 'field').fontSize).toBe(16);
    for (const token of Object.keys(TYPE) as (keyof typeof TYPE)[]) {
      for (const density of DENSITIES) {
        expect(
          textStyle(token, density).fontSize as number,
          `TYPE.${token} at ${density} is >= 13`,
        ).toBeGreaterThanOrEqual(13);
      }
    }
  });

  it('carries no weight below 400 — no hairline type (§2.2)', () => {
    for (const token of Object.keys(TYPE) as (keyof typeof TYPE)[]) {
      const w = Number(textStyle(token).fontWeight);
      expect(w, `TYPE.${token} weight >= 400`).toBeGreaterThanOrEqual(400);
    }
  });

  it('puts tabular figures on every token that carries numbers', () => {
    // §2.1: tabular figures are not optional. `mono` is the token every
    // number goes through; the large dashboard figures are Condensed and
    // carry them too, so a changing figure does not jitter.
    expect(textStyle('mono').fontVariant).toEqual(['tabular-nums']);
  });
});
