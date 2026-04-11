import {
  randomId,
  deepClone,
  deepMerge,
  shallowMerge,
  getField,
  sha256Hex,
  bytesToBase64,
  base64ToBytes,
} from '../../shared/utils.js';
import { ChangeBus } from './change_bus.js';
import { assertFilterSupported, matchesFilter } from './filtering.js';
import {
  defaultIdPrefix,
  deriveClusterShort,
  generateDistributedId,
} from './id_generation.js';
import {
  exportSnapshotBundle,
  importSnapshotBundle,
  type ResolvedSnapshotImportOptions,
  type SnapshotExportTableData,
  type SnapshotImportTableData,
  type SnapshotImportTableResult,
} from './snapshot_bundle.js';
import type { StengApi } from '../steng.js';
import type {
  BlobRecord,
  ChangeEvent,
  ExportSnapshotOptions,
  Filter,
  GetResult,
  ImportSnapshotOptions,
  IndexInfo,
  IndexType,
  ObjRow,
  Op,
  SnapshotDocRecord,
  SnapshotImportResult,
  SnapshotManifest,
  SnapshotTableSelection,
  StengIdentityOptions,
  TableConfig,
  TableInfo,
  TableType,
  Watermark,
} from '../types.js';

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

/**
 * Builds table key.
 * @param app Application name.
 * @param db Database name.
 * @param tableName Table name.
 */
function makeTableKey(app: string, db: string, tableName: string): string {
  return `${app}::${db}::${tableName}`;
}

/**
 * Validates JSON table.
 * @param state Internal state record.
 */
function assertJsonTable(state: TableState): void {
  if (state.info.type !== 'json') {
    throw new Error(`Table ${state.info.tableName} is not a json table`);
  }
}

/**
 * Validates generated id only.
 * @param row Row to process.
 */
function assertGeneratedIdOnly(row: { value: unknown }): void {
  const maybeId = (row as { id?: unknown }).id;
  if (maybeId !== undefined) {
    throw new Error(
      'add_objs does not accept caller-defined ids; store app ids inside the JSON value instead',
    );
  }
}

/**
 * In-memory STENG engine implementation.
 */
export class StengEngine implements StengApi {
  private readonly tablesByName = new Map<string, TableState>();
  private readonly tablesById = new Map<number, TableState>();
  private readonly changeBus = new ChangeBus();
  private nextTableId = 1;
  private readonly clusterShort: string;

  constructor(identity: StengIdentityOptions = {}) {
    this.clusterShort =
      identity.clusterShort ??
      (identity.clusterId ? deriveClusterShort(identity.clusterId) : 'local');
  }

  /**
   * Closes the resource and releases any associated handles.
   */
  async close(): Promise<void> {}

