import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CordNode,
  CoordCommandRegistry,
  CoordDispatcher,
  MemoryStore,
  type CoordStore,
  type ClusterNodeConfig,
  type CommandDefinition,
  defaultCoordStorageFiles,
  inspectCoordStorage,
  openCoordStorage,
  switchCoordStorage,
  type CoordStorageFiles,
  type CoordStorageInfo,
  type CommandGrant,
  type HelpSpec,
  type Invocation,
  type NodeInfo,
  type RouteTable,
  type RpcAuth,
  type RpcTarget,
} from './index.js';
import { CordRegistry } from './registry.js';
import { bytesToBase64, randomId } from '../shared/utils.js';

type PlaygroundNodeRecord = {
  nodeId: string;
  nodeEpoch: string;
  addr: string;
  port: number;
  pid?: number;
  configPath?: string;
  startedAtMs?: number;
  props?: unknown;
  clusterId?: string;
  eligible?: boolean;
  priority?: number;
};

type DiscoveryCacheEntry = {
  nodeId: string;
  addr: string;
  nodeEpoch: string;
  lastSeenMs: number;
};

type SavedPlaygroundState = {
  nodes: PlaygroundNodeRecord[];
  cache: Record<string, DiscoveryCacheEntry>;
};

type NodeConfigSource = Partial<PlaygroundNodeRecord> & {
  addrs?: unknown;
  listen?: unknown;
  listenAddr?: unknown;
  listenAddrs?: unknown;
  advertiseAddr?: unknown;
  advertiseAddrs?: unknown;
};

type PlaygroundFiles = {
  rootDir: string;
  nodesPath: string;
  cachePath: string;
  storePath: string;
  storagePath: string;
  sqliteStorePath: string;
};

type ClientBundle = {
  client: CordNode;
  cleanup: () => Promise<void>;
};

const DEFAULT_ROOT = process.env.COORD_PLAYGROUND_ROOT
  ? resolve(process.env.COORD_PLAYGROUND_ROOT)
  : resolve(process.cwd(), 'tmp', 'cord_foundation');

const NODE_FILE = 'coord.nodes.json';
const CACHE_FILE = 'coord.cache.json';
const STORE_FILE = 'coord.store.json';
const SQLITE_STORE_FILE = 'coord.store.sqlite';
const STORAGE_FILE = 'coord.storage.json';
const COORD_SERVE_ENTRY = resolve(process.cwd(), 'src/cord/coord_runtime.ts');
const DEFAULT_RPC_TIMEOUT_MS = 5000;
const NODE_STORE_PREFIX = 'runtime/nodes/';
const CACHE_STORE_PREFIX = 'runtime/cache/';

/**
 * Returns the default files.
 * @param rootDir Root dir.
 */
function defaultFiles(rootDir = DEFAULT_ROOT): PlaygroundFiles {
  return {
    rootDir,
    nodesPath: join(rootDir, NODE_FILE),
    cachePath: join(rootDir, CACHE_FILE),
    storePath: join(rootDir, STORE_FILE),
    storagePath: join(rootDir, STORAGE_FILE),
    sqliteStorePath: join(rootDir, SQLITE_STORE_FILE),
  };
}

/**
 * Handles storage files for.
 * @param files Files.
 */
function storageFilesFor(files: PlaygroundFiles): CoordStorageFiles {
  return defaultCoordStorageFiles(files.rootDir);
}

/**
 * Returns whether main module.
 */
function isMainModule(): boolean {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

/**
 * Ensures dir.
 * @param path Filesystem path.
 */
async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * Reads JSON file.
 * @param path Filesystem path.
 * @param fallback Fallback.
 */
async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) {
    return fallback;
  }
  const content = await readFile(path, 'utf8');
  return (content.trim() ? JSON.parse(content) : fallback) as T;
}

/**
 * Writes JSON file.
 * @param path Filesystem path.
 * @param value Value to process.
 */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Handles with coord store.
 * @param files Files.
 * @param fn Callback function.
 */
async function withCoordStore<T>(
  files: PlaygroundFiles,
  fn: (store: CoordStore, info: CoordStorageInfo) => Promise<T>,
): Promise<T> {
  const storage = await openCoordStorage(storageFilesFor(files), {
    allowAutoUpgrade: true,
  });
  try {
    return await fn(storage.store, storage.info);
  } finally {
    await storage.cleanup();
  }
}

/**
 * Parses node record.
 * @param value Value to process.
 */
function parseNodeRecord(value: unknown): PlaygroundNodeRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.nodeId !== 'string' ||
    record.nodeId.length === 0 ||
    typeof record.nodeEpoch !== 'string' ||
    record.nodeEpoch.length === 0
  ) {
    return null;
  }
  return {
    nodeId: record.nodeId,
    nodeEpoch: record.nodeEpoch,
    addr: typeof record.addr === 'string' ? record.addr : '',
    port: typeof record.port === 'number' ? record.port : 0,
    pid: typeof record.pid === 'number' ? record.pid : undefined,
    configPath:
      typeof record.configPath === 'string' && record.configPath.length > 0
        ? record.configPath
        : undefined,
    startedAtMs:
      typeof record.startedAtMs === 'number' ? record.startedAtMs : undefined,
    props: record.props,
    clusterId:
      typeof record.clusterId === 'string' ? record.clusterId : undefined,
    eligible:
      typeof record.eligible === 'boolean' ? record.eligible : undefined,
    priority: typeof record.priority === 'number' ? record.priority : undefined,
  };
}

/**
 * Parses cache entry.
 * @param value Value to process.
 */
function parseCacheEntry(value: unknown): DiscoveryCacheEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.nodeId !== 'string' ||
    record.nodeId.length === 0 ||
    typeof record.addr !== 'string' ||
    typeof record.nodeEpoch !== 'string'
  ) {
    return null;
  }
  return {
    nodeId: record.nodeId,
    addr: record.addr,
    nodeEpoch: record.nodeEpoch,
    lastSeenMs: typeof record.lastSeenMs === 'number' ? record.lastSeenMs : 0,
  };
}

/**
 * Handles load nodes.
 * @param files Files.
 */
