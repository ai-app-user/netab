import { MemoryStore } from './store.js';
import type { CoordStore, NodeInfo, RpcCtx } from './types.js';

/** Runtime node contract stored inside the in-process registry simulation. */
type RuntimeNode = {
  nodeId: string;
  addrList: string[];
  started: boolean;
  /**
   * Handles info.
   */
  info(): NodeInfo;
  /**
   * Dispatches the request to the matching handler.
   * @param method Method.
   * @param ctx Execution context.
   * @param params SQL parameters.
   */
  dispatch(method: string, ctx: RpcCtx, params: unknown): Promise<unknown>;
};

/**
 * In-process registry used by tests and the Node playground to simulate node
 * discovery and reachability without a real UDP/mDNS transport.
 */
export class CordRegistry {
  readonly sharedStore: CoordStore;
  private readonly nodes = new Map<string, RuntimeNode>();
  private readonly addresses = new Map<string, string>();
  private readonly reachability = new Map<string, Map<string, boolean>>();
  private readonly owners = new Map<string, unknown>();

  /** Create the registry with an optional shared durable store. */
  constructor(store: CoordStore = new MemoryStore()) {
    this.sharedStore = store;
  }

  /** Register one runtime node and index all of its listen/advertise addresses. */
  register(node: RuntimeNode): void {
    this.nodes.set(node.nodeId, node);
    for (const addr of node.addrList) {
      this.addresses.set(addr, node.nodeId);
    }
    const peerMap =
      this.reachability.get(node.nodeId) ?? new Map<string, boolean>();
    for (const peerId of this.nodes.keys()) {
      peerMap.set(peerId, peerMap.get(peerId) ?? true);
      if (!this.reachability.has(peerId)) {
        this.reachability.set(peerId, new Map<string, boolean>());
      }
      this.reachability
        .get(peerId)!
        .set(
          node.nodeId,
          this.reachability.get(peerId)!.get(node.nodeId) ?? true,
        );
    }
    this.reachability.set(node.nodeId, peerMap);
  }

  /** Remove one runtime node and all address/reachability references to it. */
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

  /** Force one directional reachability value for test or simulation purposes. */
  setReachability(
    fromNodeId: string,
    targetNodeId: string,
    reachable: boolean,
  ): void {
    const peerMap =
      this.reachability.get(fromNodeId) ?? new Map<string, boolean>();
    peerMap.set(targetNodeId, reachable);
    this.reachability.set(fromNodeId, peerMap);
  }

  /** Read one directional reachability value, defaulting to reachable. */
  canReach(fromNodeId: string, targetNodeId: string): boolean {
    return this.reachability.get(fromNodeId)?.get(targetNodeId) ?? true;
  }

  /** Lookup a registered node by node id. */
  getNode(nodeId: string): RuntimeNode | null {
    return this.nodes.get(nodeId) ?? null;
  }

  /** Associate an arbitrary owner object with one node id. */
  setOwner(nodeId: string, owner: unknown): void {
    this.owners.set(nodeId, owner);
  }

  /** Read the previously registered owner object for one node id. */
  getOwner<T>(nodeId: string): T | null {
    return (this.owners.get(nodeId) as T | undefined) ?? null;
  }

  /** Lookup a registered node by one of its published addresses. */
  getNodeByAddr(addr: string): RuntimeNode | null {
    const nodeId = this.addresses.get(addr);
    return nodeId ? this.getNode(nodeId) : null;
  }

  /** List all currently started nodes in lexical node-id order. */
  listStarted(): RuntimeNode[] {
    return [...this.nodes.values()]
      .filter((node) => node.started)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
}
