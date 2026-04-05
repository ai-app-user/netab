import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("coord playground exposes the documented CLI commands", { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "coord-playground-"));
  const exportPath = join(rootDir, "saved-state.json");
  const portA = await reservePort();
  const portB = await reservePort();

  try {
    const overview = await runCoord([], rootDir);
    assert.equal(overview.code, 0);
    assert.match(overview.stdout, /coord CLI/);
    assert.match(overview.stdout, /First-time quick start:/);
    assert.match(overview.stdout, /-start/);

    const help = await runCoord(["-help", "foundation"], rootDir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /foundation:whoami/);
    assert.match(help.stdout, /foundation:echo/);

    const commandHelp = await runCoord(["-help", "foundation:echo"], rootDir);
    assert.equal(commandHelp.code, 0);
    assert.match(commandHelp.stdout, /Echo args or payload/);
    assert.match(commandHelp.stdout, /Usage:/);
    assert.match(commandHelp.stdout, /Options:/);
    assert.match(commandHelp.stdout, /Examples:/);

    const startedA = await runCoord([`-start:${portA}`, "A"], rootDir);
    assert.equal(startedA.code, 0);
    assert.match(startedA.stdout, /mode: 'daemon'/);

    const startedB = await runCoord([`-start:${portB}`, "B"], rootDir);
    assert.equal(startedB.code, 0);
    assert.match(startedB.stdout, /mode: 'daemon'/);

    const duplicatePort = await runCoord([`-start:${portA}`, "C"], rootDir);
    assert.equal(duplicatePort.code, 1);
    assert.match(duplicatePort.stdout, /already serving node A|serving A, not C/);

    const status = await runCoord(["-status"], rootDir);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /coord status/);
    assert.match(status.stdout, /A/);
    assert.match(status.stdout, /B/);
    assert.match(status.stdout, /up/);
    assert.doesNotMatch(status.stdout, /\bC\b/);

    const health = await fetch(`http://127.0.0.1:${portA}/healthz`);
    assert.equal(health.ok, true);

    const discovered = await runCoord(["-discover", `${portA},${portB}`, "600"], rootDir);
    assert.equal(discovered.code, 0);
    assert.match(discovered.stdout, /A/);
    assert.match(discovered.stdout, /B/);

    const whoami = await runCoord(["A", "--json", "whoami"], rootDir);
    assert.equal(whoami.code, 0);
    const firstWhoami = JSON.parse(whoami.stdout) as { nodeId: string; nodeEpoch: string };
    assert.equal(firstWhoami.nodeId, "A");

    const whoamiAgain = await runCoord(["A", "--json", "whoami"], rootDir);
    assert.equal(whoamiAgain.code, 0);
    const secondWhoami = JSON.parse(whoamiAgain.stdout) as { nodeEpoch: string };
    assert.equal(secondWhoami.nodeEpoch, firstWhoami.nodeEpoch);

    const echo = await runCoord(["B", "--json", "echo", "@./src/cord/playground/samples/bigfile.txt"], rootDir);
    assert.equal(echo.code, 0);
    const echoResult = JSON.parse(echo.stdout) as { ok: boolean; kind: string; bytes: number; sha256: string };
    assert.equal(echoResult.ok, true);
    assert.equal(echoResult.kind, "bytes");
    assert.ok(echoResult.bytes > 0);
    assert.match(echoResult.sha256, /^[a-f0-9]{64}$/);

    const save = await runCoord(["-save", exportPath], rootDir);
    assert.equal(save.code, 0);
    const saved = JSON.parse(await readFile(exportPath, "utf8")) as { nodes: Array<{ nodeId: string }>; cache: Record<string, unknown> };
    assert.equal(saved.nodes.length, 2);
    assert.ok(saved.cache.A);

    const badGroup = await runCoord(["B", "bad_group:echo", "123"], rootDir);
    assert.equal(badGroup.code, 3);
    assert.match(badGroup.stdout, /unknown command group/i);

    const badCommand = await runCoord(["B", "bad_cmd"], rootDir);
    assert.equal(badCommand.code, 4);
    assert.match(badCommand.stdout, /unknown command/i);
  } finally {
    await runCoord(["-stop", "all"], rootDir).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("coord playground supports route and proxy scenarios", { concurrency: false }, async () => {
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

    const discovered = await runCoord(["-discover", `${portA},${portC},${portP},${portD}`, "600"], rootDir);
    assert.equal(discovered.code, 0);

    const baseline = await runCoord(["A", "route", "print"], rootDir);
    assert.equal(baseline.code, 0);
    assert.match(baseline.stdout, /\bC\b/);
    assert.match(baseline.stdout, /\bP\b/);
    assert.match(baseline.stdout, /\bD\b/);

    const denyOutC = await runCoord(["A", "route", "deny", "out", "C"], rootDir);
    assert.equal(denyOutC.code, 0);

    const denied = await runCoord(["A", "--dst=C", "whoami"], rootDir);
    assert.equal(denied.code, 7);
    assert.match(denied.stdout, /route denied: out to C|no route to C/i);

    const reverse = await runCoord(["C", "--json", "--dst=A", "whoami"], rootDir);
    assert.equal(reverse.code, 0);
    assert.equal((JSON.parse(reverse.stdout) as { nodeId: string }).nodeId, "A");

    const afterInbound = await runCoord(["A", "route", "print", "--verbose"], rootDir);
    assert.equal(afterInbound.code, 0);
    assert.match(afterInbound.stdout, /C\{in\}/);
    assert.match(afterInbound.stdout, /\bin\b/);

    assert.equal((await runCoord(["A", "route", "deny", "out", "D"], rootDir)).code, 0);
    assert.equal((await runCoord(["A", "route", "add", "D", "P"], rootDir)).code, 0);

    const proxied = await runCoord(["A", "--json", "--dst=D", "whoami"], rootDir);
    assert.equal(proxied.code, 0);
    assert.equal((JSON.parse(proxied.stdout) as { nodeId: string }).nodeId, "D");

    assert.equal((await runCoord(["D", "route", "deny", "out", "A"], rootDir)).code, 0);
    assert.equal((await runCoord(["D", "route", "add", "A", "P"], rootDir)).code, 0);

    const reverseProxy = await runCoord(["D", "--json", "--dst=A", "whoami"], rootDir);
    assert.equal(reverseProxy.code, 0);
    assert.equal((JSON.parse(reverseProxy.stdout) as { nodeId: string }).nodeId, "A");

    const routeTable = await runCoord(["A", "route", "print"], rootDir);
    assert.equal(routeTable.code, 0);
    assert.match(routeTable.stdout, /D\[P\]/);

    const proxyOn = await runCoord(["A", "proxy", "on", "D"], rootDir);
    assert.equal(proxyOn.code, 0);

    const proxyDefault = await runCoord(["A", "--json", "whoami"], rootDir);
    assert.equal(proxyDefault.code, 0);
    assert.equal((JSON.parse(proxyDefault.stdout) as { nodeId: string }).nodeId, "D");

    const proxyOverride = await runCoord(["A", "--json", "--dst=A", "whoami"], rootDir);
    assert.equal(proxyOverride.code, 0);
    assert.equal((JSON.parse(proxyOverride.stdout) as { nodeId: string }).nodeId, "A");

    const proxyOff = await runCoord(["A", "proxy", "off"], rootDir);
    assert.equal(proxyOff.code, 0);

    const localAgain = await runCoord(["A", "--json", "whoami"], rootDir);
    assert.equal(localAgain.code, 0);
    assert.equal((JSON.parse(localAgain.stdout) as { nodeId: string }).nodeId, "A");

    const loopRule = await runCoord(["P", "route", "add", "D", "A"], rootDir);
    assert.equal(loopRule.code, 0);

    const looped = await runCoord(["A", "--dst=D", "whoami"], rootDir);
    assert.equal(looped.code, 7);
    assert.match(looped.stdout, /proxy hop exceeds 1/i);

    const clearLoop = await runCoord(["P", "route", "del", "D"], rootDir);
    assert.equal(clearLoop.code, 0);

    const blockProxy = await runCoord(["A", "route", "deny", "out", "P"], rootDir);
    assert.equal(blockProxy.code, 0);

    const proxyUnreachable = await runCoord(["A", "--dst=D", "whoami"], rootDir);
    assert.equal(proxyUnreachable.code, 7);
    assert.match(proxyUnreachable.stdout, /cannot reach proxy P/i);

    const noRouteRoot = await mkdtemp(join(tmpdir(), "coord-no-route-"));
    try {
      for (const [name, port] of [
        ["A", await reservePort()],
        ["D", await reservePort()],
      ] as const) {
        const started = await runCoord([`-start:${port}`, name], noRouteRoot);
        assert.equal(started.code, 0);
      }
      assert.equal((await runCoord(["A", "route", "deny", "out", "D"], noRouteRoot)).code, 0);
      const noRoute = await runCoord(["A", "--dst=D", "whoami"], noRouteRoot);
      assert.equal(noRoute.code, 7);
      assert.match(noRoute.stdout, /no route to D|route denied: out to D/i);
    } finally {
      await runCoord(["-stop", "all"], noRouteRoot).catch(() => ({ code: 0, stdout: "", stderr: "" }));
      await rm(noRouteRoot, { recursive: true, force: true });
    }
  } finally {
    await runCoord(["-stop", "all"], rootDir).catch(() => ({ code: 0, stdout: "", stderr: "" }));
    await rm(rootDir, { recursive: true, force: true });
  }
});
