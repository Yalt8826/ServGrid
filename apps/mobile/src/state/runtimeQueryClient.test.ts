/**
 * The runtime query client is online for every role (PLAN-FRONTEND.md §4,
 * decision 2026-09-15): a failed fetch surfaces immediately, and nothing
 * is persisted — there is no persister to configure.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { __resetQueryClient, configureQueryClient } from './runtimeQueryClient';

afterEach(() => {
  __resetQueryClient();
});

describe('configureQueryClient', () => {
  for (const role of ['technician', 'sales_rep', 'dispatcher', 'owner'] as const) {
    it(`${role}: queries and mutations run online`, () => {
      const options = configureQueryClient(role).getDefaultOptions();
      expect(options.queries?.networkMode).toBe('online');
      expect(options.mutations?.networkMode).toBe('online');
    });
  }
});
