import { CordRegistry } from './registry.js';
import { CordFoundation } from './foundation.js';
import type {
  ClusterManager,
  ClusterNodeConfig,
  ClusterSpec,
  NodeInfo,
  RpcAuth,
} from './types.js';
import type { CoordStore } from './types.js';

/** Runtime options for the cluster manager background heartbeat logic. */
type ClusterOptions = {
  heartbeatMs: number;
  namespace: string;
};

/** Durable key for one cluster spec record. */
function clusterKey(clusterId: string): string {
  return `clusters/spec/${clusterId}`;
}

/** Durable key for one cluster membership record. */
function memberKey(clusterId: string, nodeId: string): string {
  return `clusters/members/${clusterId}/${nodeId}`;
}

/**
 * Normalizes cluster spec.
 * @param clusterId Cluster identifier.
 * @param value Value to process.
 */
function normalizeClusterSpec(clusterId: string, value: unknown): ClusterSpec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      clusterId,
      name: typeof record.name === 'string' ? record.name : undefined,
      props: record.props,
    };
  }
  return { clusterId };
}

/**
 * Normalizes node configuration.
 * @param clusterId Cluster identifier.
 * @param nodeId Node identifier.
 * @param value Value to process.
 */
function normalizeNodeConfig(
  clusterId: string,
  nodeId: string,
  value: unknown,
): ClusterNodeConfig {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const role =
      typeof record.role === 'object' && record.role !== null
        ? (record.role as ClusterNodeConfig['role'])
        : {};
    return {
      clusterId,
      nodeId,
      role,
      props: record.props,
    };
  }
  return {
    clusterId,
    nodeId,
    role: {},
  };
}

/**
 * Returns the default role.
 * @param role Role.
 */
function defaultRole(
  role: ClusterNodeConfig['role'],
): ClusterNodeConfig['role'] {
  return {
    proxyOnly: Boolean(role.proxyOnly),
    canSend: role.canSend ?? true,
    canReceive: role.canReceive ?? true,
    eligibleLeader: role.eligibleLeader ?? true,
    extra: role.extra,
  };
}

/**
 * Runs pool.
 * @param limit Maximum number of rows.
 * @param jobs Jobs.
 */
async function runPool<T>(
  limit: number,
  jobs: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = [];
  const pending = [...jobs];
  const workers = new Array(Math.max(1, limit)).fill(null).map(async () => {
    while (pending.length > 0) {
      const job = pending.shift();
      if (!job) {
        return;
      }
      results.push(await job());
    }
  });
  await Promise.all(workers);
  return results;
}

/** Read leader-priority hints from a membership record. */
export function priorityFromConfig(config: ClusterNodeConfig): number {
  if (
    typeof config.props === 'object' &&
    config.props !== null &&
    !Array.isArray(config.props)
  ) {
    const priority = (config.props as Record<string, unknown>).priority;
    if (typeof priority === 'number') {
      return priority;
    }
  }
  return 1;
}

/** Read lease duration hints from a membership record. */
export function leaseMsFromConfig(
  config: ClusterNodeConfig,
  fallback: number,
): number {
  if (
    typeof config.props === 'object' &&
    config.props !== null &&
    !Array.isArray(config.props)
  ) {
    const leaseMs = (config.props as Record<string, unknown>).leaseMs;
    if (typeof leaseMs === 'number') {
      return leaseMs;
    }
  }
  return fallback;
}

