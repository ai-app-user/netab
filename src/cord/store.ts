import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { CoordStore } from "./types.js";

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export class MemoryStore implements CoordStore {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }
}

export class FileJsonStore implements CoordStore {
  private readonly lockFilename: string;

  constructor(private readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.lockFilename = `${filename}.lock`;
  }

  async get(key: string): Promise<unknown | null> {
    const state = await this.loadFresh();
    return key in state ? structuredClone(state[key]) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.withLock(async (state) => {
      state[key] = structuredClone(value);
      await this.save(state);
    });
  }

  async del(key: string): Promise<void> {
    await this.withLock(async (state) => {
      delete state[key];
      await this.save(state);
    });
  }

  async list(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const state = await this.loadFresh();
    return Object.entries(state)
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value: structuredClone(value) }));
  }

  private async loadFresh(): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!existsSync(this.filename)) {
        return {};
      }
      try {
        const content = await readFile(this.filename, "utf8");
        return normalizeRecord(content.trim() ? JSON.parse(content) : {});
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
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

  private async save(state: Record<string, unknown>): Promise<void> {
    const tempFilename = `${this.filename}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempFilename, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempFilename, this.filename);
  }

  private async withLock<T>(fn: (state: Record<string, unknown>) => Promise<T>): Promise<T> {
    const handle = await this.acquireLock();
    try {
      const state = await this.loadFresh();
      return await fn(state);
    } finally {
      await handle.close();
      await unlink(this.lockFilename).catch(() => {});
    }
  }

  private async acquireLock() {
    for (;;) {
      try {
        return await open(this.lockFilename, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}
