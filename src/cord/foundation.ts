import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomId } from '../shared/utils.js';
import { CordRegistry } from './registry.js';
import type {
  CommandHandler,
  ConnectOptions,
  FoundationNode,
  NodeInfo,
  PeerEntry,
  PeerTable,
  RouteDirection,
  RouteEntry,
  RouteTable,
  RpcAuth,
  RpcCallOptions,
  RpcCtx,
  RpcTarget,
} from './types.js';

type FoundationOptions = {
  nodeId: string;
  nodeEpoch?: string;
  listenHttp?: boolean;
  listenAddrs?: string[];
  addrs?: string[];
  props?: unknown;
  maxPayloadBytes?: number;
  guestRateLimitPerWindow?: number;
  rateLimitWindowMs?: number;
  observationTtlMs?: number;
  authorize?: (method: string, ctx: RpcCtx) => Promise<void>;
};

type PublishedNodeRecord = NodeInfo & {
  started: boolean;
  updatedAtMs: number;
  pid: number;
};

type PeerStateRecord = {
  nodeId: string;
  nodeEpoch?: string;
  addrs?: string[];
  props?: unknown;
  directAddr?: string;
  viaNodeId?: string;
  viaDetail?: 'direct' | 'reverse';
  suggested?: boolean;
  connected?: boolean;
  expiresAtMs?: number | null;
  lastSeenMs?: number;
  lastInboundMs?: number;
  lastOutboundMs?: number;
};

type RouteStateRecord = {
  version: 2;
  routes: Record<string, { proxyNodeId?: string }>;
  deny: Record<string, { in?: boolean; out?: boolean }>;
  proxyMode: {
    enabled: boolean;
    defaultDstNodeId?: string;
  };
  peers: Record<string, PeerStateRecord>;
};

type ExecTarget =
  | { kind: 'node'; value: string }
  | { kind: 'addr'; value: string };

type RouteHop = {
  from: string;
  to: string;
  kind: 'direct' | 'reverse';
};

type PeerSummary = {
  nodeId: string;
  nodeEpoch?: string;
  addrs?: string[];
  props?: unknown;
  viaKind: 'direct' | 'proxy' | 'reverse' | 'unknown';
  viaValue?: string;
  viaDetail?: 'direct' | 'reverse';
  ways: 'out' | 'in' | 'both' | '-';
  ttlRemainingMs: number | null;
  state: 'connected' | 'learned' | 'suggested';
};

type FoundationExecRequest = {
  method: string;
  params: unknown;
  dst?: ExecTarget;
  timeoutMs?: number;
  traceId?: string;
  hopCount?: number;
  path?: RouteHop[];
};

type FoundationExecResponse = {
  result: unknown;
  route: {
    contactedNodeId: string;
    executedNodeId: string;
    mode: 'local' | 'direct' | 'proxy';
    nextHopNodeId: string;
    path: string[];
    hops: RouteHop[];
  };
};

type ReverseOpenPayload = {
  ttlMs?: number;
};

type ReversePollPayload = {
  sessionId: string;
  waitMs?: number;
};

type ReverseReplyPayload = {
  sessionId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ReverseClosePayload = {
  sessionId: string;
};

type ReverseRequest = {
  requestId: string;
  method: string;
  params: unknown;
  auth?: RpcAuth;
  traceId?: string;
  srcNodeId: string;
  srcNodeInfo: NodeInfo;
  originNodeId?: string;
};

type ReversePollResponse =
  | { kind: 'noop' }
  | { kind: 'request'; request: ReverseRequest };

type ReverseIncomingSession = {
  sessionId: string;
  peer: NodeInfo;
  expiresAtMs: number | null;
  lastSeenMs: number;
  queue: ReverseRequest[];
  waiters: Array<(response: ReversePollResponse) => void>;
  pending: Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
};

type ReverseOutgoingConnection = {
  remoteNodeId: string;
  remoteAddr: string;
  sessionId: string;
  expiresAtMs: number | null;
  stop: boolean;
};

type ConnectIntentRecord = {
  id: string;
  target: ExecTarget;
  peerNodeId?: string;
  directAddr?: string;
  expiresAtMs: number | null;
  createdAtMs: number;
};

type RpcHttpResponse<T> = {
  ok?: boolean;
  result?: T;
  node?: NodeInfo;
  error?: { message?: string };
};

type CallResult<T> = {
  result: T;
  peer: NodeInfo;
  via: 'local' | 'direct' | 'reverse';
  addr?: string;
};

/**
 * Handles node directory key.
 * @param nodeId Node identifier.
 */
function nodeDirectoryKey(nodeId: string): string {
  return `foundation/nodes/${nodeId}`;
}

/**
 * Handles route state key.
 * @param nodeId Node identifier.
 */
function routeStateKey(nodeId: string): string {
  return `foundation/routes/${nodeId}`;
}

/**
 * Connects intents key.
 * @param nodeId Node identifier.
 */
function connectIntentsKey(nodeId: string): string {
  return `foundation/connects/${nodeId}`;
}

/**
 * Handles empty route state.
 */
function emptyRouteState(): RouteStateRecord {
  return {
    version: 2,
    routes: {},
    deny: {},
    proxyMode: {
      enabled: false,
    },
    peers: {},
  };
}

/**
 * Parses exec target.
 * @param value Value to process.
 */
function parseExecTarget(value: unknown): ExecTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === 'node' || record.kind === 'addr' ? record.kind : null;
  const raw = typeof record.value === 'string' ? record.value : '';
  if (!kind || raw.length === 0) {
    return null;
  }
  return {
    kind,
    value: raw,
  };
}

/**
 * Parses connect intent records.
 * @param value Value to process.
 */
function parseConnectIntentRecords(value: unknown): ConnectIntentRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const intents: ConnectIntentRecord[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const target = parseExecTarget(record.target);
    if (!target) {
      continue;
    }
    const id =
      typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : `${target.kind}:${target.value}`;
    intents.push({
      id,
      target,
      peerNodeId:
        typeof record.peerNodeId === 'string' && record.peerNodeId.length > 0
          ? record.peerNodeId
          : undefined,
      directAddr:
        typeof record.directAddr === 'string' && record.directAddr.length > 0
          ? record.directAddr
          : undefined,
      expiresAtMs:
        typeof record.expiresAtMs === 'number' ? record.expiresAtMs : null,
      createdAtMs:
        typeof record.createdAtMs === 'number'
          ? record.createdAtMs
          : Date.now(),
    });
  }
  return intents;
}

/**
 * Parses address.
 * @param addr Network address.
 */
