import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Unit seam for the platform implementations: vitest runs in Node, so the
// contract test loads the stores through these aliases exactly as app code
// loads them through Metro's platform extension. Expo's bundled modules are
// treated as external and resolved from the hoisted install at run time.
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url).href);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: [
      {
        find: /^expo-router\/entry$/,
        replacement: here('./src/test-stubs/expo-router-entry.ts'),
      },
      {
        find: /^expo-secure-store$/,
        replacement: here('./src/test-stubs/expo-secure-store.ts'),
      },
      {
        find: /^expo-crypto$/,
        replacement: here('./src/test-stubs/expo-crypto.ts'),
      },
    ],
  },
});
