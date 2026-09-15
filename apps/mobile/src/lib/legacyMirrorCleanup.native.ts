/**
 * One-time cleanup of the offline mirror (see `legacyMirrorTables.ts`).
 * Best effort and idempotent: `DROP TABLE IF EXISTS` on a clean install is
 * a no-op, and a failure leaves the app working — the tables are simply
 * never read again. The handle is not closed: the GPS buffer opens the
 * same file, and closing a connection it may share would cost pings.
 */
import * as SQLite from 'expo-sqlite';

import { LEGACY_DB_NAME, legacyMirrorDropStatements } from './legacyMirrorTables';

export async function dropLegacyMirror(): Promise<void> {
  try {
    const database = await SQLite.openDatabaseAsync(LEGACY_DB_NAME);
    for (const statement of legacyMirrorDropStatements()) {
      await database.execAsync(statement);
    }
  } catch {
    // Nothing to do: a leftover table is never read.
  }
}
