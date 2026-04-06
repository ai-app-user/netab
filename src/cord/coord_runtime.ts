import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CordNode,
  CoordCommandRegistry,
  CoordDispatcher,
  FileJsonStore,
  type ClusterNodeConfig,
  type CommandDefinition,
  type CommandGrant,
  type HelpSpec,
  type Invocation,
  type NodeInfo,
  type RouteTable,
  type RpcAuth,
  type RpcTarget,
} from "./index.js";
import { CordRegistry } from "./registry.js";
import { bytesToBase64, randomId } from "../shared/utils.js";

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

type PlaygroundFiles = {
  rootDir: string;
  nodesPath: string;
  cachePath: string;
  storePath: string;
};

type ClientBundle = {
  client: CordNode;
};

const DEFAULT_ROOT = process.env.COORD_PLAYGROUND_ROOT
  ? resolve(process.env.COORD_PLAYGROUND_ROOT)
  : resolve(process.cwd(), "tmp", "cord_foundation");

const NODE_FILE = "coord.nodes.json";
const CACHE_FILE = "coord.cache.json";
const STORE_FILE = "coord.store.json";
const COORD_SERVE_ENTRY = resolve(process.cwd(), "src/cord/coord_runtime.ts");
const DEFAULT_RPC_TIMEOUT_MS = 5000;

