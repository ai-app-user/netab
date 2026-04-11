import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CordBootstrapManager } from './bootstrap.js';
import { CordClusterManager, priorityFromConfig } from './cluster.js';
import { CordElectionManager } from './election.js';
import { CordFoundation } from './foundation.js';
import {
  CordCommandManager,
  CordGroupManager,
  CordPermissionCatalog,
  CordUserManager,
} from './iam.js';
import { CordRegistry } from './registry.js';
import { MemoryStore } from './store.js';
import type {
  BootstrapManager,
  ClusterManager,
  ClusterNodeConfig,
  ClusterNodeHealth,
  ClusterSpec,
  ClusterStatus,
  CommandDefinition,
  CommandManager,
  ConnectOptions,
  CordNodeHandle,
  CordNodeOptions,
  ElectionManager,
  ExecCommandResult,
  FoundationNode,
  GroupManager,
  HostOsType,
  NodeInfo,
  PeerTable,
  PermissionCatalog,
  RouteDirection,
  RouteTable,
  RpcAuth,
  RpcCallOptions,
  RpcCtx,
  RpcTarget,
  ShardSpec,
  UserManager,
} from './types.js';

const DEFAULT_NAMESPACE = 'default';

/**
 * Handles describe command.
 * @param commandId Command id.
 * @param title Title.
 */
function describeCommand(commandId: string, title: string): CommandDefinition {
  return {
    title,
    description: title,
  };
}

/**
 * Returns a preview of bytes.
 * @param bytes Binary payload bytes.
 * @param max Max.
 */
function previewBytes(bytes: Uint8Array, max = 32): string {
  return Buffer.from(bytes.slice(0, max))
    .toString('utf8')
    .replace(/[^\x20-\x7E]/g, '.');
}

/**
 * Handles sha256 hex.
 * @param bytes Binary payload bytes.
 */
function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

/**
 * Detects host OS type.
 */
function detectHostOsType(): HostOsType {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'unknown';
  }
}

/**
 * Parses allowed OS.
 * @param raw Raw.
 */
function parseAllowedOs(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === 'string' ? item.trim().toLowerCase() : '',
      )
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
 * Integrated high-level coord node facade.
 *
 * This class composes the foundation, cluster, IAM, bootstrap, and election
 * managers into one object so higher-level code can use a single runtime entry
 * point without wiring those subsystems manually.
 */
