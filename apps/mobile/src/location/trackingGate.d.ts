/**
 * Type declaration for the Metro platform split. `trackingGate` resolves
 * to `trackingGate.native.ts` (native bundles) or `trackingGate.web.ts`
 * (web bundles) through Metro's extension resolution, which TypeScript
 * does not perform — this file gives tsc the shape of whichever
 * implementation the bundler picks. It is never bundled: Metro's source
 * extensions never resolve to `.d.ts`.
 */
export declare function armLocationTracking(): void;
export declare function ensureTrackingStarted(): Promise<boolean>;
