import type { ClusterStatus, CordNodeHandle, CordNodeOptions } from "./types.js";

type ClusterRecord = {
  leaderId: string | null;
  leaseUntilMs: number;
  nodes: Map<string, CordNode>;
  reachability: Map<string, Map<string, boolean>>;
};

export class CordRegistry {
  private readonly clusters = new Map<string, ClusterRecord>();

  register(node: CordNode): void {
    const record = this.ensureCluster(node.clusterId);
    record.nodes.set(node.nodeId, node);
    const nodeReachability = record.reachability.get(node.nodeId) ?? new Map<string, boolean>();
    for (const existingId of record.nodes.keys()) {
      nodeReachability.set(existingId, true);
      const existingMap = record.reachability.get(existingId) ?? new Map<string, boolean>();
      existingMap.set(node.nodeId, true);
      record.reachability.set(existingId, existingMap);
    }
    record.reachability.set(node.nodeId, nodeReachability);
  }

  unregister(node: CordNode): void {
    const record = this.clusters.get(node.clusterId);
    if (!record) {
      return;
    }

    record.nodes.delete(node.nodeId);
    record.reachability.delete(node.nodeId);
    for (const peerMap of record.reachability.values()) {
      peerMap.delete(node.nodeId);
    }

    if (record.leaderId === node.nodeId) {
      record.leaderId = null;
      record.leaseUntilMs = 0;
    }
  }

  setReachability(clusterId: string, fromNodeId: string, targetNodeId: string, reachable: boolean): void {
    const record = this.ensureCluster(clusterId);
    const peerMap = record.reachability.get(fromNodeId) ?? new Map<string, boolean>();
    peerMap.set(targetNodeId, reachable);
    record.reachability.set(fromNodeId, peerMap);
  }

  refreshLeader(clusterId: string, nowMs: number): string | null {
    const record = this.ensureCluster(clusterId);
    if (record.leaderId && record.leaseUntilMs > nowMs) {
      return record.leaderId;
    }

    const active = Array.from(record.nodes.values()).filter((node) => node.started);
    const candidates = active
      .filter((node) => node.eligible)
      .filter((candidate) =>
        active.every((peer) => peer.nodeId === candidate.nodeId || this.canReach(record, peer.nodeId, candidate.nodeId)),
      )
      .sort((left, right) => {
        if (right.priority !== left.priority) {
          return right.priority - left.priority;
        }
        return left.nodeId.localeCompare(right.nodeId);
      });

    const leader = candidates[0] ?? null;
    record.leaderId = leader?.nodeId ?? null;
    record.leaseUntilMs = leader ? nowMs + leader.leaseMs : 0;
    return record.leaderId;
  }

  renewLeader(clusterId: string, nodeId: string, leaseMs: number, nowMs: number): void {
    const record = this.ensureCluster(clusterId);
    if (record.leaderId !== nodeId) {
      throw new Error(`Node ${nodeId} is not the leader of ${clusterId}`);
    }
    record.leaseUntilMs = nowMs + leaseMs;
  }

  getLeader(clusterId: string, nowMs: number): string | null {
    return this.refreshLeader(clusterId, nowMs);
  }

  getStatus(clusterId: string, nowMs: number): ClusterStatus {
    const record = this.ensureCluster(clusterId);
    this.refreshLeader(clusterId, nowMs);
    return {
      clusterId,
      leaderId: record.leaderId,
      leaseUntilMs: record.leaseUntilMs,
      nodes: Array.from(record.nodes.values())
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map((node) => ({
          nodeId: node.nodeId,
          eligible: node.eligible,
          priority: node.priority,
          started: node.started,
          reachablePeers: Array.from(record.reachability.get(node.nodeId)?.entries() ?? [])
            .filter(([, reachable]) => reachable)
            .map(([peerId]) => peerId)
            .sort(),
        })),
    };
  }

  getNode(clusterId: string, nodeId: string): CordNode | null {
    return this.ensureCluster(clusterId).nodes.get(nodeId) ?? null;
  }

  private ensureCluster(clusterId: string): ClusterRecord {
    const existing = this.clusters.get(clusterId);
    if (existing) {
      return existing;
    }

    const record: ClusterRecord = {
      leaderId: null,
      leaseUntilMs: 0,
      nodes: new Map(),
      reachability: new Map(),
    };
    this.clusters.set(clusterId, record);
    return record;
  }

  private canReach(record: ClusterRecord, fromNodeId: string, targetNodeId: string): boolean {
    return record.reachability.get(fromNodeId)?.get(targetNodeId) ?? true;
  }
}

export class CordNode implements CordNodeHandle {
  readonly clusterId: string;
  readonly nodeId: string;
  readonly eligible: boolean;
  readonly priority: number;
  readonly leaseMs: number;
  readonly steng: CordNodeOptions["steng"];
  started = false;

  constructor(private readonly registry: CordRegistry, options: CordNodeOptions) {
    this.clusterId = options.clusterId;
    this.nodeId = options.nodeId;
    this.eligible = options.eligible ?? true;
    this.priority = options.priority ?? 1;
    this.leaseMs = options.leaseMs ?? 750;
    this.steng = options.steng;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.registry.register(this);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.registry.unregister(this);
  }

  get_leader(): string | null {
    return this.registry.getLeader(this.clusterId, Date.now());
  }

  get_cluster_status(): ClusterStatus {
    return this.registry.getStatus(this.clusterId, Date.now());
  }

  set_reachability(targetNodeId: string, reachable: boolean): void {
    this.registry.setReachability(this.clusterId, this.nodeId, targetNodeId, reachable);
  }

  async replicate_tick(): Promise<void> {
    const now = Date.now();
    const leaderId = this.registry.refreshLeader(this.clusterId, now);
    if (!leaderId) {
      return;
    }
    if (leaderId === this.nodeId) {
      this.registry.renewLeader(this.clusterId, this.nodeId, this.leaseMs, now);
      await this.replicateToReplicas();
    }
  }

  private async replicateToReplicas(): Promise<void> {
    const status = this.registry.getStatus(this.clusterId, Date.now());
    const peers = status.nodes.filter((node) => node.started && node.nodeId !== this.nodeId);
    const leaderTables = await this.steng.list_tables();

    for (const peer of peers) {
      const peerNode = this.registry.getNode(this.clusterId, peer.nodeId);
      if (!peerNode?.started) {
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
