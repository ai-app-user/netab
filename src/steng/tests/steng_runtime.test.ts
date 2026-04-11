import test from 'node:test';
import assert from 'node:assert/strict';
import { Steng, type StengBackend } from '../index.js';

for (const backend of [
  'memory',
  'sqlite',
  'postgres',
] as const satisfies readonly StengBackend[]) {
  test(`high-level Steng uses ${backend} with one backend setting`, async () => {
    const steng = new Steng({
      backend,
      clusterShort: backend.slice(0, 4),
      ...(backend === 'postgres'
        ? {
            postgres: {
              emulate: true,
              schema: 'steng_runtime_test',
            } as { schema: string } & { emulate: true },
          }
        : {}),
    });

    try {
      assert.equal(steng.backend, backend);

      const table = await steng.ensure_table('pos', 'miami1', 'orders', 'json');
      await steng.add_index(table.tableId, 'status', 'str');
      assert.deepEqual(await steng.list_indexes(table.tableId), [
        { field: 'status', type: 'str', multi: false },
      ]);
      const inserted = await steng.add_objs(table.tableId, [
        { value: { status: 'PENDING', totalCents: 1200 } },
      ]);

      assert.equal(inserted.ids.length, 1);
      assert.match(
        inserted.ids[0],
        new RegExp(`^orders_${backend.slice(0, 4)}_[0-9A-Z]{26}$`),
      );

      const fetched = await steng.get_objs(
        table.tableId,
        inserted.ids,
        null,
        0,
        10,
      );
      assert.equal(fetched.items.length, 1);
      assert.equal(
        (fetched.items[0].value as { status: string }).status,
        'PENDING',
      );
    } finally {
      await steng.close();
    }
  });
}
