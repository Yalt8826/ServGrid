/**
 * `alpha` — the tint helper the mobile frame vocabulary is built on.
 *
 * The tinted surfaces the phone app uses (a status chip's ground, a section
 * band, a control resting on the navy frame) are all one ink at low
 * opacity. Writing those as literals would put a second copy of every
 * status colour in the app and let it drift from `STATUS`; deriving them
 * here instead means a status colour is stated exactly once and every
 * tint follows it.
 *
 * Deliberately not a colour model: `#RGB` and `#RRGGBB` only, and an
 * unparseable input is returned untouched rather than throwing — a token
 * read at module scope must never take the app down over a typo, and the
 * contrast suite is where a wrong colour is caught.
 *
 * Contrast note: a tint is a **ground**, never an ink. Nothing readable is
 * ever painted in a tint — text on a tint stays `SEMANTIC.text.*`, which
 * is what keeps the outdoor legibility floor intact (`01-FOUNDATIONS.md`
 * §1.5).
 */
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function alpha(hex: string, opacity: number): string {
  const match = HEX.exec(hex.trim());
  if (match === null) return hex;
  const body = match[1]!;
  const full = body.length === 3 ? body.replace(/./g, (c) => c + c) : body;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, opacity));
  return `rgba(${r},${g},${b},${a})`;
}
