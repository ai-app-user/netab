import test from "node:test";
import assert from "node:assert/strict";
import { CordNode, CordRegistry } from "../../cord/index.js";
import { StengEngine } from "../../steng/index.js";
import { NetabDirectory, NetabService } from "../index.js";

async function makeService(args: {
  clusterId: string;
  nodeId: string;
  registry: CordRegistry;
  directory: NetabDirectory;
  priority?: number;
}) {
  const steng = new StengEngine();
  const cord = new CordNode(args.registry, {
    clusterId: args.clusterId,
    nodeId: args.nodeId,
    priority: args.priority ?? 1,
    steng,
  });

  const service = new NetabService({
    app: "pos",
    db: "miami1",
    clusterId: args.clusterId,
    nodeId: args.nodeId,
    steng,
    cord,
    directory: args.directory,
    dbSecrets: { miami1: "secret-miami1" },
    sites: [
      {
        siteId: "site_brasao_miami1",
        locationId: "miami1",
        brandId: "brand_brasao",
        brandName: "Brasao",
        db: "miami1",
        hostname: "brasao.helenabox.com",
        public: true,
        locationProof: "proof-1",
      },
    ],
    joinCodes: {
      JOIN123: "site_brasao_miami1",
    },
    pins: [
      {
        pin: "1111",
        sub: "admin_1",
        groups: ["admin"],
        db: "miami1",
      },
    ],
    tablePolicies: {
      menu_items: {
        type: "json",
        writePrimaryClusterId: "online",
        readFallbackClusters: ["online"],
      },
      orders: {
        type: "json",
        writePrimaryClusterId: "offline",
        readFallbackClusters: ["online"],
      },
    },
  });

  await service.start();
  return service;
}

test("netab routes writes to the primary cluster and enforces scoped customer permissions", async () => {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();

  const offlineA = await makeService({ clusterId: "offline", nodeId: "offline-a", registry, directory, priority: 10 });
  const offlineB = await makeService({ clusterId: "offline", nodeId: "offline-b", registry, directory, priority: 5 });
  const online = await makeService({ clusterId: "online", nodeId: "online-a", registry, directory, priority: 10 });

  const admin = await offlineA.auth_login_pin("1111");
  const adminToken = admin.token;
  await assert.rejects(() =>
    offlineA.add_objs(
      adminToken,
      "menu_items",
      [{ id: "mi_taco", value: { itemId: "mi_taco", brandId: "brand_brasao", name: "Taco", sku: "taco", priceCents: 450, isActive: true } }] as unknown as { value: unknown }[],
    ),
  );
  await offlineA.add_obj(adminToken, "menu_items", {
    itemId: "mi_taco",
    brandId: "brand_brasao",
    name: "Taco",
    sku: "taco",
    priceCents: 450,
    isActive: true,
  });

  await online.cord.replicate_tick();
  const menuRead = await offlineB.get_objs(adminToken, "menu_items", null, [["brandId", "==", "brand_brasao"]], 0, 20);
  assert.equal(menuRead.source, "fallback");
  assert.equal(menuRead.items.length, 1);

  const anonymous = await offlineA.auth_anonymous({ siteId: "site_brasao_miami1" });
  const customerToken = anonymous.token;
  const orderWrite = await offlineA.add_objs(customerToken, "orders", [
    {
      value: {
        items: [{ sku: "taco", qty: 1 }],
        notes: "No onions",
        createdAt: Date.now(),
        source: "customer_web",
      },
    },
  ]);
  assert.equal(orderWrite.ids.length, 1);

  await assert.rejects(() =>
    offlineA.update_objs(customerToken, "orders", [orderWrite.ids[0]], [{ status: "DONE" }], { merge: "shallow" }),
  );

  await offlineA.stop();
  await offlineB.stop();
  await online.stop();
});
