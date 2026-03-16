import type { SqlDb } from "./sqldb.js";

type Statement = {
  sql: string;
  params: unknown[];
};

export class MemorySqlDb implements SqlDb {
  readonly statements: Statement[] = [];

  async close(): Promise<void> {}

  async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
    this.statements.push({ sql, params });
    return { rowsAffected: 0 };
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push({ sql, params });
    return [];
  }

  async queryOne<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.statements.push({ sql, params });
    return null;
  }
}
