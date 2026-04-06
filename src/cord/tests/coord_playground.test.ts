import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type CoordResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCoord(args: string[], rootDir: string): Promise<CoordResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "./scripts/coord",
      args,
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          COORD_PLAYGROUND_ROOT: rootDir,
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
          reject(error);
          return;
        }
        resolveResult({
          code: typeof (error as NodeJS.ErrnoException | null)?.code === "number" ? Number((error as NodeJS.ErrnoException).code) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a test port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

test("coord playground learns peers from direct calls and connect", { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "coord-playground-"));
  const portA = await reservePort();
  const portP = await reservePort();

  try {
    const overview = await runCoord([], rootDir);
    assert.equal(overview.code, 0);
    assert.match(overview.stdout, /coord CLI/);
    assert.match(overview.stdout, /coord \[@sender\] -command \[@target\|%cluster\]/);

    const startA = await runCoord([`-start:${portA}`, "A"], rootDir);
    assert.equal(startA.code, 0);

    const startP = await runCoord([`-start:${portP}`, "P"], rootDir);
    assert.equal(startP.code, 0);

    const status = await runCoord(["-status"], rootDir);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /\bA\b/);
    assert.match(status.stdout, /\bP\b/);

    const direct = await runCoord(["@A", "-whoami", `@127.0.0.1:${portP}`, "--json"], rootDir);
    assert.equal(direct.code, 0, direct.stdout || direct.stderr);
    assert.equal((JSON.parse(direct.stdout) as { nodeId: string }).nodeId, "P");

    const peersOnA = await runCoord(["@A", "-peers", "--json"], rootDir);
    assert.equal(peersOnA.code, 0);
    const peerTableA = JSON.parse(peersOnA.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    assert.deepEqual(peerTableA.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state })), [
      { nodeId: "P", via: `127.0.0.1:${portP}`, ways: "out", state: "learned" },
    ]);

    const peersOnP = await runCoord(["@P", "-peers", "--json"], rootDir);
    assert.equal(peersOnP.code, 0);
    const peerTableP = JSON.parse(peersOnP.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    assert.deepEqual(peerTableP.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state })), [
      { nodeId: "A", via: `127.0.0.1:${portA}`, ways: "in", state: "learned" },
    ]);

    const connect = await runCoord(["@A", "-connect", `@127.0.0.1:${portP}`, "--ttl=0", "--json"], rootDir);
    assert.equal(connect.code, 0);
    assert.equal((JSON.parse(connect.stdout) as { peer: { nodeId: string } }).peer.nodeId, "P");

    const connectedA = await runCoord(["@A", "-peers", "--json"], rootDir);
    const connectedPeersA = JSON.parse(connectedA.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    assert.deepEqual(connectedPeersA.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state })), [
      { nodeId: "P", via: `127.0.0.1:${portP}`, ways: "both", state: "connected" },
    ]);

    const connectedP = await runCoord(["@P", "-peers", "--json"], rootDir);
    const connectedPeersP = JSON.parse(connectedP.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    assert.deepEqual(connectedPeersP.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state })), [
      { nodeId: "A", via: "reverse", ways: "both", state: "connected" },
    ]);

    const reverseCall = await runCoord(["@P", "-whoami", "@A", "--json"], rootDir);
    assert.equal(reverseCall.code, 0);
    assert.equal((JSON.parse(reverseCall.stdout) as { nodeId: string }).nodeId, "A");
  } finally {
    await runCoord(["-stop", "all"], rootDir).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("coord playground supports learned proxy paths and reverse hops", { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "coord-routing-"));
  const portA = await reservePort();
  const portC = await reservePort();
  const portP = await reservePort();
  const portD = await reservePort();

  try {
    for (const [name, port] of [
      ["A", portA],
      ["C", portC],
      ["P", portP],
      ["D", portD],
    ] as const) {
      const started = await runCoord([`-start:${port}`, name], rootDir);
      assert.equal(started.code, 0, started.stdout || started.stderr);
    }

    const denyOut = await runCoord(["@A", "-route:deny", "@C", "out"], rootDir);
    assert.equal(denyOut.code, 0);

    const denied = await runCoord(["@A", "-whoami", "@C"], rootDir);
    assert.equal(denied.code, 7);
    assert.match(denied.stdout, /no route to C|route denied: out to C/i);

    const inbound = await runCoord(["@C", "-echo", "@A", "hello", "--json"], rootDir);
    assert.equal(inbound.code, 0);
    assert.equal((JSON.parse(inbound.stdout) as { text: string }).text, "hello");

    const routesAfterInbound = await runCoord(["@A", "-routes"], rootDir);
    assert.equal(routesAfterInbound.code, 0);
    assert.match(routesAfterInbound.stdout, /\bC\b/);
    assert.match(routesAfterInbound.stdout, /\bin\b/);

    const connect = await runCoord(["@A", "-connect", `@127.0.0.1:${portP}`, "--ttl=0"], rootDir);
    assert.equal(connect.code, 0);

    const learn = await runCoord(["@D", "-learn", "@P", "--json"], rootDir);
    assert.equal(learn.code, 0);
    const learnResult = JSON.parse(learn.stdout) as { learned: string[] };
    assert.deepEqual(learnResult.learned, ["A"]);

    const peersBeforeRoute = await runCoord(["@D", "-peers", "--json"], rootDir);
    const tableBeforeRoute = JSON.parse(peersBeforeRoute.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    assert.deepEqual(tableBeforeRoute.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state })), [
      { nodeId: "A", via: "via P", ways: "-", state: "suggested" },
      { nodeId: "P", via: `127.0.0.1:${portP}`, ways: "out", state: "learned" },
    ]);

    const addRoute = await runCoord(["@D", "-route:add", "@A", "@P"], rootDir);
    assert.equal(addRoute.code, 0);

    const routed = await runCoord(["@D", "-echo", "@A", "hello-from-D", "--verbose"], rootDir);
    assert.equal(routed.code, 0, routed.stdout || routed.stderr);
    assert.match(routed.stdout, /D -> P -< A/);
    assert.match(routed.stdout, /hello-from-D/);

    const peersOnA = await runCoord(["@A", "-peers", "--json"], rootDir);
    assert.equal(peersOnA.code, 0);
    const tableOnA = JSON.parse(peersOnA.stdout) as { entries: Array<{ nodeId: string; via: string; ways: string; state: string }> };
    const summarizedOnA = tableOnA.entries.map(({ nodeId, via, ways, state }) => ({ nodeId, via, ways, state }));
    assert.ok(summarizedOnA.some((entry) => entry.nodeId === "D" && entry.via === "via P" && entry.ways === "in" && entry.state === "learned"));
    assert.ok(summarizedOnA.some((entry) => entry.nodeId === "P" && entry.via === `127.0.0.1:${portP}` && entry.ways === "both" && entry.state === "connected"));

    const routesOnA = await runCoord(["@A", "-routes"], rootDir);
    assert.equal(routesOnA.code, 0);
    assert.match(routesOnA.stdout, /A -> P -> D/);

    const denyDirectD = await runCoord(["@A", "-route:deny", "@D", "out"], rootDir);
    assert.equal(denyDirectD.code, 0);

    const reply = await runCoord(["@A", "-whoami", "@D", "--verbose"], rootDir);
    assert.equal(reply.code, 0, reply.stdout || reply.stderr);
    assert.match(reply.stdout, /A -> P -> D/);

    const proxyOn = await runCoord(["@A", "-proxy:on", "@D"], rootDir);
    assert.equal(proxyOn.code, 0);

    const proxyDefault = await runCoord(["@A", "-whoami", "--json"], rootDir);
    assert.equal(proxyDefault.code, 0);
    assert.equal((JSON.parse(proxyDefault.stdout) as { nodeId: string }).nodeId, "D");

    const proxyOff = await runCoord(["@A", "-proxy:off"], rootDir);
    assert.equal(proxyOff.code, 0);
  } finally {
    await runCoord(["-stop", "all"], rootDir).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await rm(rootDir, { recursive: true, force: true });
  }
});
