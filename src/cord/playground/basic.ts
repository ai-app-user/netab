import { CordNode, CordRegistry } from "../index.js";
import { StengEngine } from "../../steng/index.js";

async function main() {
  const registry = new CordRegistry();
  const leader = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-a",
    priority: 10,
    steng: new StengEngine(),
  });
  const replica = new CordNode(registry, {
    clusterId: "offline",
    nodeId: "node-b",
    priority: 5,
    steng: new StengEngine(),
  });

  await leader.start();
  await replica.start();
  console.log(replica.get_cluster_status());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
