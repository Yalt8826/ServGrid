/**
 * Theme token surface. T0.12 fills these; for now the module re-exports the
 * palette from `src/theme.ts` — the one file allowed to carry the accent
 * hex (custom lint rule 1) — so both import paths serve the same objects
 * and neither can drift.
 */
export { ACCENT, STATUS } from '../theme';
