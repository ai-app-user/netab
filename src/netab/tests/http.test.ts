import test from 'node:test';
import assert from 'node:assert/strict';
import { CordNode, CordRegistry } from '../../cord/index.js';
import { StengEngine } from '../../steng/index.js';
import {
  createNetabClient,
  NetabDirectory,
  NetabService,
  startNetabHttpServer,
} from '../index.js';

test('HTTP server exposes the netab client contract', async () => {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();
  const steng = new StengEngine();
  const cord = new CordNode(registry, {
    clusterId: 'offline',
    nodeId: 'node-a',
    priority: 10,
    steng,
  });

  const service = new NetabService({
    app: 'pos',
    db: 'miami1',
    clusterId: 'offline',
    nodeId: 'node-a',
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
  const http = await startNetabHttpServer(service);

  const client = createNetabClient({
    app: 'pos',
    db: 'miami1',
    baseUrl: http.baseUrl,
  });

  await client.auth.login_pin('1111');
  const inserted = await client.add_obj('menu_items', {
    itemId: 'mi_taco',
    siteId: 'site_brasao_miami1',
    brandId: 'brand_brasao',
    name: 'Asada Taco',
    sku: 'taco_asada',
    priceCents: 399,
    isActive: true,
  });

  const rows = await client.get_objs('menu_items', [inserted.id]);
  assert.equal((rows.items[0].value as { name: string }).name, 'Asada Taco');

  await http.stop();
  await service.stop();
});
