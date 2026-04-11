import test from 'node:test';
import assert from 'node:assert/strict';
import { Steng } from '../index.js';

test('steng supports indexed CRUD, subscriptions, and retention', async () => {
  const steng = new Steng({ clusterShort: 'mi1a' });
  try {
    const table = await steng.ensure_table('pos', 'miami1', 'orders', 'json');
    await steng.add_index(table.tableId, 'createdAt', 'time');
    await steng.add_index(table.tableId, 'equipmentId', 'str');
    assert.deepEqual(await steng.list_indexes(table.tableId), [
      { field: 'createdAt', type: 'time', multi: false },
      { field: 'equipmentId', type: 'str', multi: false },
    ]);
    await steng.set_table_config(table.tableId, {
      timeField: 'createdAt',
      retentionHours: 1,
    });

    const events: string[] = [];
    const unsub = steng.subscribe_objs(
      table.tableId,
      [['equipmentId', '==', 'eq_1']],
      (evt) => {
        events.push(`${evt.op}:${evt.id}`);
      },
    );

    const now = Date.now();
    const added = await steng.add_objs(table.tableId, [
      {
        value: {
          createdAt: now - 30 * 60 * 1000,
          equipmentId: 'eq_1',
          status: 'PENDING',
        },
      },
      {
        value: {
          legacyOrderId: 'legacy_ord_2',
          createdAt: now - 2 * 60 * 60 * 1000,
          equipmentId: 'eq_2',
          status: 'DONE',
        },
      },
    ]);
    assert.match(added.ids[0], /^orders_mi1a_[0-9A-Z]{26}$/);
    assert.match(added.ids[1], /^orders_mi1a_[0-9A-Z]{26}$/);

    await steng.update_objs(table.tableId, [
      { id: added.ids[0], patch: { nested: { value: 1 } } },
    ]);
    await steng.update_objs(table.tableId, [
      { id: added.ids[0], patch: { nested: { other: 2 } } },
    ]);

    const queried = await steng.get_objs(
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
      (queried.items[0].value as { nested: { value: number; other: number } })
        .nested,
      {
        value: 1,
        other: 2,
      },
    );
    assert.deepEqual(events, [
      `added:${added.ids[0]}`,
      `updated:${added.ids[0]}`,
      `updated:${added.ids[0]}`,
    ]);

    await steng.run_retention(now);
    const postRetention = await steng.get_objs(
      table.tableId,
      [added.ids[1]],
      null,
      0,
      10,
    );
    assert.equal(postRetention.items[0].miss, 'NOT_FOUND');
    assert.ok((await steng.get_watermark(table.tableId))?.localMinTimeMs);

    unsub();
  } finally {
    await steng.close();
  }
});

test('steng rejects caller-defined document ids on add_objs', async () => {
  const steng = new Steng({ clusterShort: 'mi1a' });
  try {
    const table = await steng.ensure_table('pos', 'miami1', 'orders', 'json');
    await assert.rejects(() =>
      steng.add_objs(table.tableId, [
        { id: 'ord_manual', value: { status: 'PENDING' } },
      ] as unknown as { value: unknown }[]),
    );
  } finally {
    await steng.close();
  }
});