async function loadNodes(
  files: PlaygroundFiles,
): Promise<PlaygroundNodeRecord[]> {
  const stored = await withCoordStore(files, async (store) =>
    (await store.list(NODE_STORE_PREFIX))
      .map((entry) => parseNodeRecord(entry.value))
      .filter((entry): entry is PlaygroundNodeRecord => entry !== null),
  );
  if (stored.length > 0) {
    let changed = false;
    const normalized = stored
      .map((item) => ({
        ...item,
        nodeEpoch:
          typeof item.nodeEpoch === 'string' && item.nodeEpoch.length > 0
            ? item.nodeEpoch
            : ((changed = true), randomId('epoch')),
      }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    if (changed) {
      await saveNodes(files, normalized);
    } else {
      await writeJsonFile(files.nodesPath, normalized);
    }
    return normalized;
  }

  const items = await readJsonFile<
    Array<PlaygroundNodeRecord | Omit<PlaygroundNodeRecord, 'nodeEpoch'>>
  >(files.nodesPath, []);
  let changed = false;
  const normalized = items
    .map((item) => ({
      ...item,
      nodeEpoch:
        'nodeEpoch' in item && typeof item.nodeEpoch === 'string'
          ? item.nodeEpoch
          : ((changed = true), randomId('epoch')),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (normalized.length > 0 || changed) {
    await saveNodes(files, normalized);
  }
  return normalized;
}

/**
 * Handles save nodes.
 * @param files Files.
 * @param nodes Nodes.
 */
async function saveNodes(
  files: PlaygroundFiles,
  nodes: PlaygroundNodeRecord[],
): Promise<void> {
  const normalized = [...nodes].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
  await withCoordStore(files, async (store) => {
    const existing = await store.list(NODE_STORE_PREFIX);
    const keep = new Set(normalized.map((node) => node.nodeId));
    for (const entry of existing) {
      const nodeId = entry.key.slice(NODE_STORE_PREFIX.length);
      if (!keep.has(nodeId)) {
        await store.del(entry.key);
      }
    }
    for (const node of normalized) {
      await store.set(`${NODE_STORE_PREFIX}${node.nodeId}`, node);
    }
  });
  await writeJsonFile(files.nodesPath, normalized);
}

/**
 * Handles load cache.
 * @param files Files.
 */
async function loadCache(
  files: PlaygroundFiles,
): Promise<Record<string, DiscoveryCacheEntry>> {
  const entries = await withCoordStore(files, async (store) =>
    (await store.list(CACHE_STORE_PREFIX))
      .map((entry) => parseCacheEntry(entry.value))
      .filter((entry): entry is DiscoveryCacheEntry => entry !== null),
  );
  if (entries.length > 0) {
    const cache = Object.fromEntries(
      entries.map((entry) => [entry.nodeId, entry] as const),
    );
    await writeJsonFile(files.cachePath, cache);
    return cache;
  }
  const fromFile = await readJsonFile<Record<string, DiscoveryCacheEntry>>(
    files.cachePath,
    {},
  );
  if (Object.keys(fromFile).length > 0) {
    await saveCache(files, fromFile);
  }
  return fromFile;
}

/**
 * Handles save cache.
 * @param files Files.
 * @param cache Cache.
 */
async function saveCache(
  files: PlaygroundFiles,
  cache: Record<string, DiscoveryCacheEntry>,
): Promise<void> {
  await withCoordStore(files, async (store) => {
    const existing = await store.list(CACHE_STORE_PREFIX);
    const keep = new Set(Object.keys(cache));
    for (const entry of existing) {
      const nodeId = entry.key.slice(CACHE_STORE_PREFIX.length);
      if (!keep.has(nodeId)) {
        await store.del(entry.key);
      }
    }
    for (const [nodeId, value] of Object.entries(cache)) {
      await store.set(`${CACHE_STORE_PREFIX}${nodeId}`, value);
    }
  });
  await writeJsonFile(files.cachePath, cache);
}

/**
 * Handles load node configuration.
 * @param configPath Configuration path.
 */
async function loadNodeConfig(configPath: string): Promise<NodeConfigSource> {
  const resolved = resolve(configPath);
  if (resolved.endsWith('.json')) {
    return readJsonFile<NodeConfigSource>(resolved, {});
  }
  const module = await import(pathToFileURL(resolved).href);
  return (module.default ?? module.config ?? module) as NodeConfigSource;
}

/**
 * Handles auth for CLI.
 * @param client Client.
 */
function authForCli(client: CordNode): RpcAuth {
  return client.foundation.makeInternalAuth();
}

/**
 * Parses address.
 * @param addr Network address.
 */
function parseAddr(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(':');
  if (index <= 0 || index === addr.length - 1) {
    throw new Error(`Invalid addr "${addr}"`);
  }
  return {
    host: addr.slice(0, index),
    port: Number(addr.slice(index + 1)),
  };
}

/**
 * Normalizes address spec.
 * @param value Value to process.
 * @param fallbackPort Fallback port.
 */
function normalizeAddrSpec(value: string, fallbackPort: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Address cannot be empty');
  }
  if (trimmed.startsWith(':')) {
    return `0.0.0.0${trimmed}`;
  }
  if (!trimmed.includes(':')) {
    return `${trimmed}:${fallbackPort}`;
  }
  return trimmed;
}

/**
 * Reads string list.
 * @param value Value to process.
 * @param fallbackPort Fallback port.
 */
function readStringList(value: unknown, fallbackPort: number): string[] {
  if (typeof value === 'string' && value.trim().length > 0) {
    return [normalizeAddrSpec(value, fallbackPort)];
  }
  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
      .map((item) => normalizeAddrSpec(item, fallbackPort));
  }
  return [];
}

/**
 * Scores interface address.
 * @param ifaceName Iface name.
 * @param host Host name or address.
 */
function scoreInterfaceAddress(ifaceName: string, host: string): number {
  let score = 0;
  if (/^(eth|en|ens|eno|enp|wlan|wl|rmnet|usb)/i.test(ifaceName)) {
    score += 40;
  }
  if (/^(docker|br-|veth|virbr|zt|tailscale|tun|tap)/i.test(ifaceName)) {
    score -= 30;
  }
  if (/^169\.254\./.test(host)) {
    score -= 50;
  }
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    score += 20;
  } else {
    score += 60;
  }
  return score;
}

/**
 * Chooses advertise host.
 */
function chooseAdvertiseHost(): string {
  const explicit = process.env.COORD_ADVERTISE_HOST?.trim();
  if (explicit) {
    return explicit;
  }
  const nets = networkInterfaces();
  const candidates: Array<{ iface: string; host: string; score: number }> = [];
  for (const [ifaceName, entries] of Object.entries(nets)) {
    for (const entry of (entries ?? []) as NetworkInterfaceInfo[]) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.address) {
        continue;
      }
      candidates.push({
        iface: ifaceName,
        host: entry.address,
        score: scoreInterfaceAddress(ifaceName, entry.address),
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.iface.localeCompare(right.iface) ||
      left.host.localeCompare(right.host),
  );
  return candidates[0]?.host ?? '127.0.0.1';
}

/**
 * Returns the default listen address.
 * @param port TCP port.
 */
function defaultListenAddr(port: number): string {
  const explicit = process.env.COORD_LISTEN_HOST?.trim();
  return `${explicit && explicit.length > 0 ? explicit : '0.0.0.0'}:${port}`;
}

/**
 * Handles health check address.
 * @param listenAddrs Listen addresses.
 * @param advertisedAddrs Advertised addresses.
 * @param port TCP port.
 */
function healthCheckAddr(
  listenAddrs: string[],
  advertisedAddrs: string[],
  port: number,
): string {
  const primaryListen = listenAddrs[0];
  if (!primaryListen) {
    return advertisedAddrs[0] ?? `127.0.0.1:${port}`;
  }
  const { host } = parseAddr(primaryListen);
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    return `127.0.0.1:${port}`;
  }
  return primaryListen;
}

/**
 * Resolves node addresses.
 * @param port TCP port.
 * @param fromConfig From configuration.
 */
function resolveNodeAddresses(
  port: number,
  fromConfig: NodeConfigSource,
): {
  advertisedAddrs: string[];
  listenAddrs: string[];
  primaryAddr: string;
  healthAddr: string;
} {
  const advertisedAddrs = [
    ...readStringList(fromConfig.advertiseAddrs, port),
    ...readStringList(fromConfig.advertiseAddr, port),
    ...readStringList(fromConfig.addrs, port),
    ...readStringList(fromConfig.addr, port),
  ];
  const listenAddrs = [
    ...readStringList(fromConfig.listenAddrs, port),
    ...readStringList(fromConfig.listenAddr, port),
    ...readStringList(fromConfig.listen, port),
  ];

  const finalAdvertised =
    advertisedAddrs.length > 0
      ? [...new Set(advertisedAddrs)]
      : [`${chooseAdvertiseHost()}:${port}`];
  const finalListen =
    listenAddrs.length > 0
      ? [...new Set(listenAddrs)]
      : [defaultListenAddr(port)];
  return {
    advertisedAddrs: finalAdvertised,
    listenAddrs: finalListen,
    primaryAddr: finalAdvertised[0],
    healthAddr: healthCheckAddr(finalListen, finalAdvertised, port),
  };
}

/**
 * Returns whether PID alive.
 * @param pid PID.
 */
function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles delay.
 * @param ms Duration in milliseconds.
 */
async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Handles wait for HTTP node.
 * @param addr Network address.
 * @param timeoutMs Timeout ms.
 */
async function waitForHttpNode(
  addr: string,
  timeoutMs = 5000,
): Promise<NodeInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${addr}/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as {
          ok?: boolean;
          node?: NodeInfo;
        };
        if (payload.ok && payload.node) {
          return payload.node;
        }
      }
    } catch {
      // The daemon may still be starting.
    }
    await delay(100);
  }
  return null;
}

/**
 * Handles wait for expected HTTP node.
 * @param addr Network address.
 * @param nodeId Node identifier.
 * @param nodeEpoch Node epoch.
 * @param timeoutMs Timeout ms.
 */
async function waitForExpectedHttpNode(
  addr: string,
  nodeId: string,
  nodeEpoch: string,
  timeoutMs = 5000,
): Promise<NodeInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await waitForHttpNode(addr, 250);
    if (info?.nodeId === nodeId && info.nodeEpoch === nodeEpoch) {
      return info;
    }
    await delay(100);
  }
  return null;
}

/**
 * Handles kill PID gracefully.
 * @param pid PID.
 * @param forceAfterMs Force after ms.
 */
async function killPidGracefully(
  pid: number,
  forceAfterMs = 3000,
): Promise<boolean> {
  if (!isPidAlive(pid)) {
    return true;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isPidAlive(pid);
  }
  const deadline = Date.now() + forceAfterMs;
  while (isPidAlive(pid) && Date.now() < deadline) {
    await delay(50);
  }
  if (!isPidAlive(pid)) {
    return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return !isPidAlive(pid);
  }
  const hardDeadline = Date.now() + 1000;
  while (isPidAlive(pid) && Date.now() < hardDeadline) {
    await delay(50);
  }
  return !isPidAlive(pid);
}

/**
 * Reads PID cmdline.
 * @param pid PID.
 */
async function readPidCmdline(pid: number): Promise<string> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString('utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Returns whether coord serve PID.
 * @param pid PID.
 */
async function isCoordServePid(pid: number | undefined): Promise<boolean> {
  if (!pid || !isPidAlive(pid)) {
    return false;
  }
  const cmdline = await readPidCmdline(pid);
  return cmdline.includes(COORD_SERVE_ENTRY) && cmdline.includes(' -serve ');
}

type NodeStatus = {
  nodeId: string;
  addr: string;
  pid: number | null;
  process: 'up' | 'down';
  daemon: 'coord' | 'unknown' | 'none';
  health: 'up' | 'mismatch' | 'down';
  owner: string | null;
  nodeEpoch: string;
};

/**
 * Handles collect node statuses.
 * @param files Files.
 */
async function collectNodeStatuses(
  files: PlaygroundFiles,
): Promise<NodeStatus[]> {
  const nodes = await loadNodes(files);
  const statuses: NodeStatus[] = [];
  for (const node of nodes) {
    const processAlive = isPidAlive(node.pid);
    const daemonMatches = processAlive
      ? await isCoordServePid(node.pid)
      : false;
    const occupant = await waitForHttpNode(node.addr, 250);
    statuses.push({
      nodeId: node.nodeId,
      addr: node.addr,
      pid: node.pid ?? null,
      process: processAlive ? 'up' : 'down',
      daemon: node.pid ? (daemonMatches ? 'coord' : 'unknown') : 'none',
      health: occupant
        ? occupant.nodeId === node.nodeId
          ? 'up'
          : 'mismatch'
        : 'down',
      owner: occupant?.nodeId ?? null,
      nodeEpoch: node.nodeEpoch,
    });
  }
  return statuses.sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
}

/**
 * Formats status table.
 * @param files Files.
 * @param statuses Statuses.
 */
function formatStatusTable(
  files: PlaygroundFiles,
  statuses: NodeStatus[],
): string {
  const lines = ['coord status', '', `root: ${files.rootDir}`];
  if (statuses.length === 0) {
    lines.push('', 'no nodes configured');
    return lines.join('\n');
  }
  lines.push(
    '',
    'NODE      ADDR             PID      PROCESS  DAEMON   HEALTH    OWNER     EPOCH',
  );
  for (const status of statuses) {
    lines.push(
      `${status.nodeId.padEnd(9)} ${status.addr.padEnd(16)} ${String(status.pid ?? '-').padEnd(8)} ${status.process.padEnd(8)} ${status.daemon.padEnd(7)} ${status.health.padEnd(9)} ${String(status.owner ?? '-').padEnd(9)} ${status.nodeEpoch}`,
    );
  }
  return lines.join('\n');
}

/**
 * Lists global coord serve pids.
 */
async function listGlobalCoordServePids(): Promise<number[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (await isCoordServePid(pid)) {
      pids.push(pid);
    }
  }
  return pids.sort((left, right) => left - right);
}

