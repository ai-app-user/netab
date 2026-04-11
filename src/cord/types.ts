import type { StengApi } from '../steng/index.js';

/** Stable unique identifier for one coord node. */
export type NodeId = string;
/** Async RPC handler signature used by the foundation transport. */
export type CommandHandler<TParams = unknown, TResult = unknown> = (
  ctx: RpcCtx,
  params: TParams,
) => Promise<TResult>;

/** Public identity information advertised by one node. */
export type NodeInfo = {
  nodeId: string;
  nodeEpoch: string;
  addrs?: string[];
  props?: unknown;
};

/** One cluster definition managed by coord. */
export type ClusterSpec = {
  clusterId: string;
  name?: string;
  props?: unknown;
};

/** Role flags for one node inside one cluster. */
export type ClusterNodeRole = {
  proxyOnly?: boolean;
  canSend?: boolean;
  canReceive?: boolean;
  eligibleLeader?: boolean;
  extra?: unknown;
};

/** Cluster membership record for one node. */
export type ClusterNodeConfig = {
  clusterId: string;
  nodeId: string;
  role: ClusterNodeRole;
  props?: unknown;
};

/** One shard or placement group managed by the election layer. */
export type ShardSpec = {
  shardId: string;
  weight?: number;
  props?: unknown;
};

/** Leader lease assignment for one shard. */
export type LeaderAssignment = {
  clusterId: string;
  shardId: string;
  leaderNodeId: string;
  term: number;
  leaseUntilMs: number;
};

