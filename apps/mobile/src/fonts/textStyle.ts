/**
 * TYPE token → loaded Plex face (T0.12). App code styles text through
 * `textStyle()` and never names a font family; the ramp lives in
 * `packages/shared` and the faces are loaded by `FontGate` (splash-gated).
 */
import type { TextStyle } from 'react-native';

import { PLEX_FAMILIES } from './names';
import { TYPE, type Density } from '@servgrid/shared';

type Weight = '400' | '500' | '600';

type StyleToken =
  | { size: number; lineHeight: number; weight: Weight; family: FontFamily; tabular?: boolean };

/**
 * Two families, two widths (PLAN.md §9). There is deliberately no `mono`
 * family: the `mono` TYPE token is Plex Sans at 400 with `tabular-nums`,
 * because Plex Sans was chosen *for* its tabular figures. Adding a third
 * family here is the drift this union exists to refuse.
 */
export type FontFamily = 'sans' | 'cond';

const FAMILY_FACES: Record<FontFamily, Record<Weight, string>> = {
  sans: {
    '400': PLEX_FAMILIES.sans,
    '500': PLEX_FAMILIES.sansMedium,
    '600': PLEX_FAMILIES.sansSemiBold,
  },
  cond: {
    '400': PLEX_FAMILIES.sans,
    '500': PLEX_FAMILIES.sansMedium,
    '600': PLEX_FAMILIES.condensed,
  },
};

/**
 * Density body-size adjustment (§3.3): `console` renders body at 15,
 * `desk` at 14 — the ramp value is the `field` size. Only `body` and
 * `bodyStrong` follow the density; headings, labels and captions are
 * stable across modes so chrome does not shift under a role switch.
 */
const DENSITY_BODY_SIZE: Record<Density, number> = {
  field: 16,
  console: 15,
  desk: 14,
};

export function resolveFontFamily(family: FontFamily, weight: Weight): string {
  return FAMILY_FACES[family][weight];
}

/**
 * Build a React Native text style from a TYPE token. `tabular` tokens
 * get `fontVariant: ['tabular-nums']` — tabular figures are not
 * optional on any number (§2.1).
 */
export function textStyle(token: keyof typeof TYPE, density: Density = 'field'): TextStyle {
  const t = TYPE[token] as StyleToken;
  const size = token === 'body' || token === 'bodyStrong' ? DENSITY_BODY_SIZE[density] : t.size;
  const style: TextStyle = {
    fontFamily: resolveFontFamily(t.family, t.weight),
    fontSize: size,
    lineHeight: t.lineHeight,
    fontWeight: t.weight,
  };
  if (t.tabular) {
    style.fontVariant = ['tabular-nums'];
  }
  return style;
}
