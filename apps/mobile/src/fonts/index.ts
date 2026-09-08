/**
 * The Plex faces, splash-gated (T0.12). `useFonts` blocks first paint
 * behind the root layout's `null` until every entry reports loaded —
 * no frame renders in a fallback face. See `sources.ts` for the
 * family-name rationale.
 */
export { PLEX_FONT_SOURCES } from './sources';
export { textStyle, resolveFontFamily } from './textStyle';
