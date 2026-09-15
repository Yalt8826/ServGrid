/**
 * Style helpers shared by the primitives (T0.12). All colour/typography
 * reads go through the shared tokens; no module here spells a raw hex
 * (lint rule 1).
 */
import {
  DURATION,
  EASING,
  ELEVATION,
  RADII,
  SEMANTIC,
  SPACE,
  STALE,
  TAP,
  TYPE,
  type ComponentState,
  type Density,
} from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';

export { DURATION, EASING, ELEVATION, RADII, SEMANTIC, SPACE, STALE, TAP, TYPE };
export type { ComponentState, Density };

/** Caption style — timestamps, helper text. */
export const captionStyle = {
  caption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  captionOnDark: {
    ...textStyle('caption'),
    color: SEMANTIC.text.onDark,
  },
} as const;

/** The standard field label above inputs. */
export function labelStyle(): ReturnType<typeof textStyle> & { color: string } {
  return {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  };
}

/** Height of the tap target for a control in the active density. */
export function tapTargetForDensity(density: Density): number {
  return density === 'field' ? TAP.min : density === 'console' ? TAP.console : TAP.desk;
}
