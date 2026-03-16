import { randomId, deepClone, deepMerge, shallowMerge, sha256Hex, bytesToBase64, base64ToBytes, getField } from "../../shared/utils.js";
import type { SqlDb } from "../sqldb/sqldb.js";
import { PostgresDb, type PostgresDbOptions } from "../sqldb/postgres_db.js";
import { SqliteDb, type SqliteDbOptions } from "../sqldb/sqlite_db.js";
import { ChangeBus } from "./change_bus.js";
import { assertFilterSupported, indexValuesForField, matchesFilter } from "./filtering.js";
import { defaultIdPrefix, deriveClusterShort, generateDistributedId } from "./id_generation.js";
import type { StengApi } from "../steng.js";
import type { BlobRecord, ChangeEvent, Filter, FilterClause, GetResult, IndexType, ObjRow, Op, StengIdentityOptions, TableConfig, TableInfo, TableType, Watermark } from "../types.js";

type SqlDialect = {
  name: "sqlite" | "postgres";
  blobType: string;
  catalogTable: string;
  docsTable: string;
  indexTable: string;
  oplogTable: string;
  watermarkTable: string;
  blobsTable: string;
};

type CatalogRow = {
  table_id: number | string;
  app: string;
  db_name: string;
  table_name: string;
  type: TableType;
  config_json: string;
};

type DocRow = {
  id: string;
  json_text: string | null;
  updated_at_ms: number | string;
  deleted: number | boolean;
  etag: string;
};

type OplogRow = {
  table_id: number | string;
  op_seq: number | string;
  ts_ms: number | string;
  op_type: Op["op_type"];
  id: string;
  payload_json: string | null;
};

type BlobRow = {
  id: string;
  content_type: string;
  sha256: string;
  size: number | string;
  bytes: Buffer | Uint8Array;
};

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function createDialect(name: "sqlite" | "postgres", schema?: string): SqlDialect {
  const prefix = schema ? `${quoteIdent(schema)}.` : "";
  return {
    name,
    blobType: name === "postgres" ? "BYTEA" : "BLOB",
    catalogTable: `${prefix}${quoteIdent("steng_catalog")}`,
    docsTable: `${prefix}${quoteIdent("steng_docs")}`,
    indexTable: `${prefix}${quoteIdent("steng_doc_index")}`,
    oplogTable: `${prefix}${quoteIdent("steng_oplog")}`,
    watermarkTable: `${prefix}${quoteIdent("steng_watermark")}`,
    blobsTable: `${prefix}${quoteIdent("steng_blobs")}`,
  };
}

function defaultTableConfig(): TableConfig {
  return { indexes: {} };
}

function parseTableConfig(value: string | null | undefined): TableConfig {
  if (!value) {
    return defaultTableConfig();
  }
  const parsed = JSON.parse(value) as Partial<TableConfig>;
  return {
    indexes: parsed.indexes ?? {},
    timeField: parsed.timeField,
    retentionHours: parsed.retentionHours,
  };
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function toBoolInt(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return value ? 1 : 0;
  }
  return null;
}