export class CordNode
  implements
    CordNodeHandle,
    FoundationNode,
    ClusterManager,
    GroupManager,
    PermissionCatalog,
    UserManager,
    CommandManager,
    BootstrapManager,
    ElectionManager
{
  readonly foundation: CordFoundation;
  readonly cluster: CordClusterManager;
  readonly groups: CordGroupManager;
  readonly permissions: CordPermissionCatalog;
  readonly users: CordUserManager;
  readonly commands: CordCommandManager;
  readonly bootstrap: CordBootstrapManager;
  readonly election: CordElectionManager;
  readonly namespace: string;
  readonly steng: CordNodeOptions['steng'];

  private readonly store;
  private readonly hostOsType: HostOsType;
  private readonly defaultClusterId?: string;
  private readonly priority: number;
  private readonly eligible: boolean;
  private readonly leaseMs: number;
  private readonly props: Record<string, unknown>;
  private started = false;

  /** Construct the node and all of its sub-managers around one registry/store pair. */
  constructor(
    readonly registry: CordRegistry,
    readonly options: CordNodeOptions,
  ) {
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.store = options.store ?? registry.sharedStore ?? new MemoryStore();
    this.defaultClusterId = options.clusterId;
    this.priority = options.priority ?? 1;
    this.eligible = options.eligible ?? true;
    this.leaseMs = options.leaseMs ?? 1500;
    this.steng = options.steng;
    this.hostOsType = detectHostOsType();
    const explicitProps =
      typeof options.props === 'object' &&
      options.props !== null &&
      !Array.isArray(options.props)
        ? (options.props as Record<string, unknown>)
        : {};
    this.props = {
      ...explicitProps,
      osType:
        typeof explicitProps.osType === 'string'
          ? explicitProps.osType
          : this.hostOsType,
      execSupported:
        typeof explicitProps.execSupported === 'boolean'
          ? explicitProps.execSupported
          : this.hostOsType !== 'unknown',
      priority: this.priority,
      leaseMs: this.leaseMs,
    };

    this.groups = new CordGroupManager(this.store);
    this.permissions = new CordPermissionCatalog(this.store);
    this.users = new CordUserManager(this.store, this.groups);
    this.commands = new CordCommandManager(this.store, this.groups);
    this.foundation = new CordFoundation(registry, {
      nodeId: options.nodeId,
      nodeEpoch: options.nodeEpoch,
      listenHttp: options.listenHttp,
      listenAddrs: options.listenAddrs,
      addrs: options.addrs,
      props: this.props,
      maxPayloadBytes: options.maxPayloadBytes,
      guestRateLimitPerWindow: options.guestRateLimitPerWindow,
      rateLimitWindowMs: options.rateLimitWindowMs,
      /**
       * Handles authorize.
       * @param method Method.
       * @param ctx Execution context.
       */
      authorize: (method, ctx) => this.authorizeRpc(method, ctx),
    });
    this.cluster = new CordClusterManager(
      this.store,
      registry,
      this.foundation,
      {
        heartbeatMs: options.heartbeatMs ?? 250,
        namespace: this.namespace,
      },
    );
    this.bootstrap = new CordBootstrapManager(this.store, this.namespace);
    this.election = new CordElectionManager(
      this.store,
      this.cluster,
      this.foundation,
      registry,
      {
        leaseMs: this.leaseMs,
        electionIntervalMs: options.electionIntervalMs ?? 500,
        defaultClusterId: this.defaultClusterId,
      },
    );
    this.registry.setOwner(options.nodeId, this);
    this.registerBuiltins();
  }

  /** Start the composed runtime and join/advertise the default cluster when configured. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.foundation.start();
    await this.ensureDefaults();
    await this.cluster.start();
    if (this.defaultClusterId) {
      await this.cluster.createCluster({
        clusterId: this.defaultClusterId,
        props: { leaseMode: this.options.leaseMode ?? 'quorum' },
      });
      await this.cluster.joinCluster(
        this.defaultMembership(this.defaultClusterId),
      );
      await this.election.addShard(this.defaultClusterId, {
        shardId: 'default',
        weight: 1,
      });
    } else {
      await this.bootstrap.registerUnallocated(this.self());
    }
    await this.election.start();
    this.started = true;
  }

  /** Stop the composed runtime and release all active listeners/timers. */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.election.stop();
    await this.cluster.stop();
    await this.foundation.stop();
    this.started = false;
  }

  /** Return the current public node identity. */
  self(): NodeInfo {
    return this.foundation.self();
  }

  /** Register an additional RPC handler on the embedded foundation transport. */
  registerHandler(
    method: string,
    handler: (ctx: RpcCtx, params: unknown) => Promise<unknown>,
  ): void {
    this.foundation.registerHandler(method, handler);
  }

  /** Call a remote node through the embedded foundation transport. */
  call<T>(
    target: RpcTarget,
    method: string,
    params: unknown,
    opts?: RpcCallOptions,
  ): Promise<T> {
    return this.foundation.call(target, method, params, opts);
  }

  /** Ping a remote node through the embedded foundation transport. */
  ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }> {
    return this.foundation.ping(target);
  }

  /** Discover currently visible nodes. */
  discover(opts?: {
    mode?: 'udp' | 'mdns' | 'seeds';
    timeoutMs?: number;
  }): Promise<NodeInfo[]> {
    return this.foundation.discover(opts);
  }

  /** Return the peer table for this node. */
  getPeerTable(opts?: { verbose?: boolean }): Promise<PeerTable> {
    return this.foundation.getPeerTable(opts);
  }

  /** Return the effective route table for this node. */
  getRouteTable(opts?: { verbose?: boolean }): Promise<RouteTable> {
    return this.foundation.getRouteTable(opts);
  }

  /** Create a direct or reverse connection to a peer. */
  connect(
    target: RpcTarget,
    opts?: ConnectOptions,
  ): Promise<{ ok: true; peer: NodeInfo; ttlMs: number | null }> {
    return this.foundation.connect(target, opts);
  }

  /** Remove one persistent or live connection by target node id. */
  disconnect(targetNodeId: string): Promise<{ ok: true; nodeId: string }> {
    return this.foundation.disconnect(targetNodeId);
  }

  /** Import peer suggestions from another node. */
  learn(
    target: RpcTarget,
  ): Promise<{ ok: true; learned: string[]; skipped: string[] }> {
    return this.foundation.learn(target);
  }

  /** Add or replace one explicit route. */
  setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void> {
    return this.foundation.setRoute(targetNodeId, proxyNodeId);
  }

  /** Remove one explicit route. */
  deleteRoute(targetNodeId: string): Promise<void> {
    return this.foundation.deleteRoute(targetNodeId);
  }

  /** Add an inbound, outbound, or bidirectional deny rule. */
  setRouteDeny(targetNodeId: string, direction: RouteDirection): Promise<void> {
    return this.foundation.setRouteDeny(targetNodeId, direction);
  }

  /**
   * Updates proxy mode.
   * @param enabled Enabled.
   * @param defaultDstNodeId Default dst node id.
   */
  setProxyMode(enabled: boolean, defaultDstNodeId?: string): Promise<void> {
    return this.foundation.setProxyMode(enabled, defaultDstNodeId);
  }

  /**
   * Handles restore persistent connections.
   */
  restorePersistentConnections(): Promise<{
    ok: true;
    attempted: string[];
    restored: string[];
    failed: Array<{ target: string; error: string }>;
  }> {
    return this.foundation.restorePersistentConnections();
  }

  /**
   * Creates cluster.
   * @param spec Spec.
   */
  createCluster(spec: ClusterSpec): Promise<void> {
    return this.cluster.createCluster(spec);
  }

  /**
   * Removes cluster.
   * @param clusterId Cluster identifier.
   */
  dropCluster(clusterId: string): Promise<void> {
    return this.cluster.dropCluster(clusterId);
  }

  /**
   * Lists clusters.
   */
  listClusters(): Promise<ClusterSpec[]> {
    return this.cluster.listClusters();
  }

  /**
   * Handles join cluster.
   * @param cfg Config.
   */
  joinCluster(cfg: ClusterNodeConfig): Promise<void> {
    return this.cluster.joinCluster(cfg);
  }

  /**
   * Handles leave cluster.
   * @param clusterId Cluster identifier.
   */
  leaveCluster(clusterId: string): Promise<void> {
    return this.cluster.leaveCluster(clusterId);
  }

  /**
   * Lists nodes.
   * @param clusterId Cluster identifier.
   */
  listNodes(clusterId: string): Promise<ClusterNodeConfig[]> {
    return this.cluster.listNodes(clusterId);
  }

  /**
   * Returns node.
   * @param clusterId Cluster identifier.
   * @param nodeId Node identifier.
   */
  getNode(
    clusterId: string,
    nodeId: string,
  ): Promise<ClusterNodeConfig | null> {
    return this.cluster.getNode(clusterId, nodeId);
  }

  /**
   * Returns alive nodes.
   * @param clusterId Cluster identifier.
   */
  getAliveNodes(
    clusterId: string,
  ): Promise<Array<{ nodeId: string; lastSeenMs: number }>> {
    return this.cluster.getAliveNodes(clusterId);
  }

  /**
   * Handles exec on cluster.
   * @param clusterId Cluster identifier.
   * @param method Method.
   * @param params SQL parameters.
   * @param opts Optional call options.
   */
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
  > {
    return this.cluster.execOnCluster(clusterId, method, params, opts);
  }

  /**
   * Handles discover and suggest.
   * @param clusterId Cluster identifier.
   */
  discoverAndSuggest(clusterId: string): Promise<NodeInfo[]> {
    return this.cluster.discoverAndSuggest(clusterId);
  }

  /**
   * Creates group.
   * @param ns Ns.
   * @param groupId Group id.
   * @param meta Meta.
   */
  createGroup(ns: string, groupId: string, meta?: unknown): Promise<void> {
    return this.groups.createGroup(ns, groupId, meta);
  }

  /**
   * Removes group.
   * @param ns Ns.
   * @param groupId Group id.
   */
  deleteGroup(ns: string, groupId: string): Promise<void> {
    return this.groups.deleteGroup(ns, groupId);
  }

  /**
   * Adds member.
   * @param ns Ns.
   * @param groupId Group id.
   * @param itemRef Item ref.
   */
  addMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    return this.groups.addMember(ns, groupId, itemRef);
  }

  /**
   * Removes member.
   * @param ns Ns.
   * @param groupId Group id.
   * @param itemRef Item ref.
   */
  removeMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    return this.groups.removeMember(ns, groupId, itemRef);
  }

  /**
   * Adds subgroup.
   * @param ns Ns.
   * @param groupId Group id.
   * @param childGroupId Child group id.
   */
  addSubgroup(
    ns: string,
    groupId: string,
    childGroupId: string,
  ): Promise<void> {
    return this.groups.addSubgroup(ns, groupId, childGroupId);
  }

  /**
   * Removes subgroup.
   * @param ns Ns.
   * @param groupId Group id.
   * @param childGroupId Child group id.
   */
  removeSubgroup(
    ns: string,
    groupId: string,
    childGroupId: string,
  ): Promise<void> {
    return this.groups.removeSubgroup(ns, groupId, childGroupId);
  }

  /**
   * Lists members.
   * @param ns Ns.
   * @param groupId Group id.
   * @param opts Opts.
   */
  listMembers(
    ns: string,
    groupId: string,
    opts?: { recursive?: boolean },
  ): Promise<string[]> {
    return this.groups.listMembers(ns, groupId, opts);
  }

  /**
   * Returns whether member.
   * @param ns Ns.
   * @param groupId Group id.
   * @param itemRef Item ref.
   * @param opts Opts.
   */
  isMember(
    ns: string,
    groupId: string,
    itemRef: string,
    opts?: { recursive?: boolean },
  ): Promise<boolean> {
    return this.groups.isMember(ns, groupId, itemRef, opts);
  }

  /**
   * Handles define permission.
   * @param ns Ns.
   * @param permId Perm id.
   * @param def Def.
   */
  definePermission(
    ns: string,
    permId: string,
    def: {
      title: string;
      description: string;
      maskBits?: Record<string, number>;
      scopeType?: string;
    },
  ): Promise<void> {
    return this.permissions.definePermission(ns, permId, def);
  }

  /**
   * Returns permission.
   * @param ns Ns.
   * @param permId Perm id.
   */
  getPermission(
    ns: string,
    permId: string,
  ): Promise<{
    title: string;
    description: string;
    maskBits?: Record<string, number>;
    scopeType?: string;
  } | null> {
    return this.permissions.getPermission(ns, permId);
  }

  /**
   * Lists permissions.
   * @param ns Ns.
   * @param prefix Identifier prefix.
   */
  listPermissions(
    ns: string,
    prefix?: string,
  ): Promise<
    Array<{
      permId: string;
      title: string;
      description: string;
      maskBits?: Record<string, number>;
      scopeType?: string;
    }>
  > {
    return this.permissions.listPermissions(ns, prefix);
  }

  /**
   * Ensures guest.
   * @param ns Ns.
   */
  ensureGuest(ns: string): Promise<string> {
    return this.users.ensureGuest(ns);
  }

  /**
   * Creates user.
   * @param ns Ns.
   * @param user User.
   */
  createUser(
    ns: string,
    user: { userId: string; displayName?: string; props?: unknown },
  ): Promise<void> {
    return this.users.createUser(ns, user);
  }

  /**
   * Returns user.
   * @param ns Ns.
   * @param userId User id.
   */
  getUser(
    ns: string,
    userId: string,
  ): Promise<{ userId: string; displayName?: string; props?: unknown } | null> {
    return this.users.getUser(ns, userId);
  }

  /**
   * Updates credential.
   * @param ns Ns.
   * @param userId User id.
   * @param cred Cred.
   */
  setCredential(
    ns: string,
    userId: string,
    cred: { type: 'pin' | 'password' | 'none'; secretHash?: string },
  ): Promise<void> {
    return this.users.setCredential(ns, userId, cred);
  }

  /**
   * Handles verify credential.
   * @param ns Ns.
   * @param userId User id.
   * @param proof Proof.
   */
  verifyCredential(
    ns: string,
    userId: string,
    proof: unknown,
  ): Promise<boolean> {
    return this.users.verifyCredential(ns, userId, proof);
  }

  /**
   * Adds user to group.
   * @param ns Ns.
   * @param userId User id.
   * @param groupId Group id.
   */
  addUserToGroup(ns: string, userId: string, groupId: string): Promise<void> {
    return this.users.addUserToGroup(ns, userId, groupId);
  }

  /**
   * Removes user from group.
   * @param ns Ns.
   * @param userId User id.
   * @param groupId Group id.
   */
  removeUserFromGroup(
    ns: string,
    userId: string,
    groupId: string,
  ): Promise<void> {
    return this.users.removeUserFromGroup(ns, userId, groupId);
  }

  /**
   * Handles define command.
   * @param ns Ns.
   * @param commandId Command id.
   * @param def Def.
   */
  defineCommand(
    ns: string,
    commandId: string,
    def: {
      title: string;
      description: string;
      maskBits?: Record<string, number>;
      scopeType?: string;
    },
  ): Promise<void> {
    return this.commands.defineCommand(ns, commandId, def);
  }

  /**
   * Handles grant.
   * @param ns Ns.
   * @param subject Subject.
   * @param commandId Command id.
   * @param grant Grant.
   */
  grant(
    ns: string,
    subject: string,
    commandId: string,
    grant: { allow: boolean; mask?: number; scope?: unknown },
  ): Promise<void> {
    return this.commands.grant(ns, subject, commandId, grant);
  }

  /**
   * Handles revoke.
   * @param ns Ns.
   * @param subject Subject.
   * @param commandId Command id.
   */
  revoke(ns: string, subject: string, commandId: string): Promise<void> {
    return this.commands.revoke(ns, subject, commandId);
  }

  /**
   * Returns whether invoke.
   * @param ns Ns.
   * @param ctx Execution context.
   * @param commandId Command id.
   * @param requestedMask Requested mask.
   */
  canInvoke(
    ns: string,
    ctx: { userId: string; groups?: string[]; scope?: unknown },
    commandId: string,
    requestedMask?: number,
  ): Promise<boolean> {
    return this.commands.canInvoke(ns, ctx, commandId, requestedMask);
  }

  /**
   * Handles register unallocated.
   * @param nodeInfo Node info.
   */
  registerUnallocated(nodeInfo: NodeInfo): Promise<{ status: 'unallocated' }> {
    return this.bootstrap.registerUnallocated(nodeInfo);
  }

  /**
   * Lists unallocated.
   * @param ns Ns.
   */
  listUnallocated(ns: string): Promise<NodeInfo[]> {
    return this.bootstrap.listUnallocated(ns);
  }

  /**
   * Handles claim node.
   * @param ns Ns.
   * @param nodeId Node identifier.
   * @param proof Proof.
   */
  claimNode(ns: string, nodeId: string, proof: unknown): Promise<void> {
    return this.bootstrap.claimNode(ns, nodeId, proof);
  }

  /**
   * Adds shard.
   * @param clusterId Cluster identifier.
   * @param shard Shard.
   */
  addShard(clusterId: string, shard: ShardSpec): Promise<void> {
    return this.election.addShard(clusterId, shard);
  }

  /**
   * Removes shard.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   */
  removeShard(clusterId: string, shardId: string): Promise<void> {
    return this.election.removeShard(clusterId, shardId);
  }

  /**
   * Lists shards.
   * @param clusterId Cluster identifier.
   */
  listShards(clusterId: string): Promise<ShardSpec[]> {
    return this.election.listShards(clusterId);
  }

  /**
   * Returns leader.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   */
  getLeader(
    clusterId: string,
    shardId: string,
  ): Promise<{
    clusterId: string;
    shardId: string;
    leaderNodeId: string;
    term: number;
    leaseUntilMs: number;
  } | null> {
    return this.election.getLeader(clusterId, shardId);
  }

  /**
   * Lists leaders.
   * @param clusterId Cluster identifier.
   */
  listLeaders(clusterId: string): Promise<
    Array<{
      clusterId: string;
      shardId: string;
      leaderNodeId: string;
      term: number;
      leaseUntilMs: number;
    }>
  > {
    return this.election.listLeaders(clusterId);
  }

  /**
   * Handles on leader change.
   * @param cb Callback function.
   */
  onLeaderChange(
    cb: (ev: {
      clusterId: string;
      shardId: string;
      from?: string;
      to: string;
    }) => void,
  ): () => void {
    return this.election.onLeaderChange(cb);
  }

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
  ): Promise<void> {
    return this.election.forceLeader(clusterId, shardId, nodeId, ttlMs);
  }

  /**
   * Executes one maintenance tick.
   * @param clusterId Cluster identifier.
   */
  tick(clusterId?: string): Promise<void> {
    return this.election.tick(clusterId);
  }

  /**
   * Returns leader.
   * @param shard_id Shard id.
   */
  async get_leader(shard_id = 'default'): Promise<string | null> {
    if (!this.defaultClusterId) {
      return null;
    }
    return (
      (await this.election.getLeader(this.defaultClusterId, shard_id))
        ?.leaderNodeId ?? null
    );
  }

  /**
   * Returns cluster status.
   * @param clusterId Cluster identifier.
   */
  async get_cluster_status(
    clusterId = this.defaultClusterId ?? 'unallocated',
  ): Promise<ClusterStatus> {
    const leader =
      clusterId === 'unallocated'
        ? null
        : await this.election.getLeader(clusterId, 'default');
    const nodes =
      clusterId === 'unallocated'
        ? []
        : await this.cluster.listNodes(clusterId);
    const alive = new Map(
      (clusterId === 'unallocated'
        ? []
        : await this.cluster.getAliveNodes(clusterId)
      ).map((item) => [item.nodeId, item.lastSeenMs]),
    );
    const nodeHealth: ClusterNodeHealth[] = nodes.map((node) => {
      const started =
        alive.has(node.nodeId) ||
        Boolean(this.registry.getNode(node.nodeId)?.started);
      const reachablePeers = nodes
        .filter((peer) => this.registry.canReach(node.nodeId, peer.nodeId))
        .map((peer) => peer.nodeId)
        .sort();
      return {
        nodeId: node.nodeId,
        eligibleLeader: node.role.eligibleLeader !== false,
        priority: priorityFromConfig(node),
        started,
        lastSeenMs: alive.get(node.nodeId) ?? null,
        reachablePeers,
      };
    });
    return {
      clusterId,
      leaderId: leader?.leaderNodeId ?? null,
      leaseUntilMs: leader?.leaseUntilMs ?? 0,
      nodes: nodeHealth,
    };
  }

  /**
   * Updates reachability.
   * @param targetNodeId Target node id.
   * @param reachable Reachable.
   */
  set_reachability(targetNodeId: string, reachable: boolean): void {
    this.registry.setReachability(this.self().nodeId, targetNodeId, reachable);
  }

  /**
   * Handles replicate tick.
   */
  async replicate_tick(): Promise<void> {
    await this.cluster.tickHeartbeats();
    await this.election.tick(this.defaultClusterId);
    if (this.defaultClusterId && this.steng) {
      const leaderId = await this.get_leader('default');
      if (leaderId === this.self().nodeId) {
        await this.replicateStengCluster(this.defaultClusterId);
      }
    }
  }

  /**
   * Returns the default membership.
   * @param clusterId Cluster identifier.
   */
  private defaultMembership(clusterId: string): ClusterNodeConfig {
    return {
      clusterId,
      nodeId: this.self().nodeId,
      role: {
        canSend: true,
        canReceive: true,
        eligibleLeader: this.eligible,
      },
      props: this.props,
    };
  }

  /**
   * Handles register builtins.
   */
  private registerBuiltins(): void {
    this.foundation.registerHandler('cord.foundation.ping', async () => ({
      ok: true,
    }));
    this.foundation.registerHandler('cord.foundation.whoami', async () =>
      this.self(),
    );
    this.foundation.registerHandler(
      'cord.foundation.echo',
      async (_ctx, params) => {
        const payload = params as {
          args?: unknown[];
          named?: Record<string, unknown>;
          payload?: {
            kind: 'bytes' | 'json';
            name: string;
            bytes?: string;
            json?: unknown;
          };
        };
        if (payload.payload?.kind === 'bytes' && payload.payload.bytes) {
          const bytes = new Uint8Array(
            Buffer.from(payload.payload.bytes, 'base64'),
          );
          return {
            ok: true,
            kind: 'bytes',
            name: payload.payload.name,
            bytes: bytes.byteLength,
            sha256: sha256Hex(bytes),
            preview: previewBytes(bytes),
          };
        }
        if (payload.payload?.kind === 'json') {
          return {
            ok: true,
            kind: 'json',
            name: payload.payload.name,
            json: payload.payload.json,
          };
        }
        const args = payload.args ?? [];
        return {
          ok: true,
          args,
          named: payload.named ?? {},
          text: args.map((item) => String(item)).join(' '),
        };
      },
    );
    this.foundation.registerHandler(
      'cord.foundation.sleep',
      async (_ctx, params) => {
        const ms = Number((params as { ms?: number }).ms ?? 0);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
        return { sleptMs: ms };
      },
    );
    this.foundation.registerHandler(
      'cord.foundation.execCommand',
      async (_ctx, params) => {
        const payload = params as {
          command?: unknown;
          onlyOs?: unknown;
          timeoutMs?: unknown;
        };
        return this.execHostCommand(payload);
      },
    );
    this.foundation.registerHandler(
      'cord.cluster.heartbeat',
      async (_ctx, params) => {
        const payload = params as {
          clusterId: string;
          nodeId: string;
          tsMs?: number;
        };
        this.cluster.handleHeartbeat(
          payload.clusterId,
          payload.nodeId,
          payload.tsMs ?? Date.now(),
        );
        return { ok: true };
      },
    );
    this.foundation.registerHandler(
      'cord.cluster.create',
      async (_ctx, params) => this.cluster.createCluster(params as ClusterSpec),
    );
    this.foundation.registerHandler('cord.cluster.join', async (_ctx, params) =>
      this.cluster.joinCluster(params as ClusterNodeConfig),
    );
    this.foundation.registerHandler(
      'cord.cluster.leave',
      async (_ctx, params) =>
        this.cluster.leaveCluster((params as { clusterId: string }).clusterId),
    );
    this.foundation.registerHandler(
      'cord.cluster.listNodes',
      async (_ctx, params) =>
        this.cluster.listNodes((params as { clusterId: string }).clusterId),
    );
    this.foundation.registerHandler(
      'cord.cluster.execOnCluster',
      async (_ctx, params) => {
        const payload = params as {
          clusterId: string;
          method: string;
          params: unknown;
          opts?: {
            parallel?: number;
            timeoutMs?: number;
            bestEffort?: boolean;
            auth?: RpcAuth;
          };
        };
        return this.cluster.execOnCluster(
          payload.clusterId,
          payload.method,
          payload.params,
          payload.opts,
        );
      },
    );
    this.foundation.registerHandler(
      'cord.bootstrap.register_unallocated',
      async (_ctx, params) =>
        this.bootstrap.registerUnallocated(params as NodeInfo),
    );
    this.foundation.registerHandler(
      'cord.bootstrap.list_unallocated',
      async (_ctx, params) =>
        this.bootstrap.listUnallocated(
          (params as { ns?: string }).ns ?? this.namespace,
        ),
    );
    this.foundation.registerHandler(
      'cord.election.addShard',
      async (_ctx, params) => {
        const payload = params as { clusterId: string; shard: ShardSpec };
        await this.election.addShard(payload.clusterId, payload.shard);
        return { ok: true };
      },
    );
    this.foundation.registerHandler(
      'cord.election.getLeader',
      async (_ctx, params) => {
        const payload = params as { clusterId: string; shardId: string };
        return this.election.getLeader(payload.clusterId, payload.shardId);
      },
    );
    this.foundation.registerHandler(
      'cord.election.RequestLease',
      async (_ctx, params) =>
        this.election.handleRequestLease(
          params as {
            clusterId: string;
            shardId: string;
            term: number;
            ttlMs: number;
            leaderNodeId: string;
          },
        ),
    );
    this.foundation.registerHandler(
      'cord.election.RenewLease',
      async (_ctx, params) =>
        this.election.handleRenewLease(
          params as {
            clusterId: string;
            shardId: string;
            term: number;
            ttlMs: number;
            leaderNodeId: string;
          },
        ),
    );
    this.foundation.registerHandler(
      'cord.election.ReleaseLease',
      async (_ctx, params) =>
        this.election.handleReleaseLease(
          params as {
            clusterId: string;
            shardId: string;
            term: number;
            leaderNodeId: string;
          },
        ),
    );
    this.foundation.registerHandler(
      'cord.iam.defineCommand',
      async (_ctx, params) => {
        const payload = params as {
          ns?: string;
          commandId: string;
          def: CommandDefinition;
        };
        await this.commands.defineCommand(
          payload.ns ?? this.namespace,
          payload.commandId,
          payload.def,
        );
        return { ok: true };
      },
    );
    this.foundation.registerHandler('cord.iam.grant', async (_ctx, params) => {
      const payload = params as {
        ns?: string;
        subject: string;
        commandId: string;
        grant: { allow: boolean; mask?: number; scope?: unknown };
      };
      await this.commands.grant(
        payload.ns ?? this.namespace,
        payload.subject,
        payload.commandId,
        payload.grant,
      );
      return { ok: true };
    });
    this.foundation.registerHandler(
      'cord.iam.canInvoke',
      async (_ctx, params) => {
        const payload = params as {
          ns?: string;
          ctx: { userId: string; groups?: string[]; scope?: unknown };
          commandId: string;
          requestedMask?: number;
        };
        return this.commands.canInvoke(
          payload.ns ?? this.namespace,
          payload.ctx,
          payload.commandId,
          payload.requestedMask,
        );
      },
    );
    this.foundation.registerHandler(
      'cord.users.ensureGuest',
      async (_ctx, params) =>
        this.users.ensureGuest(
          (params as { ns?: string }).ns ?? this.namespace,
        ),
    );
  }

  /**
   * Ensures defaults.
   */
  private async ensureDefaults(): Promise<void> {
    await this.users.ensureGuest(this.namespace);
    await this.groups.createGroup(this.namespace, 'internal', { system: true });
    const commandTitles: Array<[string, string]> = [
      ['cord.foundation.ping', 'Ping a node'],
      ['cord.foundation.whoami', 'Return node identity'],
      [
        'cord.foundation.exec',
        'Execute a command on this node or a routed destination',
      ],
      ['cord.foundation.execCommand', 'Execute a host shell command'],
      ['cord.foundation.route', 'Inspect or edit local routing policy'],
      ['cord.foundation.proxy', 'Configure proxy mode'],
      ['cord.foundation.echo', 'Echo args or payload'],
      ['cord.foundation.sleep', 'Sleep for a period'],
      ['cord.cluster.heartbeat', 'Record cluster heartbeat'],
      ['cord.cluster.create', 'Create a cluster'],
      ['cord.cluster.join', 'Join a cluster'],
      ['cord.cluster.leave', 'Leave a cluster'],
      ['cord.cluster.listNodes', 'List cluster nodes'],
      ['cord.cluster.execOnCluster', 'Execute a command across a cluster'],
      ['cord.iam.defineCommand', 'Define a command'],
      ['cord.iam.grant', 'Grant command access'],
      ['cord.iam.canInvoke', 'Check command access'],
      ['cord.users.ensureGuest', 'Ensure guest user exists'],
      ['cord.bootstrap.register_unallocated', 'Register an unallocated node'],
      ['cord.bootstrap.list_unallocated', 'List unallocated nodes'],
      ['cord.election.addShard', 'Add a shard'],
      ['cord.election.getLeader', 'Read shard leader'],
      ['cord.election.RequestLease', 'Internal lease request'],
      ['cord.election.RenewLease', 'Internal lease renew'],
      ['cord.election.ReleaseLease', 'Internal lease release'],
    ];
    for (const [commandId, title] of commandTitles) {
      await this.commands.defineCommand(
        this.namespace,
        commandId,
        describeCommand(commandId, title),
      );
    }
    for (const cheap of [
      'cord.foundation.ping',
      'cord.foundation.whoami',
      'cord.cluster.heartbeat',
      'cord.bootstrap.register_unallocated',
    ]) {
      await this.commands.grant(this.namespace, 'grp:guest', cheap, {
        allow: true,
      });
    }
  }

  /**
   * Handles authorize RPC.
   * @param method Method.
   * @param ctx Execution context.
   */
  private async authorizeRpc(method: string, ctx: RpcCtx): Promise<void> {
    if (!ctx.auth) {
      return;
    }
    if (ctx.auth.internal) {
      return;
    }
    const allowed = await this.commands.canInvoke(
      this.namespace,
      {
        userId: ctx.auth.userId,
        groups: ctx.auth.groups,
        scope: ctx.auth.scope,
      },
      method,
    );
    if (!allowed) {
      throw new Error(`Unauthorized for ${method}`);
    }
  }

  /**
   * Handles exec host command.
   * @param params SQL parameters.
   */
  private async execHostCommand(params: {
    command?: unknown;
    onlyOs?: unknown;
    timeoutMs?: unknown;
  }): Promise<ExecCommandResult> {
    const command =
      typeof params.command === 'string' ? params.command.trim() : '';
    if (!command) {
      throw new Error('execCommand requires a shell command');
    }
    const allowedOs = parseAllowedOs(params.onlyOs);
    if (
      allowedOs.length > 0 &&
      !allowedOs.includes(String(this.hostOsType).toLowerCase())
    ) {
      return {
        ok: true,
        command,
        osType: this.hostOsType,
        supported: this.hostOsType !== 'unknown',
        skipped: true,
        reason: `OS ${this.hostOsType} is not in allowed set ${allowedOs.join(',')}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
      };
    }
    if (this.hostOsType === 'unknown') {
      return {
        ok: true,
        command,
        osType: this.hostOsType,
        supported: false,
        skipped: true,
        reason: 'Shell execution is not supported on this host OS',
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
      };
    }
    const timeoutMs =
      typeof params.timeoutMs === 'number' &&
      Number.isFinite(params.timeoutMs) &&
      params.timeoutMs > 0
        ? Math.floor(params.timeoutMs)
        : 10_000;
    return await new Promise<ExecCommandResult>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let requiredSigKill = false;
      const maxCapture = 256 * 1024;
      /**
       * Handles append chunk.
       * @param current Current value.
       * @param chunk Chunk.
       */
      const appendChunk = (current: string, chunk: Buffer | string): string => {
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
        if (current.length >= maxCapture) {
          return current;
        }
        const next = current + text;
        return next.length > maxCapture
          ? `${next.slice(0, maxCapture)}\n[truncated]`
          : next;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            requiredSigKill = true;
            child.kill('SIGKILL');
          }
        }, 1000).unref();
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout = appendChunk(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendChunk(stderr, chunk);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          stderr = `${stderr}${stderr ? '\n' : ''}${requiredSigKill ? 'Process timed out and required SIGKILL.' : 'Process timed out.'}`;
        }
        resolve({
          ok: true,
          command,
          osType: this.hostOsType,
          supported: true,
          skipped: false,
          exitCode: typeof code === 'number' ? code : null,
          signal,
          timedOut,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      });
    });
  }

  /**
   * Handles replicate steng cluster.
   * @param clusterId Cluster identifier.
   */
  private async replicateStengCluster(clusterId: string): Promise<void> {
    if (!this.steng) {
      return;
    }
    const peers = await this.cluster.listNodes(clusterId);
    const leaderTables = await this.steng.list_tables();
    for (const peer of peers) {
      if (peer.nodeId === this.self().nodeId) {
        continue;
      }
      const peerNode = this.registry.getOwner<CordNode>(peer.nodeId);
      if (!peerNode?.steng || !this.registry.getNode(peer.nodeId)?.started) {
        continue;
      }
      for (const leaderTable of leaderTables) {
        const replicaTable =
          (await peerNode.steng.get_table_info(
            leaderTable.app,
            leaderTable.db,
            leaderTable.tableName,
          )) ??
          (await peerNode.steng.ensure_table(
            leaderTable.app,
            leaderTable.db,
            leaderTable.tableName,
            leaderTable.type,
          ));

        await peerNode.steng.set_table_config(
          replicaTable.tableId,
          leaderTable.config,
        );
        for (const [field, config] of Object.entries(
          leaderTable.config.indexes,
        )) {
          await peerNode.steng.add_index(
            replicaTable.tableId,
            field,
            config.type,
            config.multi,
          );
        }

        const afterSeq = await peerNode.steng.latest_seq(replicaTable.tableId);
        const ops = await this.steng.read_ops_since(
          leaderTable.tableId,
          afterSeq,
          10_000,
        );
        if (ops.length > 0) {
          await peerNode.steng.apply_ops(replicaTable.tableId, ops);
        }

        const watermark = await this.steng.get_watermark(leaderTable.tableId);
        if (watermark) {
          await peerNode.steng.set_watermark(replicaTable.tableId, watermark);
        }
      }
    }
  }
}