/**
 * Builds runtime.
 * @param files Files.
 */
async function buildRuntime(files: PlaygroundFiles): Promise<ClientBundle> {
  const store = new MemoryStore();
  const registry = new CordRegistry(store);
  const client = new CordNode(registry, {
    nodeId: `coord-cli-${randomId('session')}`,
    props: { type: 'cli-client' },
    store,
  });

  return {
    client,
    /**
     * Handles cleanup.
     */
    cleanup: async () => {
      // The CLI client is fully in-memory and does not keep durable resources.
    },
  };
}

/**
 * Stops runtime.
 * @param runtime Runtime.
 */
async function stopRuntime(runtime: ClientBundle): Promise<void> {
  await runtime.cleanup();
}

/**
 * Normalizes payload.
 * @param inv Inv.
 */
function normalizePayload(
  inv: Invocation,
):
  | { kind: 'bytes' | 'json'; name: string; bytes?: string; json?: unknown }
  | undefined {
  if (!inv.payload) {
    return undefined;
  }
  if (inv.payload.kind === 'bytes') {
    return {
      kind: 'bytes',
      name: inv.payload.name,
      bytes: inv.payload.bytes ? bytesToBase64(inv.payload.bytes) : '',
    };
  }
  return {
    kind: 'json',
    name: inv.payload.name,
    json: inv.payload.json,
  };
}

const OUTPUT_OPTIONS = [
  '--json          Print machine-readable JSON',
  '--pretty        Pretty-print JSON output when combined with --json',
  '--verbose       Show routing/debug metadata',
];

const RPC_OPTIONS = [
  ...OUTPUT_OPTIONS,
  `--timeout=MS    Override RPC timeout (default ${DEFAULT_RPC_TIMEOUT_MS}ms)`,
  '--dst=NODE      Ask the contacted node to execute on another node',
  '--trace=ID      Attach a trace id to the request',
];

const FANOUT_OPTIONS = [
  ...RPC_OPTIONS,
  '--parallel=N    Limit concurrent fanout work for cluster:execOnCluster',
  '--bestEffort    Continue even if some cluster targets fail',
];

const POLICY_OPTIONS = [
  ...OUTPUT_OPTIONS,
  `--timeout=MS    Override RPC timeout (default ${DEFAULT_RPC_TIMEOUT_MS}ms)`,
  '--trace=ID      Attach a trace id to the request',
];

/**
 * Handles as array.
 * @param value Value to process.
 */
function asArray(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * Formats help spec.
 * @param name Name value.
 * @param help Help.
 */
function formatHelpSpec(name: string, help: HelpSpec): string {
  const lines = [name, '', help.summary];
  const usage = asArray(help.usage);
  if (usage.length > 0) {
    lines.push('', 'Usage:');
    for (const entry of usage) {
      lines.push(`  ${entry}`);
    }
  }
  if (help.options && help.options.length > 0) {
    lines.push('', 'Options:');
    for (const entry of help.options) {
      lines.push(`  ${entry}`);
    }
  }
  if (help.examples && help.examples.length > 0) {
    lines.push('', 'Examples:');
    for (const entry of help.examples) {
      lines.push(`  ${entry}`);
    }
  }
  return lines.join('\n');
}

/**
 * Formats base help.
 * @param registry Registry.
 */
function formatBaseHelp(registry: CoordCommandRegistry): string {
  const lines = [
    'Base commands',
    '',
    'Use these to manage local coord daemons and supporting state before running targeted RPC commands.',
    '',
  ];
  for (const command of registry.listBase()) {
    const help = registry.helpFor(command);
    lines.push(`  -${command.padEnd(14)}${help?.summary ?? ''}`);
  }
  lines.push('', 'Try one command in detail:', '  ./scripts/coord -help start');
  return lines.join('\n');
}

/**
 * Formats group help.
 * @param group Group.
 * @param registry Registry.
 */
function formatGroupHelp(
  group: string,
  registry: CoordCommandRegistry,
): string {
  const lines = [`${group} commands`, ''];
  if (group === 'foundation') {
    lines.push(
      'Foundation commands are the default when you use a bare command such as `-whoami` or `-peers`.',
      '',
    );
  }
  for (const command of registry.listGroupCommands(group)) {
    const help = registry.helpFor(command);
    lines.push(`  ${command.padEnd(30)}${help?.summary ?? ''}`);
  }
  lines.push(
    '',
    `Try one command in detail:`,
    `  ./scripts/coord -help ${registry.listGroupCommands(group)[0]}`,
  );
  return lines.join('\n');
}

/**
 * Formats overview.
 * @param registry Registry.
 */
function formatOverview(registry: CoordCommandRegistry): string {
  const lines = [
    'coord CLI',
    '',
    'Run `./scripts/coord` with no arguments to show this overview again.',
    '',
    'First-time quick start:',
    '  ./scripts/coord -start:4101 A',
    '  ./scripts/coord -stor',
    '  ./scripts/coord -start:4104 P',
    '  ./scripts/coord -status',
    '  ./scripts/coord -whoami',
    '  ./scripts/coord -connect @P',
    '  ./scripts/coord -peers',
    '  ./scripts/coord -stop all',
    '  ./scripts/coord -restore',
    '',
    'Default networking:',
    '  -start:PORT binds on all interfaces by default',
    '  coord auto-advertises a non-loopback IP when one is available',
    '  -connect is persistent by default; use --ttl=0 for runtime-only',
    '',
    'Syntax:',
    '  coord [@sender] -command [@target|%cluster] [args...] [--options...]',
    '',
    'Selectors:',
    '  @A                 node id or learned peer name',
    '  @157.250.198.83:4101 direct address',
    '  %offline           cluster name',
    '  @./file.txt        file payload shortcut',
    '  f:./file.txt       explicit file payload syntax',
    '',
    'Base commands:',
  ];
  for (const command of registry.listBase()) {
    const help = registry.helpFor(command);
    lines.push(`  -${command.padEnd(14)}${help?.summary ?? ''}`);
  }
  lines.push('', 'Command groups:');
  for (const group of registry.listGroups()) {
    const commandNames = registry
      .listGroupCommands(group)
      .map((command) => command.split(':', 2)[1])
      .join(' ');
    lines.push(`  ${group.padEnd(14)}${commandNames}`);
  }
  lines.push(
    '',
    'More help:',
    '  ./scripts/coord -help base',
    '  ./scripts/coord -help foundation',
    '  ./scripts/coord -help foundation:connect',
    '  ./scripts/coord -help cluster',
  );
  return lines.join('\n');
}

/**
 * Handles register help.
 * @param registry Registry.
 */
function registerHelp(registry: CoordCommandRegistry): void {
  registry.registerBase(
    'help',
    async (inv) => {
      const topic = String(inv.baseArgs?.[0] ?? 'all');
      if (topic === 'all' || topic === 'overview') {
        return formatOverview(registry);
      }
      if (topic === 'base') {
        return formatBaseHelp(registry);
      }
      const baseName = topic.startsWith('base:')
        ? topic.slice('base:'.length)
        : topic;
      if (registry.hasBase(baseName)) {
        return formatHelpSpec(`-${baseName}`, registry.helpFor(baseName)!);
      }
      if (topic.includes(':')) {
        const help = registry.helpFor(topic);
        if (!help) {
          throw new Error(`No help registered for ${topic}`);
        }
        return formatHelpSpec(topic, help);
      }
      const groupCommands = registry.listGroupCommands(topic);
      if (groupCommands.length === 0) {
        throw new Error(`No help registered for ${topic}`);
      }
      return formatGroupHelp(topic, registry);
    },
    {
      summary: 'Show coord help',
      usage: [
        'coord -help',
        'coord -help base',
        'coord -help foundation',
        'coord -help foundation:echo',
      ],
      examples: [
        './scripts/coord',
        './scripts/coord -help',
        './scripts/coord -help foundation',
        './scripts/coord -help cluster:join',
      ],
    },
  );
}

type ResolvedSender = {
  rpcTarget: RpcTarget;
  nodeId?: string;
  addr?: string;
};

/**
 * Resolves sender.
 * @param files Files.
 * @param inv Inv.
 */
async function resolveSender(
  files: PlaygroundFiles,
  inv: Invocation,
): Promise<ResolvedSender> {
  if (inv.sender.kind === 'addr') {
    return {
      rpcTarget: { addr: inv.sender.value },
      addr: inv.sender.value,
    };
  }
  if (inv.sender.kind === 'node') {
    const senderNodeId = inv.sender.value;
    const nodes = await loadNodes(files);
    const record = nodes.find((item) => item.nodeId === senderNodeId);
    if (!record) {
      throw new Error(`Unknown local node "${senderNodeId}"`);
    }
    return {
      rpcTarget: { addr: record.addr },
      nodeId: record.nodeId,
      addr: record.addr,
    };
  }

  const nodes = await loadNodes(files);
  if (nodes.length === 0) {
    throw new Error(
      'No local coord node is available. Start one first with "coord -start:4102 A".',
    );
  }
  if (nodes.length === 1) {
    return {
      rpcTarget: { addr: nodes[0].addr },
      nodeId: nodes[0].nodeId,
      addr: nodes[0].addr,
    };
  }

  const healthy: PlaygroundNodeRecord[] = [];
  for (const node of nodes) {
    if (await waitForHttpNode(node.addr, 250)) {
      healthy.push(node);
    }
  }
  if (healthy.length === 1) {
    return {
      rpcTarget: { addr: healthy[0].addr },
      nodeId: healthy[0].nodeId,
      addr: healthy[0].addr,
    };
  }
  throw new Error(
    'Multiple local coord nodes are configured. Specify a sender first, for example "coord @A -peers".',
  );
}

/**
 * Normalizes exec target.
 * @param target Target selector.
 */
function normalizeExecTarget(
  target: Invocation['target'],
):
  | { kind: 'node'; value: string }
  | { kind: 'addr'; value: string }
  | undefined {
  if (target.kind === 'node' || target.kind === 'addr') {
    return { kind: target.kind, value: target.value };
  }
  return undefined;
}

/**
 * Handles selector to RPC target.
 * @param target Target selector.
 */
function selectorToRpcTarget(target: Invocation['target']): RpcTarget {
  if (target.kind === 'addr') {
    return { addr: target.value };
  }
  if (target.kind === 'node') {
    return { nodeId: target.value };
  }
  throw new Error(
    `Target kind ${target.kind} is not supported for this command`,
  );
}

/**
 * Normalizes node arg.
 * @param value Value to process.
 */
function normalizeNodeArg(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.startsWith('@')) {
    return text.slice(1);
  }
  return text;
}

