/**
 * One-time cleanup of what the offline build left on the phone (see
 * `legacyMirrorTables.ts`). Best effort and idempotent: on a clean install
 * every step is a no-op, and a failure leaves the app working — the old
 * data is simply never read again.
 *
 * - The mirror's tables are dropped from `servgrid.db`. The handle is not
 *   closed: the GPS buffer opens the same file, and closing a connection
 *   it may share would cost pings.
 * - The old AsyncStorage database files are deleted.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { LEGACY_ASYNC_STORAGE_FILES, LEGACY_DB_NAME, legacyMirrorDropStatements } from './legacyMirrorTables';

async function dropMirrorTables(): Promise<void> {
  try {
    const database = await SQLite.openDatabaseAsync(LEGACY_DB_NAME);
    for (const statement of legacyMirrorDropStatements()) {
      await database.execAsync(statement);
    }
  } catch {
    // Nothing to do: a leftover table is never read.
  }
}

async function deleteAsyncStorageFiles(): Promise<void> {
  const files = FileSystem.documentDirectory;
  if (files === null) return;
  // documentDirectory is `…/files/`; Android keeps app databases beside it.
  const databases = files.replace(/files\/?$/, 'databases/');
  for (const name of LEGACY_ASYNC_STORAGE_FILES) {
    try {
      await FileSystem.deleteAsync(`${databases}${name}`, { idempotent: true });
    } catch {
      // Not there, or not reachable on this OS — never read again either way.
    }
  }
}

export async function dropLegacyMirror(): Promise<void> {
  await dropMirrorTables();
  await deleteAsyncStorageFiles();
}
