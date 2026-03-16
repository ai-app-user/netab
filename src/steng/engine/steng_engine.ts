import { randomId, deepClone, deepMerge, shallowMerge, getField, sha256Hex, bytesToBase64, base64ToBytes } from "../../shared/utils.js";
import { ChangeBus } from "./change_bus.js";
import { assertFilterSupported, matchesFilter } from "./filtering.js";
import { defaultIdPrefix, deriveClusterShort, generateDistributedId } from "./id_generation.js";
import type { StengApi } from "../steng.js";
import type { BlobRecord, ChangeEvent, Filter, GetResult, IndexType, ObjRow, Op, StengIdentityOptions, TableConfig, TableInfo, TableType, Watermark } from "../types.js";

type StoredDoc = {
  id: string;
  value: unknown;
  deleted: boolean;
  updatedAtMs: number;
  etag: string;
};

type TableState = {
  info: TableInfo;
  docs: Map<string, StoredDoc>;
  blobs: Map<string, BlobRecord>;
  ops: Op[];
  latestSeq: number;
  watermark: Watermark | null;
};

function makeTableKey(app: string, db: string, tableName: string): string {
  return `${app}::${db}::${tableName}`;
}

function assertJsonTable(state: TableState): void {
  if (state.info.type !== "json") {
    throw new Error(`Table ${state.info.tableName} is not a json table`);
  }
}

function assertGeneratedIdOnly(row: { value: unknown }): void {
  const maybeId = (row as { id?: unknown }).id;
  if (maybeId !== undefined) {
    throw new Error("add_objs does not accept caller-defined ids; store app ids inside the JSON value instead");
  }
}

export class StengEngine implements StengApi {
  private readonly tablesByName = new Map<string, TableState>();
  private readonly tablesById = new Map<number, TableState>();
  private readonly changeBus = new ChangeBus();
  private nextTableId = 1;
  private readonly clusterShort: string;

  constructor(identity: StengIdentityOptions = {}) {
    this.clusterShort = identity.clusterShort ?? (identity.clusterId ? deriveClusterShort(identity.clusterId) : "local");
  }

  async close(): Promise<void> {}

  async ensure_table(app: string, db: string, table_name: string, type: TableType): Promise<TableInfo> {
    const key = makeTableKey(app, db, table_name);
    const existing = this.tablesByName.get(key);
    if (existing) {
      return deepClone(existing.info);
    }

    const info: TableInfo = {
      tableId: this.nextTableId,
      app,
      db,
      tableName: table_name,
      type,
      config: { indexes: {}, idPrefix: defaultIdPrefix(table_name) },
    };
    this.nextTableId += 1;

    const state: TableState = {
      info,
      docs: new Map(),
      blobs: new Map(),
      ops: [],
      latestSeq: 0,
      watermark: null,
    };

    this.tablesByName.set(key, state);
    this.tablesById.set(info.tableId, state);
    return deepClone(info);
  }

  async get_table_info(app: string, db: string, table_name: string): Promise<TableInfo | null> {
    const state = this.tablesByName.get(makeTableKey(app, db, table_name));
    return state ? deepClone(state.info) : null;
  }

  async get_table_info_by_id(tableId: number): Promise<TableInfo | null> {
    const state = this.tablesById.get(tableId);
    return state ? deepClone(state.info) : null;
  }

  async list_tables(app?: string, db?: string): Promise<TableInfo[]> {
    const items: TableInfo[] = [];
    for (const state of this.tablesById.values()) {
      if (app && state.info.app !== app) {
        continue;
      }
      if (db && state.info.db !== db) {
        continue;
      }
      items.push(deepClone(state.info));
    }
    items.sort((a, b) => a.tableId - b.tableId);
    return items;
  }

  async drop_table(tableId: number): Promise<void> {
    const state = this.requireTable(tableId);
    this.tablesById.delete(tableId);
    this.tablesByName.delete(makeTableKey(state.info.app, state.info.db, state.info.tableName));
  }

  async add_index(tableId: number, field: string, idx_type: IndexType, multi = false): Promise<void> {
    const state = this.requireTable(tableId);
    state.info.config.indexes[field] = { type: idx_type, multi };
  }

  async set_table_config(tableId: number, patch: Partial<TableConfig>): Promise<void> {
    const state = this.requireTable(tableId);
    state.info.config = {
      ...state.info.config,
      ...deepClone(patch),
      indexes: {
        ...state.info.config.indexes,
        ...(patch.indexes ?? {}),
      },
    };
  }