/**
 * Normalizes exec command.
 * @param inv Inv.
 */
function normalizeExecCommand(inv: Invocation): string {
  if (
    typeof inv.params.command === 'string' &&
    inv.params.command.trim().length > 0
  ) {
    return inv.params.command.trim();
  }
  if (typeof inv.params.cmd === 'string' && inv.params.cmd.trim().length > 0) {
    return inv.params.cmd.trim();
  }
  return inv.args
    .map((value) => String(value))
    .join(' ')
    .trim();
}

/**
 * Parses only OS option.
 * @param inv Inv.
 */
function parseOnlyOsOption(inv: Invocation): string[] {
  const raw =
    inv.params.onlyOs ??
    inv.params.os ??
    inv.options.onlyOs ??
    inv.options['only-os'] ??
    inv.options.os;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => item.length > 0);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
  }
  return [];
}

/**
 * Formats TTL.
 * @param ms Duration in milliseconds.
 */
function formatTtl(ms: number | null): string {
  if (ms === null) {
    return '-';
  }
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * Formats peer table.
 * @param table Table descriptor.
 */
function formatPeerTable(table: {
  nodeId: string;
  entries: Array<{
    nodeId: string;
    via: string;
    ways: string;
    ttlRemainingMs: number | null;
    state: string;
  }>;
}): string {
  const lines = [
    `coord peers on ${table.nodeId}`,
    '',
    'NAME      VIA               WAYS   TTL      STATE',
  ];
  if (table.entries.length === 0) {
    lines.push('no known peers');
    return lines.join('\n');
  }
  for (const entry of table.entries) {
    lines.push(
      `${entry.nodeId.padEnd(9)} ${entry.via.padEnd(17)} ${entry.ways.padEnd(6)} ${formatTtl(entry.ttlRemainingMs).padEnd(8)} ${entry.state}`,
    );
  }
  return lines.join('\n');
}

/**
 * Formats route table.
 * @param table Table descriptor.
 */
function formatRouteTable(table: RouteTable): string {
  const lines = [
    `coord routes on ${table.nodeId}`,
    '',
    `proxy mode: ${table.proxyMode.enabled ? 'on' : 'off'}${table.proxyMode.defaultDstNodeId ? ` -> ${table.proxyMode.defaultDstNodeId}` : ''}`,
    `learn ttl: ${Math.floor(table.observationTtlMs / 1000)}s`,
  ];
  if (table.entries.length === 0) {
    lines.push('', 'no known routes');
    return lines.join('\n');
  }
  lines.push(
    '',
    'DEST      VIA               WAYS   TTL      STATE       PATH',
  );
  for (const entry of table.entries) {
    lines.push(
      `${entry.nodeId.padEnd(9)} ${entry.via.padEnd(17)} ${entry.ways.padEnd(6)} ${formatTtl(entry.ttlRemainingMs).padEnd(8)} ${entry.state.padEnd(11)} ${entry.path}`,
    );
  }
  return lines.join('\n');
}

/**
 * Returns whether exec command result.
 * @param value Value to process.
 */
function isExecCommandResult(value: unknown): value is {
  command: string;
  osType: string;
  supported: boolean;
  skipped: boolean;
  reason?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'command' in value &&
    'osType' in value &&
    'stdout' in value &&
    'stderr' in value
  );
}

/**
 * Formats exec command result.
 */
