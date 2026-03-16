import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { StengEngine } from "./engine/steng_engine.js";
import { PostgresStengEngine, SqliteStengEngine } from "./engine/sql_steng_engine.js";
import type { PostgresDbOptions } from "./sqldb/postgres_db.js";
import type { SqliteDbOptions } from "./sqldb/sqlite_db.js";
import type {
  ChangeEvent,
  Filter,
  GetResult,
  IndexType,
  Op,
  StengIdentityOptions,
  TableConfig,
  TableInfo,
  TableType,
  Unsub,
  Watermark,
} from "./types.js";

/**
 * Stable `steng` API shared by the high-level wrapper and the low-level engines.
 *
 * If you are consuming `steng` from application code, prefer `new Steng(...)`
 * over using the engine classes directly.
 */
export interface StengApi {
  /** Release any backend resources held by this instance. */
  close(): Promise<void>;

  /** Create or fetch a table definition. */
  ensure_table(app: string, db: string, table_name: string, type: TableType): Promise<TableInfo>;

  /** Read table metadata by `(app, db, table_name)`. */
  get_table_info(app: string, db: string, table_name: string): Promise<TableInfo | null>;

  /** Read table metadata by numeric `tableId`. */
  get_table_info_by_id(tableId: number): Promise<TableInfo | null>;

  /** List tables, optionally scoped to one app and/or db. */
  list_tables(app?: string, db?: string): Promise<TableInfo[]>;

  /** Remove a table and all associated docs, blobs, indexes, and oplog rows. */
  drop_table(tableId: number): Promise<void>;

  /** Add an index so a field can be used in filters. */
  add_index(tableId: number, field: string, idx_type: IndexType, multi?: boolean): Promise<void>;

  /** Patch table configuration such as `timeField`, `retentionHours`, or `idPrefix`. */
  set_table_config(tableId: number, patch: Partial<TableConfig>): Promise<void>;

  /**
   * Read objects either by explicit ids or by filter.
   *
   * When `ids` is non-null, order follows the requested ids.
   * When `ids` is `null`, `filter` is applied and paging uses `start_pos`/`max_count`.
   */
  get_objs(tableId: number, ids: string[] | null, filter: Filter | null, start_pos?: number, max_count?: number): Promise<GetResult>;

  /** Subscribe to add/update/delete events matching the provided filter. */
  subscribe_objs(tableId: number, filter: Filter | null, cb: (evt: ChangeEvent) => void): Unsub;

  /** Insert one new row and return the generated internal document id. */
  add_obj(tableId: number, value: unknown): Promise<{ id: string }>;

  /**
   * Insert new rows and return the generated internal document ids.
   *
   * Caller-supplied ids are intentionally not allowed. If the application needs
   * its own business key, store that key inside the JSON value and index it.
   */
  add_objs(tableId: number, rows: { value: unknown }[]): Promise<{ ids: string[] }>;

  /** Patch existing rows using deep merge by default or shallow merge when requested. */
  update_objs(tableId: number, rows: { id: string; patch: unknown; merge?: "deep" | "shallow" }[]): Promise<void>;

  /** Replace the full stored value for existing rows. */
  replace_objs(tableId: number, rows: { id: string; value: unknown }[]): Promise<void>;

  /** Tombstone the given ids. */
  delete_objs(tableId: number, ids: string[]): Promise<void>;

  /** Store a blob and return its id. */
  add_blob(tableId: number, id: string | null, bytes: Uint8Array, contentType: string): Promise<{ id: string }>;

  /** Delete blobs by id. */
  delete_blobs(tableId: number, ids: string[]): Promise<void>;

  /** Read one blob by id. */
  get_blob(tableId: number, id: string): Promise<{ bytes: Uint8Array; contentType: string }>;

  /** Read oplog entries with `op_seq > after_seq`, capped by `limit`. */
  read_ops_since(tableId: number, after_seq: number, limit: number): Promise<Op[]>;

  /** Return the latest oplog sequence number for the table. */
  latest_seq(tableId: number): Promise<number>;

  /** Apply remote oplog entries in sequence order. */
  apply_ops(tableId: number, ops: Op[]): Promise<void>;

