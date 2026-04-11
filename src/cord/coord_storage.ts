import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Steng } from '../steng/index.js';
import type {
  CoordStorageBackend,
  CoordStorageInfo,
  CoordStoragePolicy,
  CoordStorageTarget,
  CoordStore,
} from './types.js';
import { FileJsonStore, StengCoordStore } from './store.js';

type CoordStorageConfig = {
  version: 1;
  policy: CoordStoragePolicy;
  current: CoordStorageTarget;
  preferredBackend?: CoordStorageBackend;
  fallback?: CoordStorageTarget;
  note?: string;
};

/** Files that define one coord root's durable storage configuration. */
export type CoordStorageFiles = {
  rootDir: string;
  configPath: string;
  filePath: string;
  sqlitePath: string;
};

/** Open store handle plus metadata about how it was provisioned. */
export type CoordStorageHandle = {
  store: CoordStore;
  info: CoordStorageInfo;
  cleanup: () => Promise<void>;
  config: CoordStorageConfig;
};

/** Operator request passed to `-stor` when switching backends. */
export type CoordStorageSwitchRequest = {
  backend: CoordStorageBackend;
  location?: string;
  schema?: string;
};

/** Result returned after a successful backend migration or no-op switch. */
export type CoordStorageSwitchResult = {
  from: CoordStorageInfo;
  to: CoordStorageInfo;
  migratedKeys: number;
  changed: boolean;
};

const STORAGE_CONFIG_FILE = 'coord.storage.json';
const SQLITE_STORE_FILE = 'coord.store.sqlite';
const JSON_STORE_FILE = 'coord.store.json';

/**
 * Return the default storage metadata and data file locations for one coord root.
 */
export function defaultCoordStorageFiles(rootDir: string): CoordStorageFiles {
  return {
    rootDir,
    configPath: join(rootDir, STORAGE_CONFIG_FILE),
    filePath: join(rootDir, JSON_STORE_FILE),
    sqlitePath: join(rootDir, SQLITE_STORE_FILE),
  };
}

/**
 * Open the durable coord store for the given root.
 *
 * Auto policy prefers SQLite, falls back to the JSON-file store when SQLite
 * cannot be opened, and can later promote that fallback back into SQLite.
 */
