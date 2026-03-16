import test from "node:test";
import assert from "node:assert/strict";
import { CordNode, CordRegistry } from "../index.js";
import { StengEngine } from "../../steng/index.js";

test("cord elects a leader and replicates oplog state to replicas", async () => {
  const registry = new CordRegistry();
  const leaderStore = new StengEngine();
  const replicaStore = new StengEngine();

  const nodeA = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-a",
    priority: 10,
    steng: leaderStore,
  });
  const nodeB = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-b",
    priority: 5,
    steng: replicaStore,
  });

  await nodeA.start();
  await nodeB.start();

  assert.equal(nodeA.get_leader(), "node-a");

  const orders = await leaderStore.ensure_table("pos", "miami1", "orders", "json");
  await leaderStore.add_index(orders.tableId, "createdAt", "time");
  const inserted = await leaderStore.add_obj(orders.tableId, { createdAt: Date.now(), status: "PENDING" });

  await nodeA.replicate_tick();

  const replicaTable = await replicaStore.get_table_info("pos", "miami1", "orders");
  assert.ok(replicaTable);
  const replicaRows = await replicaStore.get_objs(replicaTable!.tableId, [inserted.id], null, 0, 10);
  assert.equal((replicaRows.items[0].value as { status: string }).status, "PENDING");

  nodeB.set_reachability("node-a", false);
  await nodeA.stop();
  assert.equal(nodeB.get_leader(), "node-b");
});
