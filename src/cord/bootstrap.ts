import type { BootstrapManager, NodeInfo } from './types.js';
import type { CoordStore } from './types.js';

/** Build the durable key used for one unallocated node record. */
function unallocatedKey(ns: string, nodeId: string): string {
  return `bootstrap/${ns}/unallocated/${nodeId}`;
}

/** Minimal bootstrap manager that tracks visible but not-yet-claimed nodes. */
export class CordBootstrapManager implements BootstrapManager {
  /** Create a bootstrap manager for one namespace. */
  constructor(
    private readonly store: CoordStore,
    private readonly namespace: string,
  ) {}

  /** Record a node as unallocated in the current namespace. */
  async registerUnallocated(
    nodeInfo: NodeInfo,
  ): Promise<{ status: 'unallocated' }> {
    await this.store.set(
      unallocatedKey(this.namespace, nodeInfo.nodeId),
      nodeInfo,
    );
    return { status: 'unallocated' };
  }

  /** List nodes currently waiting to be claimed. */
  async listUnallocated(ns: string): Promise<NodeInfo[]> {
    const items = await this.store.list(`bootstrap/${ns}/unallocated/`);
    return items
      .map(({ value }) => value as NodeInfo)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  /** Mark one node as claimed by deleting its unallocated record. */
  async claimNode(ns: string, nodeId: string, _proof?: unknown): Promise<void> {
    await this.store.del(unallocatedKey(ns, nodeId));
  }
}