/** Minimal key-value storage contract used by coord persistence. */
export interface CoordStore {
  /** Read one key, returning `null` when absent. */
  get(key: string): Promise<unknown | null>;
  /** Insert or replace one key. */
  set(key: string, value: unknown): Promise<void>;
  /** Delete one key if it exists. */
  del(key: string): Promise<void>;
  /** List all entries whose keys start with `prefix`. */
  list(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
}

/** Durable backend choices supported by the coord runtime. */
export type CoordStorageBackend = 'file' | 'sqlite' | 'psql';

/** How the runtime chose the current durable backend. */
export type CoordStoragePolicy = 'auto' | 'explicit';

/** One configured coord storage target. */
export type CoordStorageTarget = {
  /** Durable backend currently selected for this coord root. */
  backend: CoordStorageBackend;
  /** Filesystem path or Postgres connection string. */
  location: string;
  /** Postgres schema name when `backend === "psql"`. */
  schema?: string;
};

/** Human-readable storage status returned by the `-stor` command. */
export type CoordStorageInfo = {
  /** Coord root directory whose shared state this storage backs. */
  rootDir: string;
  /** Whether the backend was chosen automatically or explicitly. */
  policy: CoordStoragePolicy;
  /** Currently active durable backend. */
  backend: CoordStorageBackend;
  /** Filesystem path or Postgres connection string for the active backend. */
  location: string;
  /** Postgres schema name when `backend === "psql"`. */
  schema?: string;
  /** Whether the current backend is a fallback from the preferred backend. */
  status: 'healthy' | 'fallback';
  /** Preferred backend for auto mode, when different from the current backend. */
  preferredBackend?: CoordStorageBackend;
  /** Backup/fallback target kept alongside the current backend. */
  fallback?: CoordStorageTarget;
  /** Free-form note explaining fallback or migration state. */
  note?: string;
};

export type RpcTarget =
  | { nodeId: string; addr?: never }
  | { addr: string; nodeId?: never };

/** Auth metadata propagated with one RPC call. */
export type RpcAuth = {
  userId: string;
  groups?: string[];
  scope?: unknown;
  internal?: boolean;
};

/** Per-call context supplied to registered RPC handlers. */
export type RpcCtx = {
  auth?: RpcAuth;
  srcNodeId?: string;
  srcNodeInfo?: NodeInfo;
  originNodeId?: string;
  traceId?: string;
};

/** Outbound RPC tuning knobs. */
export type RpcCallOptions = {
  timeoutMs?: number;
  traceId?: string;
  auth?: RpcAuth;
  originNodeId?: string;
};

/** Options for creating a reverse or durable connection intent. */
export type ConnectOptions = {
  ttlMs?: number;
  persist?: boolean;
};

/** Normalized host OS values reported by node runtimes. */
export type HostOsType = 'linux' | 'windows' | 'macos' | 'android' | 'unknown';

/** Structured result returned by `cord.foundation.execCommand`. */
export type ExecCommandResult = {
  ok: true;
  command: string;
  osType: HostOsType | string;
  supported: boolean;
  skipped: boolean;
  reason?: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

/** Direction selector used by route deny rules. */
export type RouteDirection = 'in' | 'out' | 'both';

/** One effective route entry shown by `-routes`. */
export type RouteEntry = {
  nodeId: string;
  via: string;
  path: string;
  ways: 'out' | 'in' | 'both' | '-';
  state: 'connected' | 'learned' | 'suggested' | 'configured';
  denyIn: boolean;
  denyOut: boolean;
  ttlRemainingMs: number | null;
};

/** Effective route table for one local node. */
export type RouteTable = {
  nodeId: string;
  proxyMode: {
    enabled: boolean;
    defaultDstNodeId?: string;
  };
  observationTtlMs: number;
  entries: RouteEntry[];
};

/** One learned or configured peer entry shown by `-peers`. */
export type PeerEntry = {
  nodeId: string;
  via: string;
  ways: 'out' | 'in' | 'both' | '-';
  ttlRemainingMs: number | null;
  state: 'connected' | 'learned' | 'suggested';
  nodeEpoch?: string;
  addrs?: string[];
  props?: unknown;
};

/** Peer table for one local node. */
export type PeerTable = {
  nodeId: string;
  entries: PeerEntry[];
};

/**
 * Low-level foundation runtime responsible for identity, transport, peer
 * learning, routing, and reverse-connection management.
 */
export interface FoundationNode {
  /** Start listeners, background tasks, and persistence hooks. */
  start(): Promise<void>;
  /** Stop listeners and release runtime resources. */
  stop(): Promise<void>;
  /** Return the local node identity currently advertised by the runtime. */
  self(): NodeInfo;
  /** Register one RPC handler under a fully qualified method name. */
  registerHandler(method: string, handler: CommandHandler): void;
  /** Call one remote method by node id or direct address. */
  call<T>(
    target: RpcTarget,
    method: string,
    params: unknown,
    opts?: RpcCallOptions,
  ): Promise<T>;
  /** Convenience health/ping helper built on top of `call`. */
  ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }>;
  /** Discover visible nodes by the configured discovery mechanisms. */
  discover(opts?: {
    mode?: 'udp' | 'mdns' | 'seeds';
    timeoutMs?: number;
  }): Promise<NodeInfo[]>;
  /** Read the current peer table, optionally including verbose diagnostics. */
  getPeerTable(opts?: { verbose?: boolean }): Promise<PeerTable>;
  /** Read the effective route table, optionally including verbose diagnostics. */
  getRouteTable(opts?: { verbose?: boolean }): Promise<RouteTable>;
  /** Create a direct or reverse connection and optionally persist it. */
  connect(
    target: RpcTarget,
    opts?: ConnectOptions,
  ): Promise<{ ok: true; peer: NodeInfo; ttlMs: number | null }>;
  /** Remove one persistent connection intent and close the live link when possible. */
  disconnect(targetNodeId: string): Promise<{ ok: true; nodeId: string }>;
  /** Ask one peer for additional peers it knows and import them as suggestions. */
  learn(
    target: RpcTarget,
  ): Promise<{ ok: true; learned: string[]; skipped: string[] }>;
  /** Add or replace one explicit route, optionally via a proxy node. */
  setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void>;
  /** Remove one explicit route. */
  deleteRoute(targetNodeId: string): Promise<void>;
  /** Add an inbound, outbound, or two-way deny rule. */
  setRouteDeny(targetNodeId: string, direction: RouteDirection): Promise<void>;
  /** Enable or disable proxy mode for sender-default routing. */
  setProxyMode(enabled: boolean, defaultDstNodeId?: string): Promise<void>;
  /** Replay saved persistent connections after a restart. */
  restorePersistentConnections(): Promise<{
    ok: true;
    attempted: string[];
    restored: string[];
    failed: Array<{ target: string; error: string }>;
  }>;
}

/** Cluster-management surface layered on top of the foundation transport. */
export interface ClusterManager {
  /** Start any cluster-local background work. */
  start(): Promise<void>;
  /** Stop any cluster-local background work. */
  stop(): Promise<void>;
  /** Create a cluster definition. */
  createCluster(spec: ClusterSpec): Promise<void>;
  /** Delete one cluster definition and membership records. */
  dropCluster(clusterId: string): Promise<void>;
  /** List all known clusters. */
  listClusters(): Promise<ClusterSpec[]>;
  /** Join one node to one cluster. */
  joinCluster(cfg: ClusterNodeConfig): Promise<void>;
  /** Remove the local node from one cluster. */
  leaveCluster(clusterId: string): Promise<void>;
  /** List all nodes recorded for one cluster. */
  listNodes(clusterId: string): Promise<ClusterNodeConfig[]>;
  /** Read one membership record by cluster and node id. */
  getNode(clusterId: string, nodeId: string): Promise<ClusterNodeConfig | null>;
  /** List nodes that currently appear alive in the registry. */
  getAliveNodes(
    clusterId: string,
  ): Promise<Array<{ nodeId: string; lastSeenMs: number }>>;
  /** Execute one RPC method on every eligible node in a cluster. */
  execOnCluster(
    clusterId: string,
    method: string,
    params: unknown,
    opts?: {
      parallel?: number;
      timeoutMs?: number;
      bestEffort?: boolean;
      auth?: RpcAuth;
    },
  ): Promise<
    Array<{ nodeId: string; ok: boolean; result?: unknown; err?: string }>
  >;
  /** Discover visible peers and suggest them as cluster members. */
  discoverAndSuggest(clusterId: string): Promise<NodeInfo[]>;
}

/** Hierarchical group membership manager used by IAM. */
export interface GroupManager {
  /** Create one group in a namespace. */
  createGroup(ns: string, groupId: string, meta?: unknown): Promise<void>;
  /** Delete one group and its membership records. */
  deleteGroup(ns: string, groupId: string): Promise<void>;
  /** Add a direct item member to a group. */
  addMember(ns: string, groupId: string, itemRef: string): Promise<void>;
  /** Remove a direct item member from a group. */
  removeMember(ns: string, groupId: string, itemRef: string): Promise<void>;
  /** Add a child group relationship. */
  addSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void>;
  /** Remove a child group relationship. */
  removeSubgroup(
    ns: string,
    groupId: string,
    childGroupId: string,
  ): Promise<void>;
  /** List direct or recursive members for one group. */
  listMembers(
    ns: string,
    groupId: string,
    opts?: { recursive?: boolean },
  ): Promise<string[]>;
  /** Check whether one item belongs to a group. */
  isMember(
    ns: string,
    groupId: string,
    itemRef: string,
    opts?: { recursive?: boolean },
  ): Promise<boolean>;
}

/** One permission definition registered in the IAM catalog. */
export type PermissionDefinition = {
  title: string;
  description: string;
  maskBits?: Record<string, number>;
  scopeType?: string;
};

/** CRUD API for the permission catalog. */
export interface PermissionCatalog {
  /** Define or replace one permission id. */
  definePermission(
    ns: string,
    permId: string,
    def: PermissionDefinition,
  ): Promise<void>;
  /** Read one permission definition. */
  getPermission(
    ns: string,
    permId: string,
  ): Promise<PermissionDefinition | null>;
  /** List permissions, optionally filtering by prefix. */
  listPermissions(
    ns: string,
    prefix?: string,
  ): Promise<Array<PermissionDefinition & { permId: string }>>;
}

/** Basic user profile stored by the IAM layer. */
export type UserRecord = {
  userId: string;
  displayName?: string;
  props?: unknown;
};

/** Simple credential record used by the reference runtime. */
export type CredentialRecord = {
  type: 'pin' | 'password' | 'none';
  secretHash?: string;
};

/** User-management surface used by the auth/bootstrap helpers. */
export interface UserManager {
  /** Ensure the namespace has a guest identity and return its user id. */
  ensureGuest(ns: string): Promise<string>;
  /** Create a user record. */
  createUser(ns: string, user: UserRecord): Promise<void>;
  /** Read one user record. */
  getUser(ns: string, userId: string): Promise<UserRecord | null>;
  /** Store or replace one credential record. */
  setCredential(
    ns: string,
    userId: string,
    cred: CredentialRecord,
  ): Promise<void>;
  /** Verify one credential proof against the stored record. */
  verifyCredential(
    ns: string,
    userId: string,
    proof: unknown,
  ): Promise<boolean>;
  /** Add a user to a group. */
  addUserToGroup(ns: string, userId: string, groupId: string): Promise<void>;
  /** Remove a user from a group. */
  removeUserFromGroup(
    ns: string,
    userId: string,
    groupId: string,
  ): Promise<void>;
}

/** One invokable command definition stored by IAM. */
export type CommandDefinition = {
  title: string;
  description: string;
  maskBits?: Record<string, number>;
  scopeType?: string;
};

/** One allow/deny grant for a command subject. */
export type CommandGrant = {
  allow: boolean;
  mask?: number;
  scope?: unknown;
};

/** CRUD API for command definitions and grants. */
export interface CommandManager {
  /** Define or replace one command id. */
  defineCommand(
    ns: string,
    commandId: string,
    def: CommandDefinition,
  ): Promise<void>;
  /** Grant a subject permission to invoke one command. */
  grant(
    ns: string,
    subject: string,
    commandId: string,
    grant: CommandGrant,
  ): Promise<void>;
  /** Remove a previously granted permission. */
  revoke(ns: string, subject: string, commandId: string): Promise<void>;
  /** Evaluate whether one caller can invoke a command with the requested mask. */
  canInvoke(
    ns: string,
    ctx: { userId: string; groups?: string[]; scope?: unknown },
    commandId: string,
    requestedMask?: number,
  ): Promise<boolean>;
}

/** Bootstrap workflow for claiming newly seen unallocated nodes. */
export interface BootstrapManager {
  /** Record a node as visible but not yet assigned to a namespace. */
  registerUnallocated(nodeInfo: NodeInfo): Promise<{ status: 'unallocated' }>;
  /** List currently unallocated nodes for one namespace. */
  listUnallocated(ns: string): Promise<NodeInfo[]>;
  /** Mark a node as claimed by providing whatever proof the runtime expects. */
  claimNode(ns: string, nodeId: string, proof: unknown): Promise<void>;
}

/** Notification emitted when shard leadership changes. */
export type LeaderChangeEvent = {
  clusterId: string;
  shardId: string;
  from?: string;
  to: string;
};

/** Leader-election surface layered on top of cluster membership. */
export interface ElectionManager {
  /**
   * Starts the service.
   */
  start(): Promise<void>;
  /**
   * Stops the service.
   */
  stop(): Promise<void>;
  /**
   * Adds shard.
   * @param clusterId Cluster identifier.
   * @param shard Shard.
   */
  addShard(clusterId: string, shard: ShardSpec): Promise<void>;
  /**
   * Removes shard.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   */
  removeShard(clusterId: string, shardId: string): Promise<void>;
  /**
   * Lists shards.
   * @param clusterId Cluster identifier.
   */
  listShards(clusterId: string): Promise<ShardSpec[]>;
  /**
   * Returns leader.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   */
  getLeader(
    clusterId: string,
    shardId: string,
  ): Promise<LeaderAssignment | null>;
  /**
   * Lists leaders.
   * @param clusterId Cluster identifier.
   */
  listLeaders(clusterId: string): Promise<LeaderAssignment[]>;
  /**
   * Handles on leader change.
   * @param cb Cb.
   */
  onLeaderChange(cb: (ev: LeaderChangeEvent) => void): () => void;
  /**
   * Handles force leader.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   * @param nodeId Node identifier.
   * @param ttlMs TTL ms.
   */
  forceLeader(
    clusterId: string,
    shardId: string,
    nodeId: string,
    ttlMs?: number,
  ): Promise<void>;
  /**
   * Executes one maintenance tick.
   * @param clusterId Cluster identifier.
   */
  tick(clusterId?: string): Promise<void>;
}

/** One parsed CLI selector token. */
export type Target =
  | { kind: 'none' }
  | { kind: 'node'; value: string }
  | { kind: 'addr'; value: string }
  | { kind: 'cluster'; value: string };

/** Structured result of parsing one `coord` CLI invocation. */
export type Invocation = {
  raw: string[];
  kind: 'base' | 'targeted';
  sender: Target;
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
    kind: 'bytes' | 'json';
    name: string;
    bytes?: Uint8Array;
    json?: unknown;
  };
};

