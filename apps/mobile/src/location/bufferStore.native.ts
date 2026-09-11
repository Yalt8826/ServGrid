/**
 * The SQLite half of the ping buffer (PLAN-FRONTEND.md §6: "Pings write
 * to a local SQLite table"). expo-sqlite, one table, FIFO by rowid:
 * a basement trail must reach the server in the order it was recorded.
 *
 * Imported ONLY by `task.native.ts` (and it in turn by nothing web-side):
 * the web bundle has no counterpart of this file and never resolves one —
 * `location/`'s platform modules are `.native.ts` by rule.
 */
import * as SQLite from 'expo-sqlite';

import type { LocationPingPayload } from '@servgrid/shared';
import type { BufferedPing, PingBufferStore } from './buffer.native';

const DB_NAME = 'servgrid.db';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS location_ping_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at TEXT NOT NULL,
    payload TEXT NOT NULL
  )
`;

interface PayloadRow {
  id: number;
  payload: string;
}

export function createSqlitePingStore(): PingBufferStore {
  let db: SQLite.SQLiteDatabase | null = null;

  function database(): SQLite.SQLiteDatabase {
    if (db === null) {
      db = SQLite.openDatabaseSync(DB_NAME);
      db.execSync(CREATE_TABLE);
    }
    return db;
  }

  return {
    async append(ping: LocationPingPayload): Promise<void> {
      await database().runAsync(
        'INSERT INTO location_ping_buffer (recorded_at, payload) VALUES (?, ?)',
        ping.recordedAt,
        JSON.stringify(ping),
      );
    },

    async oldest(limit: number): Promise<BufferedPing[]> {
      const rows = await database().getAllAsync<PayloadRow>(
        'SELECT id, payload FROM location_ping_buffer ORDER BY id LIMIT ?',
        limit,
      );
      return rows.map((row) => ({ id: row.id, ping: JSON.parse(row.payload) as LocationPingPayload }));
    },

    async remove(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(', ');
      await database().runAsync(`DELETE FROM location_ping_buffer WHERE id IN (${placeholders})`, ...ids);
    },

    async count(): Promise<number> {
      const row = await database().getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM location_ping_buffer',
      );
      return row?.n ?? 0;
    },
  };
}