function parseDocValue(row: DocRow): unknown {
  return row.json_text ? JSON.parse(row.json_text) : null;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function buildInClause(values: readonly unknown[]): string {
  if (values.length === 0) {
    return "(NULL)";
  }
  return `(${values.map(() => "?").join(", ")})`;
}

function indexColumnForType(type: IndexType): "i64_val" | "str_val" | "bool_val" {
  switch (type) {
    case "i64":
    case "time":
      return "i64_val";
    case "bool":
      return "bool_val";
    case "str":
    case "hash64":
    default:
      return "str_val";
  }
}

function toIndexedParam(type: IndexType, value: unknown): unknown {
  switch (type) {
    case "i64":
    case "time":
      return typeof value === "number" ? value : Number(value);
    case "bool":
      return toBoolInt(value);
    case "hash64":
    case "str":
    default:
      return String(value);
  }
}

function docRowToObjRow(row: DocRow | null): ObjRow {
  if (!row || row.deleted) {
    return { id: row?.id ?? "", miss: "NOT_FOUND" };
  }

  return {
    id: row.id,
    value: deepClone(parseDocValue(row)),
    meta: {
      updatedAtMs: toNumber(row.updated_at_ms),
      etag: row.etag,
      deleted: Boolean(row.deleted),
    },
  };
}

function rowDeleted(row: DocRow): boolean {
  return row.deleted === true || row.deleted === 1;
}

function assertGeneratedIdOnly(row: { value: unknown }): void {
  const maybeId = (row as { id?: unknown }).id;
  if (maybeId !== undefined) {
    throw new Error("add_objs does not accept caller-defined ids; store app ids inside the JSON value instead");
  }
}

export class SqlStengEngine implements StengApi {
  private readonly changeBus = new ChangeBus();
  private readonly readyPromise: Promise<void>;
  private readonly clusterShort: string;

  constructor(
    private readonly db: SqlDb,
    private readonly dialect: SqlDialect,
    identity: StengIdentityOptions = {},
  ) {
    this.clusterShort = identity.clusterShort ?? (identity.clusterId ? deriveClusterShort(identity.clusterId) : "local");
    this.readyPromise = this.init();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async ensure_table(app: string, db: string, table_name: string, type: TableType): Promise<TableInfo> {
    await this.ready();
    return this.db.tx(async (tx) => {
      const existing = await this.getTableInfoByName(tx, app, db, table_name);
      if (existing) {
        return existing;
      }

      await tx.exec(
        `INSERT INTO ${this.dialect.catalogTable} (app, db_name, table_name, type, config_json)
         VALUES (?, ?, ?, ?, ?)`,
        [app, db, table_name, type, serializeJson({ ...defaultTableConfig(), idPrefix: defaultIdPrefix(table_name) })],
      );

      const created = await this.getTableInfoByName(tx, app, db, table_name);
      if (!created) {
        throw new Error(`Failed to create table ${app}/${db}/${table_name}`);
      }
      return created;
    });
  }

  async get_table_info(app: string, db: string, table_name: string): Promise<TableInfo | null> {
    await this.ready();
    return this.getTableInfoByName(this.db, app, db, table_name);
  }

  async get_table_info_by_id(tableId: number): Promise<TableInfo | null> {
    await this.ready();
    const row = await this.db.queryOne<CatalogRow>(
      `SELECT table_id, app, db_name, table_name, type, config_json
       FROM ${this.dialect.catalogTable}
       WHERE table_id = ?`,
      [tableId],
    );
    return row ? this.catalogRowToInfo(row) : null;
  }

  async list_tables(app?: string, db?: string): Promise<TableInfo[]> {
    await this.ready();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (app) {
      clauses.push("app = ?");
      params.push(app);
    }
    if (db) {
      clauses.push("db_name = ?");
      params.push(db);
    }

    const rows = await this.db.query<CatalogRow>(
      `SELECT table_id, app, db_name, table_name, type, config_json
       FROM ${this.dialect.catalogTable}
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY table_id ASC`,
      params,
    );
    return rows.map((row) => this.catalogRowToInfo(row));
  }

  async drop_table(tableId: number): Promise<void> {
    await this.ready();
    await this.requireTableInfo(tableId);
    await this.db.tx(async (tx) => {
      await tx.exec(`DELETE FROM ${this.dialect.indexTable} WHERE table_id = ?`, [tableId]);
      await tx.exec(`DELETE FROM ${this.dialect.docsTable} WHERE table_id = ?`, [tableId]);
      await tx.exec(`DELETE FROM ${this.dialect.oplogTable} WHERE table_id = ?`, [tableId]);
      await tx.exec(`DELETE FROM ${this.dialect.watermarkTable} WHERE table_id = ?`, [tableId]);
      await tx.exec(`DELETE FROM ${this.dialect.blobsTable} WHERE table_id = ?`, [tableId]);
      await tx.exec(`DELETE FROM ${this.dialect.catalogTable} WHERE table_id = ?`, [tableId]);
    });
  }

  async add_index(tableId: number, field: string, idx_type: IndexType, multi = false): Promise<void> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    const nextConfig: TableConfig = {
      ...info.config,
      indexes: {
        ...info.config.indexes,
        [field]: { type: idx_type, multi },
      },
    };
    await this.persistTableConfigAndRebuild(tableId, nextConfig);
  }

  async set_table_config(tableId: number, patch: Partial<TableConfig>): Promise<void> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    const nextConfig: TableConfig = {
      ...info.config,
      ...deepClone(patch),
      indexes: {
        ...info.config.indexes,
        ...(patch.indexes ?? {}),
      },
    };
    await this.persistTableConfigAndRebuild(tableId, nextConfig);
  }

  async get_objs(tableId: number, ids: string[] | null, filter: Filter | null, start_pos = 0, max_count = -1): Promise<GetResult> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    const limit = max_count < 0 ? Number.MAX_SAFE_INTEGER : max_count;

    if (ids && ids.length > 0) {
      const requestedIds = ids.slice(start_pos, start_pos + limit);
      const rows = await this.fetchDocsByIds(tableId, requestedIds);
      return {
        items: requestedIds.map((id) => {
          const row = rows.get(id);
          if (!row || rowDeleted(row)) {
            return { id, miss: "NOT_FOUND" };
          }
          return docRowToObjRow(row);
        }),
        next_pos: Math.min(start_pos + requestedIds.length, ids.length),
        watermark: await this.get_watermark(tableId),
      };
    }

    assertFilterSupported(info, filter);
    const orderedIds = filter ? await this.queryFilteredIds(info, filter) : await this.queryLiveIds(tableId);
    const slice = orderedIds.slice(start_pos, start_pos + limit);
    const rows = await this.fetchDocsByIds(tableId, slice);

    return {
      items: slice.map((id) => docRowToObjRow(rows.get(id)!)),
      next_pos: Math.min(start_pos + slice.length, orderedIds.length),
      watermark: await this.get_watermark(tableId),
    };
  }

  subscribe_objs(tableId: number, filter: Filter | null, cb: (evt: ChangeEvent) => void) {
    return this.changeBus.subscribe(tableId, filter, cb);
  }

  async add_obj(tableId: number, value: unknown): Promise<{ id: string }> {
    const inserted = await this.add_objs(tableId, [{ value }]);
    return { id: inserted.ids[0] };
  }

  async add_objs(tableId: number, rows: { value: unknown }[]): Promise<{ ids: string[] }> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    this.assertJsonTable(info);
    const ids: string[] = [];
    await this.db.tx(async (tx) => {
      for (const row of rows) {
        assertGeneratedIdOnly(row);
        const id = this.generateId(info);
        await this.commitDocOpTx(tx, info, "ADD", id, row.value);
        ids.push(id);
      }
    });
    return { ids };
  }

  async update_objs(tableId: number, rows: { id: string; patch: unknown; merge?: "deep" | "shallow" }[]): Promise<void> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    this.assertJsonTable(info);
    await this.db.tx(async (tx) => {
      for (const row of rows) {
        const current = await this.getDocRow(tx, tableId, row.id);
        if (!current || rowDeleted(current)) {
          throw new Error(`Object ${row.id} does not exist`);
        }
        const currentValue = parseDocValue(current);
        const merged = row.merge === "shallow" ? shallowMerge(currentValue, row.patch as Record<string, unknown>) : deepMerge(currentValue, row.patch);
        await this.commitDocOpTx(tx, info, "UPDATE", row.id, row.patch, merged);
      }
    });
  }

  async replace_objs(tableId: number, rows: { id: string; value: unknown }[]): Promise<void> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    this.assertJsonTable(info);
    await this.db.tx(async (tx) => {
      for (const row of rows) {
        await this.commitDocOpTx(tx, info, "REPLACE", row.id, row.value);
      }
    });
  }

  async delete_objs(tableId: number, ids: string[]): Promise<void> {
    await this.ready();
    const info = await this.requireTableInfo(tableId);
    await this.db.tx(async (tx) => {
      for (const id of ids) {
        await this.commitDeleteOpTx(tx, info, id);
      }
    });
  }

  async add_blob(tableId: number, id: string | null, bytes: Uint8Array, contentType: string): Promise<{ id: string }> {
    await this.ready();
    await this.requireTableInfo(tableId);
    const blobId = id ?? randomId("blob");
    const record: BlobRecord = {
      id: blobId,
      bytes: deepClone(bytes),
      contentType,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
    };

    await this.db.tx(async (tx) => {
      await this.upsertBlobTx(tx, tableId, record, Date.now());
      await this.appendOpTx(tx, tableId, {
        op_type: "BLOB_ADD",
        id: blobId,
        payload: {
          bytes: bytesToBase64(bytes),
          contentType,
        },
      });
    });

    return { id: blobId };
  }

  async delete_blobs(tableId: number, ids: string[]): Promise<void> {
    await this.ready();
    await this.requireTableInfo(tableId);
    await this.db.tx(async (tx) => {
      for (const id of ids) {
        await tx.exec(`DELETE FROM ${this.dialect.blobsTable} WHERE table_id = ? AND id = ?`, [tableId, id]);
        await this.appendOpTx(tx, tableId, {
          op_type: "BLOB_DEL",
          id,
          payload: null,
        });
      }
    });
  }

  async get_blob(tableId: number, id: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    await this.ready();
    const row = await this.db.queryOne<BlobRow>(
      `SELECT id, content_type, sha256, size, bytes
       FROM ${this.dialect.blobsTable}
       WHERE table_id = ? AND id = ?`,
      [tableId, id],
    );
    if (!row) {
      throw new Error(`Blob ${id} not found`);
    }
    return {
      bytes: new Uint8Array(row.bytes),
      contentType: row.content_type,
    };
  }

  async read_ops_since(tableId: number, after_seq: number, limit: number): Promise<Op[]> {
    await this.ready();
    const rows = await this.db.query<OplogRow>(
      `SELECT table_id, op_seq, ts_ms, op_type, id, payload_json
       FROM ${this.dialect.oplogTable}
       WHERE table_id = ? AND op_seq > ?
       ORDER BY op_seq ASC
       LIMIT ?`,
      [tableId, after_seq, limit],
    );
    return rows.map((row) => this.oplogRowToOp(row));
  }

  async latest_seq(tableId: number): Promise<number> {
    await this.ready();
    const row = await this.db.queryOne<{ latest_seq: number | string | null }>(
      `SELECT MAX(op_seq) AS latest_seq
       FROM ${this.dialect.oplogTable}
       WHERE table_id = ?`,
      [tableId],
    );
    return row?.latest_seq == null ? 0 : toNumber(row.latest_seq);
  }

  async apply_ops(tableId: number, ops: Op[]): Promise<void> {
    await this.ready();
    if (ops.length === 0) {
      return;
    }
    const info = await this.requireTableInfo(tableId);

    await this.db.tx(async (tx) => {
      let latestSeq = await this.latestSeqTx(tx, tableId);

      for (const op of ops) {
        if (op.op_seq <= latestSeq) {
          continue;
        }
        if (op.op_seq !== latestSeq + 1) {
          throw new Error(`Cannot apply out-of-order op ${op.op_seq} to table ${tableId}`);
        }

        switch (op.op_type) {
          case "ADD":
          case "REPLACE":
            await this.writeDocTx(tx, info, op.id, op.payload, op.ts_ms);
            this.publishChange(tableId, {
              ts: op.ts_ms,
              op: op.op_type === "ADD" ? "added" : "updated",
              id: op.id,
              value: deepClone(op.payload),
            });
            break;
          case "UPDATE": {
            const current = await this.getDocRow(tx, tableId, op.id);
            if (!current || rowDeleted(current)) {
              throw new Error(`Cannot apply UPDATE for missing object ${op.id}`);
            }
            const merged = deepMerge(parseDocValue(current), op.payload);
            await this.writeDocTx(tx, info, op.id, merged, op.ts_ms);
            this.publishChange(tableId, {
              ts: op.ts_ms,
              op: "updated",
              id: op.id,
              value: deepClone(merged),
            });
            break;
          }
          case "DELETE":
            await this.writeTombstoneTx(tx, info, op.id, op.ts_ms);
            this.publishChange(tableId, {
              ts: op.ts_ms,
              op: "deleted",
              id: op.id,
            });
            break;
          case "BLOB_ADD": {
            const payload = op.payload as { bytes: string; contentType: string };
            const bytes = base64ToBytes(payload.bytes);
            await this.upsertBlobTx(
              tx,
              tableId,
              {
                id: op.id,
                bytes,
                contentType: payload.contentType,
                sha256: sha256Hex(bytes),
                size: bytes.byteLength,
              },
              op.ts_ms,
            );
            break;
          }
          case "BLOB_DEL":
            await tx.exec(`DELETE FROM ${this.dialect.blobsTable} WHERE table_id = ? AND id = ?`, [tableId, op.id]);
            break;
          case "SCHEMA":
            break;
        }

        await this.insertOpTx(tx, op);
        latestSeq = op.op_seq;
      }
    });
  }

  async run_retention(nowMs = Date.now()): Promise<void> {
    await this.ready();
    const tables = await this.list_tables();
    for (const info of tables) {
      const { retentionHours, timeField } = info.config;
      if (!retentionHours || !timeField) {
        continue;
      }

      const cutoff = nowMs - retentionHours * 60 * 60 * 1000;
      const idsToDelete = await this.findRetentionExpiredIds(info, timeField, cutoff);
      await this.db.tx(async (tx) => {
        for (const id of idsToDelete) {
          await this.commitDeleteOpTx(tx, info, id);
        }
        const currentWatermark = await this.getWatermarkTx(tx, info.tableId);
        if (idsToDelete.length > 0 || !currentWatermark?.localMinTimeMs || cutoff > currentWatermark.localMinTimeMs) {
          await this.setWatermarkTx(tx, info.tableId, { localMinTimeMs: cutoff });
        }
      });
    }
  }

  async get_watermark(tableId: number): Promise<Watermark | null> {
    await this.ready();
    return this.getWatermarkTx(this.db, tableId);
  }

  async set_watermark(tableId: number, wm: Watermark): Promise<void> {
    await this.ready();
    await this.db.tx(async (tx) => {
      await this.setWatermarkTx(tx, tableId, wm);
    });
  }

  private async init(): Promise<void> {
    if (this.dialect.name === "postgres") {
      const schema = this.extractSchemaName();
      if (schema) {
        await this.db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
      }
    }

    const autoId = this.dialect.name === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
    const deletedType = "INTEGER NOT NULL";

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.catalogTable} (
        table_id ${autoId},
        app TEXT NOT NULL,
        db_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL
      )`,
    );
    await this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent("steng_catalog_app_db_table_idx")}
       ON ${this.dialect.catalogTable} (app, db_name, table_name)`,
    );

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.docsTable} (
        table_id BIGINT NOT NULL,
        id TEXT NOT NULL,
        json_text TEXT,
        deleted ${deletedType},
        updated_at_ms BIGINT NOT NULL,
        etag TEXT NOT NULL,
        PRIMARY KEY (table_id, id)
      )`,
    );
    await this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("steng_docs_table_deleted_id_idx")}
       ON ${this.dialect.docsTable} (table_id, deleted, id)`,
    );

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.indexTable} (
        table_id BIGINT NOT NULL,
        id TEXT NOT NULL,
        field TEXT NOT NULL,
        ord INTEGER NOT NULL,
        i64_val BIGINT,
        str_val TEXT,
        bool_val INTEGER,
        PRIMARY KEY (table_id, id, field, ord)
      )`,
    );
    await this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("steng_doc_index_lookup_idx")}
       ON ${this.dialect.indexTable} (table_id, field, i64_val, str_val, bool_val, id)`,
    );

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.oplogTable} (
        table_id BIGINT NOT NULL,
        op_seq BIGINT NOT NULL,
        ts_ms BIGINT NOT NULL,
        op_type TEXT NOT NULL,
        id TEXT NOT NULL,
        payload_json TEXT,
        PRIMARY KEY (table_id, op_seq)
      )`,
    );
    await this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("steng_oplog_table_seq_idx")}
       ON ${this.dialect.oplogTable} (table_id, op_seq)`,
    );

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.watermarkTable} (
        table_id BIGINT PRIMARY KEY,
        local_min_time_ms BIGINT
      )`,
    );

    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.blobsTable} (
        table_id BIGINT NOT NULL,
        id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size BIGINT NOT NULL,
        bytes ${this.dialect.blobType} NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        PRIMARY KEY (table_id, id)
      )`,
    );
  }

  private async ready(): Promise<void> {
    await this.readyPromise;
  }

  private async getTableInfoByName(db: SqlDb, app: string, dbName: string, tableName: string): Promise<TableInfo | null> {
    const row = await db.queryOne<CatalogRow>(
      `SELECT table_id, app, db_name, table_name, type, config_json
       FROM ${this.dialect.catalogTable}
       WHERE app = ? AND db_name = ? AND table_name = ?`,
      [app, dbName, tableName],
    );
    return row ? this.catalogRowToInfo(row) : null;
  }

  private async requireTableInfo(tableId: number): Promise<TableInfo> {
    const info = await this.get_table_info_by_id(tableId);
    if (!info) {
      throw new Error(`Table ${tableId} does not exist`);
    }
    return info;
  }

  private catalogRowToInfo(row: CatalogRow): TableInfo {
    return {
      tableId: toNumber(row.table_id),
      app: row.app,
      db: row.db_name,
      tableName: row.table_name,
      type: row.type,
      config: parseTableConfig(row.config_json),
    };
  }

  private assertJsonTable(info: TableInfo): void {
    if (info.type !== "json") {
      throw new Error(`Table ${info.tableName} is not a json table`);
    }
  }

  private async persistTableConfigAndRebuild(tableId: number, config: TableConfig): Promise<void> {
    const info = await this.requireTableInfo(tableId);
    await this.db.tx(async (tx) => {
      await tx.exec(
        `UPDATE ${this.dialect.catalogTable}
         SET config_json = ?
         WHERE table_id = ?`,
        [serializeJson(config), tableId],
      );

      await tx.exec(`DELETE FROM ${this.dialect.indexTable} WHERE table_id = ?`, [tableId]);
      const docs = await tx.query<DocRow>(
        `SELECT id, json_text, updated_at_ms, deleted, etag
         FROM ${this.dialect.docsTable}
         WHERE table_id = ? AND deleted = 0`,
        [tableId],
      );
      for (const doc of docs) {
        await this.insertIndexRowsTx(tx, { ...info, config }, doc.id, parseDocValue(doc));
      }
    });
  }

  private async fetchDocsByIds(tableId: number, ids: string[]): Promise<Map<string, DocRow>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.db.query<DocRow>(
      `SELECT id, json_text, updated_at_ms, deleted, etag
       FROM ${this.dialect.docsTable}
       WHERE table_id = ? AND id IN ${buildInClause(ids)}
       ORDER BY id ASC`,
      [tableId, ...ids],
    );

    return new Map(rows.map((row) => [row.id, row]));
  }

  private async getDocRow(db: SqlDb, tableId: number, id: string): Promise<DocRow | null> {
    return db.queryOne<DocRow>(
      `SELECT id, json_text, updated_at_ms, deleted, etag
       FROM ${this.dialect.docsTable}
       WHERE table_id = ? AND id = ?`,
      [tableId, id],
    );
  }

  private async writeDocTx(db: SqlDb, info: TableInfo, id: string, value: unknown, updatedAtMs: number): Promise<void> {
    await db.exec(
      `INSERT INTO ${this.dialect.docsTable} (table_id, id, json_text, deleted, updated_at_ms, etag)
       VALUES (?, ?, ?, 0, ?, ?)
       ON CONFLICT (table_id, id) DO UPDATE SET
         json_text = excluded.json_text,
         deleted = excluded.deleted,
         updated_at_ms = excluded.updated_at_ms,
         etag = excluded.etag`,
      [info.tableId, id, serializeJson(value), updatedAtMs, sha256Hex(JSON.stringify(value))],
    );
    await db.exec(`DELETE FROM ${this.dialect.indexTable} WHERE table_id = ? AND id = ?`, [info.tableId, id]);
    await this.insertIndexRowsTx(db, info, id, value);
  }

  private async writeTombstoneTx(db: SqlDb, info: TableInfo, id: string, updatedAtMs: number): Promise<void> {
    const current = await this.getDocRow(db, info.tableId, id);
    const currentValue = current ? parseDocValue(current) : null;
    const etag = current?.etag ?? randomId("etag");
    await db.exec(
      `INSERT INTO ${this.dialect.docsTable} (table_id, id, json_text, deleted, updated_at_ms, etag)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (table_id, id) DO UPDATE SET
         json_text = excluded.json_text,
         deleted = excluded.deleted,
         updated_at_ms = excluded.updated_at_ms,
         etag = excluded.etag`,
      [info.tableId, id, serializeJson(currentValue), updatedAtMs, etag],
    );
    await db.exec(`DELETE FROM ${this.dialect.indexTable} WHERE table_id = ? AND id = ?`, [info.tableId, id]);
  }

  private async insertIndexRowsTx(db: SqlDb, info: TableInfo, id: string, value: unknown): Promise<void> {
    for (const [field, indexConfig] of Object.entries(info.config.indexes)) {
      const values = indexValuesForField(info.config, field, value);
      for (const [ord, raw] of values.entries()) {
        const type = indexConfig.type;
        const column = indexColumnForType(type);
        const normalized = toIndexedParam(type, raw);
        const i64Val = column === "i64_val" ? normalized : null;
        const strVal = column === "str_val" ? normalized : null;
        const boolVal = column === "bool_val" ? normalized : null;
        await db.exec(
          `INSERT INTO ${this.dialect.indexTable} (table_id, id, field, ord, i64_val, str_val, bool_val)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [info.tableId, id, field, ord, i64Val, strVal, boolVal],
        );
      }
    }
  }

  private async appendOpTx(
    db: SqlDb,
    tableId: number,
    partial: Omit<Op, "tableId" | "op_seq" | "ts_ms"> & { ts_ms?: number },
  ): Promise<Op> {
    const latest = await this.latestSeqTx(db, tableId);
    const op: Op = {
      tableId,
      op_seq: latest + 1,
      ts_ms: partial.ts_ms ?? Date.now(),
      op_type: partial.op_type,
      id: partial.id,
      payload: deepClone(partial.payload),
    };
    await this.insertOpTx(db, op);
    return op;
  }

  private async insertOpTx(db: SqlDb, op: Op): Promise<void> {
    await db.exec(
      `INSERT INTO ${this.dialect.oplogTable} (table_id, op_seq, ts_ms, op_type, id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [op.tableId, op.op_seq, op.ts_ms, op.op_type, op.id, serializeJson(op.payload)],
    );
  }

  private async latestSeqTx(db: SqlDb, tableId: number): Promise<number> {
    const row = await db.queryOne<{ latest_seq: number | string | null }>(
      `SELECT MAX(op_seq) AS latest_seq
       FROM ${this.dialect.oplogTable}
       WHERE table_id = ?`,
      [tableId],
    );
    return row?.latest_seq == null ? 0 : toNumber(row.latest_seq);
  }

  private async upsertBlobTx(db: SqlDb, tableId: number, blob: BlobRecord, updatedAtMs: number): Promise<void> {
    await db.exec(
      `INSERT INTO ${this.dialect.blobsTable} (table_id, id, content_type, sha256, size, bytes, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (table_id, id) DO UPDATE SET
         content_type = excluded.content_type,
         sha256 = excluded.sha256,
         size = excluded.size,
         bytes = excluded.bytes,
         updated_at_ms = excluded.updated_at_ms`,
      [tableId, blob.id, blob.contentType, blob.sha256, blob.size, blob.bytes, updatedAtMs],
    );
  }

  private async commitDocOpTx(
    db: SqlDb,
    info: TableInfo,
    opType: "ADD" | "UPDATE" | "REPLACE",
    id: string,
    payload: unknown,
    replacement?: unknown,
  ): Promise<void> {
    const ts = Date.now();
    const value = opType === "UPDATE" ? replacement : payload;
    await this.writeDocTx(db, info, id, value, ts);
    const op = await this.appendOpTx(db, info.tableId, {
      op_type: opType,
      id,
      payload,
      ts_ms: ts,
    });
    this.publishChange(info.tableId, {
      ts: op.ts_ms,
      op: opType === "ADD" ? "added" : "updated",
      id,
      value: deepClone(value),
    });
  }

  private async commitDeleteOpTx(db: SqlDb, info: TableInfo, id: string): Promise<void> {
    const ts = Date.now();
    await this.writeTombstoneTx(db, info, id, ts);
    const op = await this.appendOpTx(db, info.tableId, {
      op_type: "DELETE",
      id,
      payload: null,
      ts_ms: ts,
    });
    this.publishChange(info.tableId, {
      ts: op.ts_ms,
      op: "deleted",
      id,
    });
  }

  private publishChange(tableId: number, evt: ChangeEvent): void {
    this.changeBus.publish(tableId, evt);
  }

  private oplogRowToOp(row: OplogRow): Op {
    return {
      tableId: toNumber(row.table_id),
      op_seq: toNumber(row.op_seq),
      ts_ms: toNumber(row.ts_ms),
      op_type: row.op_type,
      id: row.id,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    };
  }

  private async queryLiveIds(tableId: number): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id
       FROM ${this.dialect.docsTable}
       WHERE table_id = ? AND deleted = 0
       ORDER BY id ASC`,
      [tableId],
    );
    return rows.map((row) => row.id);
  }

  private async queryFilteredIds(info: TableInfo, filter: Filter): Promise<string[]> {
    let candidateIds: Set<string> | null = null;

    for (const clause of filter ?? []) {
      const ids = await this.queryIdsForClause(info, clause);
      const nextIds = new Set(ids);
      candidateIds = candidateIds ? new Set<string>([...candidateIds].filter((id: string) => nextIds.has(id))) : nextIds;
      if (candidateIds.size === 0) {
        return [];
      }
    }

    const ordered = [...(candidateIds ?? new Set<string>())].sort((left, right) => left.localeCompare(right));
    const rows = await this.fetchDocsByIds(info.tableId, ordered);
    return ordered.filter((id) => {
      const row = rows.get(id);
      if (!row || rowDeleted(row)) {
        return false;
      }
      return matchesFilter({ id, ...(parseDocValue(row) as Record<string, unknown>) }, filter);
    });
  }

  private async queryIdsForClause(info: TableInfo, clause: FilterClause): Promise<string[]> {
    const [field, op, rawValue] = clause;
    if (field === "id") {
      return this.queryIdsByIdClause(info.tableId, clause);
    }

    const index = info.config.indexes[field];
    if (!index) {
      return [];
    }

    const column = indexColumnForType(index.type);
    const base = `FROM ${this.dialect.indexTable} WHERE table_id = ? AND field = ?`;

    switch (op) {
      case "==":
        return this.querySimpleIndexIds(`${base} AND ${column} = ?`, [info.tableId, field, toIndexedParam(index.type, rawValue)]);
      case "!=": {
        const excluded = await this.querySimpleIndexIds(`${base} AND ${column} = ?`, [info.tableId, field, toIndexedParam(index.type, rawValue)]);
        if (excluded.length === 0) {
          return this.queryLiveIds(info.tableId);
        }
        return this.db
          .query<{ id: string }>(
            `SELECT id
             FROM ${this.dialect.docsTable}
             WHERE table_id = ? AND deleted = 0 AND id NOT IN ${buildInClause(excluded)}
             ORDER BY id ASC`,
            [info.tableId, ...excluded],
          )
          .then((rows) => rows.map((row) => row.id));
      }
      case ">":
      case ">=":
      case "<":
      case "<=":
        return this.querySimpleIndexIds(`${base} AND ${column} ${op} ?`, [info.tableId, field, toIndexedParam(index.type, rawValue)]);
      case "between": {
        const values = rawValue as [unknown, unknown];
        return this.querySimpleIndexIds(`${base} AND ${column} >= ? AND ${column} < ?`, [
          info.tableId,
          field,
          toIndexedParam(index.type, values[0]),
          toIndexedParam(index.type, values[1]),
        ]);
      }
      case "in": {
        const values = Array.isArray(rawValue) ? rawValue : [];
        if (values.length === 0) {
          return [];
        }
        return this.querySimpleIndexIds(`${base} AND ${column} IN ${buildInClause(values)}`, [
          info.tableId,
          field,
          ...values.map((value) => toIndexedParam(index.type, value)),
        ]);
      }
      case "contains":
        if (index.multi) {
          return this.querySimpleIndexIds(`${base} AND ${column} = ?`, [info.tableId, field, toIndexedParam(index.type, rawValue)]);
        }
        if (column === "str_val") {
          return this.querySimpleIndexIds(`${base} AND ${column} LIKE '%' || ? || '%'`, [info.tableId, field, String(rawValue)]);
        }
        return this.queryLiveIds(info.tableId);
      case "prefix":
        if (column === "str_val") {
          return this.querySimpleIndexIds(`${base} AND ${column} LIKE ?`, [info.tableId, field, `${String(rawValue)}%`]);
        }
        return this.queryLiveIds(info.tableId);
      default:
        return this.queryLiveIds(info.tableId);
    }
  }

  private async queryIdsByIdClause(tableId: number, [_, op, rawValue]: FilterClause): Promise<string[]> {
    switch (op) {
      case "==":
        return this.db
          .query<{ id: string }>(
            `SELECT id FROM ${this.dialect.docsTable} WHERE table_id = ? AND deleted = 0 AND id = ? ORDER BY id ASC`,
            [tableId, String(rawValue)],
          )
          .then((rows) => rows.map((row) => row.id));
      case "!=":
        return this.db
          .query<{ id: string }>(
            `SELECT id FROM ${this.dialect.docsTable} WHERE table_id = ? AND deleted = 0 AND id <> ? ORDER BY id ASC`,
            [tableId, String(rawValue)],
          )
          .then((rows) => rows.map((row) => row.id));
      case "in": {
        const values = Array.isArray(rawValue) ? rawValue.map(String) : [];
        if (values.length === 0) {
          return [];
        }
        return this.db
          .query<{ id: string }>(
            `SELECT id FROM ${this.dialect.docsTable} WHERE table_id = ? AND deleted = 0 AND id IN ${buildInClause(values)} ORDER BY id ASC`,
            [tableId, ...values],
          )
          .then((rows) => rows.map((row) => row.id));
      }
      case "prefix":
        return this.db
          .query<{ id: string }>(
            `SELECT id FROM ${this.dialect.docsTable} WHERE table_id = ? AND deleted = 0 AND id LIKE ? ORDER BY id ASC`,
            [tableId, `${String(rawValue)}%`],
          )
          .then((rows) => rows.map((row) => row.id));
      default:
        return this.queryLiveIds(tableId);
    }
  }

  private async querySimpleIndexIds(sqlTail: string, params: unknown[]): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT DISTINCT id ${sqlTail} ORDER BY id ASC`,
      params,
    );
    return rows.map((row) => row.id);
  }

  private async findRetentionExpiredIds(info: TableInfo, timeField: string, cutoff: number): Promise<string[]> {
    if (info.config.indexes[timeField]) {
      const rows = await this.db.query<{ id: string }>(
        `SELECT DISTINCT id
         FROM ${this.dialect.indexTable}
         WHERE table_id = ? AND field = ? AND i64_val < ?
         ORDER BY id ASC`,
        [info.tableId, timeField, cutoff],
      );
      return rows.map((row) => row.id);
    }

    const rows = await this.db.query<DocRow>(
      `SELECT id, json_text, updated_at_ms, deleted, etag
       FROM ${this.dialect.docsTable}
       WHERE table_id = ? AND deleted = 0`,
      [info.tableId],
    );
    return rows
      .filter((row) => {
        const value = parseDocValue(row);
        const fieldValue = getField(value, timeField);
        return typeof fieldValue === "number" && fieldValue < cutoff;
      })
      .map((row) => row.id)
      .sort((left, right) => left.localeCompare(right));
  }

  private async getWatermarkTx(db: SqlDb, tableId: number): Promise<Watermark | null> {
    const row = await db.queryOne<{ local_min_time_ms: number | string | null }>(
      `SELECT local_min_time_ms
       FROM ${this.dialect.watermarkTable}
       WHERE table_id = ?`,
      [tableId],
    );
    if (!row) {
      return null;
    }
    return {
      localMinTimeMs: row.local_min_time_ms == null ? undefined : toNumber(row.local_min_time_ms),
    };
  }

  private async setWatermarkTx(db: SqlDb, tableId: number, wm: Watermark): Promise<void> {
    await db.exec(
      `INSERT INTO ${this.dialect.watermarkTable} (table_id, local_min_time_ms)
       VALUES (?, ?)
       ON CONFLICT (table_id) DO UPDATE SET
         local_min_time_ms = excluded.local_min_time_ms`,
      [tableId, wm.localMinTimeMs ?? null],
    );
  }

  private extractSchemaName(): string | null {
    const prefix = this.dialect.catalogTable.split(".");
    if (prefix.length < 2) {
      return null;
    }
    return prefix[0].replace(/"/g, "");
  }

  private generateId(info: TableInfo): string {
    return generateDistributedId(info.config.idPrefix ?? defaultIdPrefix(info.tableName), this.clusterShort);
  }
}

/** Low-level SQLite engine options. Most app code should prefer `new Steng({ backend: "sqlite" })`. */
export type SqliteStengEngineOptions = SqliteDbOptions & StengIdentityOptions;

export class SqliteStengEngine extends SqlStengEngine {
  constructor(options: SqliteStengEngineOptions = {}) {
    super(new SqliteDb(options), createDialect("sqlite"), options);
  }
}

/** Low-level Postgres engine options. Most app code should prefer `new Steng({ backend: "postgres" })`. */
export type PostgresStengEngineOptions = PostgresDbOptions & {
  /** SQL schema name for the `steng_*` tables. */
  schema?: string;
} & StengIdentityOptions;

export class PostgresStengEngine extends SqlStengEngine {
  constructor(options: PostgresStengEngineOptions = {}) {
    super(new PostgresDb(options), createDialect("postgres", options.schema), options);
  }
}
