import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFilterSupported,
  filterUpperBound,
  indexValuesForField,
  matchClause,
  matchesFilter,
} from './filtering.js';
import type { TableInfo } from '../types.js';

const tableInfo: TableInfo = {
  tableId: 1,
  app: 'pos',
  db: 'miami1',
  tableName: 'orders',
  type: 'json',
  config: {
    indexes: {
      status: { type: 'str' },
      createdAt: { type: 'time' },
      tags: { type: 'str', multi: true },
    },
  },
};

test('filtering helpers cover match operations and index extraction', () => {
  const row = {
    id: 'ord_1',
    status: 'READY',
    createdAt: 100,
    tags: ['vip', 'pickup'],
    nested: {
      label: 'prefix-demo',
    },
  };

  assert.equal(matchesFilter(row, null), true);
  assert.equal(matchesFilter(row, [['id', '==', 'ord_1']]), true);
  assert.equal(matchesFilter(row, [['status', '!=', 'PENDING']]), true);
  assert.equal(matchesFilter(row, [['createdAt', '>', 90]]), true);
  assert.equal(matchesFilter(row, [['createdAt', '>=', 100]]), true);
  assert.equal(matchesFilter(row, [['createdAt', '<', 101]]), true);
  assert.equal(matchesFilter(row, [['createdAt', '<=', 100]]), true);
  assert.equal(matchesFilter(row, [['createdAt', 'between', [50, 120]]]), true);
  assert.equal(matchesFilter(row, [['status', 'in', ['READY', 'DONE']]]), true);
  assert.equal(matchesFilter(row, [['tags', 'contains', 'vip']]), true);
  assert.equal(
    matchesFilter(row, [['nested.label', 'prefix', 'prefix-']]),
    true,
  );
  assert.equal(matchesFilter(row, [['status', '==', 'DONE']]), false);

  assert.deepEqual(indexValuesForField(tableInfo.config, 'status', row), [
    'READY',
  ]);
  assert.deepEqual(indexValuesForField(tableInfo.config, 'tags', row), [
    'vip',
    'pickup',
  ]);
  assert.deepEqual(indexValuesForField(tableInfo.config, 'missing', row), []);
  assert.deepEqual(
    indexValuesForField(tableInfo.config, 'tags', { tags: null }),
    [],
  );

  assert.equal(matchClause('value', 'contains', 'alu'), true);
  assert.equal(matchClause('value', 'prefix', 'va'), true);
  assert.equal(matchClause('value', 'between', [1, 2]), false);
});

test('filtering helpers validate indexed fields and derive upper bounds', () => {
  assert.doesNotThrow(() =>
    assertFilterSupported(tableInfo, [
      ['id', '==', 'x'],
      ['status', '==', 'READY'],
    ]),
  );
  assert.throws(() =>
    assertFilterSupported(tableInfo, [['customerId', '==', '1']]),
  );

  assert.equal(filterUpperBound(null, 'createdAt'), undefined);
  assert.equal(filterUpperBound([['createdAt', '<', 200]], 'createdAt'), 200);
  assert.equal(filterUpperBound([['createdAt', '<=', 180]], 'createdAt'), 180);
  assert.equal(
    filterUpperBound([['createdAt', 'between', [100, 150]]], 'createdAt'),
    150,
  );
  assert.equal(
    filterUpperBound(
      [
        ['createdAt', '<', 220],
        ['createdAt', 'between', [50, 160]],
      ],
      'createdAt',
    ),
    160,
  );
  assert.equal(
    filterUpperBound([['status', '==', 'READY']], 'createdAt'),
    undefined,
  );
});