  /** Run retention for all tables, using `nowMs` or the current time. */
  run_retention(nowMs?: number): Promise<void>;

  /** Read the current table watermark. */
  get_watermark(tableId: number): Promise<Watermark | null>;

  /** Set the table watermark. */
  set_watermark(tableId: number, wm: Watermark): Promise<void>;
}

/** Backends supported by the high-level `Steng` wrapper. */
export type StengBackend = "memory" | "sqlite" | "postgres";

/**
 * High-level constructor options for `Steng`.
 *
 * Typical usage:
 * - `new Steng({ backend: "memory" })`
 * - `new Steng({ backend: "sqlite", sqlite: { filename: "./steng.sqlite" } })`
 * - `new Steng({ backend: "postgres", postgres: { connectionString: "postgres://..." } })`
 */
export type StengOptions = StengIdentityOptions & {
  /** Storage backend to use. Defaults to `memory`. */
  backend?: StengBackend;

  /** SQLite-specific connection options used when `backend === "sqlite"`. */
  sqlite?: SqliteDbOptions;

  /**
   * Postgres-specific connection options used when `backend === "postgres"`.
   *
   * If no real Postgres target is provided, `steng` uses embedded `pg-mem`
   * by default so playgrounds and tests can run without a server.
   */
  postgres?: PostgresDbOptions & {
    /** SQL schema name for the `steng_*` tables. */
    schema?: string;
    /** Force embedded `pg-mem` instead of a real connection target. */
    emulate?: boolean;
  };
};

type Runtime = {
  api: StengApi;
  cleanup: () => Promise<void>;
};

function hasPostgresTarget(options: StengOptions["postgres"] | undefined): boolean {
  return Boolean(options?.pool || options?.connectionString || options?.config);
}

function identityOptions(options: StengOptions): StengIdentityOptions {
  return {
    clusterId: options.clusterId,
    clusterShort: options.clusterShort,
  };
}

/**
 * Select and initialize the concrete backend implementation for the given options.
 *
 * Most callers should not use this directly; it exists so the `Steng` wrapper can
 * keep backend setup out of application code.
 */
function createRuntime(options: StengOptions): Runtime {
  const backend = options.backend ?? "memory";

  if (backend === "memory") {
    const api = new StengEngine(identityOptions(options));
    return {
      api,
      cleanup: async () => {
        await api.close();
      },
    };
  }

  if (backend === "sqlite") {
    const api = new SqliteStengEngine({
      ...(options.sqlite ?? {}),
      ...identityOptions(options),
    });
    return {
      api,
      cleanup: async () => {
        await api.close();
      },
    };
  }

  const postgres = options.postgres ?? {};
  if (postgres.emulate && hasPostgresTarget(postgres)) {
    throw new Error("postgres.emulate cannot be combined with pool, connectionString, or config");
  }

  if (postgres.emulate === false || hasPostgresTarget(postgres)) {
    const api = new PostgresStengEngine({
      ...postgres,
      schema: postgres.schema,
      ...identityOptions(options),
    });
    return {
      api,
      cleanup: async () => {
        await api.close();
      },
    };
  }

  const mem = newDb();
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();
  const api = new PostgresStengEngine({
    pool: pool as unknown as Pool,
    schema: postgres.schema ?? "steng",
    ...identityOptions(options),
  });

  return {
    api,
    cleanup: async () => {
      await api.close();
      await pool.end();
    },
  };
}

/**
 * High-level `steng` entrypoint.
 *
 * This is the class application code should construct. It hides whether the
 * actual implementation is in-memory, SQLite-backed, or Postgres-backed.
 */
export class Steng implements StengApi {
  /** Backend selected for this instance. */
  readonly backend: StengBackend;
  private readonly api: StengApi;
  private readonly cleanup: () => Promise<void>;

  /** Create a new `steng` instance from one set of options. */
  constructor(options: StengOptions = {}) {
    this.backend = options.backend ?? "memory";
    const runtime = createRuntime(options);
    this.api = runtime.api;
    this.cleanup = runtime.cleanup;
  }

  /** Convenience factory equivalent to `new Steng(options)`. */
  static open(options: StengOptions = {}): Steng {
    return new Steng(options);
  }

