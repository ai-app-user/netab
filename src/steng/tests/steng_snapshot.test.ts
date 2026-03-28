import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Steng, type StengBackend } from "../index.js";

function openSteng(backend: StengBackend, clusterShort: string, rootDir: string, name: string): Steng {
  if (backend === "sqlite") {
    return new Steng({
      backend,
      clusterShort,
      sqlite: {
        filename: join(rootDir, `${name}.sqlite`),
      },
    });
  }

  if (backend === "postgres") {
    return new Steng({
      backend,
      clusterShort,
      postgres: {
        emulate: true,
        schema: `steng_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      },
    });
  }

  return new Steng({
    backend,
    clusterShort,
  });
}

for (const scenario of [
  { sourceBackend: "memory", targetBackend: "sqlite", format: "tar.gz", clusterShort: "mexp" },
  { sourceBackend: "sqlite", targetBackend: "postgres", format: "directory", clusterShort: "sexp" },
  { sourceBackend: "postgres", targetBackend: "memory", format: "tar.gz", clusterShort: "pexp" },
] as const satisfies readonly {
  sourceBackend: StengBackend;
  targetBackend: StengBackend;
  format: "directory" | "tar.gz";
  clusterShort: string;
}[]) {
  test(`steng snapshot export/import works from ${scenario.sourceBackend} to ${scenario.targetBackend}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "steng-snapshot-"));
    const source = openSteng(scenario.sourceBackend, scenario.clusterShort, dir, `src-${scenario.sourceBackend}`);
    const target = openSteng(scenario.targetBackend, `dst${scenario.clusterShort.slice(0, 1)}`, dir, `dst-${scenario.targetBackend}`);

    try {
      const table = await source.ensure_table("pos", "miami1", "orders", "json");
      await source.add_index(table.tableId, "status", "str");
      await source.add_index(table.tableId, "createdAt", "time");
      await source.set_table_config(table.tableId, {
        timeField: "createdAt",
        idPrefix: "orders",
      });

      const ready = await source.add_obj(table.tableId, {
        createdAt: 1_710_000_000_000,
        status: "READY",
        orderRef: "demo_100",
        totalCents: 1599,
      });
      const cancelled = await source.add_obj(table.tableId, {
        createdAt: 1_710_000_100_000,
        status: "CANCELLED",
        orderRef: "demo_101",
        totalCents: 899,
      });
      await source.delete_objs(table.tableId, [cancelled.id]);
      await source.add_blob(table.tableId, "blob_receipt", new Uint8Array([1, 2, 3, 4]), "application/octet-stream");
      await source.set_watermark(table.tableId, { localMinTimeMs: 1_709_999_000_000 });

      const outputPath =
        scenario.format === "directory" ? join(dir, "snapshot-dir") : join(dir, "snapshot-export.tar.gz");
      const manifest = await source.export_snapshot({
        outputPath,
        includeBlobs: true,
        includeTombstones: true,
      });

      assert.equal(manifest.totals.tables, 1);
      assert.equal(manifest.totals.docs, 1);
      assert.equal(manifest.totals.tombstones, 1);
      assert.equal(manifest.totals.blobs, 1);

      const imported = await target.import_snapshot({
        inputPath: outputPath,
        mode: "replace",
      });

      assert.equal(imported.tablesImported, 1);
      assert.equal(imported.createdTables, 1);
      assert.equal(imported.docsImported, 1);
      assert.equal(imported.tombstonesImported, 1);
      assert.equal(imported.blobsImported, 1);
      assert.equal(imported.docsSkipped, 0);
      assert.equal(imported.blobsSkipped, 0);

      const restoredTable = await target.get_table_info("pos", "miami1", "orders");
      assert.ok(restoredTable);
      assert.equal(restoredTable!.config.timeField, "createdAt");
      assert.equal(restoredTable!.config.idPrefix, "orders");
      assert.deepEqual(await target.list_indexes(restoredTable!.tableId), [
        { field: "createdAt", type: "time", multi: false },
        { field: "status", type: "str", multi: false },
      ]);

      const restoredRows = await target.get_objs(restoredTable!.tableId, [ready.id, cancelled.id], null, 0, 10);
      assert.equal((restoredRows.items[0].value as { status: string }).status, "READY");
      assert.equal(restoredRows.items[1].miss, "NOT_FOUND");
      assert.deepEqual(await target.get_watermark(restoredTable!.tableId), { localMinTimeMs: 1_709_999_000_000 });
      assert.equal((await target.get_blob(restoredTable!.tableId, "blob_receipt")).bytes.byteLength, 4);
      assert.equal((await target.read_ops_since(restoredTable!.tableId, 0, 10)).length, 3);
    } finally {
      await source.close();
      await target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("steng snapshot supports filtered exports and merge conflict handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steng-snapshot-filtered-"));
  const source = openSteng("memory", "fexp", dir, "source");
  const target = openSteng("memory", "fimp", dir, "target");

  try {
    const table = await source.ensure_table("pos", "miami1", "orders", "json");
    await source.add_index(table.tableId, "status", "str");

    const ready = await source.add_obj(table.tableId, {
      status: "READY",
      orderRef: "demo_200",
      totalCents: 1200,
    });
    await source.add_obj(table.tableId, {
      status: "PENDING",
      orderRef: "demo_201",
      totalCents: 700,
    });
    const deleted = await source.add_obj(table.tableId, {
      status: "READY",
      orderRef: "demo_202",
      totalCents: 600,
    });
    await source.delete_objs(table.tableId, [deleted.id]);
    await source.add_blob(table.tableId, "blob_hidden", new Uint8Array([9, 8, 7]), "application/octet-stream");

    const outputPath = join(dir, "filtered.tar.gz");
    const manifest = await source.export_snapshot({
      outputPath,
      includeBlobs: true,
      includeTombstones: true,
      scope: {
        tables: [
          {
            app: "pos",
            db: "miami1",
            tableName: "orders",
            filter: [["status", "==", "READY"]],
            includeBlobs: false,
          },
        ],
      },
    });

    assert.equal(manifest.tables.length, 1);
    assert.equal(manifest.tables[0].selection.includeTombstones, false);
    assert.equal(manifest.tables[0].selection.includeBlobs, false);
    assert.equal(manifest.tables[0].counts.docs, 1);
    assert.equal(manifest.tables[0].counts.tombstones, 0);
    assert.equal(manifest.tables[0].counts.blobs, 0);

    const firstImport = await target.import_snapshot({
      inputPath: outputPath,
      mode: "replace",
    });
    assert.equal(firstImport.docsImported, 1);
    assert.equal(firstImport.tombstonesImported, 0);
    assert.equal(firstImport.blobsImported, 0);

    const restoredTable = await target.get_table_info("pos", "miami1", "orders");
    assert.ok(restoredTable);
    const restoredRows = await target.get_objs(restoredTable!.tableId, null, [["status", "==", "READY"]], 0, 10);
    assert.equal(restoredRows.items.length, 1);
    assert.equal((restoredRows.items[0].value as { orderRef: string }).orderRef, "demo_200");
    await assert.rejects(() => target.get_blob(restoredTable!.tableId, "blob_hidden"));

    await target.update_objs(restoredTable!.tableId, [{ id: ready.id, patch: { status: "MODIFIED" }, merge: "shallow" }]);
    const skipImport = await target.import_snapshot({
      inputPath: outputPath,
      mode: "merge",
      conflictMode: "skip",
    });
    assert.equal(skipImport.docsSkipped, 1);
    const afterSkip = await target.get_objs(restoredTable!.tableId, [ready.id], null, 0, 1);
    assert.equal((afterSkip.items[0].value as { status: string }).status, "MODIFIED");

    const replaceImport = await target.import_snapshot({
      inputPath: outputPath,
      mode: "merge",
      conflictMode: "replace",
    });
    assert.equal(replaceImport.docsImported, 1);
    const afterReplace = await target.get_objs(restoredTable!.tableId, [ready.id], null, 0, 1);
    assert.equal((afterReplace.items[0].value as { status: string }).status, "READY");
  } finally {
    await source.close();
    await target.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
