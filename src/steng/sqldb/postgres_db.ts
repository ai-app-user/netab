import { Pool, types as pgTypes, type PoolClient, type PoolConfig } from 'pg';
import type { SqlDb } from './sqldb.js';

export type PostgresDbOptions = {
  /** Full Postgres connection string used when the wrapper owns the pool. */
  connectionString?: string;
  /** Extra `pg.Pool` configuration when the wrapper owns the pool. */
  config?: PoolConfig;
  /** Existing pool to reuse instead of creating a new one. */
  pool?: Pool;
};

type Queryable = Pool | PoolClient;

let pgParsersConfigured = false;

/**
 * Handles configure pg parsers.
 */
function configurePgParsers(): void {
  if (pgParsersConfigured) {
    return;
  }
  pgTypes.setTypeParser(20, (value) => Number(value));
  pgParsersConfigured = true;
}

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
 * Handles translate placeholders.
 * @param sql SQL statement.
 */
function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * Postgres adapter that implements the SqlDb contract.
 * @param options Operation options.
 * @param queryable Queryable.
 * @param inTransaction In transaction.
 */
export class PostgresDb implements SqlDb {
  private readonly queryable: Queryable;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly inTransaction: boolean;

  constructor(
    options: PostgresDbOptions = {},
    queryable?: Queryable,
    inTransaction = false,
  ) {
    configurePgParsers();
    this.pool =
      options.pool ??
      new Pool({
        connectionString: options.connectionString,
        ...(options.config ?? {}),
      });
    this.queryable = queryable ?? this.pool;
    this.ownsPool = !options.pool && !queryable;
    this.inTransaction = inTransaction;
  }

  /**
   * Closes the resource and releases any associated handles.
   */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  /**
   * Handles tx.
   * @param fn Callback function.
   */
  async tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = new PostgresDb({ pool: this.pool }, client, true);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
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
    const result = await this.queryable.query(
      translatePlaceholders(sql),
      normalizeParams(params),
    );
    return { rowsAffected: Number(result.rowCount ?? 0) };
  }

  /**
   * Handles query.
   * @param sql SQL statement.
   * @param params SQL parameters.
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.queryable.query(
      translatePlaceholders(sql),
      normalizeParams(params),
    );
    return result.rows as T[];
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
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
}
