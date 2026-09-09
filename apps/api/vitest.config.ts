import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Integration suites hit a real Postgres (PLAN-BACKEND.md §14: no
    // mocked database anywhere), so their floor is milliseconds of SQL
    // over a socket plus container health waits in beforeAll.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One process, one file at a time: suites share the compose database
    // and recreate scratch schemas; parallel DDL across files would race.
    fileParallelism: false,
  },
});
