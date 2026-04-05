import test from "node:test";
import assert from "node:assert/strict";
import { CoordCommandRegistry, CoordDispatcher, parseInvocation } from "../index.js";

test("coord_cli parses base and targeted commands", async () => {
  const base = await parseInvocation(["-start:4001", "A", "config.js"]);
  assert.equal(base.kind, "base");
  assert.equal(base.baseCmd, "start");
  assert.equal(base.baseCmdPort, 4001);
  assert.deepEqual(base.baseArgs, ["A", "config.js"]);

  const targeted = await parseInvocation(["#offlineMiami1", "--parallel=10", "cluster:listNodes", "clusterId=offlineMiami1", "limit=5", "raw"]);
  assert.equal(targeted.kind, "targeted");
  assert.deepEqual(targeted.target, { kind: "cluster", value: "offlineMiami1" });
  assert.equal(targeted.fullCmd, "cluster:listNodes");
  assert.equal(targeted.options.parallel, 10);
  assert.deepEqual(targeted.params, { clusterId: "offlineMiami1", limit: 5 });
  assert.deepEqual(targeted.args, ["raw"]);

  const routed = await parseInvocation(["A", "route", "print", "--verbose", "--dst=D"]);
  assert.equal(routed.fullCmd, "foundation:route");
  assert.equal(routed.options.verbose, true);
  assert.equal(routed.options.dst, "D");
  assert.deepEqual(routed.args, ["print"]);
});

test("coord_cli registry and dispatcher execute registered handlers", async () => {
  const registry = new CoordCommandRegistry();
  const seen: string[] = [];
  registry.registerBase("discover", async (inv) => {
    seen.push(`base:${inv.baseCmd}`);
  });
  registry.registerCmd("foundation:whoami", async () => {
    seen.push("foundation:whoami");
  });
  const dispatcher = new CoordDispatcher(registry);

  assert.equal(await dispatcher.dispatch(["-discover", "4001,4002", "600"]), 0);
  assert.equal(await dispatcher.dispatch(["node-a", "whoami"]), 0);
  assert.deepEqual(seen, ["base:discover", "foundation:whoami"]);
});

test("coord_cli returns specific exit codes for unknown group and command", async () => {
  const registry = new CoordCommandRegistry();
  registry.registerCmd("foundation:whoami", async () => ({ ok: true }));
  const dispatcher = new CoordDispatcher(registry);

  assert.equal(await dispatcher.dispatch(["node-a", "bad_group:echo"]), 3);
  assert.equal(await dispatcher.dispatch(["node-a", "bad_cmd"]), 4);
});