/** Hover- and CLI-friendly help metadata for one command. */
export type HelpSpec = {
  summary: string;
  usage?: string | string[];
  options?: string[];
  examples?: string[];
};

/** Registry used by the CLI dispatcher to look up commands and help text. */
export interface CommandRegistry {
  /**
   * Handles register base.
   * @param name Name value.
   * @param handler Handler.
   * @param help Help.
   */
  registerBase(
    name: string,
    handler: (inv: Invocation, ctx: unknown) => Promise<unknown>,
    help?: HelpSpec,
  ): void;
  /**
   * Handles register cmd.
   * @param fullCmd Full cmd.
   * @param handler Handler.
   * @param help Help.
   */
  registerCmd(
    fullCmd: string,
    handler: (inv: Invocation, ctx: unknown) => Promise<unknown>,
    help?: HelpSpec,
  ): void;
  /**
   * Returns whether this has base.
   * @param name Name value.
   */
  hasBase(name: string): boolean;
  /**
   * Returns whether this has cmd.
   * @param fullCmd Full cmd.
   */
  hasCmd(fullCmd: string): boolean;
  /**
   * Handles help for.
   * @param nameOrCmd Name or cmd.
   */
  helpFor(nameOrCmd: string): HelpSpec | null;
}

/** CLI dispatcher contract. */
export interface Dispatcher {
  /**
   * Dispatches the request to the matching handler.
   * @param argv Argv.
   * @param ctx Execution context.
   */
  dispatch(argv: string[], ctx?: unknown): Promise<number>;
}