/** Cluster membership and cluster-wide fan-out executor built on the foundation transport. */
export class CordClusterManager implements ClusterManager {
  private readonly alive = new Map<string, Map<string, number>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: CoordStore,
    private readonly registry: CordRegistry,
    private readonly foundation: CordFoundation,
    private readonly options: ClusterOptions,
  ) {}

  /** Start periodic cluster heartbeat publishing. */
  async start(): Promise<void> {
    if (this.heartbeatTimer) {
      return;
    }
    await this.tickHeartbeats();
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeats();
    }, this.options.heartbeatMs);
  }

  /** Stop periodic cluster heartbeat publishing. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Create or replace one cluster spec. */
  async createCluster(spec: ClusterSpec): Promise<void> {
    await this.store.set(clusterKey(spec.clusterId), spec);
  }

  /** Delete one cluster and all of its membership records. */
  async dropCluster(clusterId: string): Promise<void> {
    await this.store.del(clusterKey(clusterId));
    for (const item of await this.store.list(
      `clusters/members/${clusterId}/`,
    )) {
      await this.store.del(item.key);
    }
    this.alive.delete(clusterId);
  }

  /** List every cluster known to the durable store. */
  async listClusters(): Promise<ClusterSpec[]> {
    const items = await this.store.list('clusters/spec/');
    return items
      .map(({ key, value }) =>
        normalizeClusterSpec(key.slice('clusters/spec/'.length), value),
      )
      .sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  }

  /** Join a node to one cluster, creating the cluster spec if missing. */
  async joinCluster(cfg: ClusterNodeConfig): Promise<void> {
    const existing = (await this.store.get(
      clusterKey(cfg.clusterId),
    )) as ClusterSpec | null;
    if (!existing) {
      await this.createCluster({ clusterId: cfg.clusterId });
    }
    const normalized: ClusterNodeConfig = {
      clusterId: cfg.clusterId,
      nodeId: cfg.nodeId,
      role: defaultRole(cfg.role),
      props: cfg.props,
    };
    await this.store.set(memberKey(cfg.clusterId, cfg.nodeId), normalized);
    this.noteAlive(cfg.clusterId, cfg.nodeId, Date.now());
    if (cfg.nodeId === this.foundation.self().nodeId) {
      await this.tickHeartbeats();
    }
  }

  /** Remove the local node from one cluster. */
  async leaveCluster(clusterId: string): Promise<void> {
    const nodeId = this.foundation.self().nodeId;
    await this.store.del(memberKey(clusterId, nodeId));
    this.alive.get(clusterId)?.delete(nodeId);
  }

  /** List all membership records for one cluster. */
  async listNodes(clusterId: string): Promise<ClusterNodeConfig[]> {
    const items = await this.store.list(`clusters/members/${clusterId}/`);
    return items
      .map(({ key, value }) =>
        normalizeNodeConfig(
          clusterId,
          key.slice(`clusters/members/${clusterId}/`.length),
          value,
        ),
      )
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  /** Read one membership record by cluster id and node id. */
  async getNode(
    clusterId: string,
    nodeId: string,
  ): Promise<ClusterNodeConfig | null> {
    const value = await this.store.get(memberKey(clusterId, nodeId));
    return value ? normalizeNodeConfig(clusterId, nodeId, value) : null;
  }

  /** List members that currently appear alive from registry/discovery state. */
  async getAliveNodes(
    clusterId: string,
  ): Promise<Array<{ nodeId: string; lastSeenMs: number }>> {
    const members = await this.listNodes(clusterId);
    const now = Date.now();
    const cutoff = now - this.options.heartbeatMs * 3;
    const clusterAlive = this.alive.get(clusterId) ?? new Map<string, number>();
    const selfNodeId = this.foundation.self().nodeId;
    const discovered = new Set(
      (await this.foundation.discover()).map((node) => node.nodeId),
    );

    return members
      .map((member) => {
        const localRuntime = this.registry.getNode(member.nodeId);
        const isDiscoverable =
          (member.nodeId === selfNodeId && this.foundation.isStarted()) ||
          Boolean(localRuntime?.started) ||
          discovered.has(member.nodeId);
        const lastSeenMs = isDiscoverable
          ? Math.max(clusterAlive.get(member.nodeId) ?? 0, now)
          : 0;
        return { nodeId: member.nodeId, lastSeenMs };
      })
      .filter((item) => item.lastSeenMs >= cutoff)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  /** Execute one RPC method on all members of a cluster. */
  async execOnCluster(
    clusterId: string,
    method: string,
    params: unknown,
    opts: {
      parallel?: number;
      timeoutMs?: number;
      bestEffort?: boolean;
      auth?: RpcAuth;
    } = {},
  ): Promise<
    Array<{ nodeId: string; ok: boolean; result?: unknown; err?: string }>
  > {
    const nodes = await this.listNodes(clusterId);
    const jobs = nodes.map((node) => async () => {
      try {
        const result = await this.foundation.call(
          { nodeId: node.nodeId },
          method,
          params,
          {
            timeoutMs: opts.timeoutMs,
            auth: opts.auth,
          },
        );
        return { nodeId: node.nodeId, ok: true, result };
      } catch (error) {
        if (!opts.bestEffort) {
          throw error;
        }
        return {
          nodeId: node.nodeId,
          ok: false,
          err: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return runPool((opts.parallel ?? nodes.length) || 1, jobs);
  }

  /** Discover visible nodes that are not yet members of the specified cluster. */
  async discoverAndSuggest(clusterId: string): Promise<NodeInfo[]> {
    const known = new Set(
      (await this.listNodes(clusterId)).map((node) => node.nodeId),
    );
    const discovered = await this.foundation.discover();
    return discovered.filter((node) => !known.has(node.nodeId));
  }

  /** Record a heartbeat timestamp for one member. */
  handleHeartbeat(clusterId: string, nodeId: string, tsMs = Date.now()): void {
    this.noteAlive(clusterId, nodeId, tsMs);
  }

  /** List all cluster memberships for the local node. */
  listLocalClusters(): Promise<ClusterNodeConfig[]> {
    return this.listNodesFor(this.foundation.self().nodeId);
  }

  /** Publish the local node heartbeat into every cluster it currently belongs to. */
  async tickHeartbeats(): Promise<void> {
    const selfNodeId = this.foundation.self().nodeId;
    const memberships = await this.listNodesFor(selfNodeId);
    const auth = this.foundation.makeInternalAuth();
    for (const membership of memberships) {
      this.noteAlive(membership.clusterId, selfNodeId, Date.now());
      const members = await this.listNodes(membership.clusterId);
      for (const peer of members) {
        if (
          peer.nodeId === selfNodeId ||
          peer.role.canReceive === false ||
          membership.role.canSend === false
        ) {
          continue;
        }
        try {
          await this.foundation.call(
            { nodeId: peer.nodeId },
            'cord.cluster.heartbeat',
            {
              clusterId: membership.clusterId,
              nodeId: selfNodeId,
              tsMs: Date.now(),
            },
            { timeoutMs: this.options.heartbeatMs, auth },
          );
        } catch {
          // Liveness is advisory; failed heartbeats are expected during outages.
        }
      }
    }
  }

  /**
   * Handles note alive.
   * @param clusterId Cluster identifier.
   * @param nodeId Node identifier.
   * @param tsMs Timestamp in milliseconds.
   */
  private noteAlive(clusterId: string, nodeId: string, tsMs: number): void {
    const clusterAlive = this.alive.get(clusterId) ?? new Map<string, number>();
    clusterAlive.set(nodeId, Math.max(clusterAlive.get(nodeId) ?? 0, tsMs));
    this.alive.set(clusterId, clusterAlive);
  }

  /**
   * Lists nodes for.
   * @param nodeId Node identifier.
   */
  private async listNodesFor(nodeId: string): Promise<ClusterNodeConfig[]> {
    const items = await this.store.list('clusters/members/');
    return items
      .map(({ key, value }) => {
        const parts = key.split('/');
        const clusterId = parts[2] ?? '';
        const currentNodeId = parts[3] ?? '';
        return normalizeNodeConfig(clusterId, currentNodeId, value);
      })
      .filter((item) => item.nodeId === nodeId)
      .sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  }
}
