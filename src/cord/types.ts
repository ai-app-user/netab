import type { StengApi } from "../steng/index.js";

export type NodeId = string;
export type CommandHandler<TParams = unknown, TResult = unknown> = (ctx: RpcCtx, params: TParams) => Promise<TResult>;

export type NodeInfo = {
  nodeId: string;
  nodeEpoch: string;
  addrs?: string[];
  props?: unknown;
};

export type ClusterSpec = {
  clusterId: string;
  name?: string;
  props?: unknown;
};

export type ClusterNodeRole = {
  proxyOnly?: boolean;
  canSend?: boolean;
  canReceive?: boolean;
  eligibleLeader?: boolean;
  extra?: unknown;
};

export type ClusterNodeConfig = {
  clusterId: string;
  nodeId: string;
  role: ClusterNodeRole;
  props?: unknown;
};

export type ShardSpec = {
  shardId: string;
  weight?: number;
  props?: unknown;
};

export type LeaderAssignment = {
  clusterId: string;
  shardId: string;
  leaderNodeId: string;
  term: number;
  leaseUntilMs: number;
};

export interface CoordStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
}

export type RpcTarget =
  | { nodeId: string; addr?: never }
  | { addr: string; nodeId?: never };

export type RpcAuth = {
  userId: string;
  groups?: string[];
  scope?: unknown;
  internal?: boolean;
};

export type RpcCtx = {
  auth?: RpcAuth;
  srcNodeId?: string;
  originNodeId?: string;
  traceId?: string;
};

export type RpcCallOptions = {
  timeoutMs?: number;
  traceId?: string;
  auth?: RpcAuth;
  originNodeId?: string;
};

export type RouteDirection = "in" | "out" | "both";

export type RouteEntry = {
  nodeId: string;
  summary: string;
  mode: "direct" | "proxy" | "none";
  proxyNodeId?: string;
  denyIn: boolean;
  denyOut: boolean;
  observedIn: boolean;
  observedOut: boolean;
  lastInboundMs: number | null;
  lastOutboundMs: number | null;
  ttlRemainingInMs: number | null;
  ttlRemainingOutMs: number | null;
};

export type RouteTable = {
  nodeId: string;
  proxyMode: {
    enabled: boolean;
    defaultDstNodeId?: string;
  };
  observationTtlMs: number;
  entries: RouteEntry[];
};

export interface FoundationNode {
  start(): Promise<void>;
  stop(): Promise<void>;
  self(): NodeInfo;
  registerHandler(method: string, handler: CommandHandler): void;
  call<T>(target: RpcTarget, method: string, params: unknown, opts?: RpcCallOptions): Promise<T>;
  ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }>;
  discover(opts?: { mode?: "udp" | "mdns" | "seeds"; timeoutMs?: number }): Promise<NodeInfo[]>;
  getRouteTable(opts?: { verbose?: boolean }): Promise<RouteTable>;
  setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void>;
  deleteRoute(targetNodeId: string): Promise<void>;
  setRouteDeny(targetNodeId: string, direction: RouteDirection): Promise<void>;
  setProxyMode(enabled: boolean, defaultDstNodeId?: string): Promise<void>;
}

export interface ClusterManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  createCluster(spec: ClusterSpec): Promise<void>;
  dropCluster(clusterId: string): Promise<void>;
  listClusters(): Promise<ClusterSpec[]>;
  joinCluster(cfg: ClusterNodeConfig): Promise<void>;
  leaveCluster(clusterId: string): Promise<void>;
  listNodes(clusterId: string): Promise<ClusterNodeConfig[]>;
  getNode(clusterId: string, nodeId: string): Promise<ClusterNodeConfig | null>;
  getAliveNodes(clusterId: string): Promise<Array<{ nodeId: string; lastSeenMs: number }>>;
  execOnCluster(
    clusterId: string,
    method: string,
    params: unknown,
    opts?: { parallel?: number; timeoutMs?: number; bestEffort?: boolean; auth?: RpcAuth },
  ): Promise<Array<{ nodeId: string; ok: boolean; result?: unknown; err?: string }>>;
  discoverAndSuggest(clusterId: string): Promise<NodeInfo[]>;
}

export interface GroupManager {
  createGroup(ns: string, groupId: string, meta?: unknown): Promise<void>;
  deleteGroup(ns: string, groupId: string): Promise<void>;
  addMember(ns: string, groupId: string, itemRef: string): Promise<void>;
  removeMember(ns: string, groupId: string, itemRef: string): Promise<void>;
  addSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void>;
  removeSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void>;
  listMembers(ns: string, groupId: string, opts?: { recursive?: boolean }): Promise<string[]>;
  isMember(ns: string, groupId: string, itemRef: string, opts?: { recursive?: boolean }): Promise<boolean>;
}

export type PermissionDefinition = {
  title: string;
  description: string;
  maskBits?: Record<string, number>;
  scopeType?: string;
};

export interface PermissionCatalog {
  definePermission(ns: string, permId: string, def: PermissionDefinition): Promise<void>;
  getPermission(ns: string, permId: string): Promise<PermissionDefinition | null>;
  listPermissions(ns: string, prefix?: string): Promise<Array<PermissionDefinition & { permId: string }>>;
}