function formatExecCommandResult(result: {
  command: string;
  osType: string;
  supported: boolean;
  skipped: boolean;
  reason?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  const lines = [
    'coord exec',
    '',
    `os: ${result.osType}`,
    `command: ${result.command}`,
    `supported: ${result.supported ? 'yes' : 'no'}`,
    `skipped: ${result.skipped ? 'yes' : 'no'}`,
  ];
  if (result.reason) {
    lines.push(`reason: ${result.reason}`);
  }
  lines.push(
    `exit code: ${result.exitCode === null ? '-' : String(result.exitCode)}`,
  );
  if (result.signal) {
    lines.push(`signal: ${result.signal}`);
  }
  lines.push(`timed out: ${result.timedOut ? 'yes' : 'no'}`);
  if (result.stdout) {
    lines.push('', 'stdout:', result.stdout);
  }
  if (result.stderr) {
    lines.push('', 'stderr:', result.stderr);
  }
  return lines.join('\n');
}

/**
 * Formats storage info.
 * @param info Table metadata.
 * @param extras Extras.
 */
function formatStorageInfo(
  info: CoordStorageInfo,
  extras?: {
    switchedFrom?: CoordStorageInfo;
    migratedKeys?: number;
    restartedNodes?: string[];
  },
): string {
  const lines = [
    'coord storage',
    '',
    `root: ${info.rootDir}`,
    `policy: ${info.policy}`,
    `backend: ${info.backend}`,
    `location: ${info.location}`,
  ];
  if (info.schema) {
    lines.push(`schema: ${info.schema}`);
  }
  lines.push(`status: ${info.status}`);
  if (info.preferredBackend && info.preferredBackend !== info.backend) {
    lines.push(`preferred backend: ${info.preferredBackend}`);
  }
  if (info.fallback) {
    lines.push(
      `fallback: ${info.fallback.backend} ${info.fallback.location}${info.fallback.schema ? ` schema=${info.fallback.schema}` : ''}`,
    );
  }
  if (info.note) {
    lines.push(`note: ${info.note}`);
  }
  if (extras?.switchedFrom) {
    lines.push(
      '',
      `migrated from: ${extras.switchedFrom.backend} ${extras.switchedFrom.location}`,
    );
  }
  if (typeof extras?.migratedKeys === 'number') {
    lines.push(`migrated keys: ${extras.migratedKeys}`);
  }
  if (extras?.restartedNodes) {
    lines.push(
      `restarted nodes: ${extras.restartedNodes.length === 0 ? 'none' : extras.restartedNodes.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Handles collect running nodes.
 * @param files Files.
 */
async function collectRunningNodes(
  files: PlaygroundFiles,
): Promise<PlaygroundNodeRecord[]> {
  const running: PlaygroundNodeRecord[] = [];
  for (const node of await loadNodes(files)) {
    if (
      (node.pid && isPidAlive(node.pid)) ||
      (await waitForHttpNode(node.addr, 250))
    ) {
      running.push(node);
    }
  }
  return running;
}

/**
 * Stops nodes.
 * @param files Files.
 * @param targetNodeIds Target node ids.
 */
async function stopNodes(
  files: PlaygroundFiles,
  targetNodeIds: string[],
): Promise<string[]> {
  const nodes = await loadNodes(files);
  const selected = nodes.filter((item) => targetNodeIds.includes(item.nodeId));
  const stopped: string[] = [];
  for (const node of selected) {
    if (node.pid && isPidAlive(node.pid)) {
      await killPidGracefully(node.pid, 3000);
    }
    stopped.push(node.nodeId);
  }
  const remaining = nodes.map((node) =>
    stopped.includes(node.nodeId) ? { ...node, pid: undefined } : node,
  );
  await saveNodes(files, remaining);
  const cache = await loadCache(files);
  for (const nodeId of stopped) {
    delete cache[nodeId];
  }
  await saveCache(files, cache);
  return stopped;
}

/**
 * Starts node daemon.
 * @param files Files.
 * @param nodeId Node identifier.
 * @param port TCP port.
 * @param configPath Configuration path.
 */
async function startNodeDaemon(
  files: PlaygroundFiles,
  nodeId: string,
  port: number,
  configPath?: string,
): Promise<PlaygroundNodeRecord> {
  const fromConfig = configPath ? await loadNodeConfig(String(configPath)) : {};
  const network = resolveNodeAddresses(port, fromConfig);
  const record: PlaygroundNodeRecord = {
    nodeId,
    nodeEpoch: randomId('epoch'),
    port,
    addr: network.primaryAddr,
    configPath: configPath ? resolve(String(configPath)) : undefined,
    startedAtMs: Date.now(),
    props: fromConfig.props ?? { type: 'dev' },
    clusterId:
      typeof fromConfig.clusterId === 'string'
        ? fromConfig.clusterId
        : undefined,
    eligible:
      typeof fromConfig.eligible === 'boolean'
        ? fromConfig.eligible
        : undefined,
    priority:
      typeof fromConfig.priority === 'number' ? fromConfig.priority : undefined,
  };
  const nodes = await loadNodes(files);
  const existing = nodes.find((item) => item.nodeId === nodeId);
  if (existing?.pid && isPidAlive(existing.pid)) {
    const healthy = await waitForHttpNode(existing.addr, 500);
    if (healthy) {
      return {
        ...existing,
        nodeEpoch: healthy.nodeEpoch,
      };
    }
  }
  const existingOnAddr = nodes.find(
    (item) => item.addr === record.addr && item.nodeId !== nodeId,
  );
  if (existingOnAddr) {
    const healthy = await waitForHttpNode(existingOnAddr.addr, 500);
    if (healthy) {
      throw new Error(
        `Address ${record.addr} is already serving node ${healthy.nodeId}`,
      );
    }
  }
  const healthyOnAddr = await waitForHttpNode(network.healthAddr, 200);
  if (healthyOnAddr && healthyOnAddr.nodeId !== nodeId) {
    throw new Error(
      `Address ${record.addr} is already serving node ${healthyOnAddr.nodeId}`,
    );
  }
  const daemonArgs = [
    '--import',
    'tsx',
    COORD_SERVE_ENTRY,
    '-serve',
    nodeId,
    String(port),
    record.nodeEpoch,
  ];
  if (record.configPath) {
    daemonArgs.push(record.configPath);
  }
  const child = spawn(process.execPath, daemonArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      COORD_PLAYGROUND_ROOT: files.rootDir,
    },
  });
  child.unref();
  record.pid = child.pid;
  const next = nodes.filter((item) => item.nodeId !== nodeId);
  next.push(record);
  await saveNodes(files, next);
  const healthy = await waitForExpectedHttpNode(
    network.healthAddr,
    record.nodeId,
    record.nodeEpoch,
    15000,
  );
  if (!healthy) {
    if (record.pid) {
      await killPidGracefully(record.pid, 1000);
    }
    await saveNodes(
      files,
      next.filter((item) => item.nodeId !== nodeId),
    );
    const occupant = await waitForHttpNode(network.healthAddr, 300);
    if (occupant) {
      throw new Error(
        `Address ${network.healthAddr} is serving ${occupant.nodeId}, not ${record.nodeId}`,
      );
    }
    throw new Error(
      `Timed out waiting for daemon ${nodeId} at ${network.healthAddr}`,
    );
  }
  return {
    ...record,
    nodeEpoch: healthy.nodeEpoch,
  };
}

/**
 * Handles call sender exec.
 * @param files Files.
 * @param inv Inv.
 * @param remoteMethod Remote method.
 * @param params SQL parameters.
 * @param opts Optional call options.
 */
async function callSenderExec(
  files: PlaygroundFiles,
  inv: Invocation,
  remoteMethod: string,
  params: unknown,
  opts?: { wrapRoute?: boolean },
): Promise<unknown> {
  const runtime = await buildRuntime(files);
  try {
    const sender = await resolveSender(files, inv);
    const senderNodeId = sender.nodeId;
    const response = await runtime.client.call<{
      result: unknown;
      route: {
        contactedNodeId: string;
        executedNodeId: string;
        mode: 'local' | 'direct' | 'proxy';
        nextHopNodeId: string;
        path: string[];
        hops: Array<{ from: string; to: string; kind: 'direct' | 'reverse' }>;
      };
    }>(
      sender.rpcTarget,
      'cord.foundation.exec',
      {
        method: remoteMethod,
        params,
        dst: normalizeExecTarget(inv.target),
        timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        traceId:
          typeof inv.options.trace === 'string' ? inv.options.trace : undefined,
      },
      {
        timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        traceId:
          typeof inv.options.trace === 'string' ? inv.options.trace : undefined,
        auth: authForCli(runtime.client),
        originNodeId: senderNodeId,
      },
    );
    if (inv.options.verbose === true || opts?.wrapRoute) {
      return {
        route: response.route,
        path:
          response.route.hops.length === 0
            ? response.route.executedNodeId
            : response.route.hops.reduce(
                (text, hop, index) =>
                  (index === 0 ? hop.from : text) +
                  (hop.kind === 'reverse' ? ` -< ${hop.to}` : ` -> ${hop.to}`),
                '',
              ),
        result: response.result,
      };
    }
    return response.result;
  } finally {
    await stopRuntime(runtime);
  }
}

/**
 * Handles call sender method.
 * @param files Files.
 * @param inv Inv.
 * @param method Method.
 * @param params SQL parameters.
 */
async function callSenderMethod(
  files: PlaygroundFiles,
  inv: Invocation,
  method: string,
  params: unknown,
): Promise<unknown> {
  const runtime = await buildRuntime(files);
  try {
    const sender = await resolveSender(files, inv);
    const senderNodeId = sender.nodeId;
    return runtime.client.call(sender.rpcTarget, method, params, {
      timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
      traceId:
        typeof inv.options.trace === 'string' ? inv.options.trace : undefined,
      auth: authForCli(runtime.client),
      originNodeId: senderNodeId,
    });
  } finally {
    await stopRuntime(runtime);
  }
}

/**
 * Handles register base commands.
 * @param registry Registry.
 * @param files Files.
 */
function registerBaseCommands(
  registry: CoordCommandRegistry,
  files: PlaygroundFiles,
): void {
  registry.registerBase(
    'start',
    async (inv) => {
      const [nodeNameRaw, configPath] = inv.baseArgs ?? [];
      const nodeId = String(
        nodeNameRaw ?? `node-${Math.random().toString(36).slice(2, 6)}`,
      );
      const port = inv.baseCmdPort ?? 4001;
      const storage = await openCoordStorage(storageFilesFor(files), {
        allowAutoUpgrade: true,
      });
      await storage.cleanup();
      const record = await startNodeDaemon(
        files,
        nodeId,
        port,
        configPath ? String(configPath) : undefined,
      );
      return {
        ok: true,
        nodeId: record.nodeId,
        nodeEpoch: record.nodeEpoch,
        addr: record.addr,
        port: record.port,
        pid: record.pid,
        mode: 'daemon',
        persistedTo: storage.info.location,
        storage: storage.info,
      };
    },
    {
      summary: 'Start one background coord daemon',
      usage: [
        'coord -start[:port] [node_name] [config.json|config.js]',
        'coord -start:4101 A ./src/cord/playground/configs/A.json',
      ],
      examples: [
        './scripts/coord -start:4101 A',
        './scripts/coord -start:4102 B ./src/cord/playground/configs/B.json',
      ],
      options: [
        ...OUTPUT_OPTIONS,
        'Default networking binds on all interfaces and auto-advertises a non-loopback address.',
        'Storage is created automatically: sqlite first, file fallback if sqlite is unavailable.',
      ],
    },
  );

  registry.registerBase(
    'restore',
    async (inv) => {
      const nodes = await loadNodes(files);
      const runningBefore = new Set(
        (await collectRunningNodes(files)).map((node) => node.nodeId),
      );
      const restarted: string[] = [];
      const reused: string[] = [];
      const restoreResults: Array<{
        nodeId: string;
        attempted: string[];
        restored: string[];
        failed: Array<{ target: string; error: string }>;
      }> = [];
      const startedAfterRestore = new Set<string>();

      for (const node of nodes) {
        const record = await startNodeDaemon(
          files,
          node.nodeId,
          node.port,
          node.configPath,
        );
        startedAfterRestore.add(record.nodeId);
        if (runningBefore.has(node.nodeId)) {
          reused.push(record.nodeId);
        } else {
          restarted.push(record.nodeId);
        }
      }

      const runtime = await buildRuntime(files);
      try {
        for (const nodeId of [...startedAfterRestore].sort()) {
          const nodesAfter = await loadNodes(files);
          const record = nodesAfter.find((item) => item.nodeId === nodeId);
          if (!record) {
            continue;
          }
          const result = await runtime.client.call<{
            ok: true;
            attempted: string[];
            restored: string[];
            failed: Array<{ target: string; error: string }>;
          }>(
            { addr: record.addr },
            'cord.foundation.restore',
            {},
            {
              timeoutMs: Number(
                inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
              ),
              traceId:
                typeof inv.options.trace === 'string'
                  ? inv.options.trace
                  : undefined,
              auth: authForCli(runtime.client),
              originNodeId: record.nodeId,
            },
          );
          restoreResults.push({ nodeId, ...result });
        }
      } finally {
        await stopRuntime(runtime);
      }

      const summary = {
        ok: true,
        root: files.rootDir,
        configuredNodes: nodes.map((node) => node.nodeId),
        restarted,
        alreadyRunning: reused,
        restoredConnections: restoreResults,
      };
      return inv.options.json === true
        ? summary
        : [
            'coord restore',
            '',
            `root: ${files.rootDir}`,
            `configured nodes: ${nodes.length === 0 ? 'none' : nodes.map((node) => node.nodeId).join(', ')}`,
            `restarted nodes: ${restarted.length === 0 ? 'none' : restarted.join(', ')}`,
            `already running: ${reused.length === 0 ? 'none' : reused.join(', ')}`,
            ...restoreResults.flatMap((item) => [
              '',
              `${item.nodeId} connections`,
              `  attempted: ${item.attempted.length === 0 ? 'none' : item.attempted.join(', ')}`,
              `  restored: ${item.restored.length === 0 ? 'none' : item.restored.join(', ')}`,
              `  failed: ${item.failed.length === 0 ? 'none' : item.failed.map((failure) => `${failure.target} (${failure.error})`).join(', ')}`,
            ]),
          ].join('\n');
    },
    {
      summary:
        'Restart configured nodes from the durable store and replay persistent connections',
      usage: 'coord -restore',
      examples: ['./scripts/coord -restore', './scripts/coord -restore --json'],
      options: POLICY_OPTIONS,
    },
  );

  registry.registerBase(
    'discover',
    async (inv) => {
      const [portsRaw, ttlRaw] = inv.baseArgs ?? [];
      const ttlSecs = Number(ttlRaw ?? 600);
      const ports =
        typeof portsRaw === 'string'
          ? new Set(portsRaw.split(',').filter(Boolean))
          : null;
      const discovered: Record<string, DiscoveryCacheEntry> = {};
      for (const node of await loadNodes(files)) {
        const portText = String(node.port);
        if (ports && !ports.has(portText)) {
          continue;
        }
        const info = await waitForHttpNode(node.addr, 400);
        if (!info) {
          continue;
        }
        discovered[info.nodeId] = {
          nodeId: info.nodeId,
          addr: info.addrs?.[0] ?? node.addr,
          nodeEpoch: info.nodeEpoch,
          lastSeenMs: Date.now(),
        };
      }
      await saveCache(files, discovered);
      return {
        ok: true,
        ttlSecs,
        discovered: Object.values(discovered),
        cachePath: files.cachePath,
      };
    },
    {
      summary: 'Discover configured coord nodes and refresh the cache',
      usage: 'coord -discover [port1[,port2...]] [ttl_in_secs]',
      examples: ['./scripts/coord -discover 4101,4102,4103 600'],
    },
  );

  registry.registerBase(
    'stop',
    async (inv) => {
      const targetNodeId = String(inv.baseArgs?.[0] ?? 'all');
      const nodes = await loadNodes(files);
      const selected =
        targetNodeId === 'all'
          ? nodes
          : nodes.filter((item) => item.nodeId === targetNodeId);
      if (selected.length === 0) {
        throw new Error(`Unknown node "${targetNodeId}"`);
      }
      const stopped = await stopNodes(
        files,
        selected.map((node) => node.nodeId),
      );
      return {
        ok: true,
        stopped,
      };
    },
    {
      summary: 'Stop one daemon or all daemons from the current coord root',
      usage: ['coord -stop [node_name]', 'coord -stop all'],
      examples: ['./scripts/coord -stop A', './scripts/coord -stop all'],
    },
  );

  registry.registerBase(
    'status',
    async () => formatStatusTable(files, await collectNodeStatuses(files)),
    {
      summary: 'Show node processes and health for the current coord root',
      usage: 'coord -status',
      examples: ['./scripts/coord -status'],
    },
  );

  registry.registerBase(
    'stor',
    async (inv) => {
      if (inv.sender.kind === 'addr' || inv.target.kind === 'addr') {
        throw new Error(
          'storage commands are local to the current coord root and cannot target @host:port',
        );
      }
      const backendRaw =
        typeof inv.baseArgs?.[0] === 'string'
          ? String(inv.baseArgs[0]).toLowerCase()
          : '';
      if (!backendRaw) {
        const info = await inspectCoordStorage(storageFilesFor(files));
        return inv.options.json === true ? info : formatStorageInfo(info);
      }

      if (
        backendRaw !== 'sqlite' &&
        backendRaw !== 'psql' &&
        backendRaw !== 'file'
      ) {
        throw new Error(
          'stor backend must be one of "sqlite", "psql", or "file"',
        );
      }

      const locationRaw =
        typeof inv.baseArgs?.[1] === 'string'
          ? String(inv.baseArgs[1])
          : undefined;
      if (
        backendRaw === 'psql' &&
        !locationRaw &&
        typeof inv.options.url !== 'string' &&
        process.env.COORD_PSQL_URL === undefined
      ) {
        throw new Error(
          'stor psql requires a real Postgres connection string argument, --url=..., or COORD_PSQL_URL',
        );
      }
      const running = await collectRunningNodes(files);
      if (running.length > 0) {
        await stopNodes(
          files,
          running.map((node) => node.nodeId),
        );
      }

      try {
        const result = await switchCoordStorage(storageFilesFor(files), {
          backend: backendRaw,
          location:
            backendRaw === 'psql'
              ? (locationRaw ??
                (typeof inv.options.url === 'string'
                  ? String(inv.options.url)
                  : process.env.COORD_PSQL_URL))
              : locationRaw,
          schema:
            typeof inv.options.schema === 'string'
              ? String(inv.options.schema)
              : undefined,
        });
        const restarted: string[] = [];
        for (const node of running) {
          const started = await startNodeDaemon(
            files,
            node.nodeId,
            node.port,
            node.configPath,
          );
          restarted.push(started.nodeId);
        }
        const summary = {
          ...result,
          restartedNodes: restarted,
        };
        return inv.options.json === true
          ? summary
          : formatStorageInfo(result.to, {
              switchedFrom: result.from,
              migratedKeys: result.migratedKeys,
              restartedNodes: restarted,
            });
      } catch (error) {
        for (const node of running) {
          try {
            await startNodeDaemon(
              files,
              node.nodeId,
              node.port,
              node.configPath,
            );
          } catch {
            // Best-effort restart after failed migration.
          }
        }
        throw error;
      }
    },
    {
      summary: 'Inspect or switch the durable store for the current coord root',
      usage: [
        'coord -stor',
        'coord -stor sqlite [path.sqlite]',
        'coord -stor file [path.json]',
        'coord -stor psql postgres://user:pass@host/db --schema=coord_root',
      ],
      examples: [
        './scripts/coord -stor',
        './scripts/coord -stor sqlite',
        './scripts/coord -stor file ./tmp/coord.backup.json',
        './scripts/coord -stor psql $COORD_PSQL_URL --schema=coord_root',
      ],
      options: [
        ...OUTPUT_OPTIONS,
        '--schema=NAME   Postgres schema name when using -stor psql',
        '--url=URL       Alternative way to provide the Postgres connection string',
      ],
    },
  );

  registry.registerBase(
    'cleanup',
    async (inv) => {
      const scope = String(inv.baseArgs?.[0] ?? 'local');
      const killedGlobal: number[] = [];
      if (scope === 'global') {
        for (const pid of await listGlobalCoordServePids()) {
          if (await killPidGracefully(pid, 1000)) {
            killedGlobal.push(pid);
          }
        }
      }

      const nodes = await loadNodes(files);
      const cache = await loadCache(files);
      const cleanedNodes: PlaygroundNodeRecord[] = [];
      const clearedNodeIds: string[] = [];

      for (const node of nodes) {
        const processAlive = isPidAlive(node.pid);
        const daemonMatches = processAlive
          ? await isCoordServePid(node.pid)
          : false;
        const healthy = (await waitForHttpNode(node.addr, 250)) !== null;

        if (node.pid && processAlive && daemonMatches && !healthy) {
          await killPidGracefully(node.pid, 1000);
        }

        const keepPid =
          node.pid &&
          isPidAlive(node.pid) &&
          (await isCoordServePid(node.pid)) &&
          healthy
            ? node.pid
            : undefined;
        if (!keepPid) {
          clearedNodeIds.push(node.nodeId);
          delete cache[node.nodeId];
        }
        cleanedNodes.push({
          ...node,
          pid: keepPid,
        });
      }

      await saveNodes(files, cleanedNodes);
      await saveCache(files, cache);
      return [
        `coord cleanup complete (${scope})`,
        '',
        `root: ${files.rootDir}`,
        `cleared stale pids: ${clearedNodeIds.length === 0 ? 'none' : clearedNodeIds.join(', ')}`,
        `killed global daemons: ${killedGlobal.length === 0 ? 'none' : killedGlobal.join(', ')}`,
      ].join('\n');
    },
    {
      summary:
        'Clear dead local records and optionally stop all coord daemons from this repo',
      usage: ['coord -cleanup', 'coord -cleanup global'],
      examples: ['./scripts/coord -cleanup', './scripts/coord -cleanup global'],
    },
  );

  registry.registerBase(
    'save',
    async (inv) => {
      const targetPath = resolve(String(inv.baseArgs?.[0] ?? files.nodesPath));
      const state: SavedPlaygroundState = {
        nodes: await loadNodes(files),
        cache: await loadCache(files),
      };
      await writeJsonFile(targetPath, state);
      return { ok: true, savedTo: targetPath };
    },
    {
      summary: 'Save the current node catalog and discovery cache',
      usage: 'coord -save [config.json]',
      examples: ['./scripts/coord -save ./tmp/coord.export.json'],
    },
  );

  registry.registerBase(
    'load',
    async (inv) => {
      const sourcePath = resolve(String(inv.baseArgs?.[0] ?? files.nodesPath));
      const loaded = await readJsonFile<
        PlaygroundNodeRecord[] | SavedPlaygroundState
      >(sourcePath, []);
      const state: SavedPlaygroundState = Array.isArray(loaded)
        ? { nodes: loaded, cache: {} }
        : { nodes: loaded.nodes ?? [], cache: loaded.cache ?? {} };
      await saveNodes(files, state.nodes);
      await saveCache(files, state.cache);
      return {
        ok: true,
        loadedFrom: sourcePath,
        count: state.nodes.length,
        cached: Object.keys(state.cache).length,
      };
    },
    {
      summary:
        'Load a node catalog and discovery cache into the active coord root',
      usage: 'coord -load [config.json]',
      examples: ['./scripts/coord -load ./tmp/coord.export.json'],
    },
  );
}

/**
 * Handles register targeted commands.
 * @param registry Registry.
 * @param files Files.
 */
function registerTargetedCommands(
  registry: CoordCommandRegistry,
  files: PlaygroundFiles,
): void {
  /**
   * Handles command help.
   * @param summary Summary.
   * @param usage Usage.
   * @param examples Examples.
   * @param options Operation options.
   */
  const commandHelp = (
    summary: string,
    usage: string | string[],
    examples: string[],
    options = RPC_OPTIONS,
  ): HelpSpec => ({
    summary,
    usage,
    examples,
    options,
  });

  /**
   * Handles RPC command.
   * @param fullCmd Full cmd.
   * @param remoteMethod Remote method.
   * @param buildParams Build params.
   * @param help Help.
   */
  const rpcCommand = (
    fullCmd: string,
    remoteMethod: string,
    buildParams: (inv: Invocation) => Promise<unknown> | unknown,
    help: HelpSpec,
  ) => {
    registry.registerCmd(
      fullCmd,
      async (inv) =>
        callSenderMethod(files, inv, remoteMethod, await buildParams(inv)),
      help,
    );
  };

  registry.registerCmd(
    'foundation:whoami',
    async (inv) => callSenderExec(files, inv, 'cord.foundation.whoami', {}),
    commandHelp(
      'Run whoami on the sender or the selected peer',
      ['coord -whoami', 'coord -whoami @vps', 'coord @D -whoami @A'],
      [
        './scripts/coord -whoami',
        './scripts/coord -whoami @157.250.198.83:4101',
        './scripts/coord @D -whoami @A',
      ],
    ),
  );
  registry.registerCmd(
    'foundation:ping',
    async (inv) => callSenderExec(files, inv, 'cord.foundation.ping', {}),
    commandHelp(
      'Ping the sender or the selected peer',
      ['coord -ping @vps', 'coord @D -ping @A'],
      [
        './scripts/coord -ping @157.250.198.83:4101',
        './scripts/coord @D -ping @A',
      ],
    ),
  );
  registry.registerCmd(
    'foundation:echo',
    async (inv) =>
      callSenderExec(files, inv, 'cord.foundation.echo', {
        args: inv.args,
        named: inv.params,
        payload: normalizePayload(inv),
      }),
    commandHelp(
      'Echo args or payload on the sender or routed destination',
      [
        'coord -echo hello',
        'coord -echo @A hello',
        'coord @D -echo @A @./src/cord/playground/samples/bigfile.txt',
      ],
      [
        './scripts/coord -echo local test',
        './scripts/coord -echo @vps hello',
        './scripts/coord @D -echo @A @./src/cord/playground/samples/bigfile.txt',
      ],
    ),
  );
  registry.registerCmd(
    'foundation:sleep',
    async (inv) =>
      callSenderExec(files, inv, 'cord.foundation.sleep', {
        ms: Number(inv.params.ms ?? inv.args[0] ?? 0),
      }),
    commandHelp(
      'Sleep on the sender or routed destination',
      ['coord -sleep 200', 'coord @D -sleep @A 200'],
      ['./scripts/coord -sleep 50', './scripts/coord @D -sleep @A 50'],
    ),
  );
  registry.registerCmd(
    'foundation:exec',
    async (inv) => {
      const command = normalizeExecCommand(inv);
      if (!command) {
        throw new Error('exec requires a shell command');
      }
      const result = await callSenderExec(
        files,
        inv,
        'cord.foundation.execCommand',
        {
          command,
          onlyOs: parseOnlyOsOption(inv),
          timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        },
        { wrapRoute: inv.options.verbose === true },
      );
      if (inv.options.json === true) {
        return result;
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        'route' in result &&
        'result' in result &&
        isExecCommandResult((result as { result: unknown }).result)
      ) {
        const wrappedRecord = result as {
          path?: unknown;
          result: Parameters<typeof formatExecCommandResult>[0];
        };
        const path =
          typeof wrappedRecord.path === 'string'
            ? wrappedRecord.path
            : '(route unavailable)';
        return `${formatExecCommandResult(wrappedRecord.result)}\n\npath: ${path}`;
      }
      return formatExecCommandResult(
        result as Parameters<typeof formatExecCommandResult>[0],
      );
    },
    commandHelp(
      'Execute a host shell command on the sender or routed destination',
      [
        'coord -exec uname -a',
        'coord -exec @vps uname -a',
        'coord @D -exec @A uname -a --verbose',
        'coord -exec @vps command="powershell -Command Get-Date" --os=windows',
      ],
      [
        './scripts/coord -exec uname -a',
        './scripts/coord -exec @157.250.198.83:4001 uname -a',
        './scripts/coord @D -exec @A uname -a --verbose',
      ],
      [
        ...POLICY_OPTIONS,
        '--os=LIST      Execute only if the remote OS matches one of the comma-separated values',
        'Supported OS names: linux, windows, macos, android',
      ],
    ),
  );
  registry.registerCmd(
    'foundation:peers',
    async (inv) => {
      const result = await callSenderExec(
        files,
        inv,
        'cord.foundation.peers',
        {},
      );
      return inv.options.json === true
        ? result
        : formatPeerTable(
            result as Awaited<ReturnType<typeof callSenderMethod>> & {
              nodeId: string;
              entries: Array<{
                nodeId: string;
                via: string;
                ways: string;
                ttlRemainingMs: number | null;
                state: string;
              }>;
            },
          );
    },
    commandHelp(
      'Show learned peers on the sender or routed destination',
      ['coord -peers', 'coord -peers @P'],
      ['./scripts/coord -peers', './scripts/coord -peers @P'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'foundation:routes',
    async (inv) => {
      const result = await callSenderExec(
        files,
        inv,
        'cord.foundation.routes',
        {},
      );
      return inv.options.json === true
        ? result
        : formatRouteTable(result as RouteTable);
    },
    commandHelp(
      'Show effective routes on the sender or routed destination',
      ['coord -routes', 'coord -routes @P'],
      ['./scripts/coord -routes', './scripts/coord -routes @P'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'foundation:connect',
    async (inv) => {
      if (inv.target.kind !== 'node' && inv.target.kind !== 'addr') {
        throw new Error('connect requires @node or @host:port');
      }
      const ttlRaw =
        typeof inv.params.ttl === 'number' || typeof inv.params.ttl === 'string'
          ? Number(inv.params.ttl)
          : typeof inv.options.ttl === 'number' ||
              typeof inv.options.ttl === 'string'
            ? Number(inv.options.ttl)
            : undefined;
      const ttlSpecified =
        typeof inv.params.ttl === 'number' ||
        typeof inv.params.ttl === 'string' ||
        typeof inv.options.ttl === 'number' ||
        typeof inv.options.ttl === 'string';
      return callSenderMethod(files, inv, 'cord.foundation.connect', {
        target: normalizeExecTarget(inv.target),
        ttlMs:
          ttlSpecified &&
          typeof ttlRaw === 'number' &&
          Number.isFinite(ttlRaw) &&
          ttlRaw > 0
            ? ttlRaw * 1000
            : undefined,
        persist: ttlSpecified ? ttlRaw !== 0 : true,
      });
    },
    commandHelp(
      'Open a reverse connection from the sender to a direct peer',
      [
        'coord -connect @P',
        'coord -connect @P --ttl=0',
        'coord -connect @157.250.198.83:4104 --ttl=3600',
      ],
      [
        './scripts/coord -connect @P',
        './scripts/coord -connect @P --ttl=0',
        './scripts/coord -connect @157.250.198.83:4104 --ttl=3600',
      ],
      [
        ...POLICY_OPTIONS,
        '--ttl=0       Runtime-only connect; do not restore after restart',
        '--ttl=SECONDS Persistent connect intent that expires after the given TTL',
        'If --ttl is omitted the connect intent is persistent forever.',
      ],
    ),
  );
  registry.registerCmd(
    'foundation:disconnect',
    async (inv) => {
      if (inv.target.kind !== 'node') {
        throw new Error('disconnect requires @node');
      }
      return callSenderMethod(files, inv, 'cord.foundation.disconnect', {
        targetNodeId: inv.target.value,
      });
    },
    commandHelp(
      'Close a reverse connection or drop a reverse peer session',
      ['coord -disconnect @P'],
      ['./scripts/coord -disconnect @P'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'foundation:learn',
    async (inv) => {
      if (inv.target.kind !== 'node' && inv.target.kind !== 'addr') {
        throw new Error('learn requires @node or @host:port');
      }
      return callSenderMethod(files, inv, 'cord.foundation.learn', {
        target: normalizeExecTarget(inv.target),
      });
    },
    commandHelp(
      'Import suggested peers from a remote node',
      ['coord -learn @P'],
      ['./scripts/coord -learn @P'],
      POLICY_OPTIONS,
    ),
  );

  registry.registerCmd(
    'route:add',
    async (inv) => {
      if (inv.target.kind !== 'node') {
        throw new Error('route:add requires a destination like @A');
      }
      return callSenderMethod(files, inv, 'cord.foundation.route', {
        op: 'add',
        targetNodeId: inv.target.value,
        proxyNodeId: inv.args[0] ? normalizeNodeArg(inv.args[0]) : undefined,
      });
    },
    commandHelp(
      'Add an explicit route on the sender',
      ['coord @D -route:add @A @P', 'coord -route:add @B'],
      ['./scripts/coord @D -route:add @A @P'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'route:del',
    async (inv) => {
      if (inv.target.kind !== 'node') {
        throw new Error('route:del requires a destination like @A');
      }
      return callSenderMethod(files, inv, 'cord.foundation.route', {
        op: 'del',
        targetNodeId: inv.target.value,
      });
    },
    commandHelp(
      'Delete an explicit route on the sender',
      ['coord @D -route:del @A'],
      ['./scripts/coord @D -route:del @A'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'route:deny',
    async (inv) => {
      if (inv.target.kind !== 'node') {
        throw new Error('route:deny requires a destination like @A');
      }
      return callSenderMethod(files, inv, 'cord.foundation.route', {
        op: 'deny',
        targetNodeId: inv.target.value,
        direction: String(inv.args[0] ?? 'both'),
      });
    },
    commandHelp(
      'Deny inbound or outbound direct connectivity on the sender',
      ['coord @A -route:deny @C out', 'coord @A -route:deny @C'],
      ['./scripts/coord @A -route:deny @C out'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'proxy:on',
    async (inv) =>
      callSenderMethod(files, inv, 'cord.foundation.proxy', {
        enabled: true,
        defaultDstNodeId:
          inv.target.kind === 'node' ? inv.target.value : undefined,
      }),
    commandHelp(
      'Enable proxy mode on the sender',
      ['coord -proxy:on @D'],
      ['./scripts/coord -proxy:on @D'],
      POLICY_OPTIONS,
    ),
  );
  registry.registerCmd(
    'proxy:off',
    async (inv) =>
      callSenderMethod(files, inv, 'cord.foundation.proxy', {
        enabled: false,
      }),
    commandHelp(
      'Disable proxy mode on the sender',
      ['coord -proxy:off'],
      ['./scripts/coord -proxy:off'],
      POLICY_OPTIONS,
    ),
  );

  rpcCommand(
    'cluster:create',
    'cord.cluster.create',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
      name: inv.params.name,
      props: inv.params.props,
    }),
    commandHelp(
      'Create a cluster on the sender',
      'coord -cluster:create %offline',
      ['./scripts/coord -cluster:create %offline'],
    ),
  );
  rpcCommand(
    'cluster:join',
    'cord.cluster.join',
    async (inv) =>
      ({
        clusterId: String(
          inv.params.clusterId ??
            (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
        ),
        nodeId:
          (await resolveSender(files, inv)).nodeId ??
          String(inv.params.nodeId ?? 'unknown'),
        role: {
          proxyOnly: inv.params.proxyOnly === true,
          canSend: inv.params.canSend !== false,
          canReceive: inv.params.canReceive !== false,
          eligibleLeader: inv.params.eligibleLeader !== false,
        },
        props: {
          priority: inv.params.priority,
          leaseMs: inv.params.leaseMs,
          ...(typeof inv.params.props === 'object' && inv.params.props !== null
            ? (inv.params.props as Record<string, unknown>)
            : {}),
        },
      }) satisfies ClusterNodeConfig,
    commandHelp(
      'Join the sender to a cluster',
      'coord -cluster:join %offline',
      ['./scripts/coord -cluster:join %offline'],
    ),
  );
  rpcCommand(
    'cluster:leave',
    'cord.cluster.leave',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
    }),
    commandHelp('Leave a cluster', 'coord -cluster:leave %offline', [
      './scripts/coord -cluster:leave %offline',
    ]),
  );
  rpcCommand(
    'cluster:nodes',
    'cord.cluster.listNodes',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
    }),
    commandHelp('List nodes in a cluster', 'coord -cluster:nodes %offline', [
      './scripts/coord -cluster:nodes %offline',
    ]),
  );
  rpcCommand(
    'cluster:exec',
    'cord.cluster.execOnCluster',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
      method: String(inv.params.method ?? 'cord.foundation.whoami'),
      params: typeof inv.params.payload === 'object' ? inv.params.payload : {},
      opts: {
        parallel:
          typeof inv.options.parallel === 'number'
            ? inv.options.parallel
            : undefined,
        timeoutMs:
          typeof inv.options.timeoutMs === 'number'
            ? inv.options.timeoutMs
            : undefined,
        bestEffort: inv.options.bestEffort === true ? true : undefined,
      },
    }),
    commandHelp(
      'Fan out a method across a cluster',
      ['coord -cluster:exec %offline method=cord.foundation.whoami'],
      ['./scripts/coord -cluster:exec %offline method=cord.foundation.whoami'],
      FANOUT_OPTIONS,
    ),
  );

  rpcCommand(
    'iam:defineCommand',
    'cord.iam.defineCommand',
    (inv) => ({
      ns: String(inv.params.ns ?? 'default'),
      commandId: String(inv.params.commandId ?? inv.args[0]),
      def: {
        title: String(inv.params.title ?? inv.args[1] ?? inv.params.commandId),
        description: String(
          inv.params.description ?? inv.params.title ?? inv.params.commandId,
        ),
      } satisfies CommandDefinition,
    }),
    commandHelp(
      'Define a command in IAM',
      'coord -iam:defineCommand commandId=cmd:test title=Test',
      ['./scripts/coord -iam:defineCommand commandId=cmd:test title=Test'],
    ),
  );
  rpcCommand(
    'iam:grant',
    'cord.iam.grant',
    (inv) => ({
      ns: String(inv.params.ns ?? 'default'),
      subject: String(inv.params.subject ?? inv.args[0]),
      commandId: String(inv.params.commandId ?? inv.args[1]),
      grant: {
        allow: inv.params.allow !== false,
        mask: typeof inv.params.mask === 'number' ? inv.params.mask : undefined,
        scope: inv.params.scope,
      } satisfies CommandGrant,
    }),
    commandHelp(
      'Grant command access',
      'coord -iam:grant subject=grp:staff commandId=cmd:test allow=true',
      [
        './scripts/coord -iam:grant subject=grp:staff commandId=cmd:test allow=true',
      ],
    ),
  );
  rpcCommand(
    'iam:canInvoke',
    'cord.iam.canInvoke',
    (inv) => ({
      ns: String(inv.params.ns ?? 'default'),
      ctx: {
        userId: String(inv.params.userId ?? inv.args[0] ?? 'user:guest'),
        groups:
          typeof inv.params.groups === 'string'
            ? String(inv.params.groups).split(',')
            : [],
      },
      commandId: String(inv.params.commandId ?? inv.args[1]),
      requestedMask:
        typeof inv.params.mask === 'number' ? inv.params.mask : undefined,
    }),
    commandHelp(
      'Check whether a user can invoke a command',
      'coord -iam:canInvoke userId=user:guest commandId=cmd:test',
      ['./scripts/coord -iam:canInvoke userId=user:guest commandId=cmd:test'],
    ),
  );
  rpcCommand(
    'users:ensureGuest',
    'cord.users.ensureGuest',
    (inv) => ({ ns: String(inv.params.ns ?? 'default') }),
    commandHelp('Ensure the guest user exists', 'coord -users:ensureGuest', [
      './scripts/coord -users:ensureGuest',
    ]),
  );
  rpcCommand(
    'bootstrap:register_unallocated',
    'cord.bootstrap.register_unallocated',
    async (inv) => {
      const sender = await resolveSender(files, inv);
      if (sender.nodeId) {
        const nodes = await loadNodes(files);
        const record = nodes.find((item) => item.nodeId === sender.nodeId);
        if (record) {
          return {
            nodeId: record.nodeId,
            nodeEpoch: 'cli-register',
            addrs: [record.addr],
            props: record.props,
          } satisfies NodeInfo;
        }
      }
      return {
        nodeId: 'unknown',
        nodeEpoch: 'cli-register',
      } satisfies NodeInfo;
    },
    commandHelp(
      'Register the sender as unallocated',
      'coord -bootstrap:register_unallocated',
      ['./scripts/coord -bootstrap:register_unallocated'],
    ),
  );
  rpcCommand(
    'bootstrap:list_unallocated',
    'cord.bootstrap.list_unallocated',
    (inv) => ({ ns: String(inv.params.ns ?? 'default') }),
    commandHelp('List unallocated nodes', 'coord -bootstrap:list_unallocated', [
      './scripts/coord -bootstrap:list_unallocated',
    ]),
  );
  rpcCommand(
    'election:addShard',
    'cord.election.addShard',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
      shard: {
        shardId: String(inv.params.shardId ?? inv.args[1] ?? 'default'),
        weight:
          typeof inv.params.weight === 'number' ? inv.params.weight : undefined,
      },
    }),
    commandHelp(
      'Add a shard',
      'coord -election:addShard %offline shardId=orders weight=3',
      ['./scripts/coord -election:addShard %offline shardId=orders weight=3'],
    ),
  );
  rpcCommand(
    'election:getLeader',
    'cord.election.getLeader',
    (inv) => ({
      clusterId: String(
        inv.params.clusterId ??
          (inv.target.kind === 'cluster' ? inv.target.value : inv.args[0]),
      ),
      shardId: String(inv.params.shardId ?? inv.args[1] ?? 'default'),
    }),
    commandHelp(
      'Get shard leader',
      'coord -election:getLeader %offline shardId=default',
      ['./scripts/coord -election:getLeader %offline shardId=default'],
    ),
  );
}

/**
 * Runs serve mode.
 * @param argv Argv.
 * @param files Files.
 */
async function runServeMode(
  argv: string[],
  files: PlaygroundFiles,
): Promise<number> {
  const [, nodeIdRaw, portRaw, nodeEpochRaw, configPath] = argv;
  const nodeId = String(nodeIdRaw ?? '');
  const port = Number(portRaw ?? 0);
  const nodeEpoch = String(nodeEpochRaw ?? '');
  if (!nodeId || !nodeEpoch || !Number.isFinite(port) || port <= 0) {
    throw new Error(
      'Usage: coord -serve <nodeId> <port> <nodeEpoch> [config.json|config.js]',
    );
  }
  const fromConfig = configPath ? await loadNodeConfig(String(configPath)) : {};
  const network = resolveNodeAddresses(port, fromConfig);
  parseAddr(network.primaryAddr);
  network.listenAddrs.forEach((addr) => parseAddr(addr));

  const storage = await openCoordStorage(storageFilesFor(files), {
    allowAutoUpgrade: false,
  });
  const store = storage.store;
  const registry = new CordRegistry(store);
  const node = new CordNode(registry, {
    nodeId,
    nodeEpoch,
    listenHttp: true,
    listenAddrs: network.listenAddrs,
    addrs: network.advertisedAddrs,
    props: fromConfig.props ?? { type: 'dev' },
    clusterId:
      typeof fromConfig.clusterId === 'string'
        ? fromConfig.clusterId
        : undefined,
    eligible:
      typeof fromConfig.eligible === 'boolean'
        ? fromConfig.eligible
        : undefined,
    priority:
      typeof fromConfig.priority === 'number' ? fromConfig.priority : undefined,
    store,
  });
  try {
    await node.start();
  } catch (error) {
    await storage.cleanup();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    /**
     * Handles shutdown.
     */
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      void node
        .stop()
        .then(async () => {
          await storage.cleanup();
          resolve();
        })
        .catch(reject);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
  return 0;
}

/**
 * Build the full coord command registry for one runtime root.
 *
 * The returned registry is shared by the CLI, playground entrypoint, and tests.
 */
export function createCoordRegistry(
  files = defaultFiles(),
): CoordCommandRegistry {
  const registry = new CoordCommandRegistry();
  registerHelp(registry);
  registerBaseCommands(registry, files);
  registerTargetedCommands(registry, files);
  return registry;
}

/**
 * Execute one `coord` CLI session.
 *
 * This is the canonical entrypoint for the Node runtime. It handles helper
 * serve mode, creates the command registry, and defaults an empty invocation
 * to the help screen.
 */
export async function runCoordCli(
  argv: string[],
  files = defaultFiles(),
): Promise<number> {
  await mkdir(files.rootDir, { recursive: true });
  if (argv[0] === '-serve') {
    return runServeMode(argv, files);
  }
  const registry = createCoordRegistry(files);
  const dispatcher = new CoordDispatcher(registry);
  return dispatcher.dispatch(argv.length === 0 ? ['-help'] : argv, {
    files,
    registry,
  });
}

/** Backwards-compatible alias used by the old playground entrypoint. */
export { defaultFiles as defaultCoordFiles };
/** Backwards-compatible alias for the registry factory. */
export const createCoordPlaygroundRegistry = createCoordRegistry;
/** Backwards-compatible alias for the CLI entrypoint. */
export const runCoordPlayground = runCoordCli;

if (isMainModule()) {
  runCoordCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
