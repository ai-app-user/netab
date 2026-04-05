import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomId } from "../shared/utils.js";
import { CordRegistry } from "./registry.js";
import type {
  CommandHandler,
  FoundationNode,
  NodeInfo,
  RouteDirection,
  RouteEntry,
  RouteTable,
  RpcAuth,
  RpcCallOptions,
  RpcCtx,
  RpcTarget,
} from "./types.js";

type FoundationOptions = {
  nodeId: string;
  nodeEpoch?: string;
  listenHttp?: boolean;
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

type RouteStateRecord = {
  version: 1;
  routes: Record<string, { proxyNodeId?: string }>;
  deny: Record<string, { in?: boolean; out?: boolean }>;
  proxyMode: {
    enabled: boolean;
    defaultDstNodeId?: string;
  };
  observations: Record<string, { lastInboundMs?: number; lastOutboundMs?: number }>;
};

type FoundationExecRequest = {
  method: string;
  params: unknown;
  dstNodeId?: string;
  timeoutMs?: number;
  traceId?: string;
  verbose?: boolean;
  hopCount?: number;
  path?: string[];
};

type FoundationExecResponse = {
  result: unknown;
  route: {
    contactedNodeId: string;
    executedNodeId: string;
    mode: "local" | "direct" | "proxy";
    nextHopNodeId: string;
    proxyNodeId?: string;
    path: string[];
  };
};

function nodeDirectoryKey(nodeId: string): string {
  return `foundation/nodes/${nodeId}`;
}

function routeStateKey(nodeId: string): string {
  return `foundation/routes/${nodeId}`;
}

function emptyRouteState(): RouteStateRecord {
  return {
    version: 1,
    routes: {},
    deny: {},
    proxyMode: {
      enabled: false,
    },
    observations: {},
  };
}

function parseAddr(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(":");
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

function parsePublishedNodeRecord(value: unknown): PublishedNodeRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.nodeId !== "string" || typeof record.nodeEpoch !== "string") {
    return null;
  }
  return {
    nodeId: record.nodeId,
    nodeEpoch: record.nodeEpoch,
    addrs: Array.isArray(record.addrs) ? record.addrs.filter((item): item is string => typeof item === "string") : undefined,
    props: record.props,
    started: record.started !== false,
    updatedAtMs: typeof record.updatedAtMs === "number" ? record.updatedAtMs : 0,
    pid: typeof record.pid === "number" ? record.pid : 0,
  };
}

