import BetterSqlite3 from 'better-sqlite3';
import type { SqlDb } from './sqldb.js';

export type SqliteDbOptions = {
  /** SQLite filename. Defaults to `:memory:` when omitted. */
  filename?: string;
  /** Open the database in read-only mode. */
  readonly?: boolean;
  /** Require an existing file when opening `filename`. */
  fileMustExist?: boolean;
  /** Busy timeout used by the underlying SQLite connection. */
  timeoutMs?: number;
};

/**
 * Normalizes params.
 * @param params SQL parameters.
 */
function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((param) => {
    if (param === undefined) {
      return null;
    }
    if (param instanceof Uint8Array && !Buffer.isBuffer(param)) {
      return Buffer.from(param);
    }
    return param;
  });
}

/**
 * SQLite adapter that implements the SqlDb contract.
 * @param options Operation options.
 * @param db Database name.
 * @param inTransaction In transaction.
 */
export class SqliteDb implements SqlDb {
  private readonly db: BetterSqlite3.Database;
  private readonly inTransaction: boolean;

  constructor(
    options: SqliteDbOptions = {},
    db?: BetterSqlite3.Database,
    inTransaction = false,
  ) {
    this.db =
      db ??
      new BetterSqlite3(options.filename ?? ':memory:', {
        readonly: options.readonly ?? false,
        fileMustExist: options.fileMustExist ?? false,
        timeout: options.timeoutMs ?? 5_000,
      });
    this.inTransaction = inTransaction;

    if (!db) {
      this.db.pragma('foreign_keys = ON');
      if (
        !options.readonly &&
        (options.filename ?? ':memory:') !== ':memory:'
      ) {
        this.db.pragma('journal_mode = WAL');
      }
    }
  }

  /**
   * Closes the resource and releases any associated handles.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Handles tx.
   * @param fn Callback function.
   */
  async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }

    this.db.exec('BEGIN');
    try {
      const txDb = new SqliteDb({}, this.db, true);
      const result = await fn(txDb);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Handles exec.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  async exec(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowsAffected: number }> {
    const statement = this.db.prepare(sql);
    const info = statement.run(...normalizeParams(params));
    return { rowsAffected: Number(info.changes ?? 0) };
  }

  /**
   * Handles query.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const statement = this.db.prepare(sql);
    return statement.all(...normalizeParams(params)) as T[];
  }

  /**
   * Handles query one.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  async queryOne<T = unknown>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const statement = this.db.prepare(sql);
    const row = statement.get(...normalizeParams(params)) as T | undefined;
    return row ?? null;
  }
}