export async function openCoordStorage(
  files: CoordStorageFiles,
  options: { allowAutoUpgrade?: boolean } = {},
): Promise<CoordStorageHandle> {
  let config = await loadStorageConfig(files);
  if (!config) {
    config = await initializeAutoStorage(files);
  }

  if (
    config.policy === 'auto' &&
    options.allowAutoUpgrade &&
    config.current.backend === 'file' &&
    config.preferredBackend === 'sqlite'
  ) {
    config = await maybePromoteAutoFileStore(files, config);
  }

  try {
    return await openHandle(files, config);
  } catch (error) {
    if (config.policy !== 'auto' || config.current.backend === 'file') {
      throw error;
    }

    const fallback = {
      version: 1,
      policy: 'auto',
      current: defaultFileTarget(files),
      preferredBackend: config.preferredBackend ?? 'sqlite',
      fallback: config.current,
      note: `sqlite unavailable, using file fallback: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CoordStorageConfig;
    await saveStorageConfig(files, fallback);
    return openHandle(files, fallback);
  }
}

/**
 * Inspect the current durable storage choice without touching runtime state.
 */
export async function inspectCoordStorage(
  files: CoordStorageFiles,
): Promise<CoordStorageInfo> {
  const handle = await openCoordStorage(files, { allowAutoUpgrade: false });
  try {
    return handle.info;
  } finally {
    await handle.cleanup();
  }
}

/**
 * Migrate the durable coord store to another backend and persist that choice.
 */
export async function switchCoordStorage(
  files: CoordStorageFiles,
  request: CoordStorageSwitchRequest,
): Promise<CoordStorageSwitchResult> {
  const current = await openCoordStorage(files, { allowAutoUpgrade: false });
  try {
    const nextTarget = normalizeSwitchTarget(files, request);
    const currentTarget = current.config.current;

    if (
      sameTarget(currentTarget, nextTarget) &&
      current.config.policy === 'explicit'
    ) {
      return {
        from: current.info,
        to: current.info,
        migratedKeys: 0,
        changed: false,
      };
    }

    if (sameTarget(currentTarget, nextTarget)) {
      const explicitConfig: CoordStorageConfig = {
        version: 1,
        policy: 'explicit',
        current: nextTarget,
      };
      await saveStorageConfig(files, explicitConfig);
      return {
        from: current.info,
        to: buildStorageInfo(files, explicitConfig),
        migratedKeys: 0,
        changed: true,
      };
    }

    const nextHandle = await openHandle(files, {
      version: 1,
      policy: 'explicit',
      current: nextTarget,
    });
    try {
      const entries = await current.store.list('');
      await clearStore(nextHandle.store);
      for (const entry of entries) {
        await nextHandle.store.set(entry.key, entry.value);
      }
      const explicitConfig: CoordStorageConfig = {
        version: 1,
        policy: 'explicit',
        current: nextTarget,
      };
      await saveStorageConfig(files, explicitConfig);
      return {
        from: current.info,
        to: buildStorageInfo(files, explicitConfig),
        migratedKeys: entries.length,
        changed: true,
      };
    } finally {
      await nextHandle.cleanup();
    }
  } finally {
    await current.cleanup();
  }
}

/**
 * Returns the default SQLite target.
 * @param files Files.
 */
function defaultSqliteTarget(files: CoordStorageFiles): CoordStorageTarget {
  return {
    backend: 'sqlite',
    location: files.sqlitePath,
  };
}

/** Default file fallback used when SQLite is unavailable. */
function defaultFileTarget(files: CoordStorageFiles): CoordStorageTarget {
  return {
    backend: 'file',
    location: files.filePath,
  };
}

/** Normalize operator input into a concrete durable backend target. */
function normalizeSwitchTarget(
  files: CoordStorageFiles,
  request: CoordStorageSwitchRequest,
): CoordStorageTarget {
  if (request.backend === 'sqlite') {
    return {
      backend: 'sqlite',
      location: request.location ? resolve(request.location) : files.sqlitePath,
    };
  }
  if (request.backend === 'file') {
    return {
      backend: 'file',
      location: request.location ? resolve(request.location) : files.filePath,
    };
  }
  return {
    backend: 'psql',
    location: request.location ?? '',
    schema: request.schema ?? defaultPostgresSchema(files.rootDir),
  };
}

/** Derive a deterministic Postgres schema name from the coord root path. */
function defaultPostgresSchema(rootDir: string): string {
  const raw = basename(rootDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const tail = raw.length > 0 ? raw : 'root';
  return `coord_${tail}`.slice(0, 48);
}

/** Compare durable targets by backend and concrete location. */
function sameTarget(
  left: CoordStorageTarget,
  right: CoordStorageTarget,
): boolean {
  return (
    left.backend === right.backend &&
    left.location === right.location &&
    left.schema === right.schema
  );
}

/** Convert internal config into the public-facing storage status payload. */
function buildStorageInfo(
  files: CoordStorageFiles,
  config: CoordStorageConfig,
): CoordStorageInfo {
  return {
    rootDir: files.rootDir,
    policy: config.policy,
    backend: config.current.backend,
    location: config.current.location,
    schema: config.current.schema,
    status:
      config.preferredBackend &&
      config.preferredBackend !== config.current.backend
        ? 'fallback'
        : 'healthy',
    preferredBackend: config.preferredBackend,
    fallback: config.fallback,
    note: config.note,
  };
}

/** Open one already-resolved storage target and package it with metadata. */
async function openHandle(
  files: CoordStorageFiles,
  config: CoordStorageConfig,
): Promise<CoordStorageHandle> {
  const resolved = await openTarget(config.current);
  return {
    store: resolved.store,
    cleanup: resolved.cleanup,
    info: buildStorageInfo(files, config),
    config,
  };
}

/** Instantiate the concrete store implementation for one durable target. */
async function openTarget(
  target: CoordStorageTarget,
): Promise<{ store: CoordStore; cleanup: () => Promise<void> }> {
  if (target.backend === 'file') {
    await ensureParent(target.location);
    return {
      store: new FileJsonStore(target.location),
      /**
       * Handles cleanup.
       */
      cleanup: async () => {},
    };
  }
  if (target.backend === 'sqlite') {
    await ensureParent(target.location);
  }

  const steng = new Steng(
    target.backend === 'sqlite'
      ? {
          backend: 'sqlite',
          clusterShort: 'cord',
          sqlite: {
            filename: target.location,
          },
        }
      : {
          backend: 'postgres',
          clusterShort: 'cord',
          postgres: {
            connectionString: target.location,
            schema: target.schema,
          },
        },
  );
  const store = new StengCoordStore(steng);
  await store.list('');

  return {
    store,
    /**
     * Handles cleanup.
     */
    cleanup: async () => {
      await steng.close();
    },
  };
}

/** Remove all existing keys before copying data into a new backend. */
async function clearStore(store: CoordStore): Promise<void> {
  const entries = await store.list('');
  for (const entry of entries) {
    await store.del(entry.key);
  }
}

/** Try to move an auto-policy file fallback back into SQLite once SQLite works again. */
async function maybePromoteAutoFileStore(
  files: CoordStorageFiles,
  config: CoordStorageConfig,
): Promise<CoordStorageConfig> {
  const sourceHandle = await openHandle(files, config);
  try {
    const promotedConfig: CoordStorageConfig = {
      version: 1,
      policy: 'auto',
      current: defaultSqliteTarget(files),
      preferredBackend: 'sqlite',
      fallback: defaultFileTarget(files),
      note: 'promoted file fallback back to sqlite',
    };
    const targetHandle = await openHandle(files, promotedConfig);
    try {
      const entries = await sourceHandle.store.list('');
      await clearStore(targetHandle.store);
      for (const entry of entries) {
        await targetHandle.store.set(entry.key, entry.value);
      }
      await saveStorageConfig(files, promotedConfig);
      return promotedConfig;
    } finally {
      await targetHandle.cleanup();
    }
  } catch {
    return config;
  } finally {
    await sourceHandle.cleanup();
  }
}

/** Create a fresh auto-policy config, preferring SQLite and falling back to file storage. */
async function initializeAutoStorage(
  files: CoordStorageFiles,
): Promise<CoordStorageConfig> {
  const preferred = {
    version: 1,
    policy: 'auto',
    current: defaultSqliteTarget(files),
    preferredBackend: 'sqlite',
    fallback: defaultFileTarget(files),
  } satisfies CoordStorageConfig;

  try {
    const handle = await openHandle(files, preferred);
    await handle.cleanup();
    await saveStorageConfig(files, preferred);
    return preferred;
  } catch (error) {
    const fallback = {
      version: 1,
      policy: 'auto',
      current: defaultFileTarget(files),
      preferredBackend: 'sqlite',
      note: `sqlite unavailable, using file fallback: ${error instanceof Error ? error.message : String(error)}`,
    } satisfies CoordStorageConfig;
    await saveStorageConfig(files, fallback);
    return fallback;
  }
}

/** Load and normalize the persisted storage config if one already exists. */
async function loadStorageConfig(
  files: CoordStorageFiles,
): Promise<CoordStorageConfig | null> {
  if (!existsSync(files.configPath)) {
    return null;
  }
  const raw = await readJsonFile<CoordStorageConfig | null>(
    files.configPath,
    null,
  );
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.current.backend === 'sqlite' || raw.current.backend === 'file') {
    raw.current.location = resolve(raw.current.location);
  }
  if (
    raw.fallback &&
    (raw.fallback.backend === 'sqlite' || raw.fallback.backend === 'file')
  ) {
    raw.fallback.location = resolve(raw.fallback.location);
  }
  return raw;
}

/** Persist the current durable storage config. */
async function saveStorageConfig(
  files: CoordStorageFiles,
  config: CoordStorageConfig,
): Promise<void> {
  await writeJsonFile(files.configPath, config);
}

/** Read one small JSON helper file with a typed fallback. */
async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) {
    return fallback;
  }
  const content = await readFile(path, 'utf8');
  return (content.trim() ? JSON.parse(content) : fallback) as T;
}

/** Write one small JSON helper file, creating its parent directory on demand. */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureParent(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Ensure the parent directory for one file path exists. */
async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
