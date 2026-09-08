/**
 * Font asset map (T0.12) — Metro-resolved `.ttf` requires (expo-env.d.ts
 * enables the typed asset shape). Loaded behind the splash gate by
 * `FontGate`; never imported by component code.
 *
 * Family-name handling, deliberate and platform-spanning: the Plex files'
 * PostScript-style base families differ from their embedded name-table
 * families (`IBM Plex Sans Cond SmBld` vs typographic `IBM Plex Sans
 * Condensed`). `useFonts` keys are free-form on Android, so every face is
 * also loaded under its **embedded family name** — the names iOS matches
 * `fontWeight` requests against — so weights resolve identically on both
 * platforms. App code never spells a face name; it resolves through
 * `textStyle` (`resolveFontFamily`), so a face rename is a one-file change.
 */

import { PLEX_FAMILIES } from './names';

// Metro resolves the `.ttf` asset imports at bundle time (expo-env.d.ts
// enables the typed asset shape). Plain `import` of an asset module —
// the `no-var-requires` lint rule holds here too.
import plexSansRegular from '../../assets/fonts/IBMPlexSans-Regular.ttf';
import plexSansMedium from '../../assets/fonts/IBMPlexSans-Medium.ttf';
import plexSansSemiBold from '../../assets/fonts/IBMPlexSans-SemiBold.ttf';
import plexSansCondensedSemiBold from '../../assets/fonts/IBMPlexSansCondensed-SemiBold.ttf';

export const PLEX_FONT_SOURCES: Record<string, number> = {
  [PLEX_FAMILIES.sans]: plexSansRegular,
  [PLEX_FAMILIES.sansMedium]: plexSansMedium,
  [PLEX_FAMILIES.sansSemiBold]: plexSansSemiBold,
  [PLEX_FAMILIES.condensed]: plexSansCondensedSemiBold,
  // Embedded family names (from the vendored files' name tables):
  'IBM Plex Sans': plexSansRegular,
  'IBM Plex Sans Medium': plexSansMedium,
  'IBM Plex Sans SemiBold': plexSansSemiBold,
  'IBM Plex Sans Condensed': plexSansCondensedSemiBold,
};
