import { CordNode, CordRegistry } from "../src/cord/index.js";
import { StengEngine } from "../src/steng/index.js";
import { createNetabClient, NetabDirectory, NetabService } from "../src/netab/index.js";
import { PosHelper } from "../src/app_helpers/pos/index.js";

async function main() {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();
  const steng = new StengEngine();
  const cord = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "tablet-a",
    priority: 10,
    steng,
  });

  const service = new NetabService({
    app: "pos",
    db: "miami1",
    clusterId: "offline",
    nodeId: "tablet-a",
    steng,
    cord,
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
  });
  await service.start();

  const admin = createNetabClient({ app: "pos", db: "miami1", service });
  await admin.auth.login_pin("1111");
  await admin.add_obj("menu_items", {
    itemId: "mi_taco",
    siteId: "site_brasao_miami1",
    brandId: "brand_brasao",
    name: "Asada Taco",
    sku: "taco_asada",
    priceCents: 399,
    isActive: true,
  });

  const helper = new PosHelper({
    clientOptions: { app: "pos", db: "miami1", service },
  });
  await helper.connect_by_qr({ joinCode: "JOIN123" });
  const menu = await helper.menu_list();
  const created = await helper.order_create({
    items: [{ sku: "taco_asada", qty: 2 }],
    notes: "Playground order",
  });

  console.log({ menu, created });
  await service.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
