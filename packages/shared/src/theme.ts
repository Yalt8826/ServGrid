/**
 * ServGrid design tokens — the single definition of the palette
 * (PLAN.md §9). The safety-yellow accent appears on exactly two things:
 * the primary action and the active state. Every other module must
 * import it from here.
 */

/** Accent: safety yellow. Copy the hex only in this file. */
export const ACCENT = '#F2C200';

/** Status colours, read off UPS front panels (PLAN.md §9). */
export const STATUS = {
  completed: '#0F8A5F',
  enRoute: '#D98A00',
  inProgress: ACCENT,
  cancelled: '#B3261E',
} as const;
