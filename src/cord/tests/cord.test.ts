import test from "node:test";
import assert from "node:assert/strict";
import { CordNode, CordRegistry } from "../index.js";
import { sha256Hex } from "../../shared/utils.js";
import { StengEngine } from "../../steng/index.js";

test("cord foundation, cluster, election, and glue replication work together", async () => {
  const registry = new CordRegistry();
  const leaderStore = new StengEngine();
  const replicaStore = new StengEngine();

  const nodeA = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-a",
    priority: 10,
    addrs: ["10.0.0.10:4001"],
    steng: leaderStore,
  });
  const nodeB = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-b",
    priority: 5,
    addrs: ["10.0.0.11:4002"],
    steng: replicaStore,
  });

  await nodeA.start();
  await nodeB.start();

  nodeB.registerHandler("demo.foundation.echo", async (ctx, params) => ({
    handledBy: nodeB.self().nodeId,
    srcNodeId: ctx.srcNodeId ?? null,
    params,
  }));

  const discovered = await nodeA.discover();
  assert.deepEqual(
    discovered.map((node) => node.nodeId).sort(),
    ["node-a", "node-b"],
  );
  assert.equal((await nodeA.ping({ nodeId: "node-b" })).ok, true);
  assert.equal((await nodeA.call<{ nodeId: string }>({ nodeId: "node-b" }, "cord.foundation.whoami", {}, { auth: nodeA.foundation.makeInternalAuth() })).nodeId, "node-b");
  assert.deepEqual(
    await nodeA.call<{ handledBy: string; srcNodeId: string | null; params: { message: string } }>(
      { addr: "10.0.0.11:4002" },
      "demo.foundation.echo",
      { message: "hello" },
      { auth: nodeA.foundation.makeInternalAuth() },
    ),
    {
      handledBy: "node-b",
      srcNodeId: "node-a",
      params: { message: "hello" },
    },
  );

  const nodes = await nodeA.listNodes("offline");
  assert.equal(nodes.length, 2);
  assert.deepEqual(
    (await nodeA.getAliveNodes("offline")).map((node) => node.nodeId).sort(),
    ["node-a", "node-b"],
  );

  assert.equal(await nodeA.get_leader(), "node-a");
  await nodeA.addShard("offline", { shardId: "shard-b", weight: 1 });
  assert.equal((await nodeA.getLeader("offline", "shard-b"))?.leaderNodeId, "node-b");

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
  assert.equal(await nodeB.get_leader(), "node-b");

  await nodeB.stop();
});

test("cord IAM supports groups, credentials, and command grants", async () => {
  const registry = new CordRegistry();
  const node = new CordNode(registry, { nodeId: "iam-node" });
  await node.start();

  try {
    await node.createGroup("tenant:abc", "staff");
    await node.createGroup("tenant:abc", "ops");
    await node.addSubgroup("tenant:abc", "ops", "staff");
    await node.createUser("tenant:abc", { userId: "user:alice", displayName: "Alice" });
    await node.setCredential("tenant:abc", "user:alice", { type: "password", secretHash: sha256Hex("secret-1") });
    await node.addUserToGroup("tenant:abc", "user:alice", "staff");

    assert.equal(await node.verifyCredential("tenant:abc", "user:alice", "secret-1"), true);
    assert.equal(await node.isMember("tenant:abc", "ops", "user:alice", { recursive: true }), true);
    await assert.rejects(() => node.addSubgroup("tenant:abc", "staff", "ops"));

    await node.defineCommand("tenant:abc", "cmd:cord.cluster.exec", {
      title: "Cluster Exec",
      description: "Run a command across a cluster",
      maskBits: { invoke: 1, admin: 2 },
    });
    await node.grant("tenant:abc", "grp:staff", "cmd:cord.cluster.exec", { allow: true, mask: 1 });

    assert.equal(
      await node.canInvoke("tenant:abc", { userId: "user:alice", groups: ["staff"] }, "cmd:cord.cluster.exec", 1),
      true,
    );
    assert.equal(
      await node.canInvoke("tenant:abc", { userId: "user:alice", groups: ["staff"] }, "cmd:cord.cluster.exec", 2),
      false,
    );
  } finally {
    await node.stop();
  }
});

test("cord bootstrap keeps nodes unallocated by default", async () => {
  const registry = new CordRegistry();
  const node = new CordNode(registry, { nodeId: "guest-node" });
  await node.start();

  try {
    const unallocated = await node.listUnallocated("default");
    assert.equal(unallocated.length, 1);
    assert.equal(unallocated[0].nodeId, "guest-node");

    await node.claimNode("default", "guest-node", { installer: true });
    assert.deepEqual(await node.listUnallocated("default"), []);
  } finally {
    await node.stop();
  }
});
