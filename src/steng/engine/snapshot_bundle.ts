import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { deepClone, sha256Hex } from '../../shared/utils.js';
import type {
  ExportSnapshotOptions,
  ImportSnapshotConflictMode,
  ImportSnapshotMode,
  ImportSnapshotOptions,
  SnapshotBlobRecord,
  SnapshotDocRecord,
  SnapshotFormat,
  SnapshotImportResult,
  SnapshotManifest,
  SnapshotScope,
  SnapshotTableManifest,
  SnapshotTableSchema,
  SnapshotTableSelection,
  TableInfo,
  Watermark,
} from '../types.js';

type TarModule = {
  /**
   * Handles c.
   * @param options Operation options.
   * @param files Files.
   */
  c(
    options: { cwd: string; file: string; gzip?: boolean },
    files: string[],
  ): Promise<void>;
  /**
   * Handles x.
   * @param options Operation options.
   */
  x(options: {
    cwd: string;
    file: string;
    gzip?: boolean;
    filter?: (path: string) => boolean;
  }): Promise<void>;
};

type SnapshotExportBlob = {
  id: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  size: number;
};

type SnapshotResolvedSelection = {
  table: TableInfo;
  selection: SnapshotTableSelection;
};

type SnapshotImportBlob = SnapshotBlobRecord & {
  bytes: Uint8Array;
};

export type SnapshotExportTableData = {
  table: TableInfo;
  selection: SnapshotTableSelection;
  watermark: Watermark | null;
  docs: SnapshotDocRecord[];
  blobs: SnapshotExportBlob[];
};

export type SnapshotImportTableData = {
  schema: SnapshotTableSchema;
  docs: SnapshotDocRecord[];
  blobs: SnapshotImportBlob[];
  bundleCreatedAtMs: number;
};

export type SnapshotImportTableResult = {
  createdTable: boolean;
  docsImported: number;
  tombstonesImported: number;
  blobsImported: number;
  docsSkipped: number;
  blobsSkipped: number;
};

export type ResolvedSnapshotImportOptions = {
  mode: ImportSnapshotMode;
  conflictMode: ImportSnapshotConflictMode;
};

export interface SnapshotExportBackend {
  backendName: SnapshotManifest['sourceBackend'];
  /**
   * Lists tables.
   */
  listTables(): Promise<TableInfo[]>;
  /**
   * Exports table.
   * @param table Table descriptor.
   * @param selection Snapshot selection.
   */
  exportTable(
    table: TableInfo,
    selection: SnapshotTableSelection,
  ): Promise<SnapshotExportTableData>;
}

export interface SnapshotImportBackend {
  /**
   * Imports table.
   * @param table Table descriptor.
   * @param options Operation options.
   */
  importTable(
    table: SnapshotImportTableData,
    options: ResolvedSnapshotImportOptions,
  ): Promise<SnapshotImportTableResult>;
}

const require = createRequire(import.meta.url);
const tar = require('tar') as TarModule;
const SNAPSHOT_VERSION: SnapshotManifest['formatVersion'] = 'steng.snapshot.v1';

/**
 * Handles bundle join.
 * @param parts Parts.
 */
function bundleJoin(...parts: string[]): string {
  return posix.join(...parts);
}

/**
 * Handles encode path segment.
 * @param value Value to process.
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Resolves bundle path.
 * @param rootPath Root path to use.
 * @param relativePath Path relative to the bundle root.
 */
function resolveBundlePath(rootPath: string, relativePath: string): string {
  return join(rootPath, ...relativePath.split('/'));
}

/**
 * Handles table key.
 * @param app Application name.
 * @param db Database name.
 * @param tableName Table name.
 */
function tableKey(app: string, db: string, tableName: string): string {
  return `${app}::${db}::${tableName}`;
}

/**
 * Returns whether this has scoped selectors.
 * @param scope Scope selector.
 */
function hasScopedSelectors(scope: SnapshotScope | undefined): boolean {
  return Boolean(
    scope?.apps?.length || scope?.dbs?.length || scope?.tables?.length,
  );
}

