import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStengEngine } from "../index.js";

test("sqlite steng persists tables, docs, blobs, and oplog across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steng-sqlite-"));
  const filename = join(dir, "steng.sqlite");

  try {
    const first = new SqliteStengEngine({ filename, clusterShort: "sq1a" });
    const table = await first.ensure_table("pos", "miami1", "orders", "json");
    await first.add_index(table.tableId, "createdAt", "time");
    await first.add_index(table.tableId, "equipmentId", "str");
    await first.set_table_config(table.tableId, {
      timeField: "createdAt",
      retentionHours: 1,
    });

    const now = Date.now();
    const inserted = await first.add_objs(table.tableId, [
      { value: { createdAt: now, equipmentId: "eq_1", status: "PENDING" } },
    ]);
    assert.match(inserted.ids[0], /^orders_sq1a_[0-9A-Z]{26}$/);
    await first.update_objs(table.tableId, [{ id: inserted.ids[0], patch: { nested: { value: 1 } } }]);
    const blob = await first.add_blob(table.tableId, null, new Uint8Array([1, 2, 3]), "application/octet-stream");
    const opsBefore = await first.read_ops_since(table.tableId, 0, 100);

    assert.equal(opsBefore.length, 3);
    assert.equal((await first.get_blob(table.tableId, blob.id)).bytes.byteLength, 3);
    await first.close();

    const reopened = new SqliteStengEngine({ filename, clusterShort: "sq1a" });
    const reopenedTable = await reopened.get_table_info("pos", "miami1", "orders");
    assert.ok(reopenedTable);
    const queried = await reopened.get_objs(
      reopenedTable!.tableId,
      [inserted.ids[0]],
      null,
      0,
      10,
    );
    assert.equal(queried.items.length, 1);
    assert.deepEqual((queried.items[0].value as { nested: { value: number } }).nested, { value: 1 });
    assert.equal((await reopened.read_ops_since(reopenedTable!.tableId, 0, 100)).length, 3);
    assert.equal((await reopened.get_blob(reopenedTable!.tableId, blob.id)).contentType, "application/octet-stream");
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
