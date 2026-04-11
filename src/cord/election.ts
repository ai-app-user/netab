import { CordFoundation } from './foundation.js';
import {
  CordClusterManager,
  leaseMsFromConfig,
  priorityFromConfig,
} from './cluster.js';
import { CordRegistry } from './registry.js';
import type {
  ClusterNodeConfig,
  ClusterSpec,
  ElectionManager,
  LeaderAssignment,
  LeaderChangeEvent,
  ShardSpec,
} from './types.js';
import type { CoordStore } from './types.js';

/** One in-memory lease vote retained by a follower node. */
type LeaseVote = {
  leaderNodeId: string;
  term: number;
  leaseUntilMs: number;
};

/** Runtime tuning knobs for the election manager. */
type ElectionOptions = {
  leaseMs: number;
  electionIntervalMs: number;
  defaultClusterId?: string;
};

/** Durable key for one shard definition. */
function shardKey(clusterId: string, shardId: string): string {
  return `election/shards/${clusterId}/${shardId}`;
}

/** Durable key for one current leader assignment. */
function assignmentKey(clusterId: string, shardId: string): string {
  return `election/assignments/${clusterId}/${shardId}`;
}

/**
 * Normalizes shard.
 * @param shardId Shard id.
 * @param value Value to process.
 */
function normalizeShard(shardId: string, value: unknown): ShardSpec {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      shardId,
      weight: typeof record.weight === 'number' ? record.weight : undefined,
      props: record.props,
    };
  }
  return { shardId };
}

/**
 * Normalizes assignment.
 * @param clusterId Cluster identifier.
 * @param shardId Shard id.
 * @param value Value to process.
 */
function normalizeAssignment(
  clusterId: string,
  shardId: string,
  value: unknown,
): LeaderAssignment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.leaderNodeId !== 'string' ||
    typeof record.term !== 'number' ||
    typeof record.leaseUntilMs !== 'number'
  ) {
    return null;
  }
  return {
    clusterId,
    shardId,
    leaderNodeId: record.leaderNodeId,
    term: record.term,
    leaseUntilMs: record.leaseUntilMs,
  };
}

/**
 * Handles cluster lease mode.
 * @param spec Spec.
 */
function clusterLeaseMode(spec: ClusterSpec | null): 'quorum' | 'all' {
  if (
    typeof spec?.props === 'object' &&
    spec.props !== null &&
    !Array.isArray(spec.props)
  ) {
    const value = (spec.props as Record<string, unknown>).leaseMode;
    if (value === 'all') {
      return 'all';
    }
  }
  return 'quorum';
}

/**
 * Handles shard weight.
 * @param shard Shard.
 */
function shardWeight(shard: ShardSpec): number {
  return shard.weight ?? 1;
}

/**
 * Handles lease vote key.
 * @param clusterId Cluster identifier.
 * @param shardId Shard id.
 */
function leaseVoteKey(clusterId: string, shardId: string): string {
  return `${clusterId}::${shardId}`;
}

