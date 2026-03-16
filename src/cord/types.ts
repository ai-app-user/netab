import type { StengApi } from "../steng/index.js";

export type NodeId = string;

export type CordNodeOptions = {
  clusterId: string;
  nodeId: NodeId;
  eligible?: boolean;
  priority?: number;
  leaseMs?: number;
  steng: StengApi;
};

export type ClusterNodeHealth = {
  nodeId: string;
  eligible: boolean;
  priority: number;
  started: boolean;
  reachablePeers: string[];
};

export type ClusterStatus = {
  clusterId: string;
  leaderId: string | null;
  leaseUntilMs: number;
  nodes: ClusterNodeHealth[];
};

export interface CordNodeHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  get_leader(shard_id?: string): string | null;
  get_cluster_status(): ClusterStatus;
  set_reachability(targetNodeId: string, reachable: boolean): void;
  replicate_tick(): Promise<void>;
}