  async get_objs(tableId: number, ids: string[] | null, filter: Filter | null, start_pos = 0, max_count = -1): Promise<GetResult> {
    const state = this.requireTable(tableId);
    const limit = max_count < 0 ? Number.MAX_SAFE_INTEGER : max_count;

    if (ids && ids.length > 0) {
      const items = ids.slice(start_pos, start_pos + limit).map<ObjRow>((id) => {
        const row = state.docs.get(id);
        if (!row || row.deleted) {
          return { id, miss: "NOT_FOUND" };
        }
        return {
          id,
          value: deepClone(row.value),
          meta: {
            updatedAtMs: row.updatedAtMs,
            etag: row.etag,
            deleted: row.deleted,
          },
        };
      });
      return {
        items,
        next_pos: Math.min(start_pos + items.length, ids.length),
        watermark: deepClone(state.watermark),
      };
    }

    assertFilterSupported(state.info, filter);

    const rows = Array.from(state.docs.values())
      .filter((row) => !row.deleted)
      .map((row) => ({ id: row.id, ...(typeof row.value === "object" && row.value !== null ? (row.value as object) : {}) }))
      .filter((row) => matchesFilter(row, filter))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const slice = rows.slice(start_pos, start_pos + limit);
    return {
      items: slice.map((row) => {
        const stored = state.docs.get(String(row.id));
        return {
          id: String(row.id),
          value: deepClone(stored?.value),
          meta: stored
            ? {
                updatedAtMs: stored.updatedAtMs,
                etag: stored.etag,
                deleted: stored.deleted,
              }
            : undefined,
        };
      }),
      next_pos: Math.min(start_pos + slice.length, rows.length),
      watermark: deepClone(state.watermark),
    };
  }

  subscribe_objs(tableId: number, filter: Filter | null, cb: (evt: ChangeEvent) => void) {
    this.requireTable(tableId);
    return this.changeBus.subscribe(tableId, filter, cb);
  }

  async add_obj(tableId: number, value: unknown): Promise<{ id: string }> {
    const inserted = await this.add_objs(tableId, [{ value }]);
    return { id: inserted.ids[0] };
  }

