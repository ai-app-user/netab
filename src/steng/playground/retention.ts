import { Steng } from '../index.js';

async function main() {
  const steng = new Steng({ clusterShort: 'demo' });
  try {
    const table = await steng.ensure_table('pos', 'miami1', 'orders', 'json');
    await steng.add_index(table.tableId, 'createdAt', 'time');
    await steng.set_table_config(table.tableId, {
      timeField: 'createdAt',
      retentionHours: 1,
    });

    const now = Date.now();
    const inserted = await steng.add_objs(table.tableId, [
      { value: { createdAt: now - 2 * 60 * 60 * 1000, status: 'DONE' } },
      { value: { createdAt: now - 10 * 60 * 1000, status: 'PENDING' } },
    ]);

    console.log('generated ids', inserted.ids);
    console.log(
      'before retention',
      await steng.get_objs(table.tableId, inserted.ids, null, 0, 10),
    );
    await steng.run_retention(now);
    console.log(
      'after retention',
      await steng.get_objs(table.tableId, inserted.ids, null, 0, 10),
    );
    console.log('watermark', await steng.get_watermark(table.tableId));
  } finally {
    await steng.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
