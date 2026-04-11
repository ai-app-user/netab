import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultCoordStorageFiles,
  inspectCoordStorage,
  openCoordStorage,
  switchCoordStorage,
} from '../index.js';

test('coord storage defaults to sqlite and can switch to a file backend', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'coord-storage-'));
  const files = defaultCoordStorageFiles(rootDir);

  try {
    const initial = await inspectCoordStorage(files);
    assert.equal(initial.backend, 'sqlite');
    assert.equal(initial.policy, 'auto');
    assert.equal(initial.status, 'healthy');
    assert.equal(initial.location, files.sqlitePath);

    const handle = await openCoordStorage(files);
    try {
      await handle.store.set('runtime/example', { ok: true, count: 1 });
    } finally {
      await handle.cleanup();
    }

    const switched = await switchCoordStorage(files, {
      backend: 'file',
    });
    assert.equal(switched.changed, true);
    assert.equal(switched.from.backend, 'sqlite');
    assert.equal(switched.to.backend, 'file');
    assert.equal(switched.to.location, files.filePath);
    assert.equal(switched.to.policy, 'explicit');
    assert.equal(switched.migratedKeys, 1);

    const reopened = await openCoordStorage(files, { allowAutoUpgrade: false });
    try {
      assert.deepEqual(await reopened.store.get('runtime/example'), {
        ok: true,
        count: 1,
      });
      const listed = await reopened.store.list('runtime/');
      assert.deepEqual(listed, [
        { key: 'runtime/example', value: { ok: true, count: 1 } },
      ]);
    } finally {
      await reopened.cleanup();
    }

    const noOp = await switchCoordStorage(files, {
      backend: 'file',
      location: files.filePath,
    });
    assert.equal(noOp.changed, false);
    assert.equal(noOp.migratedKeys, 0);
    assert.equal(noOp.to.backend, 'file');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
