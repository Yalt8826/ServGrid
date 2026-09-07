/**
 * Type declaration for the Metro platform split. `tokenStore.impl`
 * resolves to `tokenStore.impl.native.ts` (native bundles) or
 * `tokenStore.impl.web.ts` (web bundles) through Metro's extension
 * resolution, which TypeScript does not perform — this file gives tsc
 * the shape of whichever implementation the bundler picks. It is never
 * bundled: Metro's source extensions never resolve to `.d.ts`.
 */
import type { TokenStore } from './tokenStore';

export declare const impl: TokenStore;
