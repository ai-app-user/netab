import { createHash } from "node:crypto";
import { CordBootstrapManager } from "./bootstrap.js";
import { CordClusterManager, priorityFromConfig } from "./cluster.js";
import { CordElectionManager } from "./election.js";
import { CordFoundation } from "./foundation.js";
import { CordCommandManager, CordGroupManager, CordPermissionCatalog, CordUserManager } from "./iam.js";
import { CordRegistry } from "./registry.js";
import { MemoryStore } from "./store.js";
import type {
  BootstrapManager,
  ClusterManager,
  ClusterNodeConfig,
  ClusterNodeHealth,
  ClusterSpec,
  ClusterStatus,
  CommandDefinition,
  CommandManager,
  CordNodeHandle,
  CordNodeOptions,
  ElectionManager,
  FoundationNode,
  GroupManager,
  NodeInfo,
  PermissionCatalog,
  RouteDirection,
  RouteTable,
  RpcAuth,
  RpcCallOptions,
  RpcCtx,
  RpcTarget,
  ShardSpec,
  UserManager,
} from "./types.js";

const DEFAULT_NAMESPACE = "default";

function describeCommand(commandId: string, title: string): CommandDefinition {
  return {
    title,
    description: title,
  };
}

function previewBytes(bytes: Uint8Array, max = 32): string {
  return Buffer.from(bytes.slice(0, max)).toString("utf8").replace(/[^\x20-\x7E]/g, ".");
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

export class CordNode
  implements CordNodeHandle, FoundationNode, ClusterManager, GroupManager, PermissionCatalog, UserManager, CommandManager, BootstrapManager, ElectionManager
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
  readonly steng: CordNodeOptions["steng"];

  private readonly store;
  private readonly defaultClusterId?: string;
  private readonly priority: number;
  private readonly eligible: boolean;
  private readonly leaseMs: number;
  private readonly props: Record<string, unknown>;
  private started = false;

  constructor(readonly registry: CordRegistry, readonly options: CordNodeOptions) {
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.store = options.store ?? registry.sharedStore ?? new MemoryStore();
    this.defaultClusterId = options.clusterId;
    this.priority = options.priority ?? 1;
    this.eligible = options.eligible ?? true;
    this.leaseMs = options.leaseMs ?? 1500;
    this.steng = options.steng;
    this.props = {
      ...(typeof options.props === "object" && options.props !== null && !Array.isArray(options.props) ? (options.props as Record<string, unknown>) : {}),
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
      addrs: options.addrs,
      props: this.props,
      maxPayloadBytes: options.maxPayloadBytes,
      guestRateLimitPerWindow: options.guestRateLimitPerWindow,
      rateLimitWindowMs: options.rateLimitWindowMs,
      authorize: (method, ctx) => this.authorizeRpc(method, ctx),
    });
    this.cluster = new CordClusterManager(this.store, registry, this.foundation, {
      heartbeatMs: options.heartbeatMs ?? 250,
      namespace: this.namespace,
    });
    this.bootstrap = new CordBootstrapManager(this.store, this.namespace);
    this.election = new CordElectionManager(this.store, this.cluster, this.foundation, registry, {
      leaseMs: this.leaseMs,
      electionIntervalMs: options.electionIntervalMs ?? 500,
      defaultClusterId: this.defaultClusterId,
    });
    this.registry.setOwner(options.nodeId, this);
    this.registerBuiltins();
  }

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
        props: { leaseMode: this.options.leaseMode ?? "quorum" },
      });
      await this.cluster.joinCluster(this.defaultMembership(this.defaultClusterId));
      await this.election.addShard(this.defaultClusterId, { shardId: "default", weight: 1 });
    } else {
      await this.bootstrap.registerUnallocated(this.self());
    }
    await this.election.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.election.stop();
    await this.cluster.stop();
    await this.foundation.stop();
    this.started = false;
  }

  self(): NodeInfo {
    return this.foundation.self();
  }

  registerHandler(method: string, handler: (ctx: RpcCtx, params: unknown) => Promise<unknown>): void {
    this.foundation.registerHandler(method, handler);
  }

  call<T>(target: RpcTarget, method: string, params: unknown, opts?: RpcCallOptions): Promise<T> {
    return this.foundation.call(target, method, params, opts);
  }

  ping(target: RpcTarget): Promise<{ ok: boolean; rttMs: number }> {
    return this.foundation.ping(target);
  }

  discover(opts?: { mode?: "udp" | "mdns" | "seeds"; timeoutMs?: number }): Promise<NodeInfo[]> {
    return this.foundation.discover(opts);
  }

  getRouteTable(opts?: { verbose?: boolean }): Promise<RouteTable> {
    return this.foundation.getRouteTable(opts);
  }

  setRoute(targetNodeId: string, proxyNodeId?: string): Promise<void> {
    return this.foundation.setRoute(targetNodeId, proxyNodeId);
  }

  deleteRoute(targetNodeId: string): Promise<void> {
    return this.foundation.deleteRoute(targetNodeId);
  }

  setRouteDeny(targetNodeId: string, direction: RouteDirection): Promise<void> {
    return this.foundation.setRouteDeny(targetNodeId, direction);
  }

  setProxyMode(enabled: boolean, defaultDstNodeId?: string): Promise<void> {
    return this.foundation.setProxyMode(enabled, defaultDstNodeId);
  }

  createCluster(spec: ClusterSpec): Promise<void> {
    return this.cluster.createCluster(spec);
  }

  dropCluster(clusterId: string): Promise<void> {
    return this.cluster.dropCluster(clusterId);
  }

  listClusters(): Promise<ClusterSpec[]> {
    return this.cluster.listClusters();
  }

  joinCluster(cfg: ClusterNodeConfig): Promise<void> {
    return this.cluster.joinCluster(cfg);
  }

  leaveCluster(clusterId: string): Promise<void> {
    return this.cluster.leaveCluster(clusterId);
  }

  listNodes(clusterId: string): Promise<ClusterNodeConfig[]> {
    return this.cluster.listNodes(clusterId);
  }

  getNode(clusterId: string, nodeId: string): Promise<ClusterNodeConfig | null> {
    return this.cluster.getNode(clusterId, nodeId);
  }

  getAliveNodes(clusterId: string): Promise<Array<{ nodeId: string; lastSeenMs: number }>> {
    return this.cluster.getAliveNodes(clusterId);
  }

  execOnCluster(
    clusterId: string,
    method: string,
    params: unknown,
    opts?: { parallel?: number; timeoutMs?: number; bestEffort?: boolean; auth?: RpcAuth },
  ): Promise<Array<{ nodeId: string; ok: boolean; result?: unknown; err?: string }>> {
    return this.cluster.execOnCluster(clusterId, method, params, opts);
  }

  discoverAndSuggest(clusterId: string): Promise<NodeInfo[]> {
    return this.cluster.discoverAndSuggest(clusterId);
  }

  createGroup(ns: string, groupId: string, meta?: unknown): Promise<void> {
    return this.groups.createGroup(ns, groupId, meta);
  }

  deleteGroup(ns: string, groupId: string): Promise<void> {
    return this.groups.deleteGroup(ns, groupId);
  }

  addMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    return this.groups.addMember(ns, groupId, itemRef);
  }

  removeMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    return this.groups.removeMember(ns, groupId, itemRef);
  }

  addSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void> {
    return this.groups.addSubgroup(ns, groupId, childGroupId);
  }

  removeSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void> {
    return this.groups.removeSubgroup(ns, groupId, childGroupId);
  }

  listMembers(ns: string, groupId: string, opts?: { recursive?: boolean }): Promise<string[]> {
    return this.groups.listMembers(ns, groupId, opts);
  }

  isMember(ns: string, groupId: string, itemRef: string, opts?: { recursive?: boolean }): Promise<boolean> {
    return this.groups.isMember(ns, groupId, itemRef, opts);
  }

  definePermission(ns: string, permId: string, def: { title: string; description: string; maskBits?: Record<string, number>; scopeType?: string }): Promise<void> {
    return this.permissions.definePermission(ns, permId, def);
  }

  getPermission(ns: string, permId: string): Promise<{ title: string; description: string; maskBits?: Record<string, number>; scopeType?: string } | null> {
    return this.permissions.getPermission(ns, permId);
  }

  listPermissions(ns: string, prefix?: string): Promise<Array<{ permId: string; title: string; description: string; maskBits?: Record<string, number>; scopeType?: string }>> {
    return this.permissions.listPermissions(ns, prefix);
  }

  ensureGuest(ns: string): Promise<string> {
    return this.users.ensureGuest(ns);
  }

  createUser(ns: string, user: { userId: string; displayName?: string; props?: unknown }): Promise<void> {
    return this.users.createUser(ns, user);
  }

  getUser(ns: string, userId: string): Promise<{ userId: string; displayName?: string; props?: unknown } | null> {
    return this.users.getUser(ns, userId);
  }

  setCredential(ns: string, userId: string, cred: { type: "pin" | "password" | "none"; secretHash?: string }): Promise<void> {
    return this.users.setCredential(ns, userId, cred);
  }

  verifyCredential(ns: string, userId: string, proof: unknown): Promise<boolean> {
    return this.users.verifyCredential(ns, userId, proof);
  }

  addUserToGroup(ns: string, userId: string, groupId: string): Promise<void> {
    return this.users.addUserToGroup(ns, userId, groupId);
  }

  removeUserFromGroup(ns: string, userId: string, groupId: string): Promise<void> {
    return this.users.removeUserFromGroup(ns, userId, groupId);
  }

  defineCommand(ns: string, commandId: string, def: { title: string; description: string; maskBits?: Record<string, number>; scopeType?: string }): Promise<void> {
    return this.commands.defineCommand(ns, commandId, def);
  }

  grant(ns: string, subject: string, commandId: string, grant: { allow: boolean; mask?: number; scope?: unknown }): Promise<void> {
    return this.commands.grant(ns, subject, commandId, grant);
  }

  revoke(ns: string, subject: string, commandId: string): Promise<void> {
    return this.commands.revoke(ns, subject, commandId);
  }

  canInvoke(ns: string, ctx: { userId: string; groups?: string[]; scope?: unknown }, commandId: string, requestedMask?: number): Promise<boolean> {
    return this.commands.canInvoke(ns, ctx, commandId, requestedMask);
  }

  registerUnallocated(nodeInfo: NodeInfo): Promise<{ status: "unallocated" }> {
    return this.bootstrap.registerUnallocated(nodeInfo);
  }

  listUnallocated(ns: string): Promise<NodeInfo[]> {
    return this.bootstrap.listUnallocated(ns);
  }

  claimNode(ns: string, nodeId: string, proof: unknown): Promise<void> {
    return this.bootstrap.claimNode(ns, nodeId, proof);
  }

  addShard(clusterId: string, shard: ShardSpec): Promise<void> {
    return this.election.addShard(clusterId, shard);
  }

  removeShard(clusterId: string, shardId: string): Promise<void> {
    return this.election.removeShard(clusterId, shardId);
  }

  listShards(clusterId: string): Promise<ShardSpec[]> {
    return this.election.listShards(clusterId);
  }

  getLeader(clusterId: string, shardId: string): Promise<{ clusterId: string; shardId: string; leaderNodeId: string; term: number; leaseUntilMs: number } | null> {
    return this.election.getLeader(clusterId, shardId);
  }

  listLeaders(clusterId: string): Promise<Array<{ clusterId: string; shardId: string; leaderNodeId: string; term: number; leaseUntilMs: number }>> {
    return this.election.listLeaders(clusterId);
  }

  onLeaderChange(cb: (ev: { clusterId: string; shardId: string; from?: string; to: string }) => void): () => void {
    return this.election.onLeaderChange(cb);
  }

  forceLeader(clusterId: string, shardId: string, nodeId: string, ttlMs?: number): Promise<void> {
    return this.election.forceLeader(clusterId, shardId, nodeId, ttlMs);
  }

  tick(clusterId?: string): Promise<void> {
    return this.election.tick(clusterId);
  }

  async get_leader(shard_id = "default"): Promise<string | null> {
    if (!this.defaultClusterId) {
      return null;
    }
    return (await this.election.getLeader(this.defaultClusterId, shard_id))?.leaderNodeId ?? null;
  }

  async get_cluster_status(clusterId = this.defaultClusterId ?? "unallocated"): Promise<ClusterStatus> {
    const leader = clusterId === "unallocated" ? null : await this.election.getLeader(clusterId, "default");
    const nodes = clusterId === "unallocated" ? [] : await this.cluster.listNodes(clusterId);
    const alive = new Map((clusterId === "unallocated" ? [] : await this.cluster.getAliveNodes(clusterId)).map((item) => [item.nodeId, item.lastSeenMs]));
    const nodeHealth: ClusterNodeHealth[] = nodes.map((node) => {
      const started = alive.has(node.nodeId) || Boolean(this.registry.getNode(node.nodeId)?.started);
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

  set_reachability(targetNodeId: string, reachable: boolean): void {
    this.registry.setReachability(this.self().nodeId, targetNodeId, reachable);
  }

  async replicate_tick(): Promise<void> {
    await this.cluster.tickHeartbeats();
    await this.election.tick(this.defaultClusterId);
    if (this.defaultClusterId && this.steng) {
      const leaderId = await this.get_leader("default");
      if (leaderId === this.self().nodeId) {
        await this.replicateStengCluster(this.defaultClusterId);
      }
    }
  }

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

  private registerBuiltins(): void {
    this.foundation.registerHandler("cord.foundation.ping", async () => ({ ok: true }));
    this.foundation.registerHandler("cord.foundation.whoami", async () => this.self());
    this.foundation.registerHandler("cord.foundation.echo", async (_ctx, params) => {
      const payload = params as {
        args?: unknown[];
        named?: Record<string, unknown>;
        payload?: { kind: "bytes" | "json"; name: string; bytes?: string; json?: unknown };
      };
      if (payload.payload?.kind === "bytes" && payload.payload.bytes) {
        const bytes = new Uint8Array(Buffer.from(payload.payload.bytes, "base64"));
        return {
          ok: true,
          kind: "bytes",
          name: payload.payload.name,
          bytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
          preview: previewBytes(bytes),
        };
      }
      if (payload.payload?.kind === "json") {
        return {
          ok: true,
          kind: "json",
          name: payload.payload.name,
          json: payload.payload.json,
        };
      }
      const args = payload.args ?? [];
      return {
        ok: true,
        args,
        named: payload.named ?? {},
        text: args.map((item) => String(item)).join(" "),
      };
    });
    this.foundation.registerHandler("cord.foundation.sleep", async (_ctx, params) => {
      const ms = Number((params as { ms?: number }).ms ?? 0);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
      return { sleptMs: ms };
    });
    this.foundation.registerHandler("cord.cluster.heartbeat", async (_ctx, params) => {
      const payload = params as { clusterId: string; nodeId: string; tsMs?: number };
      this.cluster.handleHeartbeat(payload.clusterId, payload.nodeId, payload.tsMs ?? Date.now());
      return { ok: true };
    });
    this.foundation.registerHandler("cord.cluster.create", async (_ctx, params) => this.cluster.createCluster(params as ClusterSpec));
    this.foundation.registerHandler("cord.cluster.join", async (_ctx, params) => this.cluster.joinCluster(params as ClusterNodeConfig));
    this.foundation.registerHandler("cord.cluster.leave", async (_ctx, params) => this.cluster.leaveCluster((params as { clusterId: string }).clusterId));
    this.foundation.registerHandler("cord.cluster.listNodes", async (_ctx, params) => this.cluster.listNodes((params as { clusterId: string }).clusterId));
    this.foundation.registerHandler("cord.cluster.execOnCluster", async (_ctx, params) => {
      const payload = params as {
        clusterId: string;
        method: string;
        params: unknown;
        opts?: { parallel?: number; timeoutMs?: number; bestEffort?: boolean; auth?: RpcAuth };
      };
      return this.cluster.execOnCluster(payload.clusterId, payload.method, payload.params, payload.opts);
    });
    this.foundation.registerHandler("cord.bootstrap.register_unallocated", async (_ctx, params) => this.bootstrap.registerUnallocated(params as NodeInfo));
    this.foundation.registerHandler("cord.bootstrap.list_unallocated", async (_ctx, params) => this.bootstrap.listUnallocated((params as { ns?: string }).ns ?? this.namespace));
    this.foundation.registerHandler("cord.election.addShard", async (_ctx, params) => {
      const payload = params as { clusterId: string; shard: ShardSpec };
      await this.election.addShard(payload.clusterId, payload.shard);
      return { ok: true };
    });
    this.foundation.registerHandler("cord.election.getLeader", async (_ctx, params) => {
      const payload = params as { clusterId: string; shardId: string };
      return this.election.getLeader(payload.clusterId, payload.shardId);
    });
    this.foundation.registerHandler("cord.election.RequestLease", async (_ctx, params) =>
      this.election.handleRequestLease(params as { clusterId: string; shardId: string; term: number; ttlMs: number; leaderNodeId: string }),
    );
    this.foundation.registerHandler("cord.election.RenewLease", async (_ctx, params) =>
      this.election.handleRenewLease(params as { clusterId: string; shardId: string; term: number; ttlMs: number; leaderNodeId: string }),
    );
    this.foundation.registerHandler("cord.election.ReleaseLease", async (_ctx, params) =>
      this.election.handleReleaseLease(params as { clusterId: string; shardId: string; term: number; leaderNodeId: string }),
    );
    this.foundation.registerHandler("cord.iam.defineCommand", async (_ctx, params) => {
      const payload = params as { ns?: string; commandId: string; def: CommandDefinition };
      await this.commands.defineCommand(payload.ns ?? this.namespace, payload.commandId, payload.def);
      return { ok: true };
    });
    this.foundation.registerHandler("cord.iam.grant", async (_ctx, params) => {
      const payload = params as { ns?: string; subject: string; commandId: string; grant: { allow: boolean; mask?: number; scope?: unknown } };
      await this.commands.grant(payload.ns ?? this.namespace, payload.subject, payload.commandId, payload.grant);
      return { ok: true };
    });
    this.foundation.registerHandler("cord.iam.canInvoke", async (_ctx, params) => {
      const payload = params as { ns?: string; ctx: { userId: string; groups?: string[]; scope?: unknown }; commandId: string; requestedMask?: number };
      return this.commands.canInvoke(payload.ns ?? this.namespace, payload.ctx, payload.commandId, payload.requestedMask);
    });
    this.foundation.registerHandler("cord.users.ensureGuest", async (_ctx, params) =>
      this.users.ensureGuest((params as { ns?: string }).ns ?? this.namespace),
    );
  }

  private async ensureDefaults(): Promise<void> {
    await this.users.ensureGuest(this.namespace);
    await this.groups.createGroup(this.namespace, "internal", { system: true });
    const commandTitles: Array<[string, string]> = [
      ["cord.foundation.ping", "Ping a node"],
      ["cord.foundation.whoami", "Return node identity"],
      ["cord.foundation.exec", "Execute a command on this node or a routed destination"],
      ["cord.foundation.route", "Inspect or edit local routing policy"],
      ["cord.foundation.proxy", "Configure proxy mode"],
      ["cord.foundation.echo", "Echo args or payload"],
      ["cord.foundation.sleep", "Sleep for a period"],
      ["cord.cluster.heartbeat", "Record cluster heartbeat"],
      ["cord.cluster.create", "Create a cluster"],
      ["cord.cluster.join", "Join a cluster"],
      ["cord.cluster.leave", "Leave a cluster"],
      ["cord.cluster.listNodes", "List cluster nodes"],
      ["cord.cluster.execOnCluster", "Execute a command across a cluster"],
      ["cord.iam.defineCommand", "Define a command"],
      ["cord.iam.grant", "Grant command access"],
      ["cord.iam.canInvoke", "Check command access"],
      ["cord.users.ensureGuest", "Ensure guest user exists"],
      ["cord.bootstrap.register_unallocated", "Register an unallocated node"],
      ["cord.bootstrap.list_unallocated", "List unallocated nodes"],
      ["cord.election.addShard", "Add a shard"],
      ["cord.election.getLeader", "Read shard leader"],
      ["cord.election.RequestLease", "Internal lease request"],
      ["cord.election.RenewLease", "Internal lease renew"],
      ["cord.election.ReleaseLease", "Internal lease release"],
    ];
    for (const [commandId, title] of commandTitles) {
      await this.commands.defineCommand(this.namespace, commandId, describeCommand(commandId, title));
    }
    for (const cheap of [
      "cord.foundation.ping",
      "cord.foundation.whoami",
      "cord.cluster.heartbeat",
      "cord.bootstrap.register_unallocated",
    ]) {
      await this.commands.grant(this.namespace, "grp:guest", cheap, { allow: true });
    }
  }

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
          (await peerNode.steng.get_table_info(leaderTable.app, leaderTable.db, leaderTable.tableName)) ??
          (await peerNode.steng.ensure_table(leaderTable.app, leaderTable.db, leaderTable.tableName, leaderTable.type));

        await peerNode.steng.set_table_config(replicaTable.tableId, leaderTable.config);
        for (const [field, config] of Object.entries(leaderTable.config.indexes)) {
          await peerNode.steng.add_index(replicaTable.tableId, field, config.type, config.multi);
        }

        const afterSeq = await peerNode.steng.latest_seq(replicaTable.tableId);
        const ops = await this.steng.read_ops_since(leaderTable.tableId, afterSeq, 10_000);
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
