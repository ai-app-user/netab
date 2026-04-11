import { CordNode, CordRegistry } from '../index.js';

/**
 * Run a focused foundation-layer demo:
 * - start nodes with identity and addresses
 * - register a custom RPC handler by method name
 * - discover peers
 * - call built-in and custom methods by node id and address
 * - measure ping RTT
 */
async function main() {
  const registry = new CordRegistry();

  const nodeA = new CordNode(registry, {
    nodeId: 'node-a',
    addrs: ['10.0.0.10:4001'],
    props: { type: 'tablet', model: 'demo-a' },
  });
  const nodeB = new CordNode(registry, {
    nodeId: 'node-b',
    addrs: ['10.0.0.11:4002'],
    props: { type: 'tablet', model: 'demo-b' },
  });

  nodeB.registerHandler('demo.foundation.echo', async (ctx, params) => {
    return {
      handledBy: nodeB.self().nodeId,
      srcNodeId: ctx.srcNodeId ?? null,
      traceId: ctx.traceId ?? null,
      params,
    };
  });

  await nodeA.start();
  await nodeB.start();

  try {
    const auth = nodeA.foundation.makeInternalAuth();
    const discovered = await nodeA.discover();
    const whoamiByNode = await nodeA.call(
      { nodeId: 'node-b' },
      'cord.foundation.whoami',
      {},
      { auth, traceId: 'foundation-whoami-node' },
    );
    const whoamiByAddr = await nodeA.call(
      { addr: '10.0.0.11:4002' },
      'cord.foundation.whoami',
      {},
      { auth, traceId: 'foundation-whoami-addr' },
    );
    const echo = await nodeA.call(
      { addr: '10.0.0.11:4002' },
      'demo.foundation.echo',
      {
        message: 'hello from node-a',
        count: 2,
      },
      { auth, timeoutMs: 1000, traceId: 'foundation-echo-1' },
    );
    const ping = await nodeA.ping({ nodeId: 'node-b' });

    console.log(
      JSON.stringify(
        {
          self: nodeA.self(),
          discovered,
          whoamiByNode,
          whoamiByAddr,
          echo,
          ping,
        },
        null,
        2,
      ),
    );
  } finally {
    await nodeA.stop();
    await nodeB.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
