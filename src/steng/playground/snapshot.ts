import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Steng, type StengBackend } from "../index.js";

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function normalizeBackend(value: string): StengBackend {
  if (value === "memory" || value === "sqlite" || value === "postgres") {
    return value;
  }
  throw new Error(`Unsupported backend "${value}". Use memory, sqlite, or postgres.`);
}

function readFlag(argv: string[], name: string): string | undefined {
  const flagIndex = argv.findIndex((arg) => arg === name);
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function parseBackend(argv: string[], flag: "--backend" | "--restore-backend", envName: string, fallback: StengBackend): StengBackend {
  const value = readFlag(argv, flag) ?? process.env[envName];
  return value ? normalizeBackend(value) : fallback;
}

function resolveOutputPath(argv: string[]): string {
  const explicit = readFlag(argv, "--out") ?? process.env.STENG_SNAPSHOT_OUT;
  if (explicit) {
    return explicit;
  }
  return join(process.cwd(), "tmp", `steng-playground-snapshot-${Date.now()}.tar.gz`);
}

/**
 * Export one logical snapshot from a source backend and restore it into a
 * second backend to demonstrate that the bundle format is backend-independent.
 */
export async function runSnapshotPlayground(
  sourceBackend: StengBackend = "memory",
  restoreBackend: StengBackend = "memory",
  outputPath: string = resolveOutputPath([]),
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });

  const source = new Steng({
    backend: sourceBackend,
    clusterShort: process.env.STENG_CLUSTER_SHORT?.trim() || "demo",
  });
  const restored = new Steng({
    backend: restoreBackend,
    clusterShort: process.env.STENG_RESTORE_CLUSTER_SHORT?.trim() || "rest",
  });

  try {
    const table = await source.ensure_table("pos", "miami1", "orders", "json");
    await source.add_index(table.tableId, "status", "str");
    await source.add_index(table.tableId, "createdAt", "time");
    await source.set_table_config(table.tableId, {
      timeField: "createdAt",
      idPrefix: "orders",
    });

    const ready = await source.add_obj(table.tableId, {
      createdAt: Date.now(),
      status: "READY",
      orderRef: "demo_100",
      totalCents: 1599,
    });
    const deleted = await source.add_obj(table.tableId, {
      createdAt: Date.now() - 60_000,
      status: "CANCELLED",
      orderRef: "demo_101",
      totalCents: 899,
    });
    await source.delete_objs(table.tableId, [deleted.id]);
    await source.add_blob(table.tableId, "blob_receipt", new Uint8Array([1, 2, 3, 4]), "application/octet-stream");
    await source.set_watermark(table.tableId, { localMinTimeMs: Date.now() - 3_600_000 });

    const manifest = await source.export_snapshot({
      outputPath,
      includeBlobs: true,
      includeTombstones: true,
    });

    const imported = await restored.import_snapshot({
      inputPath: outputPath,
      mode: "replace",
    });
    const restoredTable = await restored.get_table_info("pos", "miami1", "orders");
    const restoredRows = restoredTable
      ? await restored.get_objs(restoredTable.tableId, [ready.id, deleted.id], null, 0, 10)
      : null;

    console.log(
      JSON.stringify(
        {
          sourceBackend,
          restoreBackend,
          outputPath,
          manifest,
          imported,
          restoredTable,
          restoredRows: restoredRows?.items ?? [],
          restoredWatermark: restoredTable ? await restored.get_watermark(restoredTable.tableId) : null,
          restoredBlob: restoredTable ? await restored.get_blob(restoredTable.tableId, "blob_receipt") : null,
        },
        null,
        2,
      ),
    );
  } finally {
    await source.close();
    await restored.close();
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const sourceBackend = parseBackend(argv, "--backend", "STENG_BACKEND", "memory");
  const restoreBackend = parseBackend(argv, "--restore-backend", "STENG_RESTORE_BACKEND", "memory");
  const outputPath = resolveOutputPath(argv);

  runSnapshotPlayground(sourceBackend, restoreBackend, outputPath).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