  /** Release any owned connections, pools, or temporary embedded backends. */
  async close(): Promise<void> {
    await this.cleanup();
  }

  /** @inheritdoc */
  ensure_table(app: string, db: string, table_name: string, type: TableType): Promise<TableInfo> {
    return this.api.ensure_table(app, db, table_name, type);
  }

  /** @inheritdoc */
  get_table_info(app: string, db: string, table_name: string): Promise<TableInfo | null> {
    return this.api.get_table_info(app, db, table_name);
  }

  /** @inheritdoc */
  get_table_info_by_id(tableId: number): Promise<TableInfo | null> {
    return this.api.get_table_info_by_id(tableId);
  }

  /** @inheritdoc */
  list_tables(app?: string, db?: string): Promise<TableInfo[]> {
    return this.api.list_tables(app, db);
  }

  /** @inheritdoc */
  drop_table(tableId: number): Promise<void> {
    return this.api.drop_table(tableId);
  }

  /** @inheritdoc */
  add_index(tableId: number, field: string, idx_type: IndexType, multi = false): Promise<void> {
    return this.api.add_index(tableId, field, idx_type, multi);
  }

  /** @inheritdoc */
  set_table_config(tableId: number, patch: Partial<TableConfig>): Promise<void> {
    return this.api.set_table_config(tableId, patch);
  }

  /** @inheritdoc */
  get_objs(tableId: number, ids: string[] | null, filter: Filter | null, start_pos = 0, max_count = -1): Promise<GetResult> {
    return this.api.get_objs(tableId, ids, filter, start_pos, max_count);
  }

  /** @inheritdoc */
  subscribe_objs(tableId: number, filter: Filter | null, cb: (evt: ChangeEvent) => void): Unsub {
    return this.api.subscribe_objs(tableId, filter, cb);
  }

  /** @inheritdoc */
  add_obj(tableId: number, value: unknown): Promise<{ id: string }> {
    return this.api.add_obj(tableId, value);
  }

  /** @inheritdoc */
  add_objs(tableId: number, rows: { value: unknown }[]): Promise<{ ids: string[] }> {
    return this.api.add_objs(tableId, rows);
  }

  /** @inheritdoc */
  update_objs(tableId: number, rows: { id: string; patch: unknown; merge?: "deep" | "shallow" }[]): Promise<void> {
    return this.api.update_objs(tableId, rows);
  }

  /** @inheritdoc */
  replace_objs(tableId: number, rows: { id: string; value: unknown }[]): Promise<void> {
    return this.api.replace_objs(tableId, rows);
  }

  /** @inheritdoc */
  delete_objs(tableId: number, ids: string[]): Promise<void> {
    return this.api.delete_objs(tableId, ids);
  }

  /** @inheritdoc */
  add_blob(tableId: number, id: string | null, bytes: Uint8Array, contentType: string): Promise<{ id: string }> {
    return this.api.add_blob(tableId, id, bytes, contentType);
  }

  /** @inheritdoc */
  delete_blobs(tableId: number, ids: string[]): Promise<void> {
    return this.api.delete_blobs(tableId, ids);
  }

  /** @inheritdoc */
  get_blob(tableId: number, id: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    return this.api.get_blob(tableId, id);
  }

  /** @inheritdoc */
  read_ops_since(tableId: number, after_seq: number, limit: number): Promise<Op[]> {
    return this.api.read_ops_since(tableId, after_seq, limit);
  }

  /** @inheritdoc */
  latest_seq(tableId: number): Promise<number> {
    return this.api.latest_seq(tableId);
  }

  /** @inheritdoc */
  apply_ops(tableId: number, ops: Op[]): Promise<void> {
    return this.api.apply_ops(tableId, ops);
  }

  /** @inheritdoc */
  run_retention(nowMs?: number): Promise<void> {
    return this.api.run_retention(nowMs);
  }

  /** @inheritdoc */
  get_watermark(tableId: number): Promise<Watermark | null> {
    return this.api.get_watermark(tableId);
  }

  /** @inheritdoc */
  set_watermark(tableId: number, wm: Watermark): Promise<void> {
    return this.api.set_watermark(tableId, wm);
  }
}
