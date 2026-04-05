import { readFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { inspect } from "node:util";
import type { CommandRegistry, Dispatcher, HelpSpec, Invocation, Target } from "./types.js";

export class CoordCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "CoordCliError";
  }
}

const BOOLEAN_OPTIONS = new Set(["json", "pretty", "bestEffort", "quiet", "verbose"]);

function coerceValue(value: string): unknown {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseBaseToken(token: string): { baseCmd: string; baseCmdPort: number | null } {
  const raw = token.slice(1);
  const [baseCmd, portText] = raw.split(":", 2);
  return {
    baseCmd,
    baseCmdPort: portText ? Number(portText) : null,
  };
}

function parseTarget(token: string): Target {
  if (token.startsWith("#")) {
    return { kind: "cluster", value: token.slice(1) };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(token) || /^[A-Za-z0-9_.-]+:\d+$/.test(token)) {
    return { kind: "addr", value: token };
  }
  return { kind: "node", value: token };
}

async function readPayloadToken(token: string): Promise<Invocation["payload"]> {
  if (token === "@-") {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.from(chunk));
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    return { kind: "bytes", name: "-", bytes };
  }
  const name = token.slice(1);
  const bytes = new Uint8Array(await readFile(name));
  if (name.endsWith(".json")) {
    return { kind: "json", name, json: JSON.parse(Buffer.from(bytes).toString("utf8")) };
  }
  return { kind: "bytes", name, bytes };
}

function consumeOptionToken(argv: string[], index: number, options: Invocation["options"]): number {
  const token = argv[index];
  if (!token.startsWith("--")) {
    return index;
  }
  const rawOption = token.slice(2);
  if (rawOption.includes("=")) {
    const [key, rawValue] = rawOption.split("=", 2);
    if (!key || rawValue === "") {
      throw new CoordCliError(`ERROR malformed option "--${rawOption}"`, 5);
    }
    options[key === "timeout" ? "timeoutMs" : key] = coerceValue(rawValue);
    return index + 1;
  }
  if (BOOLEAN_OPTIONS.has(rawOption)) {
    options[rawOption] = true;
    return index + 1;
  }
  const next = argv[index + 1];
  if (next && !next.startsWith("--")) {
    options[rawOption === "timeout" ? "timeoutMs" : rawOption] = coerceValue(next);
    return index + 2;
  }
  options[rawOption] = true;
  return index + 1;
}

export async function parseInvocation(argv: string[]): Promise<Invocation> {
  if (argv.length === 0) {
    throw new CoordCliError("ERROR no command provided", 5);
  }
  const raw = [...argv];
  const first = argv[0];
  if (first.startsWith("-")) {
    const { baseCmd, baseCmdPort } = parseBaseToken(first);
    if (!baseCmd) {
      throw new CoordCliError(`ERROR malformed base command "${first}"`, 5);
    }
    return {
      raw,
      kind: "base",
      baseCmd,
      baseCmdPort,
      baseArgs: argv.slice(1),
      target: { kind: "none" },
      options: {},
      group: "base",
      cmd: baseCmd,
      fullCmd: `base:${baseCmd}`,
      params: {},
      args: argv.slice(1).map(coerceValue),
    };
  }

  const target = parseTarget(first);
  let index = 1;
  const options: Invocation["options"] = {};
  while (index < argv.length && argv[index].startsWith("--")) {
    index = consumeOptionToken(argv, index, options);
  }

  const cmdToken = argv[index];
  if (!cmdToken) {
    throw new CoordCliError("ERROR missing command token", 5);
  }
  index += 1;
  const [group, cmd] = cmdToken.includes(":") ? cmdToken.split(":", 2) : ["foundation", cmdToken];
  const params: Record<string, unknown> = {};
  const args: unknown[] = [];
  let payload: Invocation["payload"];

  while (index < argv.length) {
    const token = argv[index];
    if (token.startsWith("--")) {
      index = consumeOptionToken(argv, index, options);
      continue;
    }
    if (token.startsWith("@")) {
      payload = await readPayloadToken(token);
      index += 1;
      continue;
    }
    if (token.includes("=")) {
      const [key, value] = token.split("=", 2);
      params[key] = coerceValue(value);
    } else {
      args.push(coerceValue(token));
    }
    index += 1;
  }

  return {
    raw,
    kind: "targeted",
    target,
    options,
    group,
    cmd,
    fullCmd: `${group}:${cmd}`,
    params,
    args,
    payload,
  };
}