function defaultFiles(rootDir = DEFAULT_ROOT): PlaygroundFiles {
  return {
    rootDir,
    nodesPath: join(rootDir, NODE_FILE),
    cachePath: join(rootDir, CACHE_FILE),
    storePath: join(rootDir, STORE_FILE),
  };
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) {
    return fallback;
  }
  const content = await readFile(path, "utf8");
  return (content.trim() ? JSON.parse(content) : fallback) as T;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await ensureDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadNodes(files: PlaygroundFiles): Promise<PlaygroundNodeRecord[]> {
  const items = await readJsonFile<Array<PlaygroundNodeRecord | Omit<PlaygroundNodeRecord, "nodeEpoch">>>(files.nodesPath, []);
  let changed = false;
  const normalized = items
    .map((item) => ({
      ...item,
      nodeEpoch:
        "nodeEpoch" in item && typeof item.nodeEpoch === "string"
          ? item.nodeEpoch
          : ((changed = true), randomId("epoch")),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (changed) {
    await saveNodes(files, normalized);
  }
  return normalized;
}

async function saveNodes(files: PlaygroundFiles, nodes: PlaygroundNodeRecord[]): Promise<void> {
  await writeJsonFile(files.nodesPath, [...nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
}

async function loadCache(files: PlaygroundFiles): Promise<Record<string, DiscoveryCacheEntry>> {
  return readJsonFile<Record<string, DiscoveryCacheEntry>>(files.cachePath, {});
}

async function saveCache(files: PlaygroundFiles, cache: Record<string, DiscoveryCacheEntry>): Promise<void> {
  await writeJsonFile(files.cachePath, cache);
}

async function loadNodeConfig(configPath: string): Promise<Partial<PlaygroundNodeRecord>> {
  const resolved = resolve(configPath);
  if (resolved.endsWith(".json")) {
    return readJsonFile<Partial<PlaygroundNodeRecord>>(resolved, {});
  }
  const module = await import(pathToFileURL(resolved).href);
  return (module.default ?? module.config ?? module) as Partial<PlaygroundNodeRecord>;
}

function authForCli(client: CordNode): RpcAuth {
  return client.foundation.makeInternalAuth();
}

function parseAddr(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(":");
  if (index <= 0 || index === addr.length - 1) {
    throw new Error(`Invalid addr "${addr}"`);
  }
  return {
    host: addr.slice(0, index),
    port: Number(addr.slice(index + 1)),
  };
}

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

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForHttpNode(addr: string, timeoutMs = 5000): Promise<NodeInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${addr}/healthz`);
      if (response.ok) {
        const payload = (await response.json()) as { ok?: boolean; node?: NodeInfo };
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

async function waitForExpectedHttpNode(addr: string, nodeId: string, nodeEpoch: string, timeoutMs = 5000): Promise<NodeInfo | null> {
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

async function killPidGracefully(pid: number, forceAfterMs = 3000): Promise<boolean> {
  if (!isPidAlive(pid)) {
    return true;
  }
  try {
    process.kill(pid, "SIGTERM");
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
    process.kill(pid, "SIGKILL");
  } catch {
    return !isPidAlive(pid);
  }
  const hardDeadline = Date.now() + 1000;
  while (isPidAlive(pid) && Date.now() < hardDeadline) {
    await delay(50);
  }
  return !isPidAlive(pid);
}

async function readPidCmdline(pid: number): Promise<string> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

async function isCoordServePid(pid: number | undefined): Promise<boolean> {
  if (!pid || !isPidAlive(pid)) {
    return false;
  }
  const cmdline = await readPidCmdline(pid);
  return cmdline.includes(COORD_SERVE_ENTRY) && cmdline.includes(" -serve ");
}

type NodeStatus = {
  nodeId: string;
  addr: string;
  pid: number | null;
  process: "up" | "down";
  daemon: "coord" | "unknown" | "none";
  health: "up" | "mismatch" | "down";
  owner: string | null;
  nodeEpoch: string;
};

async function collectNodeStatuses(files: PlaygroundFiles): Promise<NodeStatus[]> {
  const nodes = await loadNodes(files);
  const statuses: NodeStatus[] = [];
  for (const node of nodes) {
    const processAlive = isPidAlive(node.pid);
    const daemonMatches = processAlive ? await isCoordServePid(node.pid) : false;
    const occupant = await waitForHttpNode(node.addr, 250);
    statuses.push({
      nodeId: node.nodeId,
      addr: node.addr,
      pid: node.pid ?? null,
      process: processAlive ? "up" : "down",
      daemon: node.pid ? (daemonMatches ? "coord" : "unknown") : "none",
      health: occupant ? (occupant.nodeId === node.nodeId ? "up" : "mismatch") : "down",
      owner: occupant?.nodeId ?? null,
      nodeEpoch: node.nodeEpoch,
    });
  }
  return statuses.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function formatStatusTable(files: PlaygroundFiles, statuses: NodeStatus[]): string {
  const lines = [
    "coord status",
    "",
    `root: ${files.rootDir}`,
  ];
  if (statuses.length === 0) {
    lines.push("", "no nodes configured");
    return lines.join("\n");
  }
  lines.push("", "NODE      ADDR             PID      PROCESS  DAEMON   HEALTH    OWNER     EPOCH");
  for (const status of statuses) {
    lines.push(
      `${status.nodeId.padEnd(9)} ${status.addr.padEnd(16)} ${String(status.pid ?? "-").padEnd(8)} ${status.process.padEnd(8)} ${status.daemon.padEnd(7)} ${status.health.padEnd(9)} ${String(status.owner ?? "-").padEnd(9)} ${status.nodeEpoch}`,
    );
  }
  return lines.join("\n");
}

async function listGlobalCoordServePids(): Promise<number[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
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

async function buildRuntime(files: PlaygroundFiles): Promise<ClientBundle> {
  const store = new FileJsonStore(files.storePath);
  const registry = new CordRegistry(store);
  const client = new CordNode(registry, {
    nodeId: `coord-cli-${randomId("session")}`,
    props: { type: "cli-client" },
    store,
  });

  return {
    client,
  };
}

async function stopRuntime(_runtime: ClientBundle): Promise<void> {
  // The CLI client does not keep a live transport or timers.
}

function normalizePayload(inv: Invocation): { kind: "bytes" | "json"; name: string; bytes?: string; json?: unknown } | undefined {
  if (!inv.payload) {
    return undefined;
  }
  if (inv.payload.kind === "bytes") {
    return {
      kind: "bytes",
      name: inv.payload.name,
      bytes: inv.payload.bytes ? bytesToBase64(inv.payload.bytes) : "",
    };
  }
  return {
    kind: "json",
    name: inv.payload.name,
    json: inv.payload.json,
  };
}

const OUTPUT_OPTIONS = [
  "--json          Print machine-readable JSON",
  "--pretty        Pretty-print JSON output when combined with --json",
  "--verbose       Show routing/debug metadata",
];

const RPC_OPTIONS = [
  ...OUTPUT_OPTIONS,
  `--timeout=MS    Override RPC timeout (default ${DEFAULT_RPC_TIMEOUT_MS}ms)`,
  "--dst=NODE      Ask the contacted node to execute on another node",
  "--trace=ID      Attach a trace id to the request",
];

const FANOUT_OPTIONS = [
  ...RPC_OPTIONS,
  "--parallel=N    Limit concurrent fanout work for cluster:execOnCluster",
  "--bestEffort    Continue even if some cluster targets fail",
];

const POLICY_OPTIONS = [
  ...OUTPUT_OPTIONS,
  `--timeout=MS    Override RPC timeout (default ${DEFAULT_RPC_TIMEOUT_MS}ms)`,
  "--trace=ID      Attach a trace id to the request",
];

function asArray(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function formatHelpSpec(name: string, help: HelpSpec): string {
  const lines = [name, "", help.summary];
  const usage = asArray(help.usage);
  if (usage.length > 0) {
    lines.push("", "Usage:");
    for (const entry of usage) {
      lines.push(`  ${entry}`);
    }
  }
  if (help.options && help.options.length > 0) {
    lines.push("", "Options:");
    for (const entry of help.options) {
      lines.push(`  ${entry}`);
    }
  }
  if (help.examples && help.examples.length > 0) {
    lines.push("", "Examples:");
    for (const entry of help.examples) {
      lines.push(`  ${entry}`);
    }
  }
  return lines.join("\n");
}

function formatBaseHelp(registry: CoordCommandRegistry): string {
  const lines = [
    "Base commands",
    "",
    "Use these to manage local coord daemons and supporting state before running targeted RPC commands.",
    "",
  ];
  for (const command of registry.listBase()) {
    const help = registry.helpFor(command);
    lines.push(`  -${command.padEnd(14)}${help?.summary ?? ""}`);
  }
  lines.push("", "Try one command in detail:", "  ./scripts/coord -help start");
  return lines.join("\n");
}

function formatGroupHelp(group: string, registry: CoordCommandRegistry): string {
  const lines = [`${group} commands`, ""];
  if (group === "foundation") {
    lines.push("Foundation commands are the default when you use a bare command such as `-whoami` or `-peers`.", "");
  }
  for (const command of registry.listGroupCommands(group)) {
    const help = registry.helpFor(command);
    lines.push(`  ${command.padEnd(30)}${help?.summary ?? ""}`);
  }
  lines.push("", `Try one command in detail:`, `  ./scripts/coord -help ${registry.listGroupCommands(group)[0]}`);
  return lines.join("\n");
}

function formatOverview(registry: CoordCommandRegistry): string {
  const lines = [
    "coord CLI",
    "",
    "Run `./scripts/coord` with no arguments to show this overview again.",
    "",
    "First-time quick start:",
    "  ./scripts/coord -start:4101 A",
    "  ./scripts/coord -start:4104 P",
    "  ./scripts/coord -status",
    "  ./scripts/coord -whoami",
    "  ./scripts/coord -connect @127.0.0.1:4104 --ttl=0",
    "  ./scripts/coord -peers",
    "  ./scripts/coord -stop all",
    "",
    "Syntax:",
    "  coord [@sender] -command [@target|%cluster] [args...] [--options...]",
    "",
    "Selectors:",
    "  @A                 node id or learned peer name",
    "  @127.0.0.1:4101    direct address",
    "  %offline           cluster name",
    "  @./file.txt        file payload shortcut",
    "  f:./file.txt       explicit file payload syntax",
    "",
    "Base commands:",
  ];
  for (const command of registry.listBase()) {
    const help = registry.helpFor(command);
    lines.push(`  -${command.padEnd(14)}${help?.summary ?? ""}`);
  }
  lines.push("", "Command groups:");
  for (const group of registry.listGroups()) {
    const commandNames = registry
      .listGroupCommands(group)
      .map((command) => command.split(":", 2)[1])
      .join(" ");
    lines.push(`  ${group.padEnd(14)}${commandNames}`);
  }
  lines.push(
    "",
    "More help:",
    "  ./scripts/coord -help base",
    "  ./scripts/coord -help foundation",
    "  ./scripts/coord -help foundation:connect",
    "  ./scripts/coord -help cluster",
  );
  return lines.join("\n");
}

function registerHelp(registry: CoordCommandRegistry): void {
  registry.registerBase(
    "help",
    async (inv) => {
      const topic = String(inv.baseArgs?.[0] ?? "all");
      if (topic === "all" || topic === "overview") {
        return formatOverview(registry);
      }
      if (topic === "base") {
        return formatBaseHelp(registry);
      }
      const baseName = topic.startsWith("base:") ? topic.slice("base:".length) : topic;
      if (registry.hasBase(baseName)) {
        return formatHelpSpec(`-${baseName}`, registry.helpFor(baseName)!);
      }
      if (topic.includes(":")) {
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
      summary: "Show coord help",
      usage: ["coord -help", "coord -help base", "coord -help foundation", "coord -help foundation:echo"],
      examples: ["./scripts/coord", "./scripts/coord -help", "./scripts/coord -help foundation", "./scripts/coord -help cluster:join"],
    },
  );
}

async function resolveSender(files: PlaygroundFiles, inv: Invocation): Promise<RpcTarget> {
  if (inv.sender.kind === "addr") {
    return { addr: inv.sender.value };
  }
  if (inv.sender.kind === "node") {
    return { nodeId: inv.sender.value };
  }

  const nodes = await loadNodes(files);
  if (nodes.length === 0) {
    throw new Error('No local coord node is available. Start one first with "coord -start:4102 A".');
  }
  if (nodes.length === 1) {
    return { nodeId: nodes[0].nodeId };
  }

  const healthy: PlaygroundNodeRecord[] = [];
  for (const node of nodes) {
    if (await waitForHttpNode(node.addr, 250)) {
      healthy.push(node);
    }
  }
  if (healthy.length === 1) {
    return { nodeId: healthy[0].nodeId };
  }
  throw new Error('Multiple local coord nodes are configured. Specify a sender first, for example "coord @A -peers".');
}

function normalizeExecTarget(target: Invocation["target"]): { kind: "node"; value: string } | { kind: "addr"; value: string } | undefined {
  if (target.kind === "node" || target.kind === "addr") {
    return { kind: target.kind, value: target.value };
  }
  return undefined;
}

function selectorToRpcTarget(target: Invocation["target"]): RpcTarget {
  if (target.kind === "addr") {
    return { addr: target.value };
  }
  if (target.kind === "node") {
    return { nodeId: target.value };
  }
  throw new Error(`Target kind ${target.kind} is not supported for this command`);
}

function normalizeNodeArg(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text.startsWith("@")) {
    return text.slice(1);
  }
  return text;
}

function formatTtl(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

function formatPeerTable(table: { nodeId: string; entries: Array<{ nodeId: string; via: string; ways: string; ttlRemainingMs: number | null; state: string }> }): string {
  const lines = [
    `coord peers on ${table.nodeId}`,
    "",
    "NAME      VIA               WAYS   TTL      STATE",
  ];
  if (table.entries.length === 0) {
    lines.push("no known peers");
    return lines.join("\n");
  }
  for (const entry of table.entries) {
    lines.push(`${entry.nodeId.padEnd(9)} ${entry.via.padEnd(17)} ${entry.ways.padEnd(6)} ${formatTtl(entry.ttlRemainingMs).padEnd(8)} ${entry.state}`);
  }
  return lines.join("\n");
}

function formatRouteTable(table: RouteTable): string {
  const lines = [
    `coord routes on ${table.nodeId}`,
    "",
    `proxy mode: ${table.proxyMode.enabled ? "on" : "off"}${table.proxyMode.defaultDstNodeId ? ` -> ${table.proxyMode.defaultDstNodeId}` : ""}`,
    `learn ttl: ${Math.floor(table.observationTtlMs / 1000)}s`,
  ];
  if (table.entries.length === 0) {
    lines.push("", "no known routes");
    return lines.join("\n");
  }
  lines.push("", "DEST      VIA               WAYS   TTL      STATE       PATH");
  for (const entry of table.entries) {
    lines.push(
      `${entry.nodeId.padEnd(9)} ${entry.via.padEnd(17)} ${entry.ways.padEnd(6)} ${formatTtl(entry.ttlRemainingMs).padEnd(8)} ${entry.state.padEnd(11)} ${entry.path}`,
    );
  }
  return lines.join("\n");
}

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
    const senderNodeId = "nodeId" in sender ? sender.nodeId : undefined;
    const response = await runtime.client.call<{
      result: unknown;
      route: {
        contactedNodeId: string;
        executedNodeId: string;
        mode: "local" | "direct" | "proxy";
        nextHopNodeId: string;
        path: string[];
        hops: Array<{ from: string; to: string; kind: "direct" | "reverse" }>;
      };
    }>( 
      sender,
      "cord.foundation.exec",
      {
        method: remoteMethod,
        params,
        dst: normalizeExecTarget(inv.target),
        timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        traceId: typeof inv.options.trace === "string" ? inv.options.trace : undefined,
      },
      {
        timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        traceId: typeof inv.options.trace === "string" ? inv.options.trace : undefined,
        auth: authForCli(runtime.client),
        originNodeId: senderNodeId,
      },
    );
    if (inv.options.verbose === true || opts?.wrapRoute) {
      return {
        route: response.route,
        path: response.route.hops.length === 0
          ? response.route.executedNodeId
          : response.route.hops.reduce(
              (text, hop, index) => (index === 0 ? hop.from : text) + (hop.kind === "reverse" ? ` -< ${hop.to}` : ` -> ${hop.to}`),
              "",
            ),
        result: response.result,
      };
    }
    return response.result;
  } finally {
    await stopRuntime(runtime);
  }
}

async function callSenderMethod(files: PlaygroundFiles, inv: Invocation, method: string, params: unknown): Promise<unknown> {
  const runtime = await buildRuntime(files);
  try {
    const sender = await resolveSender(files, inv);
    const senderNodeId = "nodeId" in sender ? sender.nodeId : undefined;
    return runtime.client.call(
      sender,
      method,
      params,
      {
        timeoutMs: Number(inv.options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS),
        traceId: typeof inv.options.trace === "string" ? inv.options.trace : undefined,
        auth: authForCli(runtime.client),
        originNodeId: senderNodeId,
      },
    );
  } finally {
    await stopRuntime(runtime);
  }
}

function registerBaseCommands(registry: CoordCommandRegistry, files: PlaygroundFiles): void {
  registry.registerBase(
    "start",
    async (inv) => {
      const [nodeNameRaw, configPath] = inv.baseArgs ?? [];
      const nodeId = String(nodeNameRaw ?? `node-${Math.random().toString(36).slice(2, 6)}`);
      const port = inv.baseCmdPort ?? 4001;
      const fromConfig = configPath ? await loadNodeConfig(String(configPath)) : {};
      const record: PlaygroundNodeRecord = {
        nodeId,
        nodeEpoch: randomId("epoch"),
        port,
        addr: String(fromConfig.addr ?? `127.0.0.1:${port}`),
        configPath: configPath ? resolve(String(configPath)) : undefined,
        startedAtMs: Date.now(),
        props: fromConfig.props ?? { type: "dev" },
        clusterId: typeof fromConfig.clusterId === "string" ? fromConfig.clusterId : undefined,
        eligible: typeof fromConfig.eligible === "boolean" ? fromConfig.eligible : undefined,
        priority: typeof fromConfig.priority === "number" ? fromConfig.priority : undefined,
      };
      const nodes = await loadNodes(files);
      const existing = nodes.find((item) => item.nodeId === nodeId);
      if (existing?.pid && isPidAlive(existing.pid)) {
        const healthy = await waitForHttpNode(existing.addr, 500);
        if (healthy) {
          return {
            ok: true,
            alreadyRunning: true,
            nodeId: existing.nodeId,
            nodeEpoch: healthy.nodeEpoch,
            addr: existing.addr,
            pid: existing.pid,
          };
        }
      }
      const existingOnAddr = nodes.find((item) => item.addr === record.addr && item.nodeId !== nodeId);
      if (existingOnAddr) {
        const healthy = await waitForHttpNode(existingOnAddr.addr, 500);
        if (healthy) {
          throw new Error(`Address ${record.addr} is already serving node ${healthy.nodeId}`);
        }
      }
      const healthyOnAddr = await waitForHttpNode(record.addr, 200);
      if (healthyOnAddr && healthyOnAddr.nodeId !== nodeId) {
        throw new Error(`Address ${record.addr} is already serving node ${healthyOnAddr.nodeId}`);
      }
      const daemonArgs = [
        "--import",
        "tsx",
        COORD_SERVE_ENTRY,
        "-serve",
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
        stdio: "ignore",
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
      const healthy = await waitForExpectedHttpNode(record.addr, record.nodeId, record.nodeEpoch, 15000);
      if (!healthy) {
        if (record.pid) {
          await killPidGracefully(record.pid, 1000);
        }
        await saveNodes(files, next.filter((item) => item.nodeId !== nodeId));
        const occupant = await waitForHttpNode(record.addr, 300);
        if (occupant) {
          throw new Error(`Address ${record.addr} is serving ${occupant.nodeId}, not ${record.nodeId}`);
        }
        throw new Error(`Timed out waiting for daemon ${nodeId} at ${record.addr}`);
      }
      return {
        ok: true,
        nodeId: record.nodeId,
        nodeEpoch: healthy.nodeEpoch,
        addr: record.addr,
        port: record.port,
        pid: record.pid,
        mode: "daemon",
        persistedTo: files.nodesPath,
      };
    },
    {
      summary: "Start one background coord daemon",
      usage: [
        "coord -start[:port] [node_name] [config.json|config.js]",
        "coord -start:4101 A ./src/cord/playground/configs/A.json",
      ],
      examples: ["./scripts/coord -start:4101 A", "./scripts/coord -start:4102 B ./src/cord/playground/configs/B.json"],
      options: OUTPUT_OPTIONS,
    },
  );

  registry.registerBase(
    "discover",
    async (inv) => {
      const [portsRaw, ttlRaw] = inv.baseArgs ?? [];
      const ttlSecs = Number(ttlRaw ?? 600);
      const ports = typeof portsRaw === "string" ? new Set(portsRaw.split(",").filter(Boolean)) : null;
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
      summary: "Discover configured coord nodes and refresh the cache",
      usage: "coord -discover [port1[,port2...]] [ttl_in_secs]",
      examples: ["./scripts/coord -discover 4101,4102,4103 600"],
    },
  );

  registry.registerBase(
    "stop",
    async (inv) => {
      const targetNodeId = String(inv.baseArgs?.[0] ?? "all");
      const nodes = await loadNodes(files);
      const selected = targetNodeId === "all" ? nodes : nodes.filter((item) => item.nodeId === targetNodeId);
      if (selected.length === 0) {
        throw new Error(`Unknown node "${targetNodeId}"`);
      }
      const stopped: string[] = [];
      for (const node of selected) {
        if (node.pid && isPidAlive(node.pid)) {
          await killPidGracefully(node.pid, 3000);
        }
        stopped.push(node.nodeId);
      }
      const remaining = nodes.map((node) => (stopped.includes(node.nodeId) ? { ...node, pid: undefined } : node));
      await saveNodes(files, remaining);
      const cache = await loadCache(files);
      for (const nodeId of stopped) {
        delete cache[nodeId];
      }
      await saveCache(files, cache);
      return {
        ok: true,
        stopped,
      };
    },
    {
      summary: "Stop one daemon or all daemons from the current coord root",
      usage: ["coord -stop [node_name]", "coord -stop all"],
      examples: ["./scripts/coord -stop A", "./scripts/coord -stop all"],
    },
  );

  registry.registerBase(
    "status",
    async () => formatStatusTable(files, await collectNodeStatuses(files)),
    {
      summary: "Show node processes and health for the current coord root",
      usage: "coord -status",
      examples: ["./scripts/coord -status"],
    },
  );

  registry.registerBase(
    "cleanup",
    async (inv) => {
      const scope = String(inv.baseArgs?.[0] ?? "local");
      const killedGlobal: number[] = [];
      if (scope === "global") {
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
        const daemonMatches = processAlive ? await isCoordServePid(node.pid) : false;
        const healthy = (await waitForHttpNode(node.addr, 250)) !== null;

        if (node.pid && processAlive && daemonMatches && !healthy) {
          await killPidGracefully(node.pid, 1000);
        }

        const keepPid = node.pid && isPidAlive(node.pid) && (await isCoordServePid(node.pid)) && healthy ? node.pid : undefined;
        if (!keepPid) {
          clearedNodeIds.push(node.nodeId);
          delete cache[node.nodeId];
          continue;
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
        "",
        `root: ${files.rootDir}`,
        `cleared node records: ${clearedNodeIds.length === 0 ? "none" : clearedNodeIds.join(", ")}`,
        `killed global daemons: ${killedGlobal.length === 0 ? "none" : killedGlobal.join(", ")}`,
      ].join("\n");
    },
    {
      summary: "Clear dead local records and optionally stop all coord daemons from this repo",
      usage: ["coord -cleanup", "coord -cleanup global"],
      examples: ["./scripts/coord -cleanup", "./scripts/coord -cleanup global"],
    },
  );

  registry.registerBase(
    "save",
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
      summary: "Save the current node catalog and discovery cache",
      usage: "coord -save [config.json]",
      examples: ["./scripts/coord -save ./tmp/coord.export.json"],
    },
  );

  registry.registerBase(
    "load",
    async (inv) => {
      const sourcePath = resolve(String(inv.baseArgs?.[0] ?? files.nodesPath));
      const loaded = await readJsonFile<PlaygroundNodeRecord[] | SavedPlaygroundState>(sourcePath, []);
      const state: SavedPlaygroundState = Array.isArray(loaded) ? { nodes: loaded, cache: {} } : { nodes: loaded.nodes ?? [], cache: loaded.cache ?? {} };
      await saveNodes(files, state.nodes);
      await saveCache(files, state.cache);
      return { ok: true, loadedFrom: sourcePath, count: state.nodes.length, cached: Object.keys(state.cache).length };
    },
    {
      summary: "Load a node catalog and discovery cache into the active coord root",
      usage: "coord -load [config.json]",
      examples: ["./scripts/coord -load ./tmp/coord.export.json"],
    },
  );
}

function registerTargetedCommands(registry: CoordCommandRegistry, files: PlaygroundFiles): void {
  const commandHelp = (summary: string, usage: string | string[], examples: string[], options = RPC_OPTIONS): HelpSpec => ({
    summary,
    usage,
    examples,
    options,
  });

  const rpcCommand = (
    fullCmd: string,
    remoteMethod: string,
    buildParams: (inv: Invocation) => Promise<unknown> | unknown,
    help: HelpSpec,
  ) => {
    registry.registerCmd(fullCmd, async (inv) => callSenderMethod(files, inv, remoteMethod, await buildParams(inv)), help);
  };

  registry.registerCmd(
    "foundation:whoami",
    async (inv) => callSenderExec(files, inv, "cord.foundation.whoami", {}),
    commandHelp("Run whoami on the sender or the selected peer", ["coord -whoami", "coord -whoami @vps", "coord @D -whoami @A"], ["./scripts/coord -whoami", "./scripts/coord -whoami @127.0.0.1:4101", "./scripts/coord @D -whoami @A"]),
  );
  registry.registerCmd(
    "foundation:ping",
    async (inv) => callSenderExec(files, inv, "cord.foundation.ping", {}),
    commandHelp("Ping the sender or the selected peer", ["coord -ping @vps", "coord @D -ping @A"], ["./scripts/coord -ping @127.0.0.1:4101", "./scripts/coord @D -ping @A"]),
  );
  registry.registerCmd(
    "foundation:echo",
    async (inv) =>
      callSenderExec(files, inv, "cord.foundation.echo", {
        args: inv.args,
        named: inv.params,
        payload: normalizePayload(inv),
      }),
    commandHelp(
      "Echo args or payload on the sender or routed destination",
      ["coord -echo hello", "coord -echo @A hello", "coord @D -echo @A @./src/cord/playground/samples/bigfile.txt"],
      ["./scripts/coord -echo local test", "./scripts/coord -echo @vps hello", "./scripts/coord @D -echo @A @./src/cord/playground/samples/bigfile.txt"],
    ),
  );
  registry.registerCmd(
    "foundation:sleep",
    async (inv) =>
      callSenderExec(files, inv, "cord.foundation.sleep", {
        ms: Number(inv.params.ms ?? inv.args[0] ?? 0),
      }),
    commandHelp("Sleep on the sender or routed destination", ["coord -sleep 200", "coord @D -sleep @A 200"], ["./scripts/coord -sleep 50", "./scripts/coord @D -sleep @A 50"]),
  );
  registry.registerCmd(
    "foundation:peers",
    async (inv) => {
      const result = await callSenderExec(files, inv, "cord.foundation.peers", {});
      return inv.options.json === true ? result : formatPeerTable(result as Awaited<ReturnType<typeof callSenderMethod>> & { nodeId: string; entries: Array<{ nodeId: string; via: string; ways: string; ttlRemainingMs: number | null; state: string }> });
    },
    commandHelp("Show learned peers on the sender or routed destination", ["coord -peers", "coord -peers @P"], ["./scripts/coord -peers", "./scripts/coord -peers @P"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "foundation:routes",
    async (inv) => {
      const result = await callSenderExec(files, inv, "cord.foundation.routes", {});
      return inv.options.json === true ? result : formatRouteTable(result as RouteTable);
    },
    commandHelp("Show effective routes on the sender or routed destination", ["coord -routes", "coord -routes @P"], ["./scripts/coord -routes", "./scripts/coord -routes @P"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "foundation:connect",
    async (inv) => {
      if (inv.target.kind !== "node" && inv.target.kind !== "addr") {
        throw new Error("connect requires @node or @host:port");
      }
      return callSenderMethod(files, inv, "cord.foundation.connect", {
        target: normalizeExecTarget(inv.target),
        ttlMs: typeof inv.params.ttl === "number" ? Number(inv.params.ttl) * 1000 : typeof inv.options.ttl === "number" ? Number(inv.options.ttl) * 1000 : 0,
      });
    },
    commandHelp("Open a reverse connection from the sender to a direct peer", ["coord -connect @157.250.198.83:4104 --ttl=0"], ["./scripts/coord -connect @127.0.0.1:4101 --ttl=0"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "foundation:disconnect",
    async (inv) => {
      if (inv.target.kind !== "node") {
        throw new Error("disconnect requires @node");
      }
      return callSenderMethod(files, inv, "cord.foundation.disconnect", {
        targetNodeId: inv.target.value,
      });
    },
    commandHelp("Close a reverse connection or drop a reverse peer session", ["coord -disconnect @P"], ["./scripts/coord -disconnect @P"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "foundation:learn",
    async (inv) => {
      if (inv.target.kind !== "node" && inv.target.kind !== "addr") {
        throw new Error("learn requires @node or @host:port");
      }
      return callSenderMethod(files, inv, "cord.foundation.learn", {
        target: normalizeExecTarget(inv.target),
      });
    },
    commandHelp("Import suggested peers from a remote node", ["coord -learn @P"], ["./scripts/coord -learn @P"], POLICY_OPTIONS),
  );

  registry.registerCmd(
    "route:add",
    async (inv) => {
      if (inv.target.kind !== "node") {
        throw new Error("route:add requires a destination like @A");
      }
      return callSenderMethod(files, inv, "cord.foundation.route", {
        op: "add",
        targetNodeId: inv.target.value,
        proxyNodeId: inv.args[0] ? normalizeNodeArg(inv.args[0]) : undefined,
      });
    },
    commandHelp("Add an explicit route on the sender", ["coord @D -route:add @A @P", "coord -route:add @B"], ["./scripts/coord @D -route:add @A @P"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "route:del",
    async (inv) => {
      if (inv.target.kind !== "node") {
        throw new Error("route:del requires a destination like @A");
      }
      return callSenderMethod(files, inv, "cord.foundation.route", {
        op: "del",
        targetNodeId: inv.target.value,
      });
    },
    commandHelp("Delete an explicit route on the sender", ["coord @D -route:del @A"], ["./scripts/coord @D -route:del @A"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "route:deny",
    async (inv) => {
      if (inv.target.kind !== "node") {
        throw new Error("route:deny requires a destination like @A");
      }
      return callSenderMethod(files, inv, "cord.foundation.route", {
        op: "deny",
        targetNodeId: inv.target.value,
        direction: String(inv.args[0] ?? "both"),
      });
    },
    commandHelp("Deny inbound or outbound direct connectivity on the sender", ["coord @A -route:deny @C out", "coord @A -route:deny @C"], ["./scripts/coord @A -route:deny @C out"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "proxy:on",
    async (inv) =>
      callSenderMethod(files, inv, "cord.foundation.proxy", {
        enabled: true,
        defaultDstNodeId: inv.target.kind === "node" ? inv.target.value : undefined,
      }),
    commandHelp("Enable proxy mode on the sender", ["coord -proxy:on @D"], ["./scripts/coord -proxy:on @D"], POLICY_OPTIONS),
  );
  registry.registerCmd(
    "proxy:off",
    async (inv) =>
      callSenderMethod(files, inv, "cord.foundation.proxy", {
        enabled: false,
      }),
    commandHelp("Disable proxy mode on the sender", ["coord -proxy:off"], ["./scripts/coord -proxy:off"], POLICY_OPTIONS),
  );

  rpcCommand(
    "cluster:create",
    "cord.cluster.create",
    (inv) => ({
      clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])),
      name: inv.params.name,
      props: inv.params.props,
    }),
    commandHelp("Create a cluster on the sender", "coord -cluster:create %offline", ["./scripts/coord -cluster:create %offline"]),
  );
  rpcCommand(
    "cluster:join",
    "cord.cluster.join",
    async (inv) => ({
      clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])),
      nodeId: (await resolveSender(files, inv)).nodeId ?? String(inv.params.nodeId ?? "unknown"),
      role: {
        proxyOnly: inv.params.proxyOnly === true,
        canSend: inv.params.canSend !== false,
        canReceive: inv.params.canReceive !== false,
        eligibleLeader: inv.params.eligibleLeader !== false,
      },
      props: {
        priority: inv.params.priority,
        leaseMs: inv.params.leaseMs,
        ...(typeof inv.params.props === "object" && inv.params.props !== null ? (inv.params.props as Record<string, unknown>) : {}),
      },
    } satisfies ClusterNodeConfig),
    commandHelp("Join the sender to a cluster", "coord -cluster:join %offline", ["./scripts/coord -cluster:join %offline"]),
  );
  rpcCommand(
    "cluster:leave",
    "cord.cluster.leave",
    (inv) => ({ clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])) }),
    commandHelp("Leave a cluster", "coord -cluster:leave %offline", ["./scripts/coord -cluster:leave %offline"]),
  );
  rpcCommand(
    "cluster:nodes",
    "cord.cluster.listNodes",
    (inv) => ({ clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])) }),
    commandHelp("List nodes in a cluster", "coord -cluster:nodes %offline", ["./scripts/coord -cluster:nodes %offline"]),
  );
  rpcCommand(
    "cluster:exec",
    "cord.cluster.execOnCluster",
    (inv) => ({
      clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])),
      method: String(inv.params.method ?? "cord.foundation.whoami"),
      params: typeof inv.params.payload === "object" ? inv.params.payload : {},
      opts: {
        parallel: typeof inv.options.parallel === "number" ? inv.options.parallel : undefined,
        timeoutMs: typeof inv.options.timeoutMs === "number" ? inv.options.timeoutMs : undefined,
        bestEffort: inv.options.bestEffort === true ? true : undefined,
      },
    }),
    commandHelp("Fan out a method across a cluster", ["coord -cluster:exec %offline method=cord.foundation.whoami"], ["./scripts/coord -cluster:exec %offline method=cord.foundation.whoami"], FANOUT_OPTIONS),
  );

  rpcCommand(
    "iam:defineCommand",
    "cord.iam.defineCommand",
    (inv) => ({
      ns: String(inv.params.ns ?? "default"),
      commandId: String(inv.params.commandId ?? inv.args[0]),
      def: {
        title: String(inv.params.title ?? inv.args[1] ?? inv.params.commandId),
        description: String(inv.params.description ?? inv.params.title ?? inv.params.commandId),
      } satisfies CommandDefinition,
    }),
    commandHelp("Define a command in IAM", "coord -iam:defineCommand commandId=cmd:test title=Test", ["./scripts/coord -iam:defineCommand commandId=cmd:test title=Test"]),
  );
  rpcCommand(
    "iam:grant",
    "cord.iam.grant",
    (inv) => ({
      ns: String(inv.params.ns ?? "default"),
      subject: String(inv.params.subject ?? inv.args[0]),
      commandId: String(inv.params.commandId ?? inv.args[1]),
      grant: {
        allow: inv.params.allow !== false,
        mask: typeof inv.params.mask === "number" ? inv.params.mask : undefined,
        scope: inv.params.scope,
      } satisfies CommandGrant,
    }),
    commandHelp("Grant command access", "coord -iam:grant subject=grp:staff commandId=cmd:test allow=true", ["./scripts/coord -iam:grant subject=grp:staff commandId=cmd:test allow=true"]),
  );
  rpcCommand(
    "iam:canInvoke",
    "cord.iam.canInvoke",
    (inv) => ({
      ns: String(inv.params.ns ?? "default"),
      ctx: {
        userId: String(inv.params.userId ?? inv.args[0] ?? "user:guest"),
        groups: typeof inv.params.groups === "string" ? String(inv.params.groups).split(",") : [],
      },
      commandId: String(inv.params.commandId ?? inv.args[1]),
      requestedMask: typeof inv.params.mask === "number" ? inv.params.mask : undefined,
    }),
    commandHelp("Check whether a user can invoke a command", "coord -iam:canInvoke userId=user:guest commandId=cmd:test", ["./scripts/coord -iam:canInvoke userId=user:guest commandId=cmd:test"]),
  );
  rpcCommand(
    "users:ensureGuest",
    "cord.users.ensureGuest",
    (inv) => ({ ns: String(inv.params.ns ?? "default") }),
    commandHelp("Ensure the guest user exists", "coord -users:ensureGuest", ["./scripts/coord -users:ensureGuest"]),
  );
  rpcCommand(
    "bootstrap:register_unallocated",
    "cord.bootstrap.register_unallocated",
    async (inv) => {
      const sender = await resolveSender(files, inv);
      if ("nodeId" in sender) {
        const nodes = await loadNodes(files);
        const record = nodes.find((item) => item.nodeId === sender.nodeId);
        if (record) {
          return {
            nodeId: record.nodeId,
            nodeEpoch: "cli-register",
            addrs: [record.addr],
            props: record.props,
          } satisfies NodeInfo;
        }
      }
      return {
        nodeId: "unknown",
        nodeEpoch: "cli-register",
      } satisfies NodeInfo;
    },
    commandHelp("Register the sender as unallocated", "coord -bootstrap:register_unallocated", ["./scripts/coord -bootstrap:register_unallocated"]),
  );
  rpcCommand(
    "bootstrap:list_unallocated",
    "cord.bootstrap.list_unallocated",
    (inv) => ({ ns: String(inv.params.ns ?? "default") }),
    commandHelp("List unallocated nodes", "coord -bootstrap:list_unallocated", ["./scripts/coord -bootstrap:list_unallocated"]),
  );
  rpcCommand(
    "election:addShard",
    "cord.election.addShard",
    (inv) => ({
      clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])),
      shard: {
        shardId: String(inv.params.shardId ?? inv.args[1] ?? "default"),
        weight: typeof inv.params.weight === "number" ? inv.params.weight : undefined,
      },
    }),
    commandHelp("Add a shard", "coord -election:addShard %offline shardId=orders weight=3", ["./scripts/coord -election:addShard %offline shardId=orders weight=3"]),
  );
  rpcCommand(
    "election:getLeader",
    "cord.election.getLeader",
    (inv) => ({
      clusterId: String(inv.params.clusterId ?? (inv.target.kind === "cluster" ? inv.target.value : inv.args[0])),
      shardId: String(inv.params.shardId ?? inv.args[1] ?? "default"),
    }),
    commandHelp("Get shard leader", "coord -election:getLeader %offline shardId=default", ["./scripts/coord -election:getLeader %offline shardId=default"]),
  );
}

async function runServeMode(argv: string[], files: PlaygroundFiles): Promise<number> {
  const [, nodeIdRaw, portRaw, nodeEpochRaw, configPath] = argv;
  const nodeId = String(nodeIdRaw ?? "");
  const port = Number(portRaw ?? 0);
  const nodeEpoch = String(nodeEpochRaw ?? "");
  if (!nodeId || !nodeEpoch || !Number.isFinite(port) || port <= 0) {
    throw new Error("Usage: coord -serve <nodeId> <port> <nodeEpoch> [config.json|config.js]");
  }
  const fromConfig = configPath ? await loadNodeConfig(String(configPath)) : {};
  const addr = String(fromConfig.addr ?? `127.0.0.1:${port}`);
  parseAddr(addr);

  const store = new FileJsonStore(files.storePath);
  const registry = new CordRegistry(store);
  const node = new CordNode(registry, {
    nodeId,
    nodeEpoch,
    listenHttp: true,
    addrs: [addr],
    props: fromConfig.props ?? { type: "dev" },
    clusterId: typeof fromConfig.clusterId === "string" ? fromConfig.clusterId : undefined,
    eligible: typeof fromConfig.eligible === "boolean" ? fromConfig.eligible : undefined,
    priority: typeof fromConfig.priority === "number" ? fromConfig.priority : undefined,
    store,
  });
  await node.start();

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      void node
        .stop()
        .then(resolve)
        .catch(reject);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
  return 0;
}

export function createCoordRegistry(files = defaultFiles()): CoordCommandRegistry {
  const registry = new CoordCommandRegistry();
  registerHelp(registry);
  registerBaseCommands(registry, files);
  registerTargetedCommands(registry, files);
  return registry;
}

export async function runCoordCli(argv: string[], files = defaultFiles()): Promise<number> {
  await mkdir(files.rootDir, { recursive: true });
  if (argv[0] === "-serve") {
    return runServeMode(argv, files);
  }
  const registry = createCoordRegistry(files);
  const dispatcher = new CoordDispatcher(registry);
  return dispatcher.dispatch(argv.length === 0 ? ["-help"] : argv, { files, registry });
}

export { defaultFiles as defaultCoordFiles };
export const createCoordPlaygroundRegistry = createCoordRegistry;
export const runCoordPlayground = runCoordCli;

if (isMainModule()) {
  runCoordCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
