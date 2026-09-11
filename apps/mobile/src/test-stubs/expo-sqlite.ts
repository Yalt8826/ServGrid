/**
 * Vitest seam for `expo-sqlite` (T1.13). The mirror tests run in Node, but
 * the repo's test rule is "no mocked database anywhere" — so this seam is a
 * REAL SQLite engine: Node's built-in `node:sqlite` (`DatabaseSync`,
 * SQLite 3.5x) behind the narrow expo-sqlite surface the app uses. The
 * mirror's SQL — upserts, tombstone deletes, CHECK constraints,
 * savepoint-scoped transactions — executes against a genuine SQLite
 * database, only the host binding differs from the handset's.
 *
 * Two observability hooks back the role-gate test ("a dispatcher session
 * never opens the database"):
 *  - `moduleLoads` increments every time this module is (re)evaluated.
 *    Together with `vi.resetModules()` it proves the gated dynamic import
 *    never even fetched `expo-sqlite`, which a call counter alone cannot
 *    (an already-cached import would not re-run and so would not count).
 *  - `openCalls` increments on every `openDatabaseSync`.
 *
 * Opened databases live on `globalThis` keyed by name, so a
 * `vi.resetModules()` re-import reuses the same in-memory database instead
 * of leaking handles. `__resetSqliteSeam()` closes and drops them between
 * tests.
 */

import { DatabaseSync } from 'node:sqlite';

// ── module-evaluation counter — survives re-evaluation via globalThis ──────

interface SqliteSeamState {
  databases: Map<string, DatabaseSync>;
  moduleLoads: number;
  openCalls: number;
}

const seamGlobal = globalThis as { __servgridSqliteSeam?: SqliteSeamState };

function seam(): SqliteSeamState {
  seamGlobal.__servgridSqliteSeam ??= { databases: new Map(), moduleLoads: 0, openCalls: 0 };
  return seamGlobal.__servgridSqliteSeam;
}

seam().moduleLoads += 1;

export function __expoSqliteModuleLoads(): number {
  return seam().moduleLoads;
}

export function __expoSqliteOpenCalls(): number {
  return seam().openCalls;
}

/** Test helper: close and forget every opened database, reset call counters. */
export function __resetSqliteSeam(): void {
  for (const database of seam().databases.values()) {
    try {
      database.close();
    } catch {
      // already closed — nothing to do
    }
  }
  seamGlobal.__servgridSqliteSeam = { databases: new Map(), moduleLoads: seam().moduleLoads, openCalls: 0 };
}

// ── the database surface ────────────────────────────────────────────────────

/** expo-sqlite's bind union, narrowed to what the app actually binds —
 * string/number/null everywhere in `src/db` and `src/location` (no binary
 * payloads; the pinned @types/node 22 statement-binding signature predates
 * binary support). Extend deliberately if a caller ever needs it. */
export type SeamBindValue = string | number | bigint | boolean | null;

function toNodeValue(value: SeamBindValue): string | number | bigint | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function toPlainRows<T>(rows: Array<Record<string, unknown>>): T[] {
  // node:sqlite hands back null-prototype objects; materialise plain ones
  // so deep-equality assertions compare values, not prototypes.
  return rows.map((row) => ({ ...row })) as T[];
}

class SeamDatabase {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  execSync(source: string): void {
    this.database.exec(source);
  }

  runSync(source: string, ...params: SeamBindValue[]): { changes: number; lastInsertRowId: number } {
    const result = this.database.prepare(source).run(...params.map(toNodeValue));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  getAllSync<T>(source: string, ...params: SeamBindValue[]): T[] {
    return toPlainRows<T>(this.database.prepare(source).all(...params.map(toNodeValue)) as Array<Record<string, unknown>>);
  }

  getFirstSync<T>(source: string, ...params: SeamBindValue[]): T | null {
    const row = this.database.prepare(source).get(...params.map(toNodeValue));
    return row === undefined ? null : ({ ...(row as Record<string, unknown>) } as T);
  }

  /**
   * expo-sqlite's transaction contract: the callback runs inside a
   * transaction that commits whole, or rolls back whole and rethrows.
   * Savepoints, matching expo's nesting-safe implementation — a failure
   * mid-page leaves EVERYTHING inside the callback unapplied.
   */
  withTransactionSync(task: () => void): void {
    this.execSync('SAVEPOINT withTransactionSync');
    try {
      task();
      this.execSync('RELEASE SAVEPOINT withTransactionSync');
    } catch (error) {
      this.execSync('ROLLBACK TO SAVEPOINT withTransactionSync');
      this.execSync('RELEASE SAVEPOINT withTransactionSync');
      throw error;
    }
  }

  // Async variants — the location ping buffer (bufferStore.native.ts) uses
  // these; mirrored over the sync core so the seam covers both callers.
  async runAsync(source: string, ...params: SeamBindValue[]): Promise<{ changes: number; lastInsertRowId: number }> {
    return this.runSync(source, ...params);
  }

  async getAllAsync<T>(source: string, ...params: SeamBindValue[]): Promise<T[]> {
    return this.getAllSync<T>(source, ...params);
  }

  async getFirstAsync<T>(source: string, ...params: SeamBindValue[]): Promise<T | null> {
    return this.getFirstSync<T>(source, ...params);
  }
}

export type SeamSQLiteDatabase = SeamDatabase;

/** expo-sqlite's `openDatabaseSync` — same name, same database. */
export function openDatabaseSync(databaseName: string, _options?: Record<string, unknown>): SeamSQLiteDatabase {
  const state = seam();
  state.openCalls += 1;
  let database = state.databases.get(databaseName);
  if (!database) {
    database = new DatabaseSync(':memory:');
    state.databases.set(databaseName, database);
  }
  return new SeamDatabase(database);
}
