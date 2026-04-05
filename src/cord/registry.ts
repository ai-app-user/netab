import { MemoryStore } from "./store.js";
import type { CoordStore, NodeInfo, RpcCtx } from "./types.js";

type RuntimeNode = {
  nodeId: string;
  addrList: string[];
  started: boolean;
  info(): NodeInfo;
  dispatch(method: string, ctx: RpcCtx, params: unknown): Promise<unknown>;
};

export class CordRegistry {
  readonly sharedStore: CoordStore;
  private readonly nodes = new Map<string, RuntimeNode>();
  private readonly addresses = new Map<string, string>();
  private readonly reachability = new Map<string, Map<string, boolean>>();
  private readonly owners = new Map<string, unknown>();

  constructor(store: CoordStore = new MemoryStore()) {
    this.sharedStore = store;
  }

  register(node: RuntimeNode): void {
    this.nodes.set(node.nodeId, node);
    for (const addr of node.addrList) {
      this.addresses.set(addr, node.nodeId);
    }
    const peerMap = this.reachability.get(node.nodeId) ?? new Map<string, boolean>();
    for (const peerId of this.nodes.keys()) {
      peerMap.set(peerId, peerMap.get(peerId) ?? true);
      if (!this.reachability.has(peerId)) {
        this.reachability.set(peerId, new Map<string, boolean>());
      }
      this.reachability.get(peerId)!.set(node.nodeId, this.reachability.get(peerId)!.get(node.nodeId) ?? true);
    }
    this.reachability.set(node.nodeId, peerMap);
  }

  unregister(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    this.nodes.delete(nodeId);
    for (const addr of node.addrList) {
      this.addresses.delete(addr);
    }
    this.reachability.delete(nodeId);
    for (const peerMap of this.reachability.values()) {
      peerMap.delete(nodeId);
    }
  }

  setReachability(fromNodeId: string, targetNodeId: string, reachable: boolean): void {
    const peerMap = this.reachability.get(fromNodeId) ?? new Map<string, boolean>();
    peerMap.set(targetNodeId, reachable);
    this.reachability.set(fromNodeId, peerMap);
  }

  canReach(fromNodeId: string, targetNodeId: string): boolean {
    return this.reachability.get(fromNodeId)?.get(targetNodeId) ?? true;
  }

  getNode(nodeId: string): RuntimeNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  setOwner(nodeId: string, owner: unknown): void {
    this.owners.set(nodeId, owner);
  }

  getOwner<T>(nodeId: string): T | null {
    return (this.owners.get(nodeId) as T | undefined) ?? null;
  }

  getNodeByAddr(addr: string): RuntimeNode | null {
    const nodeId = this.addresses.get(addr);
    return nodeId ? this.getNode(nodeId) : null;
  }

  listStarted(): RuntimeNode[] {
    return [...this.nodes.values()].filter((node) => node.started).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
}
