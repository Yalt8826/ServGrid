/**
 * ServGrid lint. Three of the rules in this file carry real guarantees
 * (PLAN-BACKEND.md §13): the accent-erosion defence, the revenue-leak
 * defence, and the location.split defence. The rest is style.
 *
 * The three guarantee rules are implemented in
 * tools/eslint-plugin-servgrid-rules and linked as the local
 * `servgrid-rules` plugin, so they work uniformly on .ts/.tsx/JSX/
 * template literals with one code path. Fixtures that prove them fire
 * live in packages/shared/src/__fixtures__/lint-violations/ (run by
 * tools/lint-proof.mjs as part of `pnpm lint`).
 */
module.exports = {
  root: true,
  env: { es2022: true },
  ignorePatterns: ['node_modules/', 'dist/', 'build/', '.expo/', 'coverage/', '*.gen.ts'],
  overrides: [
    {
      // Plain JavaScript in this repo is all Node-side (tools/,
      // metro.config.js, the local eslint plugin), so Node globals are
      // part of the environment.
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      env: { es2022: true, node: true },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      extends: ['eslint:recommended'],
    },
    {
      // TypeScript sources in every workspace package. TypeScript owns
      // undefined-global checking, so `no-undef` stays off here (the
      // standard @typescript-eslint setting): Node globals like
      // `process` and `console` are typed, not linted.
      files: ['**/*.ts', '**/*.tsx'],
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      parser: '@typescript-eslint/parser',
      plugins: ['servgrid-rules'],
      rules: {
        'no-undef': 'off',
        // Rule 1 — accent-erosion defence.
        'servgrid-rules/no-accent-hex': 'error',
        // Rule 2 — revenue-leak defence.
        'servgrid-rules/no-sql-money-tables': ['error', ['repo.dispatcher.ts']],
        // Rule 3 — location.health / location.read split.
        'servgrid-rules/no-sql-location-tables': ['error', ['repo.dispatcher.ts']],
      },
    },
  ],
};
