import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoordCliError,
  CoordCommandRegistry,
  CoordDispatcher,
  parseInvocation,
} from '../index.js';

test('coord_cli parses the new sender-command-target grammar', async () => {
  const base = await parseInvocation(['-start:4001', 'A', 'config.js']);
  assert.equal(base.kind, 'base');
  assert.equal(base.baseCmd, 'start');
  assert.equal(base.baseCmdPort, 4001);
  assert.deepEqual(base.baseArgs, ['A', 'config.js']);
  assert.deepEqual(base.sender, { kind: 'none' });

  const targeted = await parseInvocation([
    '@home',
    '-echo',
    '@vps',
    'hello',
    '--verbose',
  ]);
  assert.equal(targeted.kind, 'targeted');
  assert.deepEqual(targeted.sender, { kind: 'node', value: 'home' });
  assert.deepEqual(targeted.target, { kind: 'node', value: 'vps' });
  assert.equal(targeted.fullCmd, 'foundation:echo');
  assert.deepEqual(targeted.args, ['hello']);
  assert.equal(targeted.options.verbose, true);

  const clustered = await parseInvocation(['@A', '-cluster:nodes', '%offline']);
  assert.equal(clustered.fullCmd, 'cluster:nodes');
  assert.deepEqual(clustered.target, { kind: 'cluster', value: 'offline' });

  const payload = await parseInvocation([
    '@A',
    '-echo',
    '@B',
    '@./src/cord/playground/samples/bigfile.txt',
  ]);
  assert.equal(payload.fullCmd, 'foundation:echo');
  assert.equal(payload.payload?.kind, 'bytes');
  assert.equal(
    payload.payload?.name,
    './src/cord/playground/samples/bigfile.txt',
  );

  const exec = await parseInvocation([
    '@A',
    '-exec',
    '@B',
    'uname',
    '-a',
    '--os=linux,windows',
  ]);
  assert.equal(exec.fullCmd, 'foundation:exec');
  assert.deepEqual(exec.target, { kind: 'node', value: 'B' });
  assert.deepEqual(exec.args, ['uname', '-a']);
  assert.equal(exec.options.os, 'linux,windows');

  const storage = await parseInvocation([
    '-stor',
    'sqlite',
    './var/coord.sqlite',
  ]);
  assert.equal(storage.kind, 'base');
  assert.equal(storage.baseCmd, 'stor');
  assert.deepEqual(storage.baseArgs, ['sqlite', './var/coord.sqlite']);
});

test('coord_cli registry and dispatcher execute registered handlers', async () => {
  const registry = new CoordCommandRegistry();
  const seen: string[] = [];
  registry.registerBase('discover', async (inv) => {
    seen.push(`base:${inv.baseCmd}`);
  });
  registry.registerCmd('foundation:whoami', async () => {
    seen.push('foundation:whoami');
  });
  const dispatcher = new CoordDispatcher(registry);

  assert.equal(await dispatcher.dispatch(['-discover', '4001,4002', '600']), 0);
  assert.equal(await dispatcher.dispatch(['@A', '-whoami', '@B']), 0);
  assert.deepEqual(seen, ['base:discover', 'foundation:whoami']);
});

test('coord_cli returns specific exit codes for unknown group and command', async () => {
  const registry = new CoordCommandRegistry();
  registry.registerCmd('foundation:whoami', async () => ({ ok: true }));
  const dispatcher = new CoordDispatcher(registry);

  assert.equal(await dispatcher.dispatch(['@A', '-bad_group:echo']), 3);
  assert.equal(await dispatcher.dispatch(['@A', '-bad_cmd']), 4);
});

test('coord_cli reports mixed old/new syntax with a concrete selector hint', async () => {
  await assert.rejects(
    () => parseInvocation(['node-rad1', '-exec', 'node-rad1', 'uname -a']),
    (error: unknown) =>
      error instanceof CoordCliError &&
      error.message.includes('mixed coord syntax') &&
      error.message.includes('Prefix node/address selectors with "@"') &&
      error.message.includes('coord @node-rad1 -exec @node-rad1 uname -a'),
  );
});
