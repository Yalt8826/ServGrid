/**
 * The one-time mirror cleanup drops the mirror's tables and nothing else —
 * the GPS buffer lives in the same `servgrid.db` file.
 */
import { describe, expect, it } from 'vitest';

import { LEGACY_ASYNC_STORAGE_FILES, LEGACY_DB_NAME, LEGACY_MIRROR_TABLES, legacyMirrorDropStatements } from './legacyMirrorTables';

describe('legacy mirror cleanup', () => {
  it('drops the outbox and every mirror table', () => {
    for (const table of ['outbox', 'mirror_meta', 'jobs', 'customers', 'customer_products', 'products', 'services']) {
      expect(LEGACY_MIRROR_TABLES).toContain(table);
    }
  });

  it('never touches the GPS buffer, and only ever drops tables', () => {
    expect(LEGACY_MIRROR_TABLES).not.toContain('location_ping_buffer');
    for (const statement of legacyMirrorDropStatements()) {
      expect(statement).toMatch(/^DROP TABLE IF EXISTS \w+$/);
    }
  });

  it('targets the database file the buffer shares', () => {
    expect(LEGACY_DB_NAME).toBe('servgrid.db');
  });

  it('deletes the old AsyncStorage files — and never the database the GPS buffer lives in', () => {
    expect(LEGACY_ASYNC_STORAGE_FILES).toContain('RKStorage');
    for (const name of LEGACY_ASYNC_STORAGE_FILES) {
      expect(name.startsWith('servgrid')).toBe(false);
    }
  });
});