  async add_objs(tableId: number, rows: { value: unknown }[]): Promise<{ ids: string[] }> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    const ids: string[] = [];
    for (const row of rows) {
      assertGeneratedIdOnly(row);
      const id = this.generateId(state.info);
      await this.commitDocOp(state, "ADD", id, row.value);
      ids.push(id);
    }
    return { ids };
  }

  async update_objs(tableId: number, rows: { id: string; patch: unknown; merge?: "deep" | "shallow" }[]): Promise<void> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    for (const row of rows) {
      const current = state.docs.get(row.id);
      if (!current || current.deleted) {
        throw new Error(`Object ${row.id} does not exist`);
      }
      const merged = row.merge === "shallow" ? shallowMerge(current.value, row.patch as Record<string, unknown>) : deepMerge(current.value, row.patch);
      await this.commitDocOp(state, "UPDATE", row.id, row.patch, merged);
    }
  }

  async replace_objs(tableId: number, rows: { id: string; value: unknown }[]): Promise<void> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    for (const row of rows) {
      await this.commitDocOp(state, "REPLACE", row.id, row.value);
    }
  }

  async delete_objs(tableId: number, ids: string[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const id of ids) {
      await this.commitDeleteOp(state, id);
    }
  }

  async add_blob(tableId: number, id: string | null, bytes: Uint8Array, contentType: string): Promise<{ id: string }> {
    const state = this.requireTable(tableId);
    const blobId = id ?? randomId("blob");
    const record: BlobRecord = {
      id: blobId,
      bytes: deepClone(bytes),
      contentType,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
    };
    state.blobs.set(blobId, record);
    await this.appendOp(state, {
      op_type: "BLOB_ADD",
      id: blobId,
      payload: {
        bytes: bytesToBase64(bytes),
        contentType,
      },
    });
    return { id: blobId };
  }

  async delete_blobs(tableId: number, ids: string[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const id of ids) {
      state.blobs.delete(id);
      await this.appendOp(state, {
        op_type: "BLOB_DEL",
        id,
        payload: null,
      });
    }
  }

  async get_blob(tableId: number, id: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const state = this.requireTable(tableId);
    const blob = state.blobs.get(id);
    if (!blob) {
      throw new Error(`Blob ${id} not found`);
    }
    return { bytes: deepClone(blob.bytes), contentType: blob.contentType };
  }

  async read_ops_since(tableId: number, after_seq: number, limit: number): Promise<Op[]> {
    const state = this.requireTable(tableId);
    return state.ops
      .filter((op) => op.op_seq > after_seq)
      .slice(0, limit)
      .map((op) => deepClone(op));
  }

  async latest_seq(tableId: number): Promise<number> {
    const state = this.requireTable(tableId);
    return state.latestSeq;
  }

  async apply_ops(tableId: number, ops: Op[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const op of ops) {
      if (op.op_seq <= state.latestSeq) {
        continue;
      }
      if (op.op_seq !== state.latestSeq + 1) {
        throw new Error(`Cannot apply out-of-order op ${op.op_seq} to table ${tableId}`);
      }

      switch (op.op_type) {
        case "ADD":
        case "REPLACE": {
          this.writeDoc(state, op.id, op.payload, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: op.op_type === "ADD" ? "added" : "updated",
            id: op.id,
            value: deepClone(op.payload),
          });
          break;
        }
        case "UPDATE": {
          const current = state.docs.get(op.id);
          if (!current || current.deleted) {
            throw new Error(`Cannot apply UPDATE for missing object ${op.id}`);
          }
          const merged = deepMerge(current.value, op.payload);
          this.writeDoc(state, op.id, merged, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: "updated",
            id: op.id,
            value: deepClone(merged),
          });
          break;
        }
        case "DELETE": {
          this.writeTombstone(state, op.id, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: "deleted",
            id: op.id,
          });
          break;
        }
        case "BLOB_ADD": {
          const payload = op.payload as { bytes: string; contentType: string };
          const bytes = base64ToBytes(payload.bytes);
          state.blobs.set(op.id, {
            id: op.id,
            bytes,
            contentType: payload.contentType,
            sha256: sha256Hex(bytes),
            size: bytes.byteLength,
          });
          break;
        }
        case "BLOB_DEL": {
          state.blobs.delete(op.id);
          break;
        }
        case "SCHEMA":
          break;
      }

      state.latestSeq = op.op_seq;
      state.ops.push(deepClone(op));
    }
  }

  async run_retention(nowMs = Date.now()): Promise<void> {
    for (const state of this.tablesById.values()) {
      const { retentionHours, timeField } = state.info.config;
      if (!retentionHours || !timeField) {
        continue;
      }

      const cutoff = nowMs - retentionHours * 60 * 60 * 1000;
      const idsToDelete: string[] = [];
      for (const row of state.docs.values()) {
        if (row.deleted) {
          continue;
        }
        const fieldValue = getField(row.value, timeField);
        if (typeof fieldValue === "number" && fieldValue < cutoff) {
          idsToDelete.push(row.id);
        }
      }

      for (const id of idsToDelete) {
        await this.commitDeleteOp(state, id);
      }

      if (idsToDelete.length > 0 || !state.watermark?.localMinTimeMs || cutoff > state.watermark.localMinTimeMs) {
        state.watermark = { localMinTimeMs: cutoff };
      }
    }
  }

  async get_watermark(tableId: number): Promise<Watermark | null> {
    const state = this.requireTable(tableId);
    return deepClone(state.watermark);
  }

  async set_watermark(tableId: number, wm: Watermark): Promise<void> {
    const state = this.requireTable(tableId);
    state.watermark = deepClone(wm);
  }

  private requireTable(tableId: number): TableState {
    const state = this.tablesById.get(tableId);
    if (!state) {
      throw new Error(`Table ${tableId} does not exist`);
    }
    return state;
  }

  private async commitDocOp(state: TableState, opType: "ADD" | "UPDATE" | "REPLACE", id: string, payload: unknown, replacement?: unknown): Promise<void> {
    const ts = Date.now();
    const value = opType === "UPDATE" ? replacement : payload;
    this.writeDoc(state, id, value, ts);
    const op = await this.appendOp(state, {
      op_type: opType,
      id,
      payload,
      ts_ms: ts,
    });
    this.publishChange(state.info.tableId, {
      ts: op.ts_ms,
      op: opType === "ADD" ? "added" : "updated",
      id,
      value: deepClone(value),
    });
  }

  private async commitDeleteOp(state: TableState, id: string): Promise<void> {
    const ts = Date.now();
    this.writeTombstone(state, id, ts);
    const op = await this.appendOp(state, {
      op_type: "DELETE",
      id,
      payload: null,
      ts_ms: ts,
    });
    this.publishChange(state.info.tableId, {
      ts: op.ts_ms,
      op: "deleted",
      id,
    });
  }

  private writeDoc(state: TableState, id: string, value: unknown, updatedAtMs: number): void {
    state.docs.set(id, {
      id,
      value: deepClone(value),
      deleted: false,
      updatedAtMs,
      etag: sha256Hex(JSON.stringify(value)),
    });
  }

  private writeTombstone(state: TableState, id: string, updatedAtMs: number): void {
    const current = state.docs.get(id);
    state.docs.set(id, {
      id,
      value: current?.value ?? null,
      deleted: true,
      updatedAtMs,
      etag: current?.etag ?? randomId("etag"),
    });
  }

  private async appendOp(state: TableState, partial: Omit<Op, "tableId" | "op_seq" | "ts_ms"> & { ts_ms?: number }): Promise<Op> {
    const op: Op = {
      tableId: state.info.tableId,
      op_seq: state.latestSeq + 1,
      ts_ms: partial.ts_ms ?? Date.now(),
      op_type: partial.op_type,
      id: partial.id,
      payload: deepClone(partial.payload),
    };
    state.latestSeq = op.op_seq;
    state.ops.push(op);
    return deepClone(op);
  }

  private publishChange(tableId: number, evt: ChangeEvent): void {
    this.changeBus.publish(tableId, evt);
  }

  private generateId(info: TableInfo): string {
    return generateDistributedId(info.config.idPrefix ?? defaultIdPrefix(info.tableName), this.clusterShort);
  }
}