/** Per-node health row used by `get_cluster_status`. */
export type ClusterNodeHealth = {
  nodeId: string;
  eligibleLeader: boolean;
  priority: number;
  started: boolean;
  lastSeenMs: number | null;
  reachablePeers: string[];
};

/** High-level cluster status summary returned by `CordNode`. */
export type ClusterStatus = {
  clusterId: string;
  leaderId: string | null;
  leaseUntilMs: number;
  nodes: ClusterNodeHealth[];
};

/** Construction options for the integrated `CordNode` facade. */
export type CordNodeOptions = {
  nodeId: NodeId;
  nodeEpoch?: string;
  listenHttp?: boolean;
  listenAddrs?: string[];
  clusterId?: string;
  eligible?: boolean;
  priority?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  electionIntervalMs?: number;
  leaseMode?: 'quorum' | 'all';
  addrs?: string[];
  props?: unknown;
  namespace?: string;
  store?: CoordStore;
  steng?: StengApi;
  maxPayloadBytes?: number;
  guestRateLimitPerWindow?: number;
  rateLimitWindowMs?: number;
};

/** Compatibility facade kept for higher-level layers such as netab. */
export interface CordNodeHandle {
  /**
   * Starts the service.
   */
  start(): Promise<void>;
  /**
   * Stops the service.
   */
  stop(): Promise<void>;
  /**
   * Returns leader.
   * @param shard_id Shard id.
   */
  get_leader(shard_id?: string): Promise<string | null>;
  /**
   * Returns cluster status.
   * @param clusterId Cluster identifier.
   */
  get_cluster_status(clusterId?: string): Promise<ClusterStatus>;
  /**
   * Updates reachability.
   * @param targetNodeId Target node id.
   * @param reachable Reachable.
   */
  set_reachability(targetNodeId: string, reachable: boolean): void;
  /**
   * Handles replicate tick.
   */
  replicate_tick(): Promise<void>;
}