/**
 * Resolves snapshot format.
 * @param path Filesystem path.
 * @param explicit Explicit value from the caller.
 */
function resolveSnapshotFormat(
  path: string,
  explicit: SnapshotFormat | undefined,
): SnapshotFormat {
  if (explicit) {
    return explicit;
  }
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) {
    return 'tar.gz';
  }
  if (path.endsWith('.tar')) {
    return 'tar';
  }
  return 'directory';
}

/**
 * Returns the default table selection.
 * @param options Operation options.
 */
function defaultTableSelection(
  options: ExportSnapshotOptions,
): SnapshotTableSelection {
  return {
    filter: null,
    includeBlobs: options.includeBlobs ?? true,
    includeTombstones: options.includeTombstones ?? true,
  };
}

/**
 * Handles table selection from defaults.
 * @param defaults Defaults.
 * @param override Override.
 */
function tableSelectionFromDefaults(
  defaults: SnapshotTableSelection,
  override?: {
    filter?: SnapshotTableSelection['filter'];
    includeBlobs?: boolean;
    includeTombstones?: boolean;
  },
): SnapshotTableSelection {
  const filter = override?.filter ?? defaults.filter;
  return {
    filter,
    includeBlobs: override?.includeBlobs ?? defaults.includeBlobs,
    includeTombstones: filter
      ? false
      : (override?.includeTombstones ?? defaults.includeTombstones),
  };
}

/**
 * Handles matches coarse scope.
 * @param info Table metadata.
 * @param scope Scope selector.
 */
function matchesCoarseScope(info: TableInfo, scope: SnapshotScope): boolean {
  const appMatch = !scope.apps?.length || scope.apps.includes(info.app);
  const dbMatch = !scope.dbs?.length || scope.dbs.includes(info.db);
  return appMatch && dbMatch;
}

/**
 * Resolves selections.
 * @param tables Table descriptors.
 * @param options Operation options.
 */
function resolveSelections(
  tables: TableInfo[],
  options: ExportSnapshotOptions,
): SnapshotResolvedSelection[] {
  const defaults = defaultTableSelection(options);
  const selected = new Map<string, SnapshotResolvedSelection>();

  if (!hasScopedSelectors(options.scope)) {
    for (const table of tables) {
      selected.set(tableKey(table.app, table.db, table.tableName), {
        table,
        selection: defaults,
      });
    }
  } else if (options.scope) {
    for (const table of tables) {
      if (matchesCoarseScope(table, options.scope)) {
        selected.set(tableKey(table.app, table.db, table.tableName), {
          table,
          selection: defaults,
        });
      }
    }

    for (const selector of options.scope.tables ?? []) {
      const table = tables.find(
        (candidate) =>
          candidate.app === selector.app &&
          candidate.db === selector.db &&
          candidate.tableName === selector.tableName,
      );
      if (!table) {
        throw new Error(
          `Snapshot export table ${selector.app}/${selector.db}/${selector.tableName} does not exist`,
        );
      }

      selected.set(tableKey(table.app, table.db, table.tableName), {
        table,
        selection: tableSelectionFromDefaults(defaults, {
          filter: selector.filter ?? null,
          includeBlobs: selector.includeBlobs,
          includeTombstones: selector.includeTombstones,
        }),
      });
    }
  }

  return [...selected.values()].sort((left, right) =>
    tableKey(left.table.app, left.table.db, left.table.tableName).localeCompare(
      tableKey(right.table.app, right.table.db, right.table.tableName),
    ),
  );
}

/**
 * Handles path exists.
 * @param path Filesystem path.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Ensures empty directory.
 * @param path Filesystem path.
 */
async function ensureEmptyDirectory(path: string): Promise<void> {
  if (await pathExists(path)) {
    const status = await stat(path);
    if (!status.isDirectory()) {
      throw new Error(`Snapshot output ${path} exists and is not a directory`);
    }
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(`Snapshot output directory ${path} must be empty`);
    }
    return;
  }

  await mkdir(path, { recursive: true });
}

