/**
 * The only module in the app that opens the mirror database (T1.13).
 * `db/mirror.ts` imports this one dynamically, behind the role gate, so
 * a dispatcher or owner session never even loads it — and never loads
 * `expo-sqlite` either. Metro's platform resolution gives the real
 * native module on the handset; under vitest the `expo-sqlite` alias
 * points at the node:sqlite-backed seam (a real SQLite engine — the
 * repo's "no mocked database" rule).
 *
 * Shares the app's single SQLite file with the location ping buffer:
 * one database per app, separate tables.
 */
import * as SQLite from 'expo-sqlite';

import { MIRROR_DDL, MIRROR_SCHEMA_VERSION, type Mirror, type MirrorDatabase } from './mirror';
import { ensureOutboxTable } from '../sync/outbox';

export const MIRROR_DB_NAME = 'servgrid.db';

export function openSqliteMirror(): Mirror {
  const database: MirrorDatabase = SQLite.openDatabaseSync(MIRROR_DB_NAME);
  database.execSync(MIRROR_DDL);
  // T1.14: the outbox is the mirror's co-tenant in this file — created by
  // the same open, so one door still prepares the whole database.
  ensureOutboxTable(database);
  // Stamped once; a future schema change reads it and migrates. ON CONFLICT
  // DO NOTHING — re-opening an existing mirror must not clobber the version.
  database.runSync(
    'INSERT INTO mirror_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    'schema_version',
    MIRROR_SCHEMA_VERSION,
  );
  return { database };
}
