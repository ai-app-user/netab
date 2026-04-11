export interface SqlDb {
  /**
   * Closes the resource and releases any associated handles.
   */
  close(): Promise<void>;
  /**
   * Handles tx.
   * @param fn Callback function.
   */
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>;
  /**
   * Handles exec.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  exec(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  /**
   * Handles query.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Handles query one.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
}