/**
 * Ensures missing file.
 * @param path Filesystem path.
 */
async function ensureMissingFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (await pathExists(path)) {
    throw new Error(`Snapshot output file ${path} already exists`);
  }
}

/**
 * Writes JSON file.
 * @param path Filesystem path.
 * @param value Value to process.
 */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Writes NDJSON file.
 * @param path Filesystem path.
 * @param rows Rows to process.
 */
async function writeNdjsonFile(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content =
    rows.length > 0
      ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
      : '';
  await writeFile(path, content, 'utf8');
}

/**
 * Reads JSON file.
 * @param path Filesystem path.
 */
async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Reads NDJSON file.
 * @param path Filesystem path.
 */
async function readNdjsonFile<T>(path: string): Promise<T[]> {
  if (!(await pathExists(path))) {
    return [];
  }
  const content = await readFile(path, 'utf8');
  if (!content.trim()) {
    return [];
  }
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Handles safe archive path.
 * @param entryPath Entry path.
 */
function safeArchivePath(entryPath: string): boolean {
  const normalized = posix.normalize(entryPath);
  if (normalized === '.' || normalized === '') {
    return true;
  }
  return (
    !normalized.startsWith('../') &&
    !normalized.startsWith('/') &&
    normalized !== '..'
  );
}

/**
 * Handles prepare export root.
 * @param outputPath Output path.
 * @param format Snapshot format.
 */
async function prepareExportRoot(
  outputPath: string,
  format: SnapshotFormat,
): Promise<{ rootPath: string; cleanupPath: string | null }> {
  if (format === 'directory') {
    await ensureEmptyDirectory(outputPath);
    return { rootPath: outputPath, cleanupPath: null };
  }

  await ensureMissingFile(outputPath);
  const rootPath = await mkdtemp(join(tmpdir(), 'steng-snapshot-export-'));
  return { rootPath, cleanupPath: rootPath };
}

/**
 * Handles prepare import root.
 * @param inputPath Input path.
 * @param format Snapshot format.
 */
async function prepareImportRoot(
  inputPath: string,
  format: SnapshotFormat,
): Promise<{ rootPath: string; cleanupPath: string | null }> {
  if (!(await pathExists(inputPath))) {
    throw new Error(`Snapshot input ${inputPath} does not exist`);
  }

  if (format === 'directory') {
    const status = await stat(inputPath);
    if (!status.isDirectory()) {
      throw new Error(`Snapshot input ${inputPath} must be a directory`);
    }
    return { rootPath: inputPath, cleanupPath: null };
  }

  const rootPath = await mkdtemp(join(tmpdir(), 'steng-snapshot-import-'));
  await tar.x({
    cwd: rootPath,
    file: inputPath,
    gzip: format === 'tar.gz',
    filter: safeArchivePath,
  });
  return { rootPath, cleanupPath: rootPath };
}

/**
 * Validates snapshot version.
 * @param manifest Snapshot manifest.
 */
function assertSnapshotVersion(manifest: SnapshotManifest): void {
  if (manifest.formatVersion !== SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported snapshot format version ${manifest.formatVersion}`,
    );
  }
}

/**
 * Validates schema matches manifest.
 * @param schema Snapshot table schema.
 * @param manifest Snapshot manifest.
 */
function assertSchemaMatchesManifest(
  schema: SnapshotTableSchema,
  manifest: SnapshotTableManifest,
): void {
  if (
    schema.app !== manifest.app ||
    schema.db !== manifest.db ||
    schema.tableName !== manifest.tableName ||
    schema.type !== manifest.type ||
    schema.sourceTableId !== manifest.sourceTableId
  ) {
    throw new Error(
      `Snapshot table schema mismatch for ${manifest.app}/${manifest.db}/${manifest.tableName}`,
    );
  }
}

/**
 * Exports snapshot bundle.
 * @param backend Backend.
 * @param options Operation options.
 */
export async function exportSnapshotBundle(
  backend: SnapshotExportBackend,
  options: ExportSnapshotOptions,
): Promise<SnapshotManifest> {
  const format = resolveSnapshotFormat(options.outputPath, options.format);
  const prepared = await prepareExportRoot(options.outputPath, format);

  try {
    const tables = await backend.listTables();
    const selections = resolveSelections(tables, options);
    const manifestTables: SnapshotTableManifest[] = [];
    const totals = {
      tables: 0,
      docs: 0,
      tombstones: 0,
      blobs: 0,
      blobBytes: 0,
    };
    const createdAtMs = Date.now();

    for (const resolved of selections) {
      const exported = await backend.exportTable(
        resolved.table,
        resolved.selection,
      );
      const tableDir = bundleJoin(
        'tables',
        encodePathSegment(exported.table.app),
        encodePathSegment(exported.table.db),
        encodePathSegment(exported.table.tableName),
      );
      const schemaPath = bundleJoin(tableDir, 'schema.json');
      const docsPath = bundleJoin(tableDir, 'docs.ndjson');
      const blobsPath = exported.selection.includeBlobs
        ? bundleJoin(tableDir, 'blobs.ndjson')
        : undefined;

      const schema: SnapshotTableSchema = {
        app: exported.table.app,
        db: exported.table.db,
        tableName: exported.table.tableName,
        sourceTableId: exported.table.tableId,
        type: exported.table.type,
        config: deepClone(exported.table.config),
        watermark: deepClone(exported.watermark),
        selection: deepClone(exported.selection),
      };

      const docs = [...exported.docs].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const blobs = [...exported.blobs].sort((left, right) =>
        left.id.localeCompare(right.id),
      );

      await writeJsonFile(
        resolveBundlePath(prepared.rootPath, schemaPath),
        schema,
      );
      await writeNdjsonFile(
        resolveBundlePath(prepared.rootPath, docsPath),
        docs,
      );

      const blobRows: SnapshotBlobRecord[] = [];
      for (const blob of blobs) {
        if (sha256Hex(blob.bytes) !== blob.sha256) {
          throw new Error(
            `Blob ${blob.id} in ${exported.table.app}/${exported.table.db}/${exported.table.tableName} has an invalid sha256`,
          );
        }
        if (blob.bytes.byteLength !== blob.size) {
          throw new Error(
            `Blob ${blob.id} in ${exported.table.app}/${exported.table.db}/${exported.table.tableName} has an invalid size`,
          );
        }

        const blobPath = bundleJoin(
          'blobs',
          'sha256',
          blob.sha256.slice(0, 2),
          blob.sha256.slice(2, 4),
          `${blob.sha256}.bin`,
        );
        const absoluteBlobPath = resolveBundlePath(prepared.rootPath, blobPath);
        if (!(await pathExists(absoluteBlobPath))) {
          await mkdir(dirname(absoluteBlobPath), { recursive: true });
          await writeFile(absoluteBlobPath, Buffer.from(blob.bytes));
        }
        blobRows.push({
          id: blob.id,
          contentType: blob.contentType,
          sha256: blob.sha256,
          size: blob.size,
          path: blobPath,
        });
      }

      if (blobsPath) {
        await writeNdjsonFile(
          resolveBundlePath(prepared.rootPath, blobsPath),
          blobRows,
        );
      }

      const counts = {
        docs: docs.filter((row) => !row.meta.deleted).length,
        tombstones: docs.filter((row) => Boolean(row.meta.deleted)).length,
        blobs: blobRows.length,
        blobBytes: blobRows.reduce((sum, row) => sum + row.size, 0),
      };

      const manifestTable: SnapshotTableManifest = {
        ...schema,
        files: {
          schema: schemaPath,
          docs: docsPath,
          ...(blobsPath ? { blobs: blobsPath } : {}),
        },
        counts,
      };
      manifestTables.push(manifestTable);
      totals.tables += 1;
      totals.docs += counts.docs;
      totals.tombstones += counts.tombstones;
      totals.blobs += counts.blobs;
      totals.blobBytes += counts.blobBytes;
    }

    const manifest: SnapshotManifest = {
      formatVersion: SNAPSHOT_VERSION,
      createdAtMs,
      sourceBackend: backend.backendName,
      scope: options.scope ? deepClone(options.scope) : null,
      includeBlobs: options.includeBlobs ?? true,
      includeTombstones: options.includeTombstones ?? true,
      tables: manifestTables,
      totals,
    };

    await writeJsonFile(
      resolveBundlePath(prepared.rootPath, 'manifest.json'),
      manifest,
    );

    if (format !== 'directory') {
      await tar.c(
        {
          cwd: prepared.rootPath,
          file: options.outputPath,
          gzip: format === 'tar.gz',
        },
        ['.'],
      );
    }

    return manifest;
  } finally {
    if (prepared.cleanupPath) {
      await rm(prepared.cleanupPath, { recursive: true, force: true });
    }
  }
}

/**
 * Imports snapshot bundle.
 * @param backend Backend.
 * @param options Operation options.
 */
export async function importSnapshotBundle(
  backend: SnapshotImportBackend,
  options: ImportSnapshotOptions,
): Promise<SnapshotImportResult> {
  const format = resolveSnapshotFormat(options.inputPath, options.format);
  const prepared = await prepareImportRoot(options.inputPath, format);
  const resolvedOptions: ResolvedSnapshotImportOptions = {
    mode: options.mode ?? 'merge',
    conflictMode: options.conflictMode ?? 'error',
  };

  try {
    const manifest = await readJsonFile<SnapshotManifest>(
      resolveBundlePath(prepared.rootPath, 'manifest.json'),
    );
    assertSnapshotVersion(manifest);

    const result: SnapshotImportResult = {
      manifest,
      tablesImported: 0,
      createdTables: 0,
      docsImported: 0,
      tombstonesImported: 0,
      blobsImported: 0,
      docsSkipped: 0,
      blobsSkipped: 0,
    };

    for (const table of manifest.tables) {
      const schema = await readJsonFile<SnapshotTableSchema>(
        resolveBundlePath(prepared.rootPath, table.files.schema),
      );
      assertSchemaMatchesManifest(schema, table);
      const docs = await readNdjsonFile<SnapshotDocRecord>(
        resolveBundlePath(prepared.rootPath, table.files.docs),
      );
      const blobRows = table.files.blobs
        ? await readNdjsonFile<SnapshotBlobRecord>(
            resolveBundlePath(prepared.rootPath, table.files.blobs),
          )
        : [];

      const blobs: SnapshotImportBlob[] = [];
      for (const blob of blobRows) {
        const blobPath = resolveBundlePath(prepared.rootPath, blob.path);
        const bytes = new Uint8Array(await readFile(blobPath));
        if (sha256Hex(bytes) !== blob.sha256) {
          throw new Error(
            `Snapshot blob ${blob.id} for ${schema.app}/${schema.db}/${schema.tableName} failed sha256 verification`,
          );
        }
        if (bytes.byteLength !== blob.size) {
          throw new Error(
            `Snapshot blob ${blob.id} for ${schema.app}/${schema.db}/${schema.tableName} failed size verification`,
          );
        }
        blobs.push({
          ...blob,
          bytes,
        });
      }

      const imported = await backend.importTable(
        {
          schema,
          docs,
          blobs,
          bundleCreatedAtMs: manifest.createdAtMs,
        },
        resolvedOptions,
      );

      result.tablesImported += 1;
      result.createdTables += imported.createdTable ? 1 : 0;
      result.docsImported += imported.docsImported;
      result.tombstonesImported += imported.tombstonesImported;
      result.blobsImported += imported.blobsImported;
      result.docsSkipped += imported.docsSkipped;
      result.blobsSkipped += imported.blobsSkipped;
    }

    return result;
  } finally {
    if (prepared.cleanupPath) {
      await rm(prepared.cleanupPath, { recursive: true, force: true });
    }
  }
}
