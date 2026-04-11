import test from 'node:test';
import assert from 'node:assert/strict';
import { CordNode, CordRegistry } from '../../../cord/index.js';
import { StengEngine } from '../../../steng/index.js';
import {
  createNetabClient,
  NetabDirectory,
  NetabService,
} from '../../../netab/index.js';
import { PosHelper } from '../index.js';

test('POS helper supports QR onboarding, menu reads, and order creation', async () => {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();
  const steng = new StengEngine();
  const cord = new CordNode(registry, {
    clusterId: 'offline',
    nodeId: 'tablet-a',
    priority: 10,
    steng,
  });

  const service = new NetabService({
    app: 'pos',
    db: 'miami1',
    clusterId: 'offline',
    nodeId: 'tablet-a',
    steng,
    cord,
    directory,
    dbSecrets: { miami1: 'secret-miami1' },
    sites: [
      {
        siteId: 'site_brasao_miami1',
        locationId: 'miami1',
        brandId: 'brand_brasao',
        brandName: 'Brasao',
        db: 'miami1',
        public: true,
      },
    ],
    joinCodes: {
      JOIN123: 'site_brasao_miami1',
    },
    pins: [
      {
        pin: '1111',
        sub: 'admin_1',
        groups: ['admin'],
        db: 'miami1',
      },
    ],
  });
  await service.start();

  const adminClient = createNetabClient({ app: 'pos', db: 'miami1', service });
  await adminClient.auth.login_pin('1111');
  await adminClient.add_obj('menu_items', {
    itemId: 'mi_taco',
    siteId: 'site_brasao_miami1',
    brandId: 'brand_brasao',
    name: 'Asada Taco',
    sku: 'taco_asada',
    priceCents: 399,
    isActive: true,
  });

  const helper = new PosHelper({
    clientOptions: {
      app: 'pos',
      db: 'miami1',
      service,
    },
  });

  await helper.init();
  const connected = await helper.connect_by_qr({ joinCode: 'JOIN123' });
  assert.equal(connected.siteId, 'site_brasao_miami1');

  const menu = await helper.menu_list();
  assert.equal(menu.length, 1);

  const created = await helper.order_create({
    items: [{ sku: 'taco_asada', qty: 2 }],
    notes: 'Extra salsa',
  });

  const orders = await helper.order_list([['orderId', '==', created.orderId]]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].notes, 'Extra salsa');

  await service.stop();
});
