import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('android_publish stages apk manifests and root index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'netab-android-publish-'));
  const apkDir = join(dir, 'apk');
  const outDir = join(dir, 'out');
  const notesFile = join(dir, 'notes.txt');
  const apkPath = join(apkDir, 'app-debug.apk');
  await mkdir(apkDir, { recursive: true });
  await writeFile(apkPath, Buffer.from('dummy apk payload'));
  await writeFile(notesFile, 'First line\nSecond line\n', 'utf8');

  const script = resolve('scripts/android_publish.mjs');
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    '--app',
    'app_tester',
    '--channel',
    'dev',
    '--apk',
    apkPath,
    '--dest-root',
    outDir,
    '--base-url',
    'https://debian13.ispot.cc/netab/android/',
    '--package-name',
    'cc.ispot.netab.apptester',
    '--version-code',
    '42',
    '--version-name',
    '0.1.0-dev.42',
    '--git-commit',
    '25d2d07',
    '--built-at',
    '2026-04-06T18:10:00.000Z',
    '--notes-file',
    notesFile,
  ]);

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);

  const manifestPath = join(outDir, 'app_tester', 'dev', 'latest.json');
  const indexPath = join(outDir, 'index.json');
  const htmlPath = join(outDir, 'index.html');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const html = await readFile(htmlPath, 'utf8');

  assert.equal(manifest.appId, 'app_tester');
  assert.equal(manifest.channel, 'dev');
  assert.equal(manifest.packageName, 'cc.ispot.netab.apptester');
  assert.equal(manifest.versionCode, 42);
  assert.equal(manifest.versionName, '0.1.0-dev.42');
  assert.equal(manifest.apkFileName, 'app_tester-v42-25d2d07.apk');
  assert.equal(manifest.apkUrl, './builds/app_tester-v42-25d2d07.apk');
  assert.equal(manifest.latestUrl, './latest.json');
  assert.deepEqual(manifest.releaseNotes, ['First line', 'Second line']);

  assert.equal(index.apps.length, 1);
  assert.equal(index.apps[0].appId, 'app_tester');
  assert.equal(index.apps[0].channels.length, 1);
  assert.equal(
    index.apps[0].channels[0].latestUrl,
    './app_tester/dev/latest.json',
  );
  assert.equal(
    index.apps[0].channels[0].apkUrl,
    './app_tester/dev/builds/app_tester-v42-25d2d07.apk',
  );
  assert.match(html, /Netab Android Downloads/);
  assert.match(html, /app_tester/);
  assert.match(html, /\.\/android_deployer\/stable\/latest\.json/);
  assert.match(
    html,
    /\.\/app_tester\/dev\/builds\/app_tester-v42-25d2d07\.apk/,
  );
});
