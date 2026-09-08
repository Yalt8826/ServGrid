/**
 * Static asset module declarations for Metro-resolved files that the
 * TypeScript compiler has no plugin for. Metro returns an asset
 * registry handle (an AMD number) at runtime
 * (`src/fonts/sources.ts` imports these).
 */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
