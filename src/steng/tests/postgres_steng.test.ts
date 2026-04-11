import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { PostgresStengEngine } from '../index.js';

test('postgres steng supports CRUD, query, retention, blobs, and remote op apply', async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  const pool = new adapter.Pool();

  const primary = new PostgresStengEngine({
    pool: pool as unknown as Pool,
    schema: 'steng_test',
    clusterShort: 'pg1a',
  });

  const replica = new PostgresStengEngine({
    pool: pool as unknown as Pool,
    schema: 'steng_replica',
    clusterShort: 'pg1b',
  });

  const table = await primary.ensure_table('pos', 'miami1', 'orders', 'json');
  const replicaTable = await replica.ensure_table(
    'pos',
    'miami1',
    'orders',
    'json',
  );

  await primary.add_index(table.tableId, 'createdAt', 'time');
  await primary.add_index(table.tableId, 'equipmentId', 'str');
  await replica.add_index(replicaTable.tableId, 'createdAt', 'time');
  await replica.add_index(replicaTable.tableId, 'equipmentId', 'str');

  const now = Date.now();
  const inserted = await primary.add_objs(table.tableId, [
    {
      value: {
        createdAt: now - 2 * 60 * 60 * 1000,
        equipmentId: 'eq_2',
        status: 'DONE',
      },
    },
    {
      value: {
        createdAt: now - 10 * 60 * 1000,
        equipmentId: 'eq_1',
        status: 'PENDING',
      },
    },
  ]);
  assert.match(inserted.ids[0], /^orders_pg1a_[0-9A-Z]{26}$/);
  assert.match(inserted.ids[1], /^orders_pg1a_[0-9A-Z]{26}$/);
  await primary.update_objs(table.tableId, [
    { id: inserted.ids[1], patch: { nested: { value: 7 } } },
  ]);
  const blob = await primary.add_blob(
    table.tableId,
    'blob_1',
    new Uint8Array([9, 8, 7]),
    'application/octet-stream',
  );

  const queried = await primary.get_objs(
    table.tableId,
    null,
    [
      ['createdAt', '>=', now - 60 * 60 * 1000],
      ['equipmentId', '==', 'eq_1'],
    ],
    0,
    10,
  );
  assert.equal(queried.items.length, 1);
  assert.deepEqual(
    (queried.items[0].value as { nested: { value: number } }).nested,
    { value: 7 },
  );

  await primary.set_table_config(table.tableId, {
    timeField: 'createdAt',
    retentionHours: 1,
  });
  await primary.run_retention(now);
  const retained = await primary.get_objs(
    table.tableId,
    inserted.ids,
    null,
    0,
    10,
  );
  assert.equal(retained.items[0].miss, 'NOT_FOUND');
  assert.equal(
    (await primary.get_blob(table.tableId, blob.id)).bytes.byteLength,
    3,
  );

  const ops = await primary.read_ops_since(table.tableId, 0, 100);
  await replica.set_table_config(replicaTable.tableId, {
    timeField: 'createdAt',
    retentionHours: 1,
  });
  await replica.apply_ops(replicaTable.tableId, ops);
  const replicaRows = await replica.get_objs(
    replicaTable.tableId,
    [inserted.ids[1]],
    null,
    0,
    10,
  );
  assert.equal(
    (replicaRows.items[0].value as { status: string }).status,
    'PENDING',
  );

  await primary.close();
  await replica.close();
  await pool.end();
});
