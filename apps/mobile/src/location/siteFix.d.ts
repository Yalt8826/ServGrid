/**
 * Type declaration for the Metro platform split (2026-09-17).
 * `siteFix` resolves to `siteFix.native.ts` (native bundles) or
 * `siteFix.web.ts` (web bundles) through Metro's extension resolution,
 * which TypeScript does not perform — this file gives tsc the shape of
 * whichever implementation the bundler picks. It is never bundled:
 * Metro's source extensions never resolve to `.d.ts`.
 */

/** Where the technician stood, or null when the device could not say. */
export interface SiteFix {
  latitude: number;
  longitude: number;
}

/**
 * One foreground fix, for stamping a job completion with the place it
 * happened. Resolves null — never throws — when there is no permission,
 * no lock, or no answer in time: a completion must never be blocked or
 * lost because a satellite was out of sight.
 */
export declare function captureSiteFix(): Promise<SiteFix | null>;