export type UserRecord = {
  userId: string;
  displayName?: string;
  props?: unknown;
};

export type CredentialRecord = {
  type: "pin" | "password" | "none";
  secretHash?: string;
};

export interface UserManager {
  ensureGuest(ns: string): Promise<string>;
  createUser(ns: string, user: UserRecord): Promise<void>;
  getUser(ns: string, userId: string): Promise<UserRecord | null>;
  setCredential(ns: string, userId: string, cred: CredentialRecord): Promise<void>;
  verifyCredential(ns: string, userId: string, proof: unknown): Promise<boolean>;
  addUserToGroup(ns: string, userId: string, groupId: string): Promise<void>;
  removeUserFromGroup(ns: string, userId: string, groupId: string): Promise<void>;
}

export type CommandDefinition = {
  title: string;
  description: string;
  maskBits?: Record<string, number>;
  scopeType?: string;
};

export type CommandGrant = {
  allow: boolean;
  mask?: number;
  scope?: unknown;
};

export interface CommandManager {
  defineCommand(ns: string, commandId: string, def: CommandDefinition): Promise<void>;
  grant(ns: string, subject: string, commandId: string, grant: CommandGrant): Promise<void>;
  revoke(ns: string, subject: string, commandId: string): Promise<void>;
  canInvoke(ns: string, ctx: { userId: string; groups?: string[]; scope?: unknown }, commandId: string, requestedMask?: number): Promise<boolean>;
}

export interface BootstrapManager {
  registerUnallocated(nodeInfo: NodeInfo): Promise<{ status: "unallocated" }>;
  listUnallocated(ns: string): Promise<NodeInfo[]>;
  claimNode(ns: string, nodeId: string, proof: unknown): Promise<void>;
}

export type LeaderChangeEvent = {
  clusterId: string;
  shardId: string;
  from?: string;
  to: string;
};

export interface ElectionManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  addShard(clusterId: string, shard: ShardSpec): Promise<void>;
  removeShard(clusterId: string, shardId: string): Promise<void>;
  listShards(clusterId: string): Promise<ShardSpec[]>;
  getLeader(clusterId: string, shardId: string): Promise<LeaderAssignment | null>;
  listLeaders(clusterId: string): Promise<LeaderAssignment[]>;
  onLeaderChange(cb: (ev: LeaderChangeEvent) => void): () => void;
  forceLeader(clusterId: string, shardId: string, nodeId: string, ttlMs?: number): Promise<void>;
  tick(clusterId?: string): Promise<void>;
}

export type Target =
  | { kind: "none" }
  | { kind: "node"; value: string }
  | { kind: "addr"; value: string }
  | { kind: "cluster"; value: string };

export type Invocation = {
  raw: string[];
  kind: "base" | "targeted";
  baseCmd?: string;
  baseCmdPort?: number | null;
  baseArgs?: string[];
  target: Target;
  options: {
    timeoutMs?: number;
    json?: boolean;
    pretty?: boolean;
    verbose?: boolean;
    dst?: string;
    trace?: string;
    parallel?: number;
    bestEffort?: boolean;
    auth?: string;
    [k: string]: unknown;
  };
  group: string;
  cmd: string;
  fullCmd: string;
  params: Record<string, unknown>;
  args: unknown[];
  payload?: {
    kind: "bytes" | "json";
    name: string;
    bytes?: Uint8Array;
    json?: unknown;
  };
};

export type HelpSpec = {
  summary: string;
  usage?: string | string[];
  options?: string[];
  examples?: string[];
};

export interface CommandRegistry {
  registerBase(name: string, handler: (inv: Invocation, ctx: unknown) => Promise<unknown>, help?: HelpSpec): void;
  registerCmd(fullCmd: string, handler: (inv: Invocation, ctx: unknown) => Promise<unknown>, help?: HelpSpec): void;
  hasBase(name: string): boolean;
  hasCmd(fullCmd: string): boolean;
  helpFor(nameOrCmd: string): HelpSpec | null;
}

export interface Dispatcher {
  dispatch(argv: string[], ctx?: unknown): Promise<number>;
}

export type ClusterNodeHealth = {
  nodeId: string;
  eligibleLeader: boolean;
  priority: number;
  started: boolean;
  lastSeenMs: number | null;
  reachablePeers: string[];
};

export type ClusterStatus = {
  clusterId: string;
  leaderId: string | null;
  leaseUntilMs: number;
  nodes: ClusterNodeHealth[];
};

export type CordNodeOptions = {
  nodeId: NodeId;
  nodeEpoch?: string;
  listenHttp?: boolean;
  clusterId?: string;
  eligible?: boolean;
  priority?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  electionIntervalMs?: number;
  leaseMode?: "quorum" | "all";
  addrs?: string[];
  props?: unknown;
  namespace?: string;
  store?: CoordStore;
  steng?: StengApi;
  maxPayloadBytes?: number;
  guestRateLimitPerWindow?: number;
  rateLimitWindowMs?: number;
};

export interface CordNodeHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  get_leader(shard_id?: string): Promise<string | null>;
  get_cluster_status(clusterId?: string): Promise<ClusterStatus>;
  set_reachability(targetNodeId: string, reachable: boolean): void;
  replicate_tick(): Promise<void>;
}
