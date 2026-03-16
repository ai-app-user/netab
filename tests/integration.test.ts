import test from "node:test";
import assert from "node:assert/strict";
import { CordNode, CordRegistry } from "../src/cord/index.js";
import { StengEngine } from "../src/steng/index.js";
import { createNetabClient, NetabDirectory, NetabService } from "../src/netab/index.js";

test("integration: leader writes replicate inside a cluster", async () => {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();

  const leaderStore = new StengEngine();
  const replicaStore = new StengEngine();
  const leaderCord = new CordNode(registry, { clusterId: "offline", nodeId: "leader", priority: 10, steng: leaderStore });
  const replicaCord = new CordNode(registry, { clusterId: "offline", nodeId: "replica", priority: 5, steng: replicaStore });

  const common = {
    app: "pos",
    db: "miami1",
    clusterId: "offline",
    directory,
    dbSecrets: { miami1: "secret-miami1" },
    sites: [
      {
        siteId: "site_brasao_miami1",
        locationId: "miami1",
        brandId: "brand_brasao",
        brandName: "Brasao",
        db: "miami1",
        public: true,
      },
    ],
    pins: [
      {
        pin: "1111",
        sub: "admin_1",
        groups: ["admin"],
        db: "miami1",
      },
    ],
  } as const;

  const leader = new NetabService({
    ...common,
    nodeId: "leader",
    steng: leaderStore,
    cord: leaderCord,
  });

  const replica = new NetabService({
    ...common,
    nodeId: "replica",
    steng: replicaStore,
    cord: replicaCord,
  });

  await leader.start();
  await replica.start();

  const client = createNetabClient({ app: "pos", db: "miami1", service: leader });
  await client.auth.login_pin("1111");
  const inserted = await client.add_obj("orders", {
    orderId: "ord_1",
    siteId: "site_brasao_miami1",
    items: [{ sku: "taco", qty: 1 }],
    createdAt: Date.now(),
  });

  await leaderCord.replicate_tick();

  const replicaClient = createNetabClient({ app: "pos", db: "miami1", service: replica });
  await replicaClient.auth.login_pin("1111");
  const rows = await replicaClient.get_objs("orders", [inserted.id]);
  assert.equal(rows.items.length, 1);
  assert.equal((rows.items[0].value as { items: Array<{ sku: string }> }).items[0].sku, "taco");

  await leader.stop();
  await replica.stop();
});