  /**
   * Ensures table.
   * @param app Application name.
   * @param db Database name.
   * @param table_name Table name.
   * @param type Type value to process.
   */
  async ensure_table(
    app: string,
    db: string,
    table_name: string,
    type: TableType,
  ): Promise<TableInfo> {
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

  /**
   * Returns table info.
   * @param app Application name.
   * @param db Database name.
   * @param table_name Table name.
   */
  async get_table_info(
    app: string,
    db: string,
    table_name: string,
  ): Promise<TableInfo | null> {
    const state = this.tablesByName.get(makeTableKey(app, db, table_name));
    return state ? deepClone(state.info) : null;
  }

  /**
   * Returns table info by id.
   * @param tableId Table identifier.
   */
  async get_table_info_by_id(tableId: number): Promise<TableInfo | null> {
    const state = this.tablesById.get(tableId);
    return state ? deepClone(state.info) : null;
  }

  /**
   * Lists tables.
   * @param app Application name.
   * @param db Database name.
   */
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

  /**
   * Removes table.
   * @param tableId Table identifier.
   */
  async drop_table(tableId: number): Promise<void> {
    const state = this.requireTable(tableId);
    this.tablesById.delete(tableId);
    this.tablesByName.delete(
      makeTableKey(state.info.app, state.info.db, state.info.tableName),
    );
  }

  /**
   * Adds index.
   * @param tableId Table identifier.
   * @param field Field path.
   * @param idx_type Index type.
   * @param multi Whether the index stores multiple values.
   */
  async add_index(
    tableId: number,
    field: string,
    idx_type: IndexType,
    multi = false,
  ): Promise<void> {
    const state = this.requireTable(tableId);
    state.info.config.indexes[field] = { type: idx_type, multi };
  }

  /**
   * Lists indexes.
   * @param tableId Table identifier.
   */
  async list_indexes(tableId: number): Promise<IndexInfo[]> {
    const state = this.requireTable(tableId);
    return Object.entries(state.info.config.indexes)
      .map(([field, config]) => ({
        field,
        type: config.type,
        multi: Boolean(config.multi),
      }))
      .sort((left, right) => left.field.localeCompare(right.field));
  }

  /**
   * Updates table configuration.
   * @param tableId Table identifier.
   * @param patch Patch object to apply.
   */
  async set_table_config(
    tableId: number,
    patch: Partial<TableConfig>,
  ): Promise<void> {
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

  /**
   * Returns objects.
   * @param tableId Table identifier.
   * @param ids Identifiers to process.
   * @param filter Optional filter expression.
   * @param start_pos Start offset.
   * @param max_count Maximum number of results.
   */
  async get_objs(
    tableId: number,
    ids: string[] | null,
    filter: Filter | null,
    start_pos = 0,
    max_count = -1,
  ): Promise<GetResult> {
    const state = this.requireTable(tableId);
    const limit = max_count < 0 ? Number.MAX_SAFE_INTEGER : max_count;

    if (ids && ids.length > 0) {
      const items = ids
        .slice(start_pos, start_pos + limit)
        .map<ObjRow>((id) => {
          const row = state.docs.get(id);
          if (!row || row.deleted) {
            return { id, miss: 'NOT_FOUND' };
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
      .map((row) => ({
        id: row.id,
        ...(typeof row.value === 'object' && row.value !== null
          ? (row.value as object)
          : {}),
      }))
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

  /**
   * Subscribes to objects.
   * @param tableId Table identifier.
   * @param filter Optional filter expression.
   * @param cb Cb.
   */
  subscribe_objs(
    tableId: number,
    filter: Filter | null,
    cb: (evt: ChangeEvent) => void,
  ) {
    this.requireTable(tableId);
    return this.changeBus.subscribe(tableId, filter, cb);
  }

  /**
   * Adds object.
   * @param tableId Table identifier.
   * @param value Value to process.
   */
  async add_obj(tableId: number, value: unknown): Promise<{ id: string }> {
    const inserted = await this.add_objs(tableId, [{ value }]);
    return { id: inserted.ids[0] };
  }

  /**
   * Adds objects.
   * @param tableId Table identifier.
   * @param rows Rows to process.
   */
  async add_objs(
    tableId: number,
    rows: { value: unknown }[],
  ): Promise<{ ids: string[] }> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    const ids: string[] = [];
    for (const row of rows) {
      assertGeneratedIdOnly(row);
      const id = this.generateId(state.info);
      await this.commitDocOp(state, 'ADD', id, row.value);
      ids.push(id);
    }
    return { ids };
  }

  /**
   * Handles update objects.
   * @param tableId Table identifier.
   * @param rows Rows to process.
   */
  async update_objs(
    tableId: number,
    rows: { id: string; patch: unknown; merge?: 'deep' | 'shallow' }[],
  ): Promise<void> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    for (const row of rows) {
      const current = state.docs.get(row.id);
      if (!current || current.deleted) {
        throw new Error(`Object ${row.id} does not exist`);
      }
      const merged =
        row.merge === 'shallow'
          ? shallowMerge(current.value, row.patch as Record<string, unknown>)
          : deepMerge(current.value, row.patch);
      await this.commitDocOp(state, 'UPDATE', row.id, row.patch, merged);
    }
  }

  /**
   * Handles replace objects.
   * @param tableId Table identifier.
   * @param rows Rows to process.
   */
  async replace_objs(
    tableId: number,
    rows: { id: string; value: unknown }[],
  ): Promise<void> {
    const state = this.requireTable(tableId);
    assertJsonTable(state);
    for (const row of rows) {
      await this.commitDocOp(state, 'REPLACE', row.id, row.value);
    }
  }

  /**
   * Removes objects.
   * @param tableId Table identifier.
   * @param ids Identifiers to process.
   */
  async delete_objs(tableId: number, ids: string[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const id of ids) {
      await this.commitDeleteOp(state, id);
    }
  }

  /**
   * Adds blob.
   * @param tableId Table identifier.
   * @param id Identifier to process.
   * @param bytes Binary payload bytes.
   * @param contentType Content type string.
   */
  async add_blob(
    tableId: number,
    id: string | null,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ id: string }> {
    const state = this.requireTable(tableId);
    const blobId = id ?? randomId('blob');
    const record: BlobRecord = {
      id: blobId,
      bytes: deepClone(bytes),
      contentType,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
    };
    state.blobs.set(blobId, record);
    await this.appendOp(state, {
      op_type: 'BLOB_ADD',
      id: blobId,
      payload: {
        bytes: bytesToBase64(bytes),
        contentType,
      },
    });
    return { id: blobId };
  }

  /**
   * Removes blobs.
   * @param tableId Table identifier.
   * @param ids Identifiers to process.
   */
  async delete_blobs(tableId: number, ids: string[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const id of ids) {
      state.blobs.delete(id);
      await this.appendOp(state, {
        op_type: 'BLOB_DEL',
        id,
        payload: null,
      });
    }
  }

  /**
   * Returns blob.
   * @param tableId Table identifier.
   * @param id Identifier to process.
   */
  async get_blob(
    tableId: number,
    id: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const state = this.requireTable(tableId);
    const blob = state.blobs.get(id);
    if (!blob) {
      throw new Error(`Blob ${id} not found`);
    }
    return { bytes: deepClone(blob.bytes), contentType: blob.contentType };
  }

  /**
   * Reads ops since.
   * @param tableId Table identifier.
   * @param after_seq Last applied sequence number.
   * @param limit Maximum number of rows.
   */
  async read_ops_since(
    tableId: number,
    after_seq: number,
    limit: number,
  ): Promise<Op[]> {
    const state = this.requireTable(tableId);
    return state.ops
      .filter((op) => op.op_seq > after_seq)
      .slice(0, limit)
      .map((op) => deepClone(op));
  }

  /**
   * Handles latest seq.
   * @param tableId Table identifier.
   */
  async latest_seq(tableId: number): Promise<number> {
    const state = this.requireTable(tableId);
    return state.latestSeq;
  }

  /**
   * Applies ops.
   * @param tableId Table identifier.
   * @param ops Operation records.
   */
  async apply_ops(tableId: number, ops: Op[]): Promise<void> {
    const state = this.requireTable(tableId);
    for (const op of ops) {
      if (op.op_seq <= state.latestSeq) {
        continue;
      }
      if (op.op_seq !== state.latestSeq + 1) {
        throw new Error(
          `Cannot apply out-of-order op ${op.op_seq} to table ${tableId}`,
        );
      }

      switch (op.op_type) {
        case 'ADD':
        case 'REPLACE': {
          this.writeDoc(state, op.id, op.payload, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: op.op_type === 'ADD' ? 'added' : 'updated',
            id: op.id,
            value: deepClone(op.payload),
          });
          break;
        }
        case 'UPDATE': {
          const current = state.docs.get(op.id);
          if (!current || current.deleted) {
            throw new Error(`Cannot apply UPDATE for missing object ${op.id}`);
          }
          const merged = deepMerge(current.value, op.payload);
          this.writeDoc(state, op.id, merged, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: 'updated',
            id: op.id,
            value: deepClone(merged),
          });
          break;
        }
        case 'DELETE': {
          this.writeTombstone(state, op.id, op.ts_ms);
          this.publishChange(state.info.tableId, {
            ts: op.ts_ms,
            op: 'deleted',
            id: op.id,
          });
          break;
        }
        case 'BLOB_ADD': {
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
        case 'BLOB_DEL': {
          state.blobs.delete(op.id);
          break;
        }
        case 'SCHEMA':
          break;
      }

      state.latestSeq = op.op_seq;
      state.ops.push(deepClone(op));
    }
  }

  /**
   * Runs retention.
   * @param nowMs Timestamp in milliseconds.
   */
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
        if (typeof fieldValue === 'number' && fieldValue < cutoff) {
          idsToDelete.push(row.id);
        }
      }

      for (const id of idsToDelete) {
        await this.commitDeleteOp(state, id);
      }

      if (
        idsToDelete.length > 0 ||
        !state.watermark?.localMinTimeMs ||
        cutoff > state.watermark.localMinTimeMs
      ) {
        state.watermark = { localMinTimeMs: cutoff };
      }
    }
  }

  /**
   * Returns watermark.
   * @param tableId Table identifier.
   */
  async get_watermark(tableId: number): Promise<Watermark | null> {
    const state = this.requireTable(tableId);
    return deepClone(state.watermark);
  }

  /**
   * Updates watermark.
   * @param tableId Table identifier.
   * @param wm Watermark value.
   */
  async set_watermark(tableId: number, wm: Watermark): Promise<void> {
    const state = this.requireTable(tableId);
    state.watermark = deepClone(wm);
  }

  /**
   * Exports snapshot.
   * @param options Operation options.
   */
  async export_snapshot(
    options: ExportSnapshotOptions,
  ): Promise<SnapshotManifest> {
    return exportSnapshotBundle(
      {
        backendName: 'memory',
        /**
         * Lists tables.
         */
        listTables: async () => this.list_tables(),
        /**
         * Exports table.
         * @param table Table descriptor.
         * @param selection Snapshot selection.
         */
        exportTable: async (table, selection) =>
          this.exportTableSnapshot(table, selection),
      },
      options,
    );
  }

  /**
   * Imports snapshot.
   * @param options Operation options.
   */
  async import_snapshot(
    options: ImportSnapshotOptions,
  ): Promise<SnapshotImportResult> {
    return importSnapshotBundle(
      {
        /**
         * Imports table.
         * @param table Table descriptor.
         * @param resolvedOptions Resolved options.
         */
        importTable: async (table, resolvedOptions) =>
          this.importTableSnapshot(table, resolvedOptions),
      },
      options,
    );
  }

  /**
   * Handles require table.
   * @param tableId Table identifier.
   */
  private requireTable(tableId: number): TableState {
    const state = this.tablesById.get(tableId);
    if (!state) {
      throw new Error(`Table ${tableId} does not exist`);
    }
    return state;
  }

  /**
   * Handles commit doc op.
   * @param state Internal state record.
   * @param opType Op type.
   * @param id Identifier to process.
   * @param payload Payload value.
   * @param replacement Replacement.
   */
  private async commitDocOp(
    state: TableState,
    opType: 'ADD' | 'UPDATE' | 'REPLACE',
    id: string,
    payload: unknown,
    replacement?: unknown,
  ): Promise<void> {
    const ts = Date.now();
    const value = opType === 'UPDATE' ? replacement : payload;
    this.writeDoc(state, id, value, ts);
    const op = await this.appendOp(state, {
      op_type: opType,
      id,
      payload,
      ts_ms: ts,
    });
    this.publishChange(state.info.tableId, {
      ts: op.ts_ms,
      op: opType === 'ADD' ? 'added' : 'updated',
      id,
      value: deepClone(value),
    });
  }

  /**
   * Handles commit delete op.
   * @param state Internal state record.
   * @param id Identifier to process.
   */
  private async commitDeleteOp(state: TableState, id: string): Promise<void> {
    const ts = Date.now();
    this.writeTombstone(state, id, ts);
    const op = await this.appendOp(state, {
      op_type: 'DELETE',
      id,
      payload: null,
      ts_ms: ts,
    });
    this.publishChange(state.info.tableId, {
      ts: op.ts_ms,
      op: 'deleted',
      id,
    });
  }

  /**
   * Writes doc.
   * @param state Internal state record.
   * @param id Identifier to process.
   * @param value Value to process.
   * @param updatedAtMs Timestamp in milliseconds.
   */
  private writeDoc(
    state: TableState,
    id: string,
    value: unknown,
    updatedAtMs: number,
  ): void {
    state.docs.set(id, {
      id,
      value: deepClone(value),
      deleted: false,
      updatedAtMs,
      etag: sha256Hex(JSON.stringify(value)),
    });
  }

  /**
   * Writes tombstone.
   * @param state Internal state record.
   * @param id Identifier to process.
   * @param updatedAtMs Timestamp in milliseconds.
   */
  private writeTombstone(
    state: TableState,
    id: string,
    updatedAtMs: number,
  ): void {
    const current = state.docs.get(id);
    state.docs.set(id, {
      id,
      value: current?.value ?? null,
      deleted: true,
      updatedAtMs,
      etag: current?.etag ?? randomId('etag'),
    });
  }

  /**
   * Handles append op.
   * @param state Internal state record.
   * @param partial Partial value.
   */
  private async appendOp(
    state: TableState,
    partial: Omit<Op, 'tableId' | 'op_seq' | 'ts_ms'> & { ts_ms?: number },
  ): Promise<Op> {
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

  /**
   * Publishes change.
   * @param tableId Table identifier.
   * @param evt Evt.
   */
  private publishChange(tableId: number, evt: ChangeEvent): void {
    this.changeBus.publish(tableId, evt);
  }

  /**
   * Handles generate id.
   * @param info Table metadata.
   */
  private generateId(info: TableInfo): string {
    return generateDistributedId(
      info.config.idPrefix ?? defaultIdPrefix(info.tableName),
      this.clusterShort,
    );
  }

  /**
   * Exports table snapshot.
   * @param table Table descriptor.
   * @param selection Snapshot selection.
   */
  private exportTableSnapshot(
    table: TableInfo,
    selection: SnapshotTableSelection,
  ): SnapshotExportTableData {
    const state = this.requireTable(table.tableId);
    const docs = this.selectSnapshotDocs(state, selection);
    const blobs = selection.includeBlobs
      ? [...state.blobs.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((blob) => ({
            id: blob.id,
            bytes: deepClone(blob.bytes),
            contentType: blob.contentType,
            sha256: blob.sha256,
            size: blob.size,
          }))
      : [];

    return {
      table: deepClone(state.info),
      selection: deepClone(selection),
      watermark: deepClone(state.watermark),
      docs,
      blobs,
    };
  }

  /**
   * Handles select snapshot docs.
   * @param state Internal state record.
   * @param selection Snapshot selection.
   */
  private selectSnapshotDocs(
    state: TableState,
    selection: SnapshotTableSelection,
  ): SnapshotDocRecord[] {
    if (selection.filter) {
      assertFilterSupported(state.info, selection.filter);
    }

    return [...state.docs.values()]
      .filter((row) => {
        if (row.deleted) {
          return !selection.filter && selection.includeTombstones;
        }
        if (!selection.filter) {
          return true;
        }
        const candidate = {
          id: row.id,
          ...(typeof row.value === 'object' && row.value !== null
            ? (row.value as object)
            : {}),
        };
        return matchesFilter(candidate, selection.filter);
      })
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => ({
        id: row.id,
        value: deepClone(row.value),
        meta: {
          updatedAtMs: row.updatedAtMs,
          etag: row.etag,
          deleted: row.deleted,
        },
      }));
  }

  /**
   * Imports table snapshot.
   * @param table Table descriptor.
   * @param options Operation options.
   */
  private async importTableSnapshot(
    table: SnapshotImportTableData,
    options: ResolvedSnapshotImportOptions,
  ): Promise<SnapshotImportTableResult> {
    const existing = await this.get_table_info(
      table.schema.app,
      table.schema.db,
      table.schema.tableName,
    );
    if (existing && existing.type !== table.schema.type) {
      throw new Error(
        `Cannot import ${table.schema.app}/${table.schema.db}/${table.schema.tableName}: local table type ${existing.type} does not match snapshot type ${table.schema.type}`,
      );
    }

    const info = await this.ensure_table(
      table.schema.app,
      table.schema.db,
      table.schema.tableName,
      table.schema.type,
    );
    const state = this.requireTable(info.tableId);

    if (options.mode === 'replace') {
      this.resetTableData(state);
    }

    state.info.config = deepClone(table.schema.config);

    let docsImported = 0;
    let tombstonesImported = 0;
    let blobsImported = 0;
    let docsSkipped = 0;
    let blobsSkipped = 0;

    for (const row of table.docs) {
      const outcome = await this.importSnapshotDoc(state, row, options);
      if (outcome === 'skipped') {
        docsSkipped += 1;
      } else if (row.meta.deleted) {
        tombstonesImported += 1;
      } else {
        docsImported += 1;
      }
    }

    for (const blob of table.blobs) {
      const outcome = await this.importSnapshotBlob(
        state,
        blob,
        table.bundleCreatedAtMs,
        options,
      );
      if (outcome === 'skipped') {
        blobsSkipped += 1;
      } else {
        blobsImported += 1;
      }
    }

    if (options.mode === 'replace') {
      state.watermark = deepClone(table.schema.watermark);
    } else {
      state.watermark = this.mergeWatermark(
        state.watermark,
        table.schema.watermark,
      );
    }

    return {
      createdTable: !existing,
      docsImported,
      tombstonesImported,
      blobsImported,
      docsSkipped,
      blobsSkipped,
    };
  }

  /**
   * Handles reset table data.
   * @param state Internal state record.
   */
  private resetTableData(state: TableState): void {
    state.docs.clear();
    state.blobs.clear();
    state.ops = [];
    state.latestSeq = 0;
    state.watermark = null;
  }

  /**
   * Merges watermark.
   * @param current Current value.
   * @param incoming Incoming value.
   */
  private mergeWatermark(
    current: Watermark | null,
    incoming: Watermark | null,
  ): Watermark | null {
    if (!current) {
      return deepClone(incoming);
    }
    if (!incoming) {
      return deepClone(current);
    }
    const currentValue = current.localMinTimeMs;
    const incomingValue = incoming.localMinTimeMs;
    if (currentValue === undefined) {
      return deepClone(incoming);
    }
    if (incomingValue === undefined) {
      return deepClone(current);
    }
    return { localMinTimeMs: Math.max(currentValue, incomingValue) };
  }

  /**
   * Imports snapshot doc.
   * @param state Internal state record.
   * @param row Row to process.
   * @param options Operation options.
   */
  private async importSnapshotDoc(
    state: TableState,
    row: SnapshotDocRecord,
    options: ResolvedSnapshotImportOptions,
  ): Promise<'imported' | 'skipped'> {
    const current = state.docs.get(row.id);
    if (current) {
      if (options.conflictMode === 'error') {
        throw new Error(`Snapshot import conflict on document ${row.id}`);
      }
      if (options.conflictMode === 'skip') {
        return 'skipped';
      }
    }

    if (row.meta.deleted) {
      state.docs.set(row.id, {
        id: row.id,
        value: deepClone(row.value),
        deleted: true,
        updatedAtMs: row.meta.updatedAtMs,
        etag: row.meta.etag,
      });
      await this.appendOp(state, {
        op_type: 'DELETE',
        id: row.id,
        payload: null,
        ts_ms: row.meta.updatedAtMs,
      });
      return 'imported';
    }

    state.docs.set(row.id, {
      id: row.id,
      value: deepClone(row.value),
      deleted: false,
      updatedAtMs: row.meta.updatedAtMs,
      etag: row.meta.etag,
    });
    await this.appendOp(state, {
      op_type: !current || current.deleted ? 'ADD' : 'REPLACE',
      id: row.id,
      payload: deepClone(row.value),
      ts_ms: row.meta.updatedAtMs,
    });
    return 'imported';
  }

  /**
   * Imports snapshot blob.
   * @param state Internal state record.
   * @param blob Blob.
   * @param tsMs Timestamp in milliseconds.
   * @param options Operation options.
   */
  private async importSnapshotBlob(
    state: TableState,
    blob: BlobRecord,
    tsMs: number,
    options: ResolvedSnapshotImportOptions,
  ): Promise<'imported' | 'skipped'> {
    const current = state.blobs.get(blob.id);
    if (current) {
      if (options.conflictMode === 'error') {
        throw new Error(`Snapshot import conflict on blob ${blob.id}`);
      }
      if (options.conflictMode === 'skip') {
        return 'skipped';
      }
    }

    state.blobs.set(blob.id, {
      id: blob.id,
      bytes: deepClone(blob.bytes),
      contentType: blob.contentType,
      sha256: blob.sha256,
      size: blob.size,
    });
    await this.appendOp(state, {
      op_type: 'BLOB_ADD',
      id: blob.id,
      payload: {
        bytes: bytesToBase64(blob.bytes),
        contentType: blob.contentType,
      },
      ts_ms: tsMs,
    });
    return 'imported';
  }
}
