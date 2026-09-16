/**
 * `packages/shared/theme` — the single source of the design system
 * (T0.12; `UI/plan-2/01-FOUNDATIONS.md`). Imported by both apps so the
 * owner's web build and the technician's APK cannot drift. The accent
 * hex lives only in `../theme.ts` (lint rule 1); everything else reads
 * tokens from here.
 */
export * from './tokens.ts';
export { alpha } from './alpha.ts';
export { contrastRatio, relativeLuminance, round2 } from './contrast.ts';
