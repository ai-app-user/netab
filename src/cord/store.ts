import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { CoordStore } from './types.js';
import type { StengApi } from '../steng/index.js';

/** Normalize persisted JSON into a plain record shape. */
function normalizeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** In-memory coord store used by tests and transient runtimes. */
export class MemoryStore implements CoordStore {
  private readonly values = new Map<string, unknown>();

  /** Read one stored key, returning a detached clone when present. */
  async get(key: string): Promise<unknown | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  /** Insert or replace one stored key. */
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  /** Remove one stored key if it exists. */
  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  /** List all keys under a prefix in lexical order. */
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

/** JSON-file coord store with a simple advisory lock for multi-process access. */
export class FileJsonStore implements CoordStore {
  private readonly lockFilename: string;

  constructor(private readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.lockFilename = `${filename}.lock`;
  }

  /** Read one key from the latest on-disk snapshot. */
  async get(key: string): Promise<unknown | null> {
    const state = await this.loadFresh();
    return key in state ? structuredClone(state[key]) : null;
  }

  /** Replace one key and atomically rewrite the JSON file. */
  async set(key: string, value: unknown): Promise<void> {
    await this.withLock(async (state) => {
      state[key] = structuredClone(value);
      await this.save(state);
    });
  }

  /** Delete one key and atomically rewrite the JSON file. */
  async del(key: string): Promise<void> {
    await this.withLock(async (state) => {
      delete state[key];
      await this.save(state);
    });
  }

  /** List a prefix from the latest on-disk snapshot. */
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const state = await this.loadFresh();
    return Object.entries(state)
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }

  /** Reload the JSON file, tolerating transient rename and partial-write windows. */
  private async loadFresh(): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!existsSync(this.filename)) {
        return {};
      }
      try {
        const content = await readFile(this.filename, 'utf8');
        return normalizeRecord(content.trim() ? JSON.parse(content) : {});
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          if (attempt === 4) {
            return {};
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (!(error instanceof SyntaxError) || attempt === 4) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return {};
  }

  /** Persist one complete JSON snapshot using rename-based atomic replacement. */
  private async save(state: Record<string, unknown>): Promise<void> {
    const tempFilename = `${this.filename}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(
      tempFilename,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
    await rename(tempFilename, this.filename);
  }

  /** Run a state mutation while holding the store's advisory lock file. */
  private async withLock<T>(
    fn: (state: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const handle = await this.acquireLock();
    try {
      const state = await this.loadFresh();
      return await fn(state);
    } finally {
      await handle.close();
      await unlink(this.lockFilename).catch(() => {});
    }
  }

  /** Spin until the lock file can be created exclusively. */
  private async acquireLock() {
    for (;;) {
      try {
        return await open(this.lockFilename, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}

type StengCoordStoreOptions = {
  /** App namespace used for the backing `steng` table. */
  app?: string;
  /** Logical db namespace used for the backing `steng` table. */
  db?: string;
  /** Table name used for the backing `steng` table. */
  tableName?: string;
};

/**
 * Adapter that stores coord KV entries inside one `steng` JSON table.
 *
 * This keeps `coord` decoupled from the concrete backend choice while allowing
 * the runtime to reuse `steng` SQLite/Postgres implementations for durable
 * state. Keys are stored inside the JSON payload and indexed by the `key`
 * field so `get`/`list(prefix)` remain backend-independent.
 */
export class StengCoordStore implements CoordStore {
  private tableIdPromise: Promise<number> | null = null;

  constructor(
    private readonly steng: StengApi,
    private readonly options: StengCoordStoreOptions = {},
  ) {}

  /** Read one coord key from the backing `steng` table. */
  async get(key: string): Promise<unknown | null> {
    try {
      const rows = await this.findRows(key);
      if (rows.length === 0) {
        return null;
      }
      if (rows.length > 1) {
        await this.deleteDuplicateRows(rows.slice(1));
      }
      return structuredClone(
        (rows[0].value as { value?: unknown }).value ?? null,
      );
    } catch (error) {
      throw new Error(
        `coord steng store get(${key}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Insert or replace one coord key inside the backing `steng` table. */
  async set(key: string, value: unknown): Promise<void> {
    try {
      const tableId = await this.tableId();
      const rows = await this.findRows(key);
      if (rows.length === 0) {
        await this.steng.add_obj(tableId, {
          key,
          value: structuredClone(value),
        });
        return;
      }
      await this.steng.replace_objs(tableId, [
        {
          id: rows[0].id,
          value: {
            key,
            value: structuredClone(value),
          },
        },
      ]);
      if (rows.length > 1) {
        await this.deleteDuplicateRows(rows.slice(1));
      }
    } catch (error) {
      throw new Error(
        `coord steng store set(${key}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Delete one coord key and all duplicate rows that happen to exist. */
  async del(key: string): Promise<void> {
    try {
      const rows = await this.findRows(key);
      if (rows.length === 0) {
        return;
      }
      await this.steng.delete_objs(
        await this.tableId(),
        rows.map((row) => row.id),
      );
    } catch (error) {
      throw new Error(
        `coord steng store del(${key}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** List keys by prefix using the indexed `key` field inside the backing table. */
  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    try {
      const tableId = await this.tableId();
      const rows: Array<{ key: string; value: unknown }> = [];
      let start = 0;
      for (;;) {
        const page = await this.steng.get_objs(
          tableId,
          null,
          prefix.length === 0 ? null : [['key', 'prefix', prefix]],
          start,
          500,
        );
        for (const item of page.items) {
          if (
            item.miss ||
            !item.value ||
            typeof item.value !== 'object' ||
            Array.isArray(item.value)
          ) {
            continue;
          }
          const record = item.value as { key?: unknown; value?: unknown };
          if (typeof record.key !== 'string') {
            continue;
          }
          rows.push({
            key: record.key,
            value: structuredClone(record.value),
          });
        }
        if (page.items.length === 0 || page.next_pos <= start) {
          break;
        }
        start = page.next_pos;
      }
      return rows.sort((left, right) => left.key.localeCompare(right.key));
    } catch (error) {
      throw new Error(
        `coord steng store list(${prefix}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Lazily create or open the backing table and cache its numeric id. */
  private async tableId(): Promise<number> {
    if (!this.tableIdPromise) {
      this.tableIdPromise = (async () => {
        const table = await this.steng.ensure_table(
          this.options.app ?? 'cord',
          this.options.db ?? 'runtime',
          this.options.tableName ?? 'coord_store',
          'json',
        );
        await this.steng.add_index(table.tableId, 'key', 'str');
        return table.tableId;
      })();
    }
    return this.tableIdPromise;
  }

  /** Query up to a small batch of rows sharing the same coord key. */
  private async findRows(
    key: string,
  ): Promise<Array<{ id: string; value: unknown }>> {
    const tableId = await this.tableId();
    const page = await this.steng.get_objs(
      tableId,
      null,
      [['key', '==', key]],
      0,
      10,
    );
    return page.items
      .filter((item) => !item.miss)
      .map((item) => ({
        id: item.id,
        value: structuredClone(item.value),
      }));
  }

  /** Delete redundant duplicate rows that can appear after interrupted migrations. */
  private async deleteDuplicateRows(
    rows: Array<{ id: string }>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.steng.delete_objs(
      await this.tableId(),
      rows.map((row) => row.id),
    );
  }
}
