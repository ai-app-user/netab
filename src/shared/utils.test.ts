import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  bytesToBase64,
  deepClone,
  deepMerge,
  getField,
  isRecord,
  pickFields,
  randomId,
  sha256Hex,
  shallowMerge,
  stableStringify,
  topLevelKeys,
} from './utils.js';

test('shared utils clone, merge, and inspect JSON-like values', () => {
  const original = {
    id: 'abc',
    nested: {
      count: 1,
      child: {
        value: 'x',
      },
    },
    tags: ['a', 'b'],
  };

  const cloned = deepClone(original);
  assert.deepEqual(cloned, original);
  cloned.nested.count = 2;
  assert.equal(original.nested.count, 1);

  assert.equal(isRecord(original), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(['x']), false);

  assert.deepEqual(
    deepMerge(original, {
      nested: { child: { value: 'y' } },
      tags: ['c'],
    }),
    {
      id: 'abc',
      nested: {
        count: 1,
        child: {
          value: 'y',
        },
      },
      tags: ['c'],
    },
  );

  assert.deepEqual(
    shallowMerge(original, {
      nested: { count: 9 } as unknown as typeof original.nested,
    }),
    {
      id: 'abc',
      nested: { count: 9 },
      tags: ['a', 'b'],
    },
  );

  assert.equal(getField(original, 'id'), 'abc');
  assert.equal(getField(original, 'nested.child.value'), 'x');
  assert.equal(getField(original, 'nested.missing.value'), undefined);

  assert.deepEqual(pickFields(original, ['nested.child.value', 'id']), {
    nested: { child: { value: 'x' } },
    id: 'abc',
  });
  assert.deepEqual(pickFields(original), original);
  assert.deepEqual(topLevelKeys(original), ['id', 'nested', 'tags']);
  assert.deepEqual(topLevelKeys('x'), []);
});

test('shared utils provide deterministic helpers for ids, hashes, and base64', () => {
  const first = randomId('node');
  const second = randomId('node');
  assert.match(first, /^node_[a-z0-9]+_[a-f0-9]{12}$/);
  assert.notEqual(first, second);

  assert.equal(stableStringify({ b: 2, a: 1 }), JSON.stringify({ a: 1, b: 2 }));
  assert.equal(
    sha256Hex('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );

  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const encoded = bytesToBase64(bytes);
  assert.deepEqual([...base64ToBytes(encoded)], [1, 2, 3, 4, 5]);
});