/** Lease-based leader election manager built on cluster membership and foundation RPC. */
export class CordElectionManager implements ElectionManager {
  private readonly callbacks = new Set<(ev: LeaderChangeEvent) => void>();
  private readonly leaseVotes = new Map<string, LeaseVote>();
  private electionTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: CoordStore,
    private readonly cluster: CordClusterManager,
    private readonly foundation: CordFoundation,
    private readonly registry: CordRegistry,
    private readonly options: ElectionOptions,
  ) {}

  /** Start periodic lease reconciliation. */
  async start(): Promise<void> {
    if (this.electionTimer) {
      return;
    }
    await this.tick(this.options.defaultClusterId);
    this.electionTimer = setInterval(() => {
      void this.tick(this.options.defaultClusterId);
    }, this.options.electionIntervalMs);
  }

  /** Stop periodic lease reconciliation. */
  async stop(): Promise<void> {
    if (this.electionTimer) {
      clearInterval(this.electionTimer);
      this.electionTimer = null;
    }
  }

  /** Add a shard definition and immediately reconcile leadership. */
  async addShard(clusterId: string, shard: ShardSpec): Promise<void> {
    await this.store.set(shardKey(clusterId, shard.shardId), shard);
    await this.tick(clusterId);
  }

  /** Remove a shard definition and its current assignment. */
  async removeShard(clusterId: string, shardId: string): Promise<void> {
    await this.store.del(shardKey(clusterId, shardId));
    const previous = await this.readAssignment(clusterId, shardId);
    await this.store.del(assignmentKey(clusterId, shardId));
    if (previous?.leaderNodeId) {
      this.emitLeaderChange({
        clusterId,
        shardId,
        from: previous.leaderNodeId,
        to: '',
      });
    }
  }

  /** List shard definitions for one cluster. */
  async listShards(clusterId: string): Promise<ShardSpec[]> {
    const items = await this.store.list(`election/shards/${clusterId}/`);
    return items
      .map(({ key, value }) =>
        normalizeShard(
          key.slice(`election/shards/${clusterId}/`.length),
          value,
        ),
      )
      .sort((left, right) => left.shardId.localeCompare(right.shardId));
  }

  /** Return the healthy leader assignment for one shard, if any. */
  async getLeader(
    clusterId: string,
    shardId: string,
  ): Promise<LeaderAssignment | null> {
    await this.tick(clusterId);
    const assignment = await this.readAssignment(clusterId, shardId);
    if (!assignment) {
      return null;
    }
    return (await this.isHealthyAssignment(clusterId, assignment))
      ? assignment
      : null;
  }

  /** List every currently healthy leader assignment in one cluster. */
  async listLeaders(clusterId: string): Promise<LeaderAssignment[]> {
    await this.tick(clusterId);
    const shards = await this.listShards(clusterId);
    const results: LeaderAssignment[] = [];
    for (const shard of shards) {
      const assignment = await this.readAssignment(clusterId, shard.shardId);
      if (
        assignment &&
        (await this.isHealthyAssignment(clusterId, assignment))
      ) {
        results.push(assignment);
      }
    }
    return results.sort((left, right) =>
      left.shardId.localeCompare(right.shardId),
    );
  }

  /** Subscribe to future leader-change events. */
  onLeaderChange(cb: (ev: LeaderChangeEvent) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  /** Force one node to become leader for a shard for the provided TTL. */
  async forceLeader(
    clusterId: string,
    shardId: string,
    nodeId: string,
    ttlMs = this.options.leaseMs,
  ): Promise<void> {
    const current = await this.readAssignment(clusterId, shardId);
    const assignment: LeaderAssignment = {
      clusterId,
      shardId,
      leaderNodeId: nodeId,
      term: (current?.term ?? 0) + 1,
      leaseUntilMs: Date.now() + ttlMs,
    };
    await this.writeAssignment(assignment);
    if (current?.leaderNodeId !== nodeId) {
      this.emitLeaderChange({
        clusterId,
        shardId,
        from: current?.leaderNodeId,
        to: nodeId,
      });
    }
  }

  /** Reconcile one cluster or all local clusters immediately. */
  async tick(clusterId?: string): Promise<void> {
    const targetClusters = clusterId ? [clusterId] : await this.localClusters();
    for (const currentClusterId of targetClusters) {
      await this.reconcileCluster(currentClusterId);
    }
  }

  /** RPC handler used by followers to grant a fresh leader lease vote. */
  async handleRequestLease(params: {
    clusterId: string;
    shardId: string;
    term: number;
    ttlMs: number;
    leaderNodeId: string;
  }): Promise<{ ok: boolean; leaseUntilMs: number }> {
    const member = await this.cluster.getNode(
      params.clusterId,
      params.leaderNodeId,
    );
    if (!member || member.role.eligibleLeader === false) {
      return { ok: false, leaseUntilMs: 0 };
    }
    const selfNodeId = this.foundation.self().nodeId;
    if (!this.registry.canReach(selfNodeId, params.leaderNodeId)) {
      return { ok: false, leaseUntilMs: 0 };
    }
    const now = Date.now();
    const key = leaseVoteKey(params.clusterId, params.shardId);
    const current = this.leaseVotes.get(key);
    if (current && current.leaseUntilMs > now) {
      if (current.term > params.term) {
        return { ok: false, leaseUntilMs: current.leaseUntilMs };
      }
      if (
        current.term === params.term &&
        current.leaderNodeId !== params.leaderNodeId
      ) {
        return { ok: false, leaseUntilMs: current.leaseUntilMs };
      }
    }
    const leaseUntilMs = now + params.ttlMs;
    this.leaseVotes.set(key, {
      leaderNodeId: params.leaderNodeId,
      term: params.term,
      leaseUntilMs,
    });
    return { ok: true, leaseUntilMs };
  }

  /** RPC handler used by followers to renew an existing leader lease vote. */
  async handleRenewLease(params: {
    clusterId: string;
    shardId: string;
    term: number;
    ttlMs: number;
    leaderNodeId: string;
  }): Promise<{ ok: boolean; leaseUntilMs: number }> {
    const key = leaseVoteKey(params.clusterId, params.shardId);
    const current = this.leaseVotes.get(key);
    if (
      !current ||
      current.leaderNodeId !== params.leaderNodeId ||
      current.term !== params.term
    ) {
      return { ok: false, leaseUntilMs: current?.leaseUntilMs ?? 0 };
    }
    const leaseUntilMs = Date.now() + params.ttlMs;
    this.leaseVotes.set(key, { ...current, leaseUntilMs });
    return { ok: true, leaseUntilMs };
  }

  /** RPC handler used by leaders to release a follower lease vote. */
  async handleReleaseLease(params: {
    clusterId: string;
    shardId: string;
    term: number;
    leaderNodeId: string;
  }): Promise<{ ok: boolean }> {
    const key = leaseVoteKey(params.clusterId, params.shardId);
    const current = this.leaseVotes.get(key);
    if (
      current &&
      current.leaderNodeId === params.leaderNodeId &&
      current.term === params.term
    ) {
      this.leaseVotes.delete(key);
    }
    return { ok: true };
  }

  /**
   * Handles reconcile cluster.
   * @param clusterId Cluster identifier.
   */
  private async reconcileCluster(clusterId: string): Promise<void> {
    const shards = await this.listShards(clusterId);
    if (shards.length === 0) {
      return;
    }
    const nodes = await this.cluster.listNodes(clusterId);
    const aliveNodes = await this.cluster.getAliveNodes(clusterId);
    const aliveSet = new Set(aliveNodes.map((item) => item.nodeId));
    const eligible = nodes.filter(
      (node) =>
        aliveSet.has(node.nodeId) &&
        node.role.eligibleLeader !== false &&
        node.role.canReceive !== false,
    );
    if (eligible.length === 0) {
      return;
    }

    const loads = new Map<string, number>(
      eligible.map((node) => [node.nodeId, 0]),
    );
    const retained = new Map<string, LeaderAssignment>();
    for (const shard of shards) {
      const current = await this.readAssignment(clusterId, shard.shardId);
      if (current && (await this.isHealthyAssignment(clusterId, current))) {
        retained.set(shard.shardId, current);
        loads.set(
          current.leaderNodeId,
          (loads.get(current.leaderNodeId) ?? 0) + shardWeight(shard),
        );
      }
    }

    const sortedShards = [...shards].sort((left, right) => {
      if (shardWeight(right) !== shardWeight(left)) {
        return shardWeight(right) - shardWeight(left);
      }
      return left.shardId.localeCompare(right.shardId);
    });

    for (const shard of sortedShards) {
      const current = retained.get(shard.shardId);
      if (current) {
        await this.maybeRenew(clusterId, shard, current);
        continue;
      }
      const chosen = [...eligible].sort((left, right) => {
        const loadDiff =
          (loads.get(left.nodeId) ?? 0) - (loads.get(right.nodeId) ?? 0);
        if (loadDiff !== 0) {
          return loadDiff;
        }
        const priorityDiff =
          priorityFromConfig(right) - priorityFromConfig(left);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return left.nodeId.localeCompare(right.nodeId);
      })[0];
      if (!chosen) {
        continue;
      }
      const previous = await this.readAssignment(clusterId, shard.shardId);
      const term = (previous?.term ?? 0) + 1;
      const ttlMs = leaseMsFromConfig(chosen, this.options.leaseMs);
      const assignment = await this.acquireLease(
        clusterId,
        shard.shardId,
        chosen.nodeId,
        term,
        ttlMs,
      );
      if (assignment) {
        loads.set(
          chosen.nodeId,
          (loads.get(chosen.nodeId) ?? 0) + shardWeight(shard),
        );
        if (previous?.leaderNodeId !== assignment.leaderNodeId) {
          this.emitLeaderChange({
            clusterId,
            shardId: shard.shardId,
            from: previous?.leaderNodeId,
            to: assignment.leaderNodeId,
          });
        }
      }
    }
  }

  /**
   * Handles maybe renew.
   * @param clusterId Cluster identifier.
   * @param shard Shard.
   * @param current Current value.
   */
  private async maybeRenew(
    clusterId: string,
    shard: ShardSpec,
    current: LeaderAssignment,
  ): Promise<void> {
    const member = await this.cluster.getNode(clusterId, current.leaderNodeId);
    if (!member) {
      return;
    }
    const ttlMs = leaseMsFromConfig(member, this.options.leaseMs);
    if (current.leaseUntilMs - Date.now() > ttlMs / 2) {
      return;
    }
    const renewed = await this.renewLease(
      clusterId,
      shard.shardId,
      current.leaderNodeId,
      current.term,
      ttlMs,
    );
    if (renewed) {
      await this.writeAssignment(renewed);
    }
  }

  /**
   * Handles acquire lease.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   * @param leaderNodeId Leader node id.
   * @param term Term.
   * @param ttlMs TTL ms.
   */
  private async acquireLease(
    clusterId: string,
    shardId: string,
    leaderNodeId: string,
    term: number,
    ttlMs: number,
  ): Promise<LeaderAssignment | null> {
    const approvals = await this.requestVotes('cord.election.RequestLease', {
      clusterId,
      shardId,
      term,
      ttlMs,
      leaderNodeId,
    });
    if (approvals.length === 0) {
      return null;
    }
    const assignment: LeaderAssignment = {
      clusterId,
      shardId,
      leaderNodeId,
      term,
      leaseUntilMs: Math.min(...approvals),
    };
    await this.writeAssignment(assignment);
    return assignment;
  }

  /**
   * Handles renew lease.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   * @param leaderNodeId Leader node id.
   * @param term Term.
   * @param ttlMs TTL ms.
   */
  private async renewLease(
    clusterId: string,
    shardId: string,
    leaderNodeId: string,
    term: number,
    ttlMs: number,
  ): Promise<LeaderAssignment | null> {
    const approvals = await this.requestVotes('cord.election.RenewLease', {
      clusterId,
      shardId,
      term,
      ttlMs,
      leaderNodeId,
    });
    if (approvals.length === 0) {
      return null;
    }
    return {
      clusterId,
      shardId,
      leaderNodeId,
      term,
      leaseUntilMs: Math.min(...approvals),
    };
  }

  /**
   * Handles request votes.
   * @param method Method.
   * @param params SQL parameters.
   */
  private async requestVotes(
    method: string,
    params: {
      clusterId: string;
      shardId: string;
      term: number;
      ttlMs: number;
      leaderNodeId: string;
    },
  ): Promise<number[]> {
    const voters = await this.voters(params.clusterId, params.leaderNodeId);
    if (voters.length === 0) {
      return [];
    }
    const approvals: number[] = [];
    const required = await this.requiredVotes(params.clusterId, voters.length);
    const auth = this.foundation.makeInternalAuth();

    for (const voter of voters) {
      try {
        const response = await this.foundation.call<{
          ok: boolean;
          leaseUntilMs: number;
        }>({ nodeId: voter.nodeId }, method, params, {
          timeoutMs: this.options.leaseMs,
          auth,
        });
        if (response.ok) {
          approvals.push(response.leaseUntilMs);
        }
      } catch {
        // A missing vote is just a failed approval.
      }
    }

    return approvals.length >= required ? approvals : [];
  }

  /**
   * Handles voters.
   * @param clusterId Cluster identifier.
   * @param leaderNodeId Leader node id.
   */
  private async voters(
    clusterId: string,
    leaderNodeId: string,
  ): Promise<ClusterNodeConfig[]> {
    const nodes = await this.cluster.listNodes(clusterId);
    const aliveNodes = new Set(
      (await this.cluster.getAliveNodes(clusterId)).map((item) => item.nodeId),
    );
    return nodes.filter(
      (node) =>
        aliveNodes.has(node.nodeId) &&
        node.role.canReceive !== false &&
        this.registry.canReach(node.nodeId, leaderNodeId),
    );
  }

  /**
   * Handles required votes.
   * @param clusterId Cluster identifier.
   * @param voterCount Voter count.
   */
  private async requiredVotes(
    clusterId: string,
    voterCount: number,
  ): Promise<number> {
    const spec = await this.readClusterSpec(clusterId);
    return clusterLeaseMode(spec) === 'all'
      ? voterCount
      : Math.floor((voterCount * 2) / 3) + 1;
  }

  /**
   * Returns whether healthy assignment.
   * @param clusterId Cluster identifier.
   * @param assignment Assignment.
   */
  private async isHealthyAssignment(
    clusterId: string,
    assignment: LeaderAssignment,
  ): Promise<boolean> {
    if (assignment.leaseUntilMs <= Date.now()) {
      return false;
    }
    const member = await this.cluster.getNode(
      clusterId,
      assignment.leaderNodeId,
    );
    if (!member || member.role.eligibleLeader === false) {
      return false;
    }
    const alive = new Set(
      (await this.cluster.getAliveNodes(clusterId)).map((item) => item.nodeId),
    );
    if (!alive.has(assignment.leaderNodeId)) {
      return false;
    }
    const voters = await this.voters(clusterId, assignment.leaderNodeId);
    return (
      voters.length >= (await this.requiredVotes(clusterId, voters.length))
    );
  }

  /**
   * Handles local clusters.
   */
  private async localClusters(): Promise<string[]> {
    const memberships = await this.cluster.listLocalClusters();
    return [...new Set(memberships.map((item) => item.clusterId))].sort();
  }

  /**
   * Reads assignment.
   * @param clusterId Cluster identifier.
   * @param shardId Shard id.
   */
  private async readAssignment(
    clusterId: string,
    shardId: string,
  ): Promise<LeaderAssignment | null> {
    return normalizeAssignment(
      clusterId,
      shardId,
      await this.store.get(assignmentKey(clusterId, shardId)),
    );
  }

  /**
   * Writes assignment.
   * @param assignment Assignment.
   */
  private async writeAssignment(assignment: LeaderAssignment): Promise<void> {
    await this.store.set(
      assignmentKey(assignment.clusterId, assignment.shardId),
      assignment,
    );
  }

  /**
   * Reads cluster spec.
   * @param clusterId Cluster identifier.
   */
  private async readClusterSpec(
    clusterId: string,
  ): Promise<ClusterSpec | null> {
    const value = await this.store.get(`clusters/spec/${clusterId}`);
    return value ? (value as ClusterSpec) : null;
  }

  /**
   * Handles emit leader change.
   * @param event Event.
   */
  private emitLeaderChange(event: LeaderChangeEvent): void {
    for (const callback of this.callbacks) {
      callback(event);
    }
  }
}