export class CoordCommandRegistry implements CommandRegistry {
  private readonly baseHandlers = new Map<string, { handler: (inv: Invocation, ctx: unknown) => Promise<unknown>; help?: HelpSpec }>();
  private readonly commandHandlers = new Map<string, { handler: (inv: Invocation, ctx: unknown) => Promise<unknown>; help?: HelpSpec }>();

  registerBase(name: string, handler: (inv: Invocation, ctx: unknown) => Promise<unknown>, help?: HelpSpec): void {
    this.baseHandlers.set(name, { handler, help });
  }

  registerCmd(fullCmd: string, handler: (inv: Invocation, ctx: unknown) => Promise<unknown>, help?: HelpSpec): void {
    this.commandHandlers.set(fullCmd, { handler, help });
  }

  hasBase(name: string): boolean {
    return this.baseHandlers.has(name);
  }

  hasCmd(fullCmd: string): boolean {
    return this.commandHandlers.has(fullCmd);
  }

  helpFor(nameOrCmd: string): HelpSpec | null {
    return this.baseHandlers.get(nameOrCmd)?.help ?? this.commandHandlers.get(nameOrCmd)?.help ?? null;
  }

  listBase(): string[] {
    return [...this.baseHandlers.keys()].sort();
  }

  listCommands(): string[] {
    return [...this.commandHandlers.keys()].sort();
  }

  listGroups(): string[] {
    return [...new Set(this.listCommands().map((command) => command.split(":", 1)[0]))].sort();
  }

  listGroupCommands(group: string): string[] {
    return this.listCommands().filter((command) => command.startsWith(`${group}:`));
  }

  async invoke(inv: Invocation, ctx: unknown): Promise<unknown> {
    if (inv.kind === "base") {
      const handler = this.baseHandlers.get(inv.baseCmd!);
      if (!handler) {
        throw new CoordCliError(`ERROR unknown base command "${inv.baseCmd}"`, 2);
      }
      return handler.handler(inv, ctx);
    }
    const matchingGroupCommands = this.listGroupCommands(inv.group);
    if (matchingGroupCommands.length === 0) {
      const hint = this.listGroups().includes("foundation") ? ' (did you mean "foundation"?)' : "";
      throw new CoordCliError(`ERROR unknown command group "${inv.group}"${hint}`, 3);
    }
    const handler = this.commandHandlers.get(inv.fullCmd);
    if (!handler) {
      const example = matchingGroupCommands[0];
      throw new CoordCliError(`ERROR unknown command "${inv.fullCmd}"${example ? ` (try "coord <target> ${example}")` : ""}`, 4);
    }
    return handler.handler(inv, ctx);
  }
}

export class CoordDispatcher implements Dispatcher {
  constructor(private readonly registry: CoordCommandRegistry) {}

  async dispatch(argv: string[], ctx?: unknown): Promise<number> {
    try {
      const invocation = await parseInvocation(argv);
      const result = await this.registry.invoke(invocation, ctx);
      if (invocation.options.json) {
        output.write(`${JSON.stringify(result, null, invocation.options.pretty ? 2 : 0)}\n`);
      } else if (typeof result === "string") {
        output.write(result.endsWith("\n") ? result : `${result}\n`);
      } else if (result !== undefined) {
        output.write(`${inspect(result, { depth: null, colors: false })}\n`);
      }
      return 0;
    } catch (error) {
      const failure = normalizeCliError(error);
      output.write(`${failure.message}\n`);
      return failure.exitCode;
    }
  }
}

function normalizeCliError(error: unknown): CoordCliError {
  if (error instanceof CoordCliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out")) {
    return new CoordCliError(`ERROR timeout: ${message}`, 6);
  }
  if (message.includes("Target ") && message.includes(" is not available")) {
    return new CoordCliError(`ERROR transport: ${message}`, 7);
  }
  if (message.includes("cannot reach") || message.includes("no route to") || message.includes("route denied") || message.includes("proxy hop exceeds 1")) {
    return new CoordCliError(`ERROR transport: ${message}`, 7);
  }
  if (message.includes("Unknown RPC method")) {
    return new CoordCliError(`ERROR remote method: ${message}`, 8);
  }
  if (message.includes("Unauthorized")) {
    return new CoordCliError(`ERROR permission denied: ${message}`, 9);
  }
  return new CoordCliError(`ERROR ${message}`, 1);
}