function parseRouteStateRecord(value: unknown): RouteStateRecord {
  const base = emptyRouteState();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return base;
  }
  const record = value as Record<string, unknown>;
  const routesValue = typeof record.routes === "object" && record.routes !== null && !Array.isArray(record.routes) ? record.routes as Record<string, unknown> : {};
  const denyValue = typeof record.deny === "object" && record.deny !== null && !Array.isArray(record.deny) ? record.deny as Record<string, unknown> : {};
  const observationsValue =
    typeof record.observations === "object" && record.observations !== null && !Array.isArray(record.observations)
      ? record.observations as Record<string, unknown>
      : {};
  const proxyModeValue =
    typeof record.proxyMode === "object" && record.proxyMode !== null && !Array.isArray(record.proxyMode)
      ? record.proxyMode as Record<string, unknown>
      : {};

  return {
    version: 1,
    routes: Object.fromEntries(
      Object.entries(routesValue)
        .filter(([nodeId]) => typeof nodeId === "string" && nodeId.length > 0)
        .map(([nodeId, route]) => {
          const routeRecord = typeof route === "object" && route !== null && !Array.isArray(route) ? route as Record<string, unknown> : {};
          return [
            nodeId,
            {
              proxyNodeId: typeof routeRecord.proxyNodeId === "string" && routeRecord.proxyNodeId.length > 0 ? routeRecord.proxyNodeId : undefined,
            },
          ] as const;
        }),
    ),
    deny: Object.fromEntries(
      Object.entries(denyValue)
        .filter(([nodeId]) => typeof nodeId === "string" && nodeId.length > 0)
        .map(([nodeId, deny]) => {
          const denyRecord = typeof deny === "object" && deny !== null && !Array.isArray(deny) ? deny as Record<string, unknown> : {};
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
        typeof proxyModeValue.defaultDstNodeId === "string" && proxyModeValue.defaultDstNodeId.length > 0
          ? proxyModeValue.defaultDstNodeId
          : undefined,
    },
    observations: Object.fromEntries(
      Object.entries(observationsValue)
        .filter(([nodeId]) => typeof nodeId === "string" && nodeId.length > 0)
        .map(([nodeId, observation]) => {
          const observationRecord =
            typeof observation === "object" && observation !== null && !Array.isArray(observation) ? observation as Record<string, unknown> : {};
          return [
            nodeId,
            {
              lastInboundMs: typeof observationRecord.lastInboundMs === "number" ? observationRecord.lastInboundMs : undefined,
              lastOutboundMs: typeof observationRecord.lastOutboundMs === "number" ? observationRecord.lastOutboundMs : undefined,
            },
          ] as const;
        }),
    ),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.trim() ? JSON.parse(body) : {};
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(value)}\n`);
}

function estimateBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  return Buffer.byteLength(JSON.stringify(value));
}

function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function isRouteVisibleNodeId(nodeId: string): boolean {
  return nodeId.length > 0 && !nodeId.startsWith("coord-cli-");
}

function ttlRemaining(timestampMs: number | undefined, ttlMs: number, nowMs: number): number | null {
  if (!timestampMs) {
    return null;
  }
  const remaining = timestampMs + ttlMs - nowMs;
  return remaining > 0 ? remaining : null;
}

export class CordFoundation implements FoundationNode {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly nodeId: string;
  private readonly addrs: string[];
  private readonly props: unknown;
  private readonly maxPayloadBytes: number;
  private readonly guestRateLimitPerWindow: number;
  private readonly rateLimitWindowMs: number;
  private readonly observationTtlMs: number;
  private readonly authorize?: FoundationOptions["authorize"];
  private readonly listenHttp: boolean;
  private readonly guestWindows = new Map<string, { windowStartMs: number; count: number }>();
  private readonly nodeEpoch: string;
  private httpServer: Server | null = null;
  private started = false;

  constructor(private readonly registry: CordRegistry, options: FoundationOptions) {
    this.nodeId = options.nodeId;
    this.nodeEpoch = options.nodeEpoch ?? randomId("epoch");
    this.listenHttp = options.listenHttp ?? false;
    this.addrs = [...(options.addrs ?? [])];
    this.props = options.props;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 256 * 1024;
    this.guestRateLimitPerWindow = options.guestRateLimitPerWindow ?? 50;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 1000;
    this.observationTtlMs = options.observationTtlMs ?? 300_000;
    this.authorize = options.authorize;
    this.registerFoundationBuiltins();
  }

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
      addrList: this.addrs,
      started: true,
      info: () => this.self(),
      dispatch: (method, ctx, params) => this.dispatch(method, ctx, params),
    });
    if (this.listenHttp) {
      await this.publishNodeDirectory(true);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
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

  self(): NodeInfo {
    return {
      nodeId: this.nodeId,
      nodeEpoch: this.nodeEpoch,
      addrs: this.addrs.length > 0 ? [...this.addrs] : undefined,
      props: this.props,
    };
  }

  registerHandler(method: string, handler: CommandHandler): void {
    this.handlers.set(method, handler);
  }

  async call<T>(target: RpcTarget, method: string, params: unknown, opts: RpcCallOptions = {}): Promise<T> {
    const isNodeTarget = "nodeId" in target && typeof target.nodeId === "string";
    const timeoutMs = opts.timeoutMs ?? 1000;
    const originNodeId = opts.originNodeId ?? this.nodeId;

    if (isNodeTarget) {
      const local = this.registry.getNode(target.nodeId);
      if (local?.started) {
        if (!this.registry.canReach(this.nodeId, local.nodeId)) {
          throw new Error(`Node ${this.nodeId} cannot reach ${local.nodeId}`);
        }
        const result = await raceTimeout(
          local.dispatch(
            method,
            { auth: opts.auth, srcNodeId: this.nodeId, originNodeId, traceId: opts.traceId },
            params,
          ) as Promise<T>,
          timeoutMs,
          `${method} -> ${local.nodeId}`,
        );
        await this.observeOutbound(local.nodeId);
        return result;
      }

      const remote = await this.lookupPublishedNode(target.nodeId);
      const addr = remote?.addrs?.[0];
      if (!remote?.started || !addr) {
        throw new Error(`Target ${target.nodeId} is not available`);
      }
      const result = await raceTimeout(this.callHttp<T>(addr, method, params, { ...opts, originNodeId }), timeoutMs, `${method} -> ${target.nodeId}`);
      await this.observeOutbound(target.nodeId);
      return result;
    }

    const addr = target.addr;
    const local = this.registry.getNodeByAddr(addr);
    if (local?.started) {
      if (!this.registry.canReach(this.nodeId, local.nodeId)) {
        throw new Error(`Node ${this.nodeId} cannot reach ${local.nodeId}`);
      }
      const result = await raceTimeout(
        local.dispatch(
          method,
          { auth: opts.auth, srcNodeId: this.nodeId, originNodeId, traceId: opts.traceId },
          params,
        ) as Promise<T>,
        timeoutMs,
        `${method} -> ${local.nodeId}`,
      );
      await this.observeOutbound(local.nodeId);
      return result;
    }
    return raceTimeout(this.callHttp<T>(addr, method, params, { ...opts, originNodeId }), timeoutMs, `${method} -> ${addr}`);
  }

  async ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }> {
    const startedMs = Date.now();
    await this.call(target, "cord.foundation.ping", { ts: startedMs }, { timeoutMs: 1000, auth: this.makeInternalAuth() });
    return { ok: true, rttMs: Date.now() - startedMs };
  }

  async discover(_opts?: { mode?: "udp" | "mdns" | "seeds"; timeoutMs?: number }): Promise<NodeInfo[]> {
    const discovered = new Map<string, NodeInfo>();
    for (const node of this.registry.listStarted()) {
      discovered.set(node.nodeId, node.info());
    }
    for (const item of await this.registry.sharedStore.list("foundation/nodes/")) {
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
    return [...discovered.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  async getRouteTable(_opts?: { verbose?: boolean }): Promise<RouteTable> {
    const state = await this.loadRouteState();
    const knownNodeIds = new Set<string>();
    for (const node of await this.discover()) {
      if (node.nodeId !== this.nodeId) {
        knownNodeIds.add(node.nodeId);
      }
    }
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
    for (const nodeId of Object.keys(state.observations)) {
      if (nodeId !== this.nodeId && isRouteVisibleNodeId(nodeId)) {
        knownNodeIds.add(nodeId);
      }
    }
    if (state.proxyMode.defaultDstNodeId && state.proxyMode.defaultDstNodeId !== this.nodeId) {
      knownNodeIds.add(state.proxyMode.defaultDstNodeId);
    }

    const nowMs = Date.now();
    const entries: RouteEntry[] = [...knownNodeIds]
      .sort((left, right) => left.localeCompare(right))
      .map((nodeId) => this.buildRouteEntry(nodeId, state, nowMs));

    return {
      nodeId: this.nodeId,
      proxyMode: { ...state.proxyMode },
      observationTtlMs: this.observationTtlMs,
      entries,
    };
  }

  async setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void> {
    if (!targetNodeId || targetNodeId === this.nodeId) {
      throw new Error("route target must be a peer node");
    }
    if (proxyNodeId && (proxyNodeId === this.nodeId || proxyNodeId === targetNodeId)) {
      throw new Error("invalid route: proxy must be a different peer");
    }
    await this.updateRouteState((state) => {
      state.routes[targetNodeId] = proxyNodeId ? { proxyNodeId } : {};
    });
  }

  async deleteRoute(targetNodeId: string): Promise<void> {
    await this.updateRouteState((state) => {
      delete state.routes[targetNodeId];
    });
  }

  async setRouteDeny(targetNodeId: string, direction: RouteDirection): Promise<void> {
    if (!targetNodeId || targetNodeId === this.nodeId) {
      throw new Error("deny target must be a peer node");
    }
    await this.updateRouteState((state) => {
      const current = state.deny[targetNodeId] ?? {};
      if (direction === "in" || direction === "both") {
        current.in = true;
      }
      if (direction === "out" || direction === "both") {
        current.out = true;
      }
      state.deny[targetNodeId] = current;
    });
  }

  async setProxyMode(enabled: boolean, defaultDstNodeId?: string): Promise<void> {
    if (defaultDstNodeId === this.nodeId) {
      throw new Error("proxy default destination must be a different node");
    }
    await this.updateRouteState((state) => {
      state.proxyMode = {
        enabled,
        defaultDstNodeId: enabled && defaultDstNodeId ? defaultDstNodeId : undefined,
      };
    });
  }

  makeInternalAuth(): RpcAuth {
    return {
      userId: `node:${this.nodeId}`,
      groups: ["grp:internal"],
      internal: true,
    };
  }

  isStarted(): boolean {
    return this.started;
  }

  private buildRouteEntry(nodeId: string, state: RouteStateRecord, nowMs: number): RouteEntry {
    const route = state.routes[nodeId];
    const deny = state.deny[nodeId] ?? {};
    const observation = state.observations[nodeId] ?? {};
    const ttlRemainingInMs = ttlRemaining(observation.lastInboundMs, this.observationTtlMs, nowMs);
    const ttlRemainingOutMs = ttlRemaining(observation.lastOutboundMs, this.observationTtlMs, nowMs);
    const observedIn = ttlRemainingInMs !== null;
    const observedOut = ttlRemainingOutMs !== null;
    const denyIn = deny.in === true;
    const denyOut = deny.out === true;

    let summary = nodeId;
    let mode: RouteEntry["mode"] = denyOut ? "none" : "direct";

    if (route?.proxyNodeId) {
      summary = `${nodeId}[${route.proxyNodeId}]`;
      mode = "proxy";
    } else if (denyIn && denyOut) {
      summary = `${nodeId}{none}`;
      mode = "none";
    } else if (denyOut && !denyIn) {
      summary = `${nodeId}{in}`;
      mode = "none";
    } else if (denyIn && !denyOut) {
      summary = `${nodeId}{out}`;
      mode = "direct";
    } else if (observedIn && !observedOut) {
      summary = `${nodeId}{in}`;
    } else if (observedOut && !observedIn) {
      summary = `${nodeId}{out}`;
    }

    return {
      nodeId,
      summary,
      mode,
      proxyNodeId: route?.proxyNodeId,
      denyIn,
      denyOut,
      observedIn,
      observedOut,
      lastInboundMs: observedIn ? observation.lastInboundMs ?? null : null,
      lastOutboundMs: observedOut ? observation.lastOutboundMs ?? null : null,
      ttlRemainingInMs,
      ttlRemainingOutMs,
    };
  }

  private async startHttpServer(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    const listenAddr = this.addrs[0];
    if (!listenAddr) {
      throw new Error(`Node ${this.nodeId} cannot start HTTP transport without an address`);
    }
    const { host, port } = parseAddr(listenAddr);
    this.httpServer = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/healthz") {
          writeJson(res, 200, {
            ok: true,
            node: this.self(),
            pid: process.pid,
          });
          return;
        }
        if (req.method === "POST" && req.url === "/rpc") {
          const payload = (await readRequestBody(req)) as {
            method?: string;
            params?: unknown;
            auth?: RpcAuth;
            traceId?: string;
            srcNodeId?: string;
            originNodeId?: string;
          };
          if (typeof payload.method !== "string" || payload.method.length === 0) {
            writeJson(res, 400, {
              ok: false,
              error: { message: "Missing RPC method" },
            });
            return;
          }
          const result = await this.dispatch(
            payload.method,
            {
              auth: payload.auth,
              srcNodeId: payload.srcNodeId,
              originNodeId: payload.originNodeId,
              traceId: payload.traceId,
            },
            payload.params,
          );
          writeJson(res, 200, { ok: true, result });
          return;
        }
        writeJson(res, 404, { ok: false, error: { message: `Unknown route ${req.method ?? "GET"} ${req.url ?? "/"}` } });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off("error", reject);
        resolve();
      });
    });
  }

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

  private async lookupPublishedNode(nodeId: string): Promise<PublishedNodeRecord | null> {
    return parsePublishedNodeRecord(await this.registry.sharedStore.get(nodeDirectoryKey(nodeId)));
  }

  private async loadRouteState(): Promise<RouteStateRecord> {
    return parseRouteStateRecord(await this.registry.sharedStore.get(routeStateKey(this.nodeId)));
  }

  private async saveRouteState(state: RouteStateRecord): Promise<void> {
    await this.registry.sharedStore.set(routeStateKey(this.nodeId), state);
  }

  private async updateRouteState(mutator: (state: RouteStateRecord) => void): Promise<RouteStateRecord> {
    const state = await this.loadRouteState();
    mutator(state);
    await this.saveRouteState(state);
    return state;
  }

  private async observeInbound(srcNodeId: string | undefined): Promise<void> {
    if (!srcNodeId || srcNodeId === this.nodeId || !isRouteVisibleNodeId(srcNodeId)) {
      return;
    }
    await this.updateRouteState((state) => {
      const current = state.observations[srcNodeId] ?? {};
      current.lastInboundMs = Date.now();
      state.observations[srcNodeId] = current;
    });
  }

  private async observeOutbound(dstNodeId: string | undefined): Promise<void> {
    if (!dstNodeId || dstNodeId === this.nodeId || !isRouteVisibleNodeId(dstNodeId)) {
      return;
    }
    await this.updateRouteState((state) => {
      const current = state.observations[dstNodeId] ?? {};
      current.lastOutboundMs = Date.now();
      state.observations[dstNodeId] = current;
    });
  }

  private async callHttp<T>(addr: string, method: string, params: unknown, opts: RpcCallOptions): Promise<T> {
    const response = await fetch(`http://${addr}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method,
        params,
        auth: opts.auth,
        traceId: opts.traceId,
        srcNodeId: this.nodeId,
        originNodeId: opts.originNodeId ?? this.nodeId,
      }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: T;
      error?: { message?: string };
    };
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error?.message ?? `${method} failed against ${addr}`);
    }
    return payload.result as T;
  }

  private async dispatch(method: string, ctx: RpcCtx, params: unknown): Promise<unknown> {
    await this.observeInbound(ctx.srcNodeId);
    await this.enforceInboundRoutePolicy(ctx.srcNodeId);
    return this.invokeHandler(method, ctx, params);
  }

  private async invokeHandler(method: string, ctx: RpcCtx, params: unknown): Promise<unknown> {
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

  private async enforceInboundRoutePolicy(srcNodeId: string | undefined): Promise<void> {
    if (!srcNodeId || srcNodeId === this.nodeId || !isRouteVisibleNodeId(srcNodeId)) {
      return;
    }
    const state = await this.loadRouteState();
    if (state.deny[srcNodeId]?.in) {
      throw new Error(`route denied: in from ${srcNodeId}`);
    }
  }

  private async executeRouted(ctx: RpcCtx, request: FoundationExecRequest): Promise<FoundationExecResponse> {
    if (!request.method || request.method === "cord.foundation.exec") {
      throw new Error("invalid routed exec method");
    }

    const state = await this.loadRouteState();
    const effectiveDstNodeId = request.dstNodeId ?? (state.proxyMode.enabled ? state.proxyMode.defaultDstNodeId : undefined);
    const timeoutMs = request.timeoutMs ?? 5000;
    const originNodeId = ctx.originNodeId ?? ctx.srcNodeId ?? this.nodeId;

    if (!effectiveDstNodeId || effectiveDstNodeId === this.nodeId) {
      return {
        result: await this.invokeHandler(request.method, ctx, request.params),
        route: {
          contactedNodeId: this.nodeId,
          executedNodeId: this.nodeId,
          mode: "local",
          nextHopNodeId: this.nodeId,
          path: request.path && request.path.length > 0 ? [...request.path] : [this.nodeId],
        },
      };
    }

    const nextPath = [...(request.path && request.path.length > 0 ? request.path : [this.nodeId])];
    const route = state.routes[effectiveDstNodeId];
    const denyOutToDst = state.deny[effectiveDstNodeId]?.out === true;
    const hopCount = request.hopCount ?? 0;

    if (hopCount > 0 && route?.proxyNodeId) {
      throw new Error("invalid route: proxy hop exceeds 1");
    }

    if (hopCount === 0 && route?.proxyNodeId) {
      const proxyNodeId = route.proxyNodeId;
      if (state.deny[proxyNodeId]?.out) {
        throw new Error(`cannot reach proxy ${proxyNodeId} (route denied or unreachable)`);
      }
      try {
        const forwarded = await this.call<FoundationExecResponse>(
          { nodeId: proxyNodeId },
          "cord.foundation.exec",
          {
            ...request,
            dstNodeId: effectiveDstNodeId,
            hopCount: 1,
            path: [...nextPath, proxyNodeId],
          } satisfies FoundationExecRequest,
          {
            timeoutMs,
            traceId: request.traceId ?? ctx.traceId,
            auth: ctx.auth,
            originNodeId,
          },
        );
        return {
          result: forwarded.result,
          route: {
            ...forwarded.route,
            contactedNodeId: this.nodeId,
            executedNodeId: effectiveDstNodeId,
            mode: "proxy",
            proxyNodeId,
            nextHopNodeId: proxyNodeId,
            path: forwarded.route.path,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("route denied") || message.includes("cannot reach") || message.includes("Target ")) {
          throw new Error(`cannot reach proxy ${proxyNodeId} (route denied or unreachable)`);
        }
        throw error;
      }
    }

    if (denyOutToDst) {
      if (hopCount > 0) {
        throw new Error(`cannot reach destination ${effectiveDstNodeId} from proxy ${this.nodeId} (route denied or unreachable)`);
      }
      throw new Error(`no route to ${effectiveDstNodeId} (direct denied, no proxy route)`);
    }

    try {
      const result = await this.call(
        { nodeId: effectiveDstNodeId },
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
        result,
        route: {
          contactedNodeId: this.nodeId,
          executedNodeId: effectiveDstNodeId,
          mode: hopCount > 0 ? "proxy" : "direct",
          nextHopNodeId: effectiveDstNodeId,
          path: [...nextPath, effectiveDstNodeId],
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (hopCount > 0 && (message.includes("Target ") || message.includes("cannot reach") || message.includes("route denied"))) {
        throw new Error(`cannot reach destination ${effectiveDstNodeId} from proxy ${this.nodeId} (route denied or unreachable)`);
      }
      throw error;
    }
  }

  private assertPayloadLimit(params: unknown): void {
    if (estimateBytes(params) > this.maxPayloadBytes) {
      throw new Error(`RPC payload exceeds limit of ${this.maxPayloadBytes} bytes`);
    }
  }

  private enforceRateLimit(ctx: RpcCtx, method: string): void {
    const auth = ctx.auth;
    if (auth?.internal || auth?.userId) {
      return;
    }
    const guestAllow = new Set([
      "cord.foundation.ping",
      "cord.foundation.whoami",
      "cord.cluster.heartbeat",
      "cord.bootstrap.register_unallocated",
    ]);
    if (!guestAllow.has(method)) {
      throw new Error(`Guest access denied for ${method}`);
    }

    const key = ctx.srcNodeId ?? "guest:anonymous";
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

  private registerFoundationBuiltins(): void {
    this.registerHandler("cord.foundation.ping", async () => ({ ok: true }));
    this.registerHandler("cord.foundation.whoami", async () => this.self());
    this.registerHandler("cord.foundation.exec", async (ctx, params) => this.executeRouted(ctx, params as FoundationExecRequest));
    this.registerHandler("cord.foundation.route", async (_ctx, params) => {
      const payload = params as { op?: string; targetNodeId?: string; proxyNodeId?: string; direction?: RouteDirection };
      switch (payload.op) {
        case "print":
          return this.getRouteTable();
        case "add":
          await this.setRoute(String(payload.targetNodeId ?? ""), typeof payload.proxyNodeId === "string" ? payload.proxyNodeId : undefined);
          return { ok: true };
        case "del":
          await this.deleteRoute(String(payload.targetNodeId ?? ""));
          return { ok: true };
        case "deny":
          await this.setRouteDeny(String(payload.targetNodeId ?? ""), payload.direction ?? "both");
          return { ok: true };
        default:
          throw new Error(`Unknown route op ${String(payload.op ?? "")}`);
      }
    });
    this.registerHandler("cord.foundation.proxy", async (_ctx, params) => {
      const payload = params as { enabled?: boolean; defaultDstNodeId?: string };
      await this.setProxyMode(payload.enabled === true, typeof payload.defaultDstNodeId === "string" ? payload.defaultDstNodeId : undefined);
      const table = await this.getRouteTable();
      return { ok: true, proxyMode: table.proxyMode };
    });
  }
}