function parseAddr(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(':');
  if (index <= 0 || index === addr.length - 1) {
    throw new Error(`Invalid listen addr "${addr}"`);
  }
  const host = addr.slice(0, index);
  const port = Number(addr.slice(index + 1));
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid listen addr "${addr}"`);
  }
  return { host, port };
}

/**
 * Returns whether address.
 * @param addr Network address.
 */
function isAddr(addr: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(addr) ||
    /^[A-Za-z0-9_.-]+:\d+$/.test(addr)
  );
}

/**
 * Parses published node record.
 * @param value Value to process.
 */
function parsePublishedNodeRecord(value: unknown): PublishedNodeRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.nodeId !== 'string' ||
    typeof record.nodeEpoch !== 'string'
  ) {
    return null;
  }
  return {
    nodeId: record.nodeId,
    nodeEpoch: record.nodeEpoch,
    addrs: Array.isArray(record.addrs)
      ? record.addrs.filter((item): item is string => typeof item === 'string')
      : undefined,
    props: record.props,
    started: record.started !== false,
    updatedAtMs:
      typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
    pid: typeof record.pid === 'number' ? record.pid : 0,
  };
}

/**
 * Parses peer state record.
 * @param nodeId Node identifier.
 * @param value Value to process.
 */
function parsePeerStateRecord(nodeId: string, value: unknown): PeerStateRecord {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    nodeId,
    nodeEpoch:
      typeof record.nodeEpoch === 'string' ? record.nodeEpoch : undefined,
    addrs: Array.isArray(record.addrs)
      ? record.addrs.filter((item): item is string => typeof item === 'string')
      : undefined,
    props: record.props,
    directAddr:
      typeof record.directAddr === 'string' && record.directAddr.length > 0
        ? record.directAddr
        : undefined,
    viaNodeId:
      typeof record.viaNodeId === 'string' && record.viaNodeId.length > 0
        ? record.viaNodeId
        : undefined,
    viaDetail:
      record.viaDetail === 'reverse'
        ? 'reverse'
        : record.viaDetail === 'direct'
          ? 'direct'
          : undefined,
    suggested: record.suggested === true,
    connected: record.connected === true,
    expiresAtMs:
      typeof record.expiresAtMs === 'number'
        ? record.expiresAtMs
        : record.expiresAtMs === null
          ? null
          : undefined,
    lastSeenMs:
      typeof record.lastSeenMs === 'number' ? record.lastSeenMs : undefined,
    lastInboundMs:
      typeof record.lastInboundMs === 'number'
        ? record.lastInboundMs
        : undefined,
    lastOutboundMs:
      typeof record.lastOutboundMs === 'number'
        ? record.lastOutboundMs
        : undefined,
  };
}

/**
 * Parses route state record.
 * @param value Value to process.
 */
function parseRouteStateRecord(value: unknown): RouteStateRecord {
  const base = emptyRouteState();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return base;
  }
  const record = value as Record<string, unknown>;
  const routesValue =
    typeof record.routes === 'object' &&
    record.routes !== null &&
    !Array.isArray(record.routes)
      ? (record.routes as Record<string, unknown>)
      : {};
  const denyValue =
    typeof record.deny === 'object' &&
    record.deny !== null &&
    !Array.isArray(record.deny)
      ? (record.deny as Record<string, unknown>)
      : {};
  const proxyModeValue =
    typeof record.proxyMode === 'object' &&
    record.proxyMode !== null &&
    !Array.isArray(record.proxyMode)
      ? (record.proxyMode as Record<string, unknown>)
      : {};
  const peersValue =
    typeof record.peers === 'object' &&
    record.peers !== null &&
    !Array.isArray(record.peers)
      ? (record.peers as Record<string, unknown>)
      : {};
  const observationsValue =
    typeof record.observations === 'object' &&
    record.observations !== null &&
    !Array.isArray(record.observations)
      ? (record.observations as Record<string, unknown>)
      : {};

  const peers = Object.fromEntries(
    Object.entries(peersValue)
      .filter(([nodeId]) => typeof nodeId === 'string' && nodeId.length > 0)
      .map(
        ([nodeId, peer]) =>
          [nodeId, parsePeerStateRecord(nodeId, peer)] as const,
      ),
  );

  for (const [nodeId, observation] of Object.entries(observationsValue)) {
    const source =
      typeof observation === 'object' &&
      observation !== null &&
      !Array.isArray(observation)
        ? (observation as Record<string, unknown>)
        : {};
    const current = peers[nodeId] ?? {
      nodeId,
      suggested: false,
    };
    current.lastInboundMs =
      typeof source.lastInboundMs === 'number'
        ? source.lastInboundMs
        : current.lastInboundMs;
    current.lastOutboundMs =
      typeof source.lastOutboundMs === 'number'
        ? source.lastOutboundMs
        : current.lastOutboundMs;
    peers[nodeId] = current;
  }

  return {
    version: 2,
    routes: Object.fromEntries(
      Object.entries(routesValue)
        .filter(([nodeId]) => typeof nodeId === 'string' && nodeId.length > 0)
        .map(([nodeId, route]) => {
          const routeRecord =
            typeof route === 'object' && route !== null && !Array.isArray(route)
              ? (route as Record<string, unknown>)
              : {};
          return [
            nodeId,
            {
              proxyNodeId:
                typeof routeRecord.proxyNodeId === 'string' &&
                routeRecord.proxyNodeId.length > 0
                  ? routeRecord.proxyNodeId
                  : undefined,
            },
          ] as const;
        }),
    ),
    deny: Object.fromEntries(
      Object.entries(denyValue)
        .filter(([nodeId]) => typeof nodeId === 'string' && nodeId.length > 0)
        .map(([nodeId, deny]) => {
          const denyRecord =
            typeof deny === 'object' && deny !== null && !Array.isArray(deny)
              ? (deny as Record<string, unknown>)
              : {};
          return [
            nodeId,
            {
              in: denyRecord.in === true,
              out: denyRecord.out === true,
            },
          ] as const;
        }),
    ),
    proxyMode: {
      enabled: proxyModeValue.enabled === true,
      defaultDstNodeId:
        typeof proxyModeValue.defaultDstNodeId === 'string' &&
        proxyModeValue.defaultDstNodeId.length > 0
          ? proxyModeValue.defaultDstNodeId
          : undefined,
    },
    peers,
  };
}

/**
 * Reads request body.
 * @param req Req.
 */
async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body.trim() ? JSON.parse(body) : {};
}

/**
 * Writes JSON.
 * @param res Res.
 * @param statusCode Status code.
 * @param value Value to process.
 */
function writeJson(
  res: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(`${JSON.stringify(value)}\n`);
}

/**
 * Handles estimate bytes.
 * @param value Value to process.
 */
function estimateBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Handles race timeout.
 * @param promise Promise.
 * @param timeoutMs Timeout ms.
 * @param label Label.
 */
function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

/**
 * Handles delay.
 * @param ms Duration in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns whether route visible node id.
 * @param nodeId Node identifier.
 */
function isRouteVisibleNodeId(nodeId: string): boolean {
  return nodeId.length > 0 && !nodeId.startsWith('coord-cli-');
}

/**
 * Handles hop path.
 * @param hops Hops.
 */
function hopPath(hops: RouteHop[]): string[] {
  if (hops.length === 0) {
    return [];
  }
  const parts = [hops[0].from];
  for (const hop of hops) {
    parts.push(hop.to);
  }
  return parts;
}

/**
 * Handles render hop path.
 * @param hops Hops.
 * @param selfNodeId Self node id.
 * @param peerNodeId Peer node id.
 */
function renderHopPath(
  hops: RouteHop[],
  selfNodeId: string,
  peerNodeId: string,
): string {
  if (hops.length === 0) {
    return selfNodeId === peerNodeId
      ? selfNodeId
      : `${selfNodeId} -> ${peerNodeId}`;
  }
  let text = hops[0].from;
  for (const hop of hops) {
    text += hop.kind === 'reverse' ? ` -< ${hop.to}` : ` -> ${hop.to}`;
  }
  return text;
}

/**
 * Low-level CORD transport, routing, and reverse-link foundation runtime.
 */
export class CordFoundation implements FoundationNode {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly nodeId: string;
  private readonly listenAddrs: string[];
  private readonly addrs: string[];
  private readonly props: unknown;
  private readonly maxPayloadBytes: number;
  private readonly guestRateLimitPerWindow: number;
  private readonly rateLimitWindowMs: number;
  private readonly observationTtlMs: number;
  private readonly authorize?: FoundationOptions['authorize'];
  private readonly listenHttp: boolean;
  private readonly guestWindows = new Map<
    string,
    { windowStartMs: number; count: number }
  >();
  private readonly nodeEpoch: string;
  private readonly reverseIncoming = new Map<string, ReverseIncomingSession>();
  private readonly reverseOutgoing = new Map<
    string,
    ReverseOutgoingConnection
  >();
  private httpServer: Server | null = null;
  private started = false;

  /** Construct the low-level foundation runtime around a shared in-process registry. */
  constructor(
    private readonly registry: CordRegistry,
    options: FoundationOptions,
  ) {
    this.nodeId = options.nodeId;
    this.nodeEpoch = options.nodeEpoch ?? randomId('epoch');
    this.listenHttp = options.listenHttp ?? false;
    this.listenAddrs = [...(options.listenAddrs ?? [])];
    this.addrs = [...(options.addrs ?? [])];
    this.props = options.props;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
    this.guestRateLimitPerWindow = options.guestRateLimitPerWindow ?? 50;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 1000;
    this.observationTtlMs = options.observationTtlMs ?? 300_000;
    this.authorize = options.authorize;
    this.registerFoundationBuiltins();
  }

  /** Start listeners, publish directory state, and replay persistent connections. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.listenHttp) {
      await this.startHttpServer();
    }
    this.started = true;
    this.registry.register({
      nodeId: this.nodeId,
      addrList: [...new Set([...this.addrs, ...this.listenAddrs])],
      started: true,
      /**
       * Handles info.
       */
      info: () => this.self(),
      /**
       * Dispatches the request to the matching handler.
       * @param method Method.
       * @param ctx Execution context.
       * @param params SQL parameters.
       */
      dispatch: (method, ctx, params) => this.dispatch(method, ctx, params),
    });
    if (this.listenHttp) {
      await this.publishNodeDirectory(true);
    }
    await this.restorePersistentConnections();
  }

  /** Stop listeners, clear live reverse links, and unpublish directory state. */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    for (const outgoing of this.reverseOutgoing.values()) {
      outgoing.stop = true;
    }
    for (const session of this.reverseIncoming.values()) {
      this.closeIncomingSession(session, 'node stopped');
    }
    this.reverseOutgoing.clear();
    this.reverseIncoming.clear();
    if (this.listenHttp) {
      await this.publishNodeDirectory(false);
    }
    this.started = false;
    this.registry.unregister(this.nodeId);
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.httpServer = null;
    }
  }

  /** Return the currently advertised node identity. */
  self(): NodeInfo {
    return {
      nodeId: this.nodeId,
      nodeEpoch: this.nodeEpoch,
      addrs: this.addrs.length > 0 ? [...this.addrs] : undefined,
      props: this.props,
    };
  }

  /** Register one RPC handler. */
  registerHandler(method: string, handler: CommandHandler): void {
    this.handlers.set(method, handler);
  }

  /** Call a remote method and return only its decoded result payload. */
  async call<T>(
    target: RpcTarget,
    method: string,
    params: unknown,
    opts: RpcCallOptions = {},
  ): Promise<T> {
    return (await this.callDetailed<T>(target, method, params, opts)).result;
  }

  /** Send a ping RPC and report the round-trip time. */
  async ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }> {
    const startedMs = Date.now();
    await this.call(
      target,
      'cord.foundation.ping',
      { ts: startedMs },
      { timeoutMs: 1000, auth: this.makeInternalAuth() },
    );
    return { ok: true, rttMs: Date.now() - startedMs };
  }

  /** Discover visible peers from the registry and published node directory. */
  async discover(_opts?: {
    mode?: 'udp' | 'mdns' | 'seeds';
    timeoutMs?: number;
  }): Promise<NodeInfo[]> {
    const discovered = new Map<string, NodeInfo>();
    for (const node of this.registry.listStarted()) {
      discovered.set(node.nodeId, node.info());
    }
    for (const item of await this.registry.sharedStore.list(
      'foundation/nodes/',
    )) {
      const record = parsePublishedNodeRecord(item.value);
      if (record?.started) {
        discovered.set(record.nodeId, {
          nodeId: record.nodeId,
          nodeEpoch: record.nodeEpoch,
          addrs: record.addrs,
          props: record.props,
        });
      }
    }
    return [...discovered.values()].sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    );
  }

  /** Build the current peer table for CLI and UI inspection. */
  async getPeerTable(_opts?: { verbose?: boolean }): Promise<PeerTable> {
    return {
      nodeId: this.nodeId,
      entries: this.buildPeerEntries(await this.loadRouteState()),
    };
  }

  /** Build the current effective route table for CLI and UI inspection. */
  async getRouteTable(_opts?: { verbose?: boolean }): Promise<RouteTable> {
    const state = await this.loadRouteState();
    const knownNodeIds = new Set<string>();
    for (const nodeId of Object.keys(state.routes)) {
      if (nodeId !== this.nodeId) {
        knownNodeIds.add(nodeId);
      }
      const proxyNodeId = state.routes[nodeId]?.proxyNodeId;
      if (proxyNodeId && proxyNodeId !== this.nodeId) {
        knownNodeIds.add(proxyNodeId);
      }
    }
    for (const nodeId of Object.keys(state.deny)) {
      if (nodeId !== this.nodeId) {
        knownNodeIds.add(nodeId);
      }
    }
    for (const entry of this.buildPeerEntries(state)) {
      knownNodeIds.add(entry.nodeId);
    }
    if (
      state.proxyMode.defaultDstNodeId &&
      state.proxyMode.defaultDstNodeId !== this.nodeId
    ) {
      knownNodeIds.add(state.proxyMode.defaultDstNodeId);
    }

    const entries: RouteEntry[] = [...knownNodeIds]
      .sort((left, right) => left.localeCompare(right))
      .map((nodeId) => {
        const peer = this.buildPeerEntry(nodeId, state);
        const explicitRoute = state.routes[nodeId];
        const deny = state.deny[nodeId] ?? {};
        const path = this.renderPathForNode(
          nodeId,
          state,
          explicitRoute?.proxyNodeId ?? state.peers[nodeId]?.viaNodeId,
          peer?.viaDetail,
        );
        return {
          nodeId,
          via: explicitRoute?.proxyNodeId ?? peer?.via ?? '-',
          path,
          ways: peer?.ways ?? '-',
          state: explicitRoute?.proxyNodeId
            ? 'configured'
            : (peer?.state ?? 'configured'),
          denyIn: deny.in === true,
          denyOut: deny.out === true,
          ttlRemainingMs: peer?.ttlRemainingMs ?? null,
        };
      });

    return {
      nodeId: this.nodeId,
      proxyMode: { ...state.proxyMode },
      observationTtlMs: this.observationTtlMs,
      entries,
    };
  }

  /**
   * Connects to a peer.
   * @param target Target selector.
   * @param opts Opts.
   */
  async connect(
    target: RpcTarget,
    opts: ConnectOptions = {},
  ): Promise<{ ok: true; peer: NodeInfo; ttlMs: number | null }> {
    const ttlMs =
      typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : 0;
    const persist = opts.persist !== false;
    const resolved = await this.resolveDirectAddr(target);
    let opened: Awaited<
      ReturnType<typeof this.callHttpDetailed<{ ok: true; sessionId: string }>>
    >;
    try {
      opened = await this.callHttpDetailed<{ ok: true; sessionId: string }>(
        resolved.addr,
        'cord.foundation.reverse.open',
        { ttlMs } satisfies ReverseOpenPayload,
        {
          timeoutMs: 5_000,
          auth: this.makeInternalAuth(),
          originNodeId: this.nodeId,
        },
      );
    } catch (error) {
      throw new Error(
        `connect open failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await this.mergePeer(opened.peer.nodeId, (peer) => {
        this.applyNodeInfo(peer, opened.peer);
        peer.directAddr = resolved.addr;
        peer.connected = true;
        peer.suggested = false;
        peer.expiresAtMs = ttlMs > 0 ? Date.now() + ttlMs : null;
        peer.lastInboundMs = Date.now();
        peer.lastOutboundMs = Date.now();
        peer.lastSeenMs = Date.now();
      });
      await this.persistConnectIntent(
        opened.peer,
        target,
        resolved.addr,
        ttlMs > 0 ? ttlMs : null,
        persist,
      );
    } catch (error) {
      throw new Error(
        `connect persist failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const existing = this.reverseOutgoing.get(opened.peer.nodeId);
    if (existing) {
      existing.stop = true;
      this.reverseOutgoing.delete(opened.peer.nodeId);
    }

    const outgoing: ReverseOutgoingConnection = {
      remoteNodeId: opened.peer.nodeId,
      remoteAddr: resolved.addr,
      sessionId: opened.result.sessionId,
      expiresAtMs: ttlMs > 0 ? Date.now() + ttlMs : null,
      stop: false,
    };
    this.reverseOutgoing.set(opened.peer.nodeId, outgoing);
    void this.runReverseClient(outgoing);

    return {
      ok: true,
      peer: opened.peer,
      ttlMs: ttlMs > 0 ? ttlMs : null,
    };
  }

  /**
   * Disconnects a peer or route.
   * @param targetNodeId Target node id.
   */
  async disconnect(
    targetNodeId: string,
  ): Promise<{ ok: true; nodeId: string }> {
    const outgoing = this.reverseOutgoing.get(targetNodeId);
    if (outgoing) {
      outgoing.stop = true;
      this.reverseOutgoing.delete(targetNodeId);
      try {
        await this.callHttpDetailed(
          outgoing.remoteAddr,
          'cord.foundation.reverse.close',
          { sessionId: outgoing.sessionId } satisfies ReverseClosePayload,
          {
            timeoutMs: 2_000,
            auth: this.makeInternalAuth(),
            originNodeId: this.nodeId,
          },
        );
      } catch {
        // Best-effort close.
      }
    }

    const incoming = this.reverseIncoming.get(targetNodeId);
    if (incoming) {
      this.closeIncomingSession(incoming, 'closed by peer');
    }

    await this.mergePeer(targetNodeId, (peer) => {
      peer.connected = false;
      if (peer.expiresAtMs === null) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
    await this.removeConnectIntent(targetNodeId);

    return { ok: true, nodeId: targetNodeId };
  }

  /**
   * Handles restore persistent connections.
   */
  async restorePersistentConnections(): Promise<{
    ok: true;
    attempted: string[];
    restored: string[];
    failed: Array<{ target: string; error: string }>;
  }> {
    const now = Date.now();
    const intents = (await this.loadConnectIntents()).filter(
      (intent) => intent.expiresAtMs === null || intent.expiresAtMs > now,
    );
    if (intents.length === 0) {
      const current = await this.loadConnectIntents();
      if (current.length > 0) {
        await this.saveConnectIntents(intents);
      }
      return { ok: true, attempted: [], restored: [], failed: [] };
    }

    const attempted: string[] = [];
    const restored: string[] = [];
    const failed: Array<{ target: string; error: string }> = [];

    await Promise.allSettled(
      intents.map(async (intent) => {
        const label =
          intent.peerNodeId ?? `${intent.target.kind}:${intent.target.value}`;
        attempted.push(label);
        try {
          await this.restoreConnectIntent(intent);
          restored.push(label);
        } catch (error) {
          failed.push({
            target: label,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );

    return {
      ok: true,
      attempted: attempted.sort(),
      restored: restored.sort(),
      failed: failed.sort((left, right) =>
        left.target.localeCompare(right.target),
      ),
    };
  }

  /**
   * Learns the value.
   * @param target Target selector.
   */
  async learn(
    target: RpcTarget,
  ): Promise<{ ok: true; learned: string[]; skipped: string[] }> {
    const remote = await this.callDetailed<PeerSummary[]>(
      target,
      'cord.foundation.peer.list',
      {},
      { timeoutMs: 5_000, auth: this.makeInternalAuth() },
    );
    const learned: string[] = [];
    const skipped: string[] = [];
    for (const peer of remote.result) {
      if (peer.nodeId === this.nodeId || peer.nodeId === remote.peer.nodeId) {
        skipped.push(peer.nodeId);
        continue;
      }
      const current = (await this.loadRouteState()).peers[peer.nodeId];
      if (
        current?.connected ||
        (current &&
          !current.suggested &&
          (current.directAddr || current.viaNodeId))
      ) {
        skipped.push(peer.nodeId);
        continue;
      }
      await this.mergePeer(peer.nodeId, (localPeer) => {
        localPeer.nodeEpoch = peer.nodeEpoch;
        localPeer.addrs = peer.addrs;
        localPeer.props = peer.props;
        localPeer.viaNodeId = remote.peer.nodeId;
        localPeer.viaDetail = peer.viaKind === 'reverse' ? 'reverse' : 'direct';
        localPeer.suggested = true;
        localPeer.connected = false;
        localPeer.expiresAtMs = Date.now() + this.observationTtlMs;
        localPeer.lastSeenMs = Date.now();
      });
      learned.push(peer.nodeId);
    }
    return { ok: true, learned, skipped };
  }

  /**
   * Updates route.
   * @param targetNodeId Target node id.
   * @param proxyNodeId Proxy node id.
   */
  async setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void> {
    if (!targetNodeId || targetNodeId === this.nodeId) {
      throw new Error('route target must be a peer node');
    }
    if (
      proxyNodeId &&
      (proxyNodeId === this.nodeId || proxyNodeId === targetNodeId)
    ) {
      throw new Error('invalid route: proxy must be a different peer');
    }
    await this.updateRouteState((state) => {
      state.routes[targetNodeId] = proxyNodeId ? { proxyNodeId } : {};
    });
  }

  /**
   * Removes route.
   * @param targetNodeId Target node id.
   */
  async deleteRoute(targetNodeId: string): Promise<void> {
    await this.updateRouteState((state) => {
      delete state.routes[targetNodeId];
    });
  }

  /**
   * Updates route deny.
   * @param targetNodeId Target node id.
   * @param direction Direction.
   */
  async setRouteDeny(
    targetNodeId: string,
    direction: RouteDirection,
  ): Promise<void> {
    if (!targetNodeId || targetNodeId === this.nodeId) {
      throw new Error('deny target must be a peer node');
    }
    await this.updateRouteState((state) => {
      const current = state.deny[targetNodeId] ?? {};
      if (direction === 'in' || direction === 'both') {
        current.in = true;
      }
      if (direction === 'out' || direction === 'both') {
        current.out = true;
      }
      state.deny[targetNodeId] = current;
    });
  }

  /**
   * Updates proxy mode.
   * @param enabled Enabled.
   * @param defaultDstNodeId Default dst node id.
   */
  async setProxyMode(
    enabled: boolean,
    defaultDstNodeId?: string,
  ): Promise<void> {
    if (defaultDstNodeId === this.nodeId) {
      throw new Error('proxy default destination must be a different node');
    }
    await this.updateRouteState((state) => {
      state.proxyMode = {
        enabled,
        defaultDstNodeId:
          enabled && defaultDstNodeId ? defaultDstNodeId : undefined,
      };
    });
  }

  /**
   * Builds internal auth.
   */
  makeInternalAuth(): RpcAuth {
    return {
      userId: `node:${this.nodeId}`,
      groups: ['grp:internal'],
      internal: true,
    };
  }

  /**
   * Returns whether started.
   */
  isStarted(): boolean {
    return this.started;
  }

  /**
   * Starts HTTP server.
   */
  private async startHttpServer(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    const listenAddr = this.listenAddrs[0] ?? this.addrs[0];
    if (!listenAddr) {
      throw new Error(
        `Node ${this.nodeId} cannot start HTTP transport without an address`,
      );
    }
    const { host, port } = parseAddr(listenAddr);
    this.httpServer = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/healthz') {
          writeJson(res, 200, {
            ok: true,
            node: this.self(),
            pid: process.pid,
          });
          return;
        }
        if (req.method === 'POST' && req.url === '/rpc') {
          const payload = (await readRequestBody(req)) as {
            method?: string;
            params?: unknown;
            auth?: RpcAuth;
            traceId?: string;
            srcNodeId?: string;
            srcNodeInfo?: NodeInfo;
            originNodeId?: string;
          };
          if (
            typeof payload.method !== 'string' ||
            payload.method.length === 0
          ) {
            writeJson(res, 400, {
              ok: false,
              error: { message: 'Missing RPC method' },
            });
            return;
          }
          const result = await this.dispatch(
            payload.method,
            {
              auth: payload.auth,
              srcNodeId: payload.srcNodeId,
              srcNodeInfo: payload.srcNodeInfo,
              originNodeId: payload.originNodeId,
              traceId: payload.traceId,
            },
            payload.params,
          );
          writeJson(res, 200, { ok: true, node: this.self(), result });
          return;
        }
        writeJson(res, 404, {
          ok: false,
          error: {
            message: `Unknown route ${req.method ?? 'GET'} ${req.url ?? '/'}`,
          },
        });
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          node: this.self(),
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off('error', reject);
        resolve();
      });
    });
  }

  /**
   * Publishes node directory.
   * @param started Started.
   */
  private async publishNodeDirectory(started: boolean): Promise<void> {
    const key = nodeDirectoryKey(this.nodeId);
    if (!started) {
      await this.registry.sharedStore.del(key);
      return;
    }
    await this.registry.sharedStore.set(key, {
      ...this.self(),
      started,
      updatedAtMs: Date.now(),
      pid: process.pid,
    } satisfies PublishedNodeRecord);
  }

  /**
   * Handles lookup published node.
   * @param nodeId Node identifier.
   */
  private async lookupPublishedNode(
    nodeId: string,
  ): Promise<PublishedNodeRecord | null> {
    return parsePublishedNodeRecord(
      await this.registry.sharedStore.get(nodeDirectoryKey(nodeId)),
    );
  }

  /**
   * Handles load route state.
   */
  private async loadRouteState(): Promise<RouteStateRecord> {
    const state = parseRouteStateRecord(
      await this.registry.sharedStore.get(routeStateKey(this.nodeId)),
    );
    const now = Date.now();
    let changed = false;
    for (const peer of Object.values(state.peers)) {
      if (peer.connected && !this.isLiveConnectedPeer(peer.nodeId)) {
        peer.connected = false;
        if (peer.expiresAtMs === null) {
          peer.expiresAtMs = now + this.observationTtlMs;
        }
        changed = true;
      }
      if (
        peer.expiresAtMs &&
        peer.expiresAtMs <= now &&
        !peer.connected &&
        !state.routes[peer.nodeId] &&
        !state.deny[peer.nodeId]
      ) {
        delete state.peers[peer.nodeId];
        changed = true;
      }
    }
    if (changed) {
      await this.saveRouteState(state);
    }
    return state;
  }

  /**
   * Handles save route state.
   * @param state Internal state record.
   */
  private async saveRouteState(state: RouteStateRecord): Promise<void> {
    await this.registry.sharedStore.set(routeStateKey(this.nodeId), state);
  }

  /**
   * Handles load connect intents.
   */
  private async loadConnectIntents(): Promise<ConnectIntentRecord[]> {
    return parseConnectIntentRecords(
      await this.registry.sharedStore.get(connectIntentsKey(this.nodeId)),
    );
  }

  /**
   * Handles save connect intents.
   * @param intents Intents.
   */
  private async saveConnectIntents(
    intents: ConnectIntentRecord[],
  ): Promise<void> {
    const live = intents
      .filter(
        (intent) =>
          intent.expiresAtMs === null || intent.expiresAtMs > Date.now(),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    await this.registry.sharedStore.set(connectIntentsKey(this.nodeId), live);
  }

  /**
   * Handles persist connect intent.
   * @param peer Peer.
   * @param target Target selector.
   * @param directAddr Direct address.
   * @param ttlMs TTL ms.
   * @param persist Persist.
   */
  private async persistConnectIntent(
    peer: NodeInfo,
    target: RpcTarget,
    directAddr: string | undefined,
    ttlMs: number | null,
    persist: boolean,
  ): Promise<void> {
    const id = peer.nodeId;
    const intents = await this.loadConnectIntents();
    const next = intents.filter(
      (intent) => intent.id !== id && intent.peerNodeId !== peer.nodeId,
    );
    if (persist) {
      const normalizedTarget: ExecTarget =
        'addr' in target && typeof target.addr === 'string'
          ? { kind: 'addr', value: target.addr }
          : { kind: 'node', value: target.nodeId };
      next.push({
        id,
        target: normalizedTarget,
        peerNodeId: peer.nodeId,
        directAddr,
        expiresAtMs: ttlMs === null ? null : Date.now() + ttlMs,
        createdAtMs: Date.now(),
      });
    }
    await this.saveConnectIntents(next);
  }

  /**
   * Removes connect intent.
   * @param targetNodeId Target node id.
   */
  private async removeConnectIntent(targetNodeId: string): Promise<void> {
    const intents = await this.loadConnectIntents();
    await this.saveConnectIntents(
      intents.filter(
        (intent) =>
          intent.id !== targetNodeId && intent.peerNodeId !== targetNodeId,
      ),
    );
  }

  /**
   * Handles update route state.
   * @param mutator Mutator.
   */
  private async updateRouteState(
    mutator: (state: RouteStateRecord) => void,
  ): Promise<RouteStateRecord> {
    const state = await this.loadRouteState();
    mutator(state);
    await this.saveRouteState(state);
    return state;
  }

  /**
   * Handles restore connect intent.
   * @param intent Intent.
   */
  private async restoreConnectIntent(
    intent: ConnectIntentRecord,
  ): Promise<void> {
    const now = Date.now();
    if (intent.expiresAtMs !== null && intent.expiresAtMs <= now) {
      return;
    }
    const target: RpcTarget = intent.directAddr
      ? { addr: intent.directAddr }
      : intent.target.kind === 'addr'
        ? { addr: intent.target.value }
        : { nodeId: intent.target.value };
    const remainingTtlMs =
      intent.expiresAtMs === null
        ? undefined
        : Math.max(1, intent.expiresAtMs - now);
    await this.connect(target, {
      ttlMs: remainingTtlMs,
      persist: true,
    });
  }

  /**
   * Returns whether live connected peer.
   * @param nodeId Node identifier.
   */
  private isLiveConnectedPeer(nodeId: string): boolean {
    return this.reverseIncoming.has(nodeId) || this.reverseOutgoing.has(nodeId);
  }

  /**
   * Applies node info.
   * @param peer Peer.
   * @param info Table metadata.
   */
  private applyNodeInfo(peer: PeerStateRecord, info: NodeInfo): void {
    peer.nodeId = info.nodeId;
    peer.nodeEpoch = info.nodeEpoch;
    peer.addrs = info.addrs;
    peer.props = info.props;
  }

  /**
   * Merges peer.
   * @param nodeId Node identifier.
   * @param mutator Mutator.
   */
  private async mergePeer(
    nodeId: string,
    mutator: (peer: PeerStateRecord) => void,
  ): Promise<void> {
    await this.updateRouteState((state) => {
      const peer = state.peers[nodeId] ?? {
        nodeId,
        suggested: false,
        connected: false,
      };
      mutator(peer);
      state.peers[nodeId] = peer;
    });
  }

  /**
   * Learns inbound.
   * @param srcNodeId Src node id.
   * @param srcNodeInfo Src node info.
   */
  private async learnInbound(
    srcNodeId: string | undefined,
    srcNodeInfo: NodeInfo | undefined,
  ): Promise<void> {
    if (
      !srcNodeId ||
      srcNodeId === this.nodeId ||
      !isRouteVisibleNodeId(srcNodeId)
    ) {
      return;
    }
    await this.mergePeer(srcNodeId, (peer) => {
      if (srcNodeInfo) {
        this.applyNodeInfo(peer, srcNodeInfo);
        if (
          !peer.directAddr &&
          srcNodeInfo.addrs?.[0] &&
          isAddr(srcNodeInfo.addrs[0])
        ) {
          peer.directAddr = srcNodeInfo.addrs[0];
        }
      }
      peer.lastInboundMs = Date.now();
      peer.lastSeenMs = Date.now();
      peer.suggested = false;
      if (!peer.connected) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
  }

  /**
   * Learns outbound.
   * @param info Table metadata.
   * @param opts Optional call options.
   */
  private async learnOutbound(
    info: NodeInfo,
    opts: {
      addr?: string;
      viaNodeId?: string;
      viaDetail?: 'direct' | 'reverse';
      connected?: boolean;
    },
  ): Promise<void> {
    if (
      !info.nodeId ||
      info.nodeId === this.nodeId ||
      !isRouteVisibleNodeId(info.nodeId)
    ) {
      return;
    }
    await this.mergePeer(info.nodeId, (peer) => {
      this.applyNodeInfo(peer, info);
      if (opts.addr) {
        peer.directAddr = opts.addr;
      }
      if (opts.viaNodeId) {
        peer.viaNodeId = opts.viaNodeId;
        peer.viaDetail = opts.viaDetail ?? 'direct';
      }
      if (typeof opts.connected === 'boolean') {
        peer.connected = opts.connected;
      }
      peer.lastOutboundMs = Date.now();
      peer.lastSeenMs = Date.now();
      peer.suggested = false;
      if (!peer.connected) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
  }

  /**
   * Learns proxy origin.
   * @param originNodeId Origin node id.
   * @param viaNodeId Via node id.
   */
  private async learnProxyOrigin(
    originNodeId: string | undefined,
    viaNodeId: string | undefined,
  ): Promise<void> {
    if (
      !originNodeId ||
      !viaNodeId ||
      originNodeId === this.nodeId ||
      originNodeId === viaNodeId ||
      !isRouteVisibleNodeId(originNodeId)
    ) {
      return;
    }
    await this.mergePeer(originNodeId, (peer) => {
      peer.nodeId = originNodeId;
      peer.viaNodeId = viaNodeId;
      peer.viaDetail = 'direct';
      peer.lastInboundMs = Date.now();
      peer.lastSeenMs = Date.now();
      peer.suggested = false;
      if (!peer.connected) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
  }

  /**
   * Builds peer entries.
   * @param state Internal state record.
   */
  private buildPeerEntries(state: RouteStateRecord): PeerEntry[] {
    const now = Date.now();
    const entries: PeerEntry[] = [];
    for (const [nodeId, peer] of Object.entries(state.peers)) {
      const connected = Boolean(
        peer.connected && this.isLiveConnectedPeer(nodeId),
      );
      const outbound =
        connected ||
        (typeof peer.lastOutboundMs === 'number' &&
          peer.lastOutboundMs + this.observationTtlMs > now);
      const inbound =
        connected ||
        (typeof peer.lastInboundMs === 'number' &&
          peer.lastInboundMs + this.observationTtlMs > now);
      const suggested =
        peer.suggested === true && !connected && !outbound && !inbound;
      const stateLabel: PeerEntry['state'] = connected
        ? 'connected'
        : suggested
          ? 'suggested'
          : 'learned';
      if (!connected && !outbound && !inbound && !suggested) {
        continue;
      }
      entries.push({
        nodeId,
        via: this.viaLabelForPeer(nodeId, peer),
        ways:
          outbound && inbound
            ? 'both'
            : outbound
              ? 'out'
              : inbound
                ? 'in'
                : '-',
        ttlRemainingMs: connected
          ? null
          : peer.expiresAtMs
            ? Math.max(0, peer.expiresAtMs - now)
            : null,
        state: stateLabel,
        nodeEpoch: peer.nodeEpoch,
        addrs: peer.addrs,
        props: peer.props,
      });
    }
    return entries.sort((left, right) =>
      left.nodeId.localeCompare(right.nodeId),
    );
  }

  /**
   * Builds peer entry.
   * @param nodeId Node identifier.
   * @param state Internal state record.
   */
  private buildPeerEntry(
    nodeId: string,
    state: RouteStateRecord,
  ):
    | (PeerEntry & { viaValue?: string; viaDetail?: 'direct' | 'reverse' })
    | null {
    const peer = state.peers[nodeId];
    if (!peer) {
      return null;
    }
    const entry = this.buildPeerEntries(state).find(
      (item) => item.nodeId === nodeId,
    );
    if (!entry) {
      return null;
    }
    return {
      ...entry,
      viaValue: peer.viaNodeId ?? peer.directAddr ?? peer.addrs?.[0],
      viaDetail: peer.viaDetail,
    };
  }

  /**
   * Handles via label for peer.
   * @param nodeId Node identifier.
   * @param peer Peer.
   */
  private viaLabelForPeer(nodeId: string, peer: PeerStateRecord): string {
    if (peer.connected && this.reverseIncoming.has(nodeId)) {
      return 'reverse';
    }
    if (peer.viaNodeId) {
      return `via ${peer.viaNodeId}`;
    }
    if (peer.directAddr) {
      return peer.directAddr;
    }
    if (peer.addrs?.[0]) {
      return peer.addrs[0];
    }
    if (peer.connected && this.reverseOutgoing.has(nodeId)) {
      return this.reverseOutgoing.get(nodeId)!.remoteAddr;
    }
    return '-';
  }

  /**
   * Handles render path for node.
   * @param nodeId Node identifier.
   * @param state Internal state record.
   * @param explicitProxyNodeId Explicit proxy node id.
   * @param viaDetail Via detail.
   */
  private renderPathForNode(
    nodeId: string,
    state: RouteStateRecord,
    explicitProxyNodeId?: string,
    viaDetail?: 'direct' | 'reverse',
  ): string {
    if (this.reverseIncoming.has(nodeId)) {
      return `${this.nodeId} -< ${nodeId}`;
    }
    const proxyNodeId = explicitProxyNodeId || state.peers[nodeId]?.viaNodeId;
    if (proxyNodeId) {
      return `${this.nodeId} -> ${proxyNodeId}${viaDetail === 'reverse' ? ` -< ${nodeId}` : ` -> ${nodeId}`}`;
    }
    return `${this.nodeId} -> ${nodeId}`;
  }

  /**
   * Resolves direct address.
   * @param target Target selector.
   */
  private async resolveDirectAddr(
    target: RpcTarget,
  ): Promise<{ addr: string; nodeId?: string }> {
    if ('addr' in target && typeof target.addr === 'string') {
      return { addr: target.addr };
    }
    const state = await this.loadRouteState();
    const peer = state.peers[target.nodeId];
    if (peer?.directAddr) {
      return { addr: peer.directAddr, nodeId: target.nodeId };
    }
    if (peer?.addrs?.[0]) {
      return { addr: peer.addrs[0], nodeId: target.nodeId };
    }
    const local = this.registry.getNode(target.nodeId);
    if (local?.started) {
      const addr = local.info().addrs?.[0];
      if (addr) {
        return { addr, nodeId: target.nodeId };
      }
    }
    const published = await this.lookupPublishedNode(target.nodeId);
    if (published?.started && published.addrs?.[0]) {
      return { addr: published.addrs[0], nodeId: target.nodeId };
    }
    throw new Error(`Target ${target.nodeId} is not available`);
  }

  /**
   * Handles call detailed.
   * @param target Target selector.
   * @param method Method.
   * @param params SQL parameters.
   * @param opts Optional call options.
   */
  private async callDetailed<T>(
    target: RpcTarget,
    method: string,
    params: unknown,
    opts: RpcCallOptions = {},
  ): Promise<CallResult<T>> {
    const timeoutMs = opts.timeoutMs ?? 1000;
    const originNodeId = opts.originNodeId ?? this.nodeId;
    const ctxBase = {
      auth: opts.auth,
      srcNodeId: this.nodeId,
      srcNodeInfo: this.self(),
      originNodeId,
      traceId: opts.traceId,
    } satisfies RpcCtx;

    if ('nodeId' in target && typeof target.nodeId === 'string') {
      const local = this.registry.getNode(target.nodeId);
      if (local?.started) {
        if (!this.registry.canReach(this.nodeId, local.nodeId)) {
          throw new Error(`Node ${this.nodeId} cannot reach ${local.nodeId}`);
        }
        const result = await raceTimeout(
          local.dispatch(method, ctxBase, params) as Promise<T>,
          timeoutMs,
          `${method} -> ${local.nodeId}`,
        );
        await this.learnOutbound(local.info(), {
          addr: local.info().addrs?.[0],
        });
        return {
          result,
          peer: local.info(),
          via: 'local',
          addr: local.info().addrs?.[0],
        };
      }

      const reverseSession = this.getActiveIncomingSession(target.nodeId);
      if (reverseSession) {
        const result = await this.callReverse<T>(
          reverseSession,
          method,
          params,
          {
            timeoutMs,
            traceId: opts.traceId,
            auth: opts.auth,
            originNodeId,
          },
        );
        await this.learnOutbound(reverseSession.peer, {
          viaNodeId: undefined,
          viaDetail: 'reverse',
          connected: true,
        });
        return {
          result,
          peer: reverseSession.peer,
          via: 'reverse',
        };
      }

      const resolved = await this.resolveDirectAddr(target);
      const remote = await raceTimeout(
        this.callHttpDetailed<T>(resolved.addr, method, params, {
          ...opts,
          originNodeId,
        }),
        timeoutMs,
        `${method} -> ${target.nodeId}`,
      );
      await this.learnOutbound(remote.peer, { addr: resolved.addr });
      return {
        result: remote.result,
        peer: remote.peer,
        via: 'direct',
        addr: resolved.addr,
      };
    }

    const local = this.registry.getNodeByAddr(target.addr);
    if (local?.started) {
      if (!this.registry.canReach(this.nodeId, local.nodeId)) {
        throw new Error(`Node ${this.nodeId} cannot reach ${local.nodeId}`);
      }
      const result = await raceTimeout(
        local.dispatch(method, ctxBase, params) as Promise<T>,
        timeoutMs,
        `${method} -> ${local.nodeId}`,
      );
      await this.learnOutbound(local.info(), { addr: target.addr });
      return {
        result,
        peer: local.info(),
        via: 'local',
        addr: target.addr,
      };
    }

    const remote = await raceTimeout(
      this.callHttpDetailed<T>(target.addr, method, params, {
        ...opts,
        originNodeId,
      }),
      timeoutMs,
      `${method} -> ${target.addr}`,
    );
    await this.learnOutbound(remote.peer, { addr: target.addr });
    return {
      result: remote.result,
      peer: remote.peer,
      via: 'direct',
      addr: target.addr,
    };
  }

  /**
   * Handles call HTTP detailed.
   * @param addr Network address.
   * @param method Method.
   * @param params SQL parameters.
   * @param opts Optional call options.
   */
  private async callHttpDetailed<T>(
    addr: string,
    method: string,
    params: unknown,
    opts: RpcCallOptions,
  ): Promise<{ result: T; peer: NodeInfo }> {
    const response = await fetch(`http://${addr}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        method,
        params,
        auth: opts.auth,
        traceId: opts.traceId,
        srcNodeId: this.nodeId,
        srcNodeInfo: this.self(),
        originNodeId: opts.originNodeId ?? this.nodeId,
      }),
    });
    const payload = (await response.json()) as RpcHttpResponse<T>;
    if (!response.ok || payload.ok === false) {
      throw new Error(
        payload.error?.message ?? `${method} failed against ${addr}`,
      );
    }
    if (!payload.node?.nodeId) {
      throw new Error(
        `${method} failed against ${addr}: missing remote node metadata`,
      );
    }
    return {
      result: payload.result as T,
      peer: payload.node,
    };
  }

  /**
   * Dispatches the request to the matching handler.
   * @param method Method.
   * @param ctx Execution context.
   * @param params SQL parameters.
   */
  private async dispatch(
    method: string,
    ctx: RpcCtx,
    params: unknown,
  ): Promise<unknown> {
    await this.learnInbound(ctx.srcNodeId, ctx.srcNodeInfo);
    await this.learnProxyOrigin(ctx.originNodeId, ctx.srcNodeId);
    await this.enforceInboundRoutePolicy(ctx.srcNodeId);
    return this.invokeHandler(method, ctx, params);
  }

  /**
   * Invokes the resolved handler and normalizes its result.
   * @param method Method.
   * @param ctx Execution context.
   * @param params SQL parameters.
   */
  private async invokeHandler(
    method: string,
    ctx: RpcCtx,
    params: unknown,
  ): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Unknown RPC method ${method}`);
    }
    this.assertPayloadLimit(params);
    this.enforceRateLimit(ctx, method);
    if (this.authorize) {
      await this.authorize(method, ctx);
    }
    return handler(ctx, params);
  }

  /**
   * Handles enforce inbound route policy.
   * @param srcNodeId Src node id.
   */
  private async enforceInboundRoutePolicy(
    srcNodeId: string | undefined,
  ): Promise<void> {
    if (
      !srcNodeId ||
      srcNodeId === this.nodeId ||
      !isRouteVisibleNodeId(srcNodeId)
    ) {
      return;
    }
    const state = await this.loadRouteState();
    if (state.deny[srcNodeId]?.in) {
      throw new Error(`route denied: in from ${srcNodeId}`);
    }
  }

  /**
   * Handles execute routed.
   * @param ctx Execution context.
   * @param request Request.
   */
  private async executeRouted(
    ctx: RpcCtx,
    request: FoundationExecRequest,
  ): Promise<FoundationExecResponse> {
    if (!request.method || request.method === 'cord.foundation.exec') {
      throw new Error('invalid routed exec method');
    }

    const state = await this.loadRouteState();
    const effectiveDst =
      request.dst ??
      (state.proxyMode.enabled && state.proxyMode.defaultDstNodeId
        ? { kind: 'node', value: state.proxyMode.defaultDstNodeId }
        : undefined);
    const timeoutMs = request.timeoutMs ?? 5000;
    const originNodeId = ctx.originNodeId ?? ctx.srcNodeId ?? this.nodeId;

    if (
      !effectiveDst ||
      (effectiveDst.kind === 'node' && effectiveDst.value === this.nodeId) ||
      (effectiveDst.kind === 'addr' &&
        [...this.addrs, ...this.listenAddrs].includes(effectiveDst.value))
    ) {
      return {
        result: await this.invokeHandler(request.method, ctx, request.params),
        route: {
          contactedNodeId: this.nodeId,
          executedNodeId: this.nodeId,
          mode: 'local',
          nextHopNodeId: this.nodeId,
          path: [this.nodeId],
          hops: request.path ?? [],
        },
      };
    }

    if (effectiveDst.kind === 'addr') {
      const outbound = await this.callDetailed(
        { addr: effectiveDst.value },
        request.method,
        request.params,
        {
          timeoutMs,
          traceId: request.traceId ?? ctx.traceId,
          auth: ctx.auth,
          originNodeId,
        },
      );
      return {
        result: outbound.result,
        route: {
          contactedNodeId: this.nodeId,
          executedNodeId: outbound.peer.nodeId,
          mode: 'direct',
          nextHopNodeId: outbound.peer.nodeId,
          path: hopPath([
            ...(request.path ?? []),
            {
              from: this.nodeId,
              to: outbound.peer.nodeId,
              kind: outbound.via === 'reverse' ? 'reverse' : 'direct',
            },
          ]),
          hops: [
            ...(request.path ?? []),
            {
              from: this.nodeId,
              to: outbound.peer.nodeId,
              kind: outbound.via === 'reverse' ? 'reverse' : 'direct',
            },
          ],
        },
      };
    }

    const dstNodeId = effectiveDst.value;
    const route = state.routes[dstNodeId];
    const learnedPeer = state.peers[dstNodeId];
    const proxyNodeId =
      route?.proxyNodeId ??
      (learnedPeer && !learnedPeer.suggested
        ? learnedPeer.viaNodeId
        : undefined);
    const hopCount = request.hopCount ?? 0;
    const denyOutToDst = state.deny[dstNodeId]?.out === true;

    if (hopCount > 0 && proxyNodeId) {
      throw new Error('invalid route: proxy hop exceeds 1');
    }

    if (hopCount === 0 && proxyNodeId) {
      if (state.deny[proxyNodeId]?.out) {
        throw new Error(
          `cannot reach proxy ${proxyNodeId} (route denied or unreachable)`,
        );
      }
      try {
        const forwarded = await this.callDetailed<FoundationExecResponse>(
          { nodeId: proxyNodeId },
          'cord.foundation.exec',
          {
            ...request,
            dst: { kind: 'node', value: dstNodeId },
            hopCount: 1,
            path: [
              ...(request.path ?? []),
              { from: this.nodeId, to: proxyNodeId, kind: 'direct' },
            ],
          } satisfies FoundationExecRequest,
          {
            timeoutMs,
            traceId: request.traceId ?? ctx.traceId,
            auth: ctx.auth,
            originNodeId,
          },
        );

        const tailHop =
          forwarded.result.route.hops[forwarded.result.route.hops.length - 1];
        await this.mergePeer(dstNodeId, (peer) => {
          peer.nodeId = dstNodeId;
          peer.viaNodeId = proxyNodeId;
          peer.viaDetail = tailHop?.kind === 'reverse' ? 'reverse' : 'direct';
          peer.lastOutboundMs = Date.now();
          peer.lastSeenMs = Date.now();
          peer.suggested = false;
          if (!peer.connected) {
            peer.expiresAtMs = Date.now() + this.observationTtlMs;
          }
        });

        return {
          result: forwarded.result.result,
          route: {
            contactedNodeId: this.nodeId,
            executedNodeId: forwarded.result.route.executedNodeId,
            mode: 'proxy',
            nextHopNodeId: proxyNodeId,
            path: forwarded.result.route.path,
            hops: forwarded.result.route.hops,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('route denied') ||
          message.includes('cannot reach') ||
          message.includes('Target ')
        ) {
          throw new Error(
            `cannot reach proxy ${proxyNodeId} (route denied or unreachable)`,
          );
        }
        throw error;
      }
    }

    const reverseAvailable = this.getActiveIncomingSession(dstNodeId) !== null;
    if (denyOutToDst && !reverseAvailable) {
      if (hopCount > 0) {
        throw new Error(
          `cannot reach destination ${dstNodeId} from proxy ${this.nodeId} (route denied or unreachable)`,
        );
      }
      throw new Error(
        `no route to ${dstNodeId} (direct denied, no proxy route)`,
      );
    }

    try {
      const outbound = await this.callDetailed(
        { nodeId: dstNodeId },
        request.method,
        request.params,
        {
          timeoutMs,
          traceId: request.traceId ?? ctx.traceId,
          auth: ctx.auth,
          originNodeId,
        },
      );
      return {
        result: outbound.result,
        route: {
          contactedNodeId: this.nodeId,
          executedNodeId: outbound.peer.nodeId,
          mode: hopCount > 0 ? 'proxy' : 'direct',
          nextHopNodeId: outbound.peer.nodeId,
          path: hopPath([
            ...(request.path ?? []),
            {
              from: this.nodeId,
              to: outbound.peer.nodeId,
              kind: outbound.via === 'reverse' ? 'reverse' : 'direct',
            },
          ]),
          hops: [
            ...(request.path ?? []),
            {
              from: this.nodeId,
              to: outbound.peer.nodeId,
              kind: outbound.via === 'reverse' ? 'reverse' : 'direct',
            },
          ],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        hopCount > 0 &&
        (message.includes('Target ') ||
          message.includes('cannot reach') ||
          message.includes('route denied'))
      ) {
        throw new Error(
          `cannot reach destination ${dstNodeId} from proxy ${this.nodeId} (route denied or unreachable)`,
        );
      }
      throw error;
    }
  }

  /**
   * Validates payload limit.
   * @param params SQL parameters.
   */
  private assertPayloadLimit(params: unknown): void {
    if (estimateBytes(params) > this.maxPayloadBytes) {
      throw new Error(
        `RPC payload exceeds limit of ${this.maxPayloadBytes} bytes`,
      );
    }
  }

  /**
   * Handles enforce rate limit.
   * @param ctx Execution context.
   * @param method Method.
   */
  private enforceRateLimit(ctx: RpcCtx, method: string): void {
    const auth = ctx.auth;
    if (auth?.internal || auth?.userId) {
      return;
    }
    const guestAllow = new Set([
      'cord.foundation.ping',
      'cord.foundation.whoami',
      'cord.cluster.heartbeat',
      'cord.bootstrap.register_unallocated',
    ]);
    if (!guestAllow.has(method)) {
      throw new Error(`Guest access denied for ${method}`);
    }

    const key = ctx.srcNodeId ?? 'guest:anonymous';
    const now = Date.now();
    const current = this.guestWindows.get(key);
    if (!current || now - current.windowStartMs >= this.rateLimitWindowMs) {
      this.guestWindows.set(key, { windowStartMs: now, count: 1 });
      return;
    }
    if (current.count >= this.guestRateLimitPerWindow) {
      throw new Error(`Rate limit exceeded for ${key}`);
    }
    current.count += 1;
  }

  /**
   * Returns active incoming session.
   * @param nodeId Node identifier.
   */
  private getActiveIncomingSession(
    nodeId: string,
  ): ReverseIncomingSession | null {
    const session = this.reverseIncoming.get(nodeId);
    if (!session) {
      return null;
    }
    if (session.expiresAtMs && session.expiresAtMs <= Date.now()) {
      this.closeIncomingSession(session, 'reverse session expired');
      return null;
    }
    if (Date.now() - session.lastSeenMs > 45_000) {
      this.closeIncomingSession(session, 'reverse session stale');
      return null;
    }
    return session;
  }

  /**
   * Handles close incoming session.
   * @param session Session.
   * @param reason Reason.
   */
  private closeIncomingSession(
    session: ReverseIncomingSession,
    reason: string,
  ): void {
    this.reverseIncoming.delete(session.peer.nodeId);
    for (const waiter of session.waiters) {
      waiter({ kind: 'noop' });
    }
    session.waiters.length = 0;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    session.pending.clear();
    void this.mergePeer(session.peer.nodeId, (peer) => {
      peer.connected = false;
      if (peer.expiresAtMs === null) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
  }

  /**
   * Handles call reverse.
   * @param session Session.
   * @param method Method.
   * @param params SQL parameters.
   * @param opts Optional call options.
   */
  private async callReverse<T>(
    session: ReverseIncomingSession,
    method: string,
    params: unknown,
    opts: RpcCallOptions,
  ): Promise<T> {
    const requestId = randomId('revreq');
    const timeoutMs = opts.timeoutMs ?? 5000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(requestId);
        reject(
          new Error(
            `${method} -> ${session.peer.nodeId} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      session.pending.set(requestId, {
        /**
         * Resolves the value.
         * @param value Value to process.
         */
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      const request: ReverseRequest = {
        requestId,
        method,
        params,
        auth: opts.auth,
        traceId: opts.traceId,
        srcNodeId: this.nodeId,
        srcNodeInfo: this.self(),
        originNodeId: opts.originNodeId ?? this.nodeId,
      };
      const waiter = session.waiters.shift();
      if (waiter) {
        waiter({ kind: 'request', request });
      } else {
        session.queue.push(request);
      }
    });
  }

  /**
   * Runs reverse client.
   * @param connection Connection.
   */
  private async runReverseClient(
    connection: ReverseOutgoingConnection,
  ): Promise<void> {
    while (this.started && !connection.stop) {
      if (connection.expiresAtMs && connection.expiresAtMs <= Date.now()) {
        break;
      }
      try {
        const polled = await this.callHttpDetailed<ReversePollResponse>(
          connection.remoteAddr,
          'cord.foundation.reverse.poll',
          {
            sessionId: connection.sessionId,
            waitMs: 15_000,
          } satisfies ReversePollPayload,
          {
            timeoutMs: 20_000,
            auth: this.makeInternalAuth(),
            originNodeId: this.nodeId,
          },
        );
        await this.learnOutbound(polled.peer, {
          addr: connection.remoteAddr,
          connected: true,
        });
        if (polled.result.kind === 'request') {
          await this.handleReverseRequest(connection, polled.result.request);
        }
      } catch (error) {
        if (connection.stop) {
          break;
        }
        await delay(500);
        if (connection.expiresAtMs && connection.expiresAtMs <= Date.now()) {
          break;
        }
        if (!this.started) {
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes('Unknown RPC method') ||
          message.includes('invalid reverse session')
        ) {
          break;
        }
      }
    }
    this.reverseOutgoing.delete(connection.remoteNodeId);
    await this.mergePeer(connection.remoteNodeId, (peer) => {
      peer.connected = false;
      if (peer.expiresAtMs === null) {
        peer.expiresAtMs = Date.now() + this.observationTtlMs;
      }
    });
  }

  /**
   * Handles handle reverse request.
   * @param connection Connection.
   * @param request Request.
   */
  private async handleReverseRequest(
    connection: ReverseOutgoingConnection,
    request: ReverseRequest,
  ): Promise<void> {
    let ok = true;
    let result: unknown;
    let errorText: string | undefined;
    try {
      result = await this.dispatch(
        request.method,
        {
          auth: request.auth,
          srcNodeId: request.srcNodeId,
          srcNodeInfo: request.srcNodeInfo,
          originNodeId: request.originNodeId,
          traceId: request.traceId,
        },
        request.params,
      );
    } catch (error) {
      ok = false;
      errorText = error instanceof Error ? error.message : String(error);
    }

    await this.callHttpDetailed(
      connection.remoteAddr,
      'cord.foundation.reverse.reply',
      {
        sessionId: connection.sessionId,
        requestId: request.requestId,
        ok,
        result,
        error: errorText,
      } satisfies ReverseReplyPayload,
      {
        timeoutMs: 5_000,
        auth: this.makeInternalAuth(),
        originNodeId: this.nodeId,
      },
    );
  }

  /**
   * Handles handle reverse open.
   * @param ctx Execution context.
   * @param payload Payload value.
   */
  private async handleReverseOpen(
    ctx: RpcCtx,
    payload: ReverseOpenPayload,
  ): Promise<{ ok: true; sessionId: string }> {
    const peer =
      ctx.srcNodeInfo ??
      (ctx.srcNodeId ? { nodeId: ctx.srcNodeId, nodeEpoch: 'unknown' } : null);
    if (!peer?.nodeId) {
      throw new Error('reverse.open requires srcNodeInfo');
    }
    const existing = this.reverseIncoming.get(peer.nodeId);
    if (existing) {
      this.closeIncomingSession(existing, 'replaced by new reverse session');
    }
    const session: ReverseIncomingSession = {
      sessionId: randomId('reverse'),
      peer,
      expiresAtMs:
        typeof payload.ttlMs === 'number' && payload.ttlMs > 0
          ? Date.now() + payload.ttlMs
          : null,
      lastSeenMs: Date.now(),
      queue: [],
      waiters: [],
      pending: new Map(),
    };
    this.reverseIncoming.set(peer.nodeId, session);
    await this.mergePeer(peer.nodeId, (record) => {
      this.applyNodeInfo(record, peer);
      record.connected = true;
      record.suggested = false;
      record.expiresAtMs = session.expiresAtMs;
      record.lastInboundMs = Date.now();
      record.lastOutboundMs = Date.now();
      record.lastSeenMs = Date.now();
    });
    return {
      ok: true,
      sessionId: session.sessionId,
    };
  }

  /**
   * Handles handle reverse poll.
   * @param ctx Execution context.
   * @param payload Payload value.
   */
  private async handleReversePoll(
    ctx: RpcCtx,
    payload: ReversePollPayload,
  ): Promise<ReversePollResponse> {
    const peerNodeId = ctx.srcNodeId;
    if (!peerNodeId) {
      throw new Error('reverse.poll requires srcNodeId');
    }
    const session = this.reverseIncoming.get(peerNodeId);
    if (!session || session.sessionId !== payload.sessionId) {
      throw new Error('invalid reverse session');
    }
    session.lastSeenMs = Date.now();
    if (session.expiresAtMs && session.expiresAtMs <= Date.now()) {
      this.closeIncomingSession(session, 'reverse session expired');
      throw new Error('invalid reverse session');
    }
    if (session.queue.length > 0) {
      return { kind: 'request', request: session.queue.shift()! };
    }
    return new Promise<ReversePollResponse>((resolve) => {
      const timer = setTimeout(
        () => {
          const index = session.waiters.indexOf(handler);
          if (index >= 0) {
            session.waiters.splice(index, 1);
          }
          resolve({ kind: 'noop' });
        },
        Math.max(500, Number(payload.waitMs ?? 15_000)),
      );
      /**
       * Handles handler.
       * @param response Response.
       */
      const handler = (response: ReversePollResponse) => {
        clearTimeout(timer);
        resolve(response);
      };
      session.waiters.push(handler);
    });
  }

  /**
   * Handles handle reverse reply.
   * @param ctx Execution context.
   * @param payload Payload value.
   */
  private async handleReverseReply(
    ctx: RpcCtx,
    payload: ReverseReplyPayload,
  ): Promise<{ ok: true }> {
    const peerNodeId = ctx.srcNodeId;
    if (!peerNodeId) {
      throw new Error('reverse.reply requires srcNodeId');
    }
    const session = this.reverseIncoming.get(peerNodeId);
    if (!session || session.sessionId !== payload.sessionId) {
      throw new Error('invalid reverse session');
    }
    const pending = session.pending.get(payload.requestId);
    if (!pending) {
      throw new Error(`unknown reverse request ${payload.requestId}`);
    }
    session.pending.delete(payload.requestId);
    clearTimeout(pending.timer);
    if (payload.ok) {
      pending.resolve(payload.result);
    } else {
      pending.reject(
        new Error(
          payload.error ?? `reverse request ${payload.requestId} failed`,
        ),
      );
    }
    session.lastSeenMs = Date.now();
    return { ok: true };
  }

  /**
   * Handles handle reverse close.
   * @param ctx Execution context.
   * @param payload Payload value.
   */
  private async handleReverseClose(
    ctx: RpcCtx,
    payload: ReverseClosePayload,
  ): Promise<{ ok: true }> {
    const peerNodeId = ctx.srcNodeId;
    if (!peerNodeId) {
      throw new Error('reverse.close requires srcNodeId');
    }
    const session = this.reverseIncoming.get(peerNodeId);
    if (session && session.sessionId === payload.sessionId) {
      this.closeIncomingSession(session, 'closed by remote');
    }
    return { ok: true };
  }

  /**
   * Lists peer summaries.
   */
  private async listPeerSummaries(): Promise<PeerSummary[]> {
    const state = await this.loadRouteState();
    return this.buildPeerEntries(state).map((entry) => {
      const peer = state.peers[entry.nodeId];
      return {
        nodeId: entry.nodeId,
        nodeEpoch: peer?.nodeEpoch,
        addrs: peer?.addrs,
        props: peer?.props,
        viaKind: this.reverseIncoming.has(entry.nodeId)
          ? 'reverse'
          : peer?.viaNodeId
            ? 'proxy'
            : peer?.directAddr || peer?.addrs?.[0]
              ? 'direct'
              : 'unknown',
        viaValue: peer?.viaNodeId ?? peer?.directAddr ?? peer?.addrs?.[0],
        viaDetail: peer?.viaDetail,
        ways: entry.ways,
        ttlRemainingMs: entry.ttlRemainingMs,
        state: entry.state,
      } satisfies PeerSummary;
    });
  }

  /**
   * Handles register foundation builtins.
   */
  private registerFoundationBuiltins(): void {
    this.registerHandler('cord.foundation.ping', async () => ({ ok: true }));
    this.registerHandler('cord.foundation.whoami', async () => this.self());
    this.registerHandler('cord.foundation.exec', async (ctx, params) =>
      this.executeRouted(ctx, params as FoundationExecRequest),
    );
    this.registerHandler('cord.foundation.peer.list', async () =>
      this.listPeerSummaries(),
    );
    this.registerHandler('cord.foundation.peers', async () =>
      this.getPeerTable(),
    );
    this.registerHandler('cord.foundation.routes', async () =>
      this.getRouteTable(),
    );
    this.registerHandler('cord.foundation.connect', async (_ctx, params) => {
      const payload = params as {
        target?: ExecTarget;
        ttlMs?: number;
        persist?: boolean;
      };
      if (!payload.target) {
        throw new Error('connect requires a target');
      }
      return this.connect(
        payload.target.kind === 'addr'
          ? { addr: payload.target.value }
          : { nodeId: payload.target.value },
        { ttlMs: payload.ttlMs, persist: payload.persist },
      );
    });
    this.registerHandler('cord.foundation.disconnect', async (_ctx, params) => {
      const payload = params as { targetNodeId?: string };
      return this.disconnect(String(payload.targetNodeId ?? ''));
    });
    this.registerHandler('cord.foundation.restore', async () =>
      this.restorePersistentConnections(),
    );
    this.registerHandler('cord.foundation.learn', async (_ctx, params) => {
      const payload = params as { target?: ExecTarget };
      if (!payload.target) {
        throw new Error('learn requires a target');
      }
      return this.learn(
        payload.target.kind === 'addr'
          ? { addr: payload.target.value }
          : { nodeId: payload.target.value },
      );
    });
    this.registerHandler('cord.foundation.route', async (_ctx, params) => {
      const payload = params as {
        op?: string;
        targetNodeId?: string;
        proxyNodeId?: string;
        direction?: RouteDirection;
      };
      switch (payload.op) {
        case 'print':
          return this.getRouteTable();
        case 'add':
          await this.setRoute(
            String(payload.targetNodeId ?? ''),
            typeof payload.proxyNodeId === 'string'
              ? payload.proxyNodeId
              : undefined,
          );
          return { ok: true };
        case 'del':
          await this.deleteRoute(String(payload.targetNodeId ?? ''));
          return { ok: true };
        case 'deny':
          await this.setRouteDeny(
            String(payload.targetNodeId ?? ''),
            payload.direction ?? 'both',
          );
          return { ok: true };
        default:
          throw new Error(`Unknown route op ${String(payload.op ?? '')}`);
      }
    });
    this.registerHandler('cord.foundation.proxy', async (_ctx, params) => {
      const payload = params as {
        enabled?: boolean;
        defaultDstNodeId?: string;
      };
      await this.setProxyMode(
        payload.enabled === true,
        typeof payload.defaultDstNodeId === 'string'
          ? payload.defaultDstNodeId
          : undefined,
      );
      const table = await this.getRouteTable();
      return { ok: true, proxyMode: table.proxyMode };
    });
    this.registerHandler('cord.foundation.reverse.open', async (ctx, params) =>
      this.handleReverseOpen(ctx, params as ReverseOpenPayload),
    );
    this.registerHandler('cord.foundation.reverse.poll', async (ctx, params) =>
      this.handleReversePoll(ctx, params as ReversePollPayload),
    );
    this.registerHandler('cord.foundation.reverse.reply', async (ctx, params) =>
      this.handleReverseReply(ctx, params as ReverseReplyPayload),
    );
    this.registerHandler('cord.foundation.reverse.close', async (ctx, params) =>
      this.handleReverseClose(ctx, params as ReverseClosePayload),
    );
  }
}
