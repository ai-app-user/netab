import { Steng } from '../index.js';

async function main() {
  const steng = new Steng({ clusterShort: 'demo' });
  try {
    const table = await steng.ensure_table('pos', 'miami1', 'orders', 'json');
    await steng.add_index(table.tableId, 'status', 'str');

    const unsubscribe = steng.subscribe_objs(
      table.tableId,
      [['status', '==', 'PENDING']],
      (evt) => {
        console.log('subscription event', evt);
      },
    );

    const inserted = await steng.add_objs(table.tableId, [
      { value: { status: 'PENDING', totalCents: 1200 } },
      { value: { status: 'DONE', totalCents: 800 } },
    ]);
    console.log('generated ids', inserted.ids);
    await steng.update_objs(table.tableId, [
      { id: inserted.ids[0], patch: { status: 'READY' } },
    ]);
    await steng.delete_objs(table.tableId, [inserted.ids[1]]);

    unsubscribe();
  } finally {
    await steng.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
