/**
 * What the offline mirror and outbox left inside `servgrid.db` before the
 * app went online-only (decision 2026-09-15). The new build drops these
 * tables once, so no job copy or queued work stays on a handset.
 *
 * **Tables, never the file.** `servgrid.db` also holds
 * `location_ping_buffer` — the GPS buffer, the one table that stays
 * (`location/bufferStore.native.ts`). Deleting the database file would
 * throw away a technician's unsent trail.
 */
export const LEGACY_DB_NAME = 'servgrid.db';

export const LEGACY_MIRROR_TABLES = ['outbox', 'mirror_meta', 'jobs', 'customers', 'customer_products', 'products', 'services'] as const;

/**
 * The old AsyncStorage database (Android's `RKStorage`, in the app's
 * `databases/` directory) and its SQLite side files. It held the two
 * permission-ladder flags and a parked FCM token; both now live on the
 * server or in memory (TON.5), and the package is gone, so the new build
 * deletes the files once. Nothing here is `servgrid.db`.
 */
export const LEGACY_ASYNC_STORAGE_FILES = ['RKStorage', 'RKStorage-journal', 'RKStorage-wal', 'RKStorage-shm'] as const;

/** The statements, in order. */
export function legacyMirrorDropStatements(): string[] {
  return LEGACY_MIRROR_TABLES.map((table) => `DROP TABLE IF EXISTS ${table}`);
}
