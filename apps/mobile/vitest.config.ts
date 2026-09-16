import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Unit seam for the platform implementations: vitest runs in Node, so the
// contract test loads the stores through these aliases exactly as app code
// loads them through Metro's platform extension. Expo's bundled modules are
// treated as external and resolved from the hoisted install at run time.
//
// T0.12 adds the component-render seam: the primitives render through
// react-test-renderer against string-typed host stubs for `react-native`
// (see src/test-stubs/react-native.ts) — the real component logic, zero
// native surface, no flow sources.
const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url).href);
const repoRoot = here('../..');

export default defineConfig({
  // esbuild JSX transform with the automatic runtime — no React import
  // needed in test files, matching the Expo/Babel app config.
  plugins: [react({ jsxRuntime: 'automatic' }) as never],
  server: {
    fs: {
      // The reanimated mock alias points into the hoisted repo root.
      allow: [repoRoot],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-stubs/ui.ts'],
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
        // T1.13: the SQLite mirror runs against a REAL SQLite engine under
        // vitest — Node's built-in node:sqlite behind expo-sqlite's sync
        // surface (no mocked database). The seam also counts module
        // evaluations, which is how the role-gate test proves a dispatcher
        // session never even imports expo-sqlite.
        find: /^expo-sqlite$/,
        replacement: here('./src/test-stubs/expo-sqlite.ts'),
      },
      {
        find: /^expo-crypto$/,
        replacement: here('./src/test-stubs/expo-crypto.ts'),
      },
      {
        // React core renders against string-typed host stubs under
        // react-test-renderer — the real component logic, no native code.
        find: /^react-native$/,
        replacement: here('./src/test-stubs/react-native.ts'),
      },
      {
        // Reanimated ships an official mock — animated values become plain
        // objects, hooks run inline; exactly what state assertions want.
        // Our stub re-exports Reanimated's own src/mock (its stock
        // mock.js has a relative require vitest cannot resolve).
        find: /^react-native-reanimated$/,
        replacement: here('./src/test-stubs/reanimated.ts'),
      },
      {
        find: /^expo-haptics$/,
        replacement: here('./src/test-stubs/expo-haptics.ts'),
      },
      {
        // The icon set (mobile UI overhaul): a real glyph is drawn by
        // expo-font's native loader, so the stub renders the Text host
        // with the glyph name as a prop and NO text — see
        // src/test-stubs/vector-icons.ts for why the empty child is
        // deliberate (the suite asserts exact text in places).
        find: /^@expo\/vector-icons$/,
        replacement: here('./src/test-stubs/vector-icons.ts'),
      },
      {
        // T1.17: FlashList is the jobs list on the handset; under vitest
        // its rows render through the string-typed host seam like every
        // other list, with the real row components and their logic.
        find: /^@shopify\/flash-list$/,
        replacement: here('./src/test-stubs/flash-list.ts'),
      },
    ],
  },
});
