/**
 * WCAG 2.x contrast, computed from the tokens — never copied from a
 * table (UI/plan-2/01-FOUNDATIONS.md §1.5: an earlier draft carried
 * approximations and every one ran in the flattering direction, which
 * is the specific way a contrast table becomes worse than no table).
 */

/** sRGB channel → linear light (WCAG 2.x definition). */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a `#RRGGBB` string. Throws on anything else. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Not a #RRGGBB colour: ${hex}`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio of two hex colours (order-independent), ≥ 1. */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** Ratio rounded to two decimals — the resolution every doc figure quotes. */
export function round2(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
