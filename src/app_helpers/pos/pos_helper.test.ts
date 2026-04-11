import test from 'node:test';
import assert from 'node:assert/strict';
import { PosHelper } from './pos_helper.js';
import type { NetabClient } from '../../netab/client.js';
import type { SubEvent } from '../../netab/types.js';
import type { Filter } from '../../steng/index.js';

function createStubClient() {
  let token = 'initial-token';
  const rowsByTable = new Map<string, Array<{ id: string; value: unknown }>>();
  rowsByTable.set('menu_items', []);
  rowsByTable.set('orders', []);

  const calls: Array<{ name: string; args: unknown[] }> = [];
  const client = {
    auth: {
      setToken(nextToken: string) {
        token = nextToken;
      },
      getToken() {
        return token;
      },
      async login_pin(pin: string) {
        calls.push({ name: 'auth.login_pin', args: [pin] });
        token = `pin-${pin}`;
        return {
          token,
          site: {
            siteId: 'site_pin',
            locationId: 'loc_pin',
            brandId: 'brand_1',
            brandName: 'Brand One',
            db: 'miami1',
          },
        };
      },
      async anonymous(args?: { brand?: string; siteId?: string }) {
        calls.push({ name: 'auth.anonymous', args: [args] });
        token = `anon-${args?.siteId ?? 'site'}`;
        return {
          token,
          site: {
            siteId: args?.siteId ?? 'site_1',
            locationId: 'loc_1',
            brandId: 'brand_1',
            brandName: 'Brand One',
            db: 'miami1',
          },
        };
      },
    },
    access: {
      async redeem_join_code(joinCode: string) {
        calls.push({ name: 'access.redeem_join_code', args: [joinCode] });
        token = `join-${joinCode}`;
        return {
          token,
          site: {
            siteId: 'site_join',
            locationId: 'loc_join',
            brandId: 'brand_1',
            brandName: 'Brand One',
            db: 'miami1',
          },
        };
      },
      async request_location_access(locationId: string, proof?: string) {
        calls.push({
          name: 'access.request_location_access',
          args: [locationId, proof],
        });
        token = `loc-${locationId}`;
        return {
          token,
          site: {
            siteId: 'site_loc',
            locationId,
            brandId: 'brand_1',
            brandName: 'Brand One',
            db: 'miami1',
          },
        };
      },
      async list_sites_for_brand(brandName: string) {
        calls.push({ name: 'access.list_sites_for_brand', args: [brandName] });
        if (brandName === 'Missing') {
          throw new Error('lookup failed');
        }
        return [
          {
            siteId: 'site_1',
            locationId: 'loc_1',
            brandId: 'brand_1',
            brandName,
            db: 'miami1',
          },
        ];
      },
      async resolve_token_site() {
        calls.push({ name: 'access.resolve_token_site', args: [] });
        return {
          siteId: 'site_2',
          locationId: 'loc_2',
          brandId: 'brand_2',
          brandName: 'Brand Two',
          db: 'miami1',
        };
      },
      async lookup_brand() {
        return [];
      },
      async resolve_domain() {
        return null;
      },
    },
    async get_objs(tableName: string) {
      calls.push({ name: 'get_objs', args: [tableName] });
      return {
        items: (rowsByTable.get(tableName) ?? []).map((row) => ({ ...row })),
        next_pos: 0,
      };
    },
    async add_obj(tableName: string, value: unknown) {
      calls.push({ name: 'add_obj', args: [tableName, value] });
      const next = {
        id: `${tableName}_${(rowsByTable.get(tableName)?.length ?? 0) + 1}`,
        value,
      };
      rowsByTable.set(tableName, [...(rowsByTable.get(tableName) ?? []), next]);
      return { id: next.id };
    },
    async add_objs() {
      return { ids: [] };
    },
    async update_objs(tableName: string, ids: string[], patches: unknown[]) {
      calls.push({ name: 'update_objs', args: [tableName, ids, patches] });
    },
    async replace_objs(tableName: string, ids: string[], values: unknown[]) {
      calls.push({ name: 'replace_objs', args: [tableName, ids, values] });
    },
    async delete_objs() {},
    async subscribe_objs(
      _tableName: string,
      _filter: Filter | null,
      cb: (evt: SubEvent) => void,
    ) {
      cb({ op: 'added', id: 'ord_1', ts: 1 });
      return () => {
        calls.push({ name: 'unsubscribe', args: [] });
      };
    },
    _calls: calls,
    _rowsByTable: rowsByTable,
  } satisfies NetabClient & {
    _calls: Array<{ name: string; args: unknown[] }>;
    _rowsByTable: Map<string, Array<{ id: string; value: unknown }>>;
  };

  return client;
}

test('pos helper covers fallback onboarding branches and menu upsert/update paths', async () => {
  const client = createStubClient();
  const helper = new PosHelper({ client });

  assert.deepEqual(helper.onboarding_options(), {
    byQR: true,
    byBrand: true,
    byLocationId: true,
  });
  await assert.rejects(() => helper.menu_list());

  const qrCtx = await helper.connect_by_qr({ joinCode: 'JOIN123' });
  assert.equal(qrCtx.siteId, 'site_join');
  assert.equal(helper.get_context()?.token, 'join-JOIN123');

  const locationCtx = await helper.connect_by_location_id('loc_9', 'proof-9');
  assert.equal(locationCtx.locationId, 'loc_9');

  assert.deepEqual(await helper.connect_by_brand_name('Brand One'), {
    choices: [
      {
        siteId: 'site_1',
        locationId: 'loc_1',
        brandId: 'brand_1',
        brandName: 'Brand One',
      },
    ],
  });
  assert.deepEqual(await helper.connect_by_brand_name('Missing'), {
    requiresAdminOrJoinCode: true,
  });

  const selected = await helper.connect_select_site('site_1');
  assert.equal(selected.siteId, 'site_1');
  assert.equal(helper.get_context()?.token, 'anon-site_1');

  await helper.menu_upsert({
    itemId: 'm_1',
    brandId: 'brand_1',
    name: 'Item One',
    sku: 'sku_1',
    priceCents: 500,
    isActive: true,
  });
  client._rowsByTable.set('menu_items', [
    {
      id: 'menu_items_1',
      value: {
        itemId: 'm_1',
        brandId: 'brand_1',
        name: 'Item One',
        sku: 'sku_1',
        priceCents: 500,
        isActive: true,
      },
    },
  ]);
  await helper.menu_upsert({
    itemId: 'm_1',
    brandId: 'brand_1',
    name: 'Item One Updated',
    sku: 'sku_1',
    priceCents: 550,
    isActive: true,
  });
  await helper.menu_set_availability('m_1', false);

  const unsubscribe = await helper.order_subscribe(() => undefined);
  unsubscribe();

  assert.ok(
    client._calls.some(
      (call) => call.name === 'add_obj' && call.args[0] === 'menu_items',
    ),
  );
  assert.ok(
    client._calls.some(
      (call) => call.name === 'replace_objs' && call.args[0] === 'menu_items',
    ),
  );
  assert.ok(
    client._calls.some(
      (call) => call.name === 'update_objs' && call.args[0] === 'menu_items',
    ),
  );
  assert.ok(client._calls.some((call) => call.name === 'unsubscribe'));
});
