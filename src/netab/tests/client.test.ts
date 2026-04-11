import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetabClient } from '../client.js';
import type { Filter } from '../../steng/index.js';
import type {
  AccessResult,
  NetabGetResult,
  NetabServiceLike,
  SiteRecord,
  SubEvent,
} from '../types.js';

function makeSite(siteId = 'site_1'): SiteRecord {
  return {
    siteId,
    locationId: 'loc_1',
    brandId: 'brand_1',
    brandName: 'Brand One',
    db: 'miami1',
  };
}

function makeService(
  callLog: Array<{ name: string; args: unknown[] }>,
): NetabServiceLike {
  return {
    async auth_anonymous(args) {
      callLog.push({ name: 'auth_anonymous', args: [args] });
      return { token: 'anon-token', site: makeSite() };
    },
    async auth_login_pin(pin) {
      callLog.push({ name: 'auth_login_pin', args: [pin] });
      return {
        token: `pin-${pin}`,
        site: makeSite('site_pin'),
      } as AccessResult;
    },
    async access_redeem_join_code(joinCode) {
      callLog.push({ name: 'access_redeem_join_code', args: [joinCode] });
      return { token: `join-${joinCode}`, site: makeSite('site_join') };
    },
    async access_request_location_access(locationId, proof) {
      callLog.push({
        name: 'access_request_location_access',
        args: [locationId, proof],
      });
      return { token: `loc-${locationId}`, site: makeSite('site_loc') };
    },
    async access_lookup_brand(token, brandName) {
      callLog.push({ name: 'access_lookup_brand', args: [token, brandName] });
      return [makeSite('site_brand')];
    },
    async access_list_sites_for_brand(token, brandName) {
      callLog.push({
        name: 'access_list_sites_for_brand',
        args: [token, brandName],
      });
      return [makeSite('site_brand_list')];
    },
    async access_resolve_domain(hostname) {
      callLog.push({ name: 'access_resolve_domain', args: [hostname] });
      return makeSite('site_domain');
    },
    async access_resolve_token_site(token) {
      callLog.push({ name: 'access_resolve_token_site', args: [token] });
      return makeSite('site_token');
    },
    async get_objs(token, table_name, ids, filter, start_pos, max_count, opts) {
      callLog.push({
        name: 'get_objs',
        args: [token, table_name, ids, filter, start_pos, max_count, opts],
      });
      return {
        items: [{ id: 'doc_1', value: { ok: true } }],
        next_pos: 0,
        source: 'local',
      } satisfies NetabGetResult;
    },
    async add_obj(token, table_name, value) {
      callLog.push({ name: 'add_obj', args: [token, table_name, value] });
      return { id: 'doc_added' };
    },
    async add_objs(token, table_name, rows) {
      callLog.push({ name: 'add_objs', args: [token, table_name, rows] });
      return { ids: ['doc_a', 'doc_b'] };
    },
    async update_objs(token, table_name, ids, patches, opts) {
      callLog.push({
        name: 'update_objs',
        args: [token, table_name, ids, patches, opts],
      });
    },
    async replace_objs(token, table_name, ids, values) {
      callLog.push({
        name: 'replace_objs',
        args: [token, table_name, ids, values],
      });
    },
    async delete_objs(token, table_name, ids) {
      callLog.push({ name: 'delete_objs', args: [token, table_name, ids] });
    },
    async subscribe_objs(token, table_name, filter, cb) {
      callLog.push({
        name: 'subscribe_objs',
        args: [token, table_name, filter],
      });
      cb({ op: 'added', id: 'doc_1', ts: 1 } satisfies SubEvent);
      return () => {
        callLog.push({ name: 'unsubscribe', args: [] });
      };
    },
  };
}

test('netab client forwards the full in-process service surface and manages tokens', async () => {
  const callLog: Array<{ name: string; args: unknown[] }> = [];
  const client = createNetabClient({
    app: 'pos',
    db: 'miami1',
    service: makeService(callLog),
  });

  assert.equal(client.auth.getToken(), '');
  await client.auth.anonymous({ brand: 'Brand One' });
  assert.equal(client.auth.getToken(), 'anon-token');
  await client.auth.login_pin('1111');
  assert.equal(client.auth.getToken(), 'pin-1111');

  await client.access.redeem_join_code('JOIN123');
  assert.equal(client.auth.getToken(), 'join-JOIN123');
  await client.access.request_location_access('loc_9', 'proof-9');
  assert.equal(client.auth.getToken(), 'loc-loc_9');

  await client.access.lookup_brand('Brand One');
  await client.access.list_sites_for_brand('Brand One');
  await client.access.resolve_domain('example.test');
  await client.access.resolve_token_site();

  const filter: Filter = [['brandId', '==', 'brand_1']];
  await client.get_objs('menu_items', null, filter, 0, 25, {
    readMode: 'local_then_fallback',
  });
  await client.add_obj('menu_items', { itemId: 'm1' });
  await client.add_objs('menu_items', [
    { value: { itemId: 'm2' } },
    { value: { itemId: 'm3' } },
  ]);
  await client.update_objs('menu_items', ['doc_1'], [{ isActive: false }], {
    merge: 'shallow',
  });
  await client.replace_objs(
    'menu_items',
    ['doc_1'],
    [{ itemId: 'm1', isActive: true }],
  );
  await client.delete_objs('menu_items', ['doc_1']);

  let eventCount = 0;
  const unsub = await client.subscribe_objs('menu_items', filter, () => {
    eventCount += 1;
  });
  unsub();
  assert.equal(eventCount, 1);

  assert.deepEqual(
    callLog.map((entry) => entry.name),
    [
      'auth_anonymous',
      'auth_login_pin',
      'access_redeem_join_code',
      'access_request_location_access',
      'access_lookup_brand',
      'access_list_sites_for_brand',
      'access_resolve_domain',
      'access_resolve_token_site',
      'get_objs',
      'add_obj',
      'add_objs',
      'update_objs',
      'replace_objs',
      'delete_objs',
      'subscribe_objs',
      'unsubscribe',
    ],
  );
  assert.equal(
    (callLog.find((entry) => entry.name === 'access_lookup_brand')
      ?.args[0] as string) ?? '',
    'loc-loc_9',
  );
});

test('netab client rejects subscribe over plain HTTP-only configuration', async () => {
  const client = createNetabClient({
    app: 'pos',
    db: 'miami1',
    baseUrl: 'http://127.0.0.1:1',
  });

  await assert.rejects(() =>
    client.subscribe_objs('menu_items', null, () => undefined),
  );
});
