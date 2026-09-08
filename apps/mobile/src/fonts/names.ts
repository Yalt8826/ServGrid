/**
 * Plex family names (T0.12) — pure module, no asset imports.
 * See sources.ts for the splash-gated asset map and the family-name
 * rationale (embedded name tables vs PostScript handles).
 */

/** PostScript-style names — the app's canonical handles (Android keys). */
export const PLEX_FAMILIES = {
  sans: 'Plex-Sans',
  sansMedium: 'Plex-Sans-Medium',
  sansSemiBold: 'Plex-Sans-SemiBold',
  condensed: 'Plex-Sans-Condensed',
} as const;
