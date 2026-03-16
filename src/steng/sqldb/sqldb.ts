export interface SqlDb {
  close(): Promise<void>;
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>;
  exec(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
}
