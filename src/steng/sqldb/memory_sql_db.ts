import type { SqlDb } from './sqldb.js';

type Statement = {
  sql: string;
  params: unknown[];
};

/**
 * In-memory SQL adapter that records executed statements for tests and development helpers.
 */
export class MemorySqlDb implements SqlDb {
  readonly statements: Statement[] = [];

  /**
   * Closes the resource and releases any associated handles.
   */
  async close(): Promise<void> {}

  /**
   * Handles tx.
   * @param fn Callback function.
   */
  async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    return fn(this);
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
    this.statements.push({ sql, params });
    return { rowsAffected: 0 };
  }

  /**
   * Handles query.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push({ sql, params });
    return [];
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
    this.statements.push({ sql, params });
    return null;
  }
}
