import type { BootstrapManager, NodeInfo } from "./types.js";
import type { CoordStore } from "./types.js";

function unallocatedKey(ns: string, nodeId: string): string {
  return `bootstrap/${ns}/unallocated/${nodeId}`;
}

export class CordBootstrapManager implements BootstrapManager {
  constructor(private readonly store: CoordStore, private readonly namespace: string) {}

  async registerUnallocated(nodeInfo: NodeInfo): Promise<{ status: "unallocated" }> {
    await this.store.set(unallocatedKey(this.namespace, nodeInfo.nodeId), nodeInfo);
    return { status: "unallocated" };
  }

  async listUnallocated(ns: string): Promise<NodeInfo[]> {
    const items = await this.store.list(`bootstrap/${ns}/unallocated/`);
    return items
      .map(({ value }) => value as NodeInfo)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  async claimNode(ns: string, nodeId: string, _proof?: unknown): Promise<void> {
    await this.store.del(unallocatedKey(ns, nodeId));
  }
}
