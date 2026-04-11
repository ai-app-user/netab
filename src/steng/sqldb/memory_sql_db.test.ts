import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySqlDb } from './memory_sql_db.js';

test('memory sql db records statements for exec and queries', async () => {
  const db = new MemorySqlDb();

  assert.deepEqual(await db.exec('create table demo(id int)'), {
    rowsAffected: 0,
  });
  assert.deepEqual(await db.query('select * from demo where id = ?', [1]), []);
  assert.equal(await db.queryOne('select * from demo where id = ?', [1]), null);

  const txResult = await db.tx(async (tx) => {
    await tx.exec('insert into demo(id) values (?)', [1]);
    return 'ok';
  });
  assert.equal(txResult, 'ok');

  assert.deepEqual(db.statements, [
    { sql: 'create table demo(id int)', params: [] },
    { sql: 'select * from demo where id = ?', params: [1] },
    { sql: 'select * from demo where id = ?', params: [1] },
    { sql: 'insert into demo(id) values (?)', params: [1] },
  ]);

  await db.close();
});
