import { CordNode, CordRegistry } from '../index.js';
import { StengEngine } from '../../steng/index.js';

async function main() {
  const registry = new CordRegistry();
  const leader = new CordNode(registry, {
    clusterId: 'offline',
    nodeId: 'node-a',
    priority: 10,
    steng: new StengEngine(),
  });
  const replica = new CordNode(registry, {
    clusterId: 'offline',
    nodeId: 'node-b',
    priority: 5,
    steng: new StengEngine(),
  });

  await leader.start();
  await replica.start();
  await leader.addShard('offline', { shardId: 'orders', weight: 3 });
  await leader.addShard('offline', { shardId: 'payments', weight: 1 });
  await leader.replicate_tick();
  console.log(
    JSON.stringify(
      {
        self: leader.self(),
        clusters: await leader.listClusters(),
        nodes: await leader.listNodes('offline'),
        alive: await leader.getAliveNodes('offline'),
        leaders: await leader.listLeaders('offline'),
        status: await replica.get_cluster_status(),
      },
      null,
      2,
    ),
  );

  await leader.stop();
  await replica.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
