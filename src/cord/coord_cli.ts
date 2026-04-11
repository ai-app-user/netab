import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { inspect } from 'node:util';
import type {
  CommandRegistry,
  Dispatcher,
  HelpSpec,
  Invocation,
  Target,
} from './types.js';

/** CLI-facing error that also carries the process exit code to use. */
export class CoordCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'CoordCliError';
  }
}

const BOOLEAN_OPTIONS = new Set([
  'json',
  'pretty',
  'bestEffort',
  'quiet',
  'verbose',
]);
const BASE_COMMANDS = new Set([
  'start',
  'stop',
  'status',
  'cleanup',
  'discover',
  'save',
  'load',
  'stor',
  'restore',
  'help',
]);

/**
 * Coerces value.
 * @param value Value to process.
 */
function coerceValue(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
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

/**
 * Returns whether address token.
 * @param token Token.
 */
function isAddrToken(token: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(token) ||
    /^[A-Za-z0-9_.-]+:\d+$/.test(token)
  );
}

/**
 * Returns whether file token.
 * @param token Token.
 */
function isFileToken(token: string): boolean {
  return (
    token === '@-' ||
    token.startsWith('f:') ||
    token.startsWith('@./') ||
    token.startsWith('@../') ||
    token.startsWith('@/') ||
    token.startsWith('@~/')
  );
}

/**
 * Returns whether selector token.
 * @param token Token.
 */
function isSelectorToken(token: string): boolean {
  return (
    (token.startsWith('@') && !isFileToken(token)) ||
    token.startsWith('%') ||
    token.startsWith('#')
  );
}

/**
 * Parses selector.
 * @param token Token.
 */
function parseSelector(token: string): Target {
  if (token.startsWith('%') || token.startsWith('#')) {
    return { kind: 'cluster', value: token.slice(1) };
  }
  const raw = token.startsWith('@') ? token.slice(1) : token;
  if (isAddrToken(raw)) {
    return { kind: 'addr', value: raw };
  }
  if (raw.length === 0) {
    throw new CoordCliError(`ERROR malformed selector "${token}"`, 5);
  }
  return { kind: 'node', value: raw };
}

/**
 * Parses base token.
 * @param token Token.
 */
function parseBaseToken(token: string): {
  baseCmd: string;
  baseCmdPort: number | null;
} {
  const raw = token.startsWith('-') ? token.slice(1) : token;
  const [head, tail] = raw.split(':', 2);
  return {
    baseCmd: head,
    baseCmdPort: head === 'start' && tail ? Number(tail) : null,
  };
}

/**
 * Reads payload token.
 * @param token Token.
 */
async function readPayloadToken(token: string): Promise<Invocation['payload']> {
  if (token === '@-') {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(Buffer.from(chunk));
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    return { kind: 'bytes', name: '-', bytes };
  }
  const name = token.startsWith('f:') ? token.slice(2) : token.slice(1);
  const bytes = new Uint8Array(await readFile(name));
  if (name.endsWith('.json')) {
    return {
      kind: 'json',
      name,
      json: JSON.parse(Buffer.from(bytes).toString('utf8')),
    };
  }
  return { kind: 'bytes', name, bytes };
}

/**
 * Handles consume option token.
 * @param argv Argv.
 * @param index Index.
 * @param options Operation options.
 */
function consumeOptionToken(
  argv: string[],
  index: number,
  options: Invocation['options'],
): number {
  const token = argv[index];
  if (!token.startsWith('--')) {
    return index;
  }
  const rawOption = token.slice(2);
  if (rawOption.includes('=')) {
    const [key, rawValue] = rawOption.split('=', 2);
    if (!key || rawValue === '') {
      throw new CoordCliError(`ERROR malformed option "--${rawOption}"`, 5);
    }
    options[key === 'timeout' ? 'timeoutMs' : key] = coerceValue(rawValue);
    return index + 1;
  }
  if (BOOLEAN_OPTIONS.has(rawOption)) {
    options[rawOption] = true;
    return index + 1;
  }
  const next = argv[index + 1];
  if (next && !next.startsWith('--')) {
    options[rawOption === 'timeout' ? 'timeoutMs' : rawOption] =
      coerceValue(next);
    return index + 2;
  }
  options[rawOption] = true;
  return index + 1;
}

/**
 * Parses legacy invocation.
 * @param argv Argv.
 */
async function parseLegacyInvocation(argv: string[]): Promise<Invocation> {
  const raw = [...argv];
  const target = parseSelector(
    argv[0].startsWith('@') ||
      argv[0].startsWith('#') ||
      argv[0].startsWith('%')
      ? argv[0]
      : `@${argv[0]}`,
  );
  let index = 1;
  const options: Invocation['options'] = {};
  while (index < argv.length && argv[index].startsWith('--')) {
    index = consumeOptionToken(argv, index, options);
  }

  const cmdToken = argv[index];
  if (!cmdToken) {
    throw new CoordCliError('ERROR missing command token', 5);
  }
  index += 1;
  const [group, cmd] = cmdToken.includes(':')
    ? cmdToken.split(':', 2)
    : ['foundation', cmdToken];
  const params: Record<string, unknown> = {};
  const args: unknown[] = [];
  let payload: Invocation['payload'];

  while (index < argv.length) {
    const token = argv[index];
    if (token.startsWith('--')) {
      index = consumeOptionToken(argv, index, options);
      continue;
    }
    if (isFileToken(token)) {
      payload = await readPayloadToken(token);
      index += 1;
      continue;
    }
    if (token.includes('=')) {
      const [key, value] = token.split('=', 2);
      params[key] = coerceValue(value);
    } else {
      args.push(coerceValue(token));
    }
    index += 1;
  }

  return {
    raw,
    kind: 'targeted',
    sender: { kind: 'none' },
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

/**
 * Parse one `coord` command line into the normalized invocation shape used by
 * the dispatcher and runtime registry.
 *
 * The current grammar is:
 * `coord [@sender] -command [@target|%cluster] [args...] [--options...]`
 */
export async function parseInvocation(argv: string[]): Promise<Invocation> {
  if (argv.length === 0) {
    throw new CoordCliError('ERROR no command provided', 5);
  }
  const raw = [...argv];
  if (
    argv.length >= 2 &&
    !argv[0]?.startsWith('-') &&
    !isSelectorToken(argv[0] ?? '') &&
    argv[1]?.startsWith('-')
  ) {
    const senderHint = `@${argv[0]}`;
    const targetHint =
      argv.length >= 3 &&
      argv[2] &&
      !argv[2].startsWith('-') &&
      !isSelectorToken(argv[2]) &&
      !isFileToken(argv[2])
        ? ` @${argv[2]}`
        : '';
    throw new CoordCliError(
      `ERROR mixed coord syntax. Prefix node/address selectors with "@". Try: coord ${senderHint} ${argv[1]}${targetHint}${argv
        .slice(targetHint ? 3 : 2)
        .map((token) => ` ${token}`)
        .join('')}`,
      5,
    );
  }
  let index = 0;
  let sender: Target = { kind: 'none' };

  if (isSelectorToken(argv[index])) {
    sender = parseSelector(argv[index]);
    index += 1;
  }

  const cmdToken = argv[index];
  if (!cmdToken) {
    throw new CoordCliError('ERROR missing command token', 5);
  }

  if (!cmdToken.startsWith('-')) {
    return parseLegacyInvocation(argv);
  }

  const commandToken = cmdToken.slice(1);
  if (!commandToken) {
    throw new CoordCliError(`ERROR malformed command "${cmdToken}"`, 5);
  }
  index += 1;

  const baseMeta = parseBaseToken(cmdToken);
  const isBase = BASE_COMMANDS.has(baseMeta.baseCmd);
  const target =
    index < argv.length && isSelectorToken(argv[index])
      ? parseSelector(argv[index++])
      : ({ kind: 'none' } satisfies Target);
  const options: Invocation['options'] = {};
  const params: Record<string, unknown> = {};
  const args: unknown[] = [];
  let payload: Invocation['payload'];

  while (index < argv.length) {
    const token = argv[index];
    if (token.startsWith('--')) {
      index = consumeOptionToken(argv, index, options);
      continue;
    }
    if (isFileToken(token)) {
      payload = await readPayloadToken(token);
      index += 1;
      continue;
    }
    if (token.includes('=')) {
      const [key, value] = token.split('=', 2);
      params[key] = coerceValue(value);
    } else {
      args.push(coerceValue(token));
    }
    index += 1;
  }

  if (isBase) {
    return {
      raw,
      kind: 'base',
      sender,
      baseCmd: baseMeta.baseCmd,
      baseCmdPort: baseMeta.baseCmdPort,
      baseArgs: [
        ...(target.kind !== 'none' ? [target.value] : []),
        ...args.map((value) => String(value)),
      ],
      target,
      options,
      group: 'base',
      cmd: baseMeta.baseCmd,
      fullCmd: `base:${baseMeta.baseCmd}`,
      params,
      args,
      payload,
    };
  }

  const [group, cmd] = commandToken.includes(':')
    ? commandToken.split(':', 2)
    : ['foundation', commandToken];
  return {
    raw,
    kind: 'targeted',
    sender,
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

/** In-memory registry of base commands, targeted commands, and help text. */
export class CoordCommandRegistry implements CommandRegistry {
  private readonly baseHandlers = new Map<
    string,
    {
      handler: (inv: Invocation, ctx: unknown) => Promise<unknown>;
      help?: HelpSpec;
    }
  >();
  private readonly commandHandlers = new Map<
    string,
    {
      handler: (inv: Invocation, ctx: unknown) => Promise<unknown>;
      help?: HelpSpec;
    }
  >();

  /** Register one base command such as `-status` or `-start`. */
  registerBase(
    name: string,
    handler: (inv: Invocation, ctx: unknown) => Promise<unknown>,
    help?: HelpSpec,
  ): void {
    this.baseHandlers.set(name, { handler, help });
  }

  /** Register one targeted command such as `foundation:whoami`. */
  registerCmd(
    fullCmd: string,
    handler: (inv: Invocation, ctx: unknown) => Promise<unknown>,
    help?: HelpSpec,
  ): void {
    this.commandHandlers.set(fullCmd, { handler, help });
  }

  /** True when a base command has been registered. */
  hasBase(name: string): boolean {
    return this.baseHandlers.has(name);
  }

  /** True when a targeted command has been registered. */
  hasCmd(fullCmd: string): boolean {
    return this.commandHandlers.has(fullCmd);
  }

  /** Lookup help metadata for either a base command or a targeted command id. */
  helpFor(nameOrCmd: string): HelpSpec | null {
    return (
      this.baseHandlers.get(nameOrCmd)?.help ??
      this.commandHandlers.get(nameOrCmd)?.help ??
      null
    );
  }

  /** List registered base commands in sorted order. */
  listBase(): string[] {
    return [...this.baseHandlers.keys()].sort();
  }

  /** List registered targeted commands in sorted order. */
  listCommands(): string[] {
    return [...this.commandHandlers.keys()].sort();
  }

  /** List known targeted command groups such as `foundation` or `cluster`. */
  listGroups(): string[] {
    return [
      ...new Set(
        this.listCommands().map((command) => command.split(':', 1)[0]),
      ),
    ].sort();
  }

  /** List commands belonging to one command group. */
  listGroupCommands(group: string): string[] {
    return this.listCommands().filter((command) =>
      command.startsWith(`${group}:`),
    );
  }

  /** Invoke the handler that matches one parsed invocation. */
  async invoke(inv: Invocation, ctx: unknown): Promise<unknown> {
    if (inv.kind === 'base') {
      const handler = this.baseHandlers.get(inv.baseCmd!);
      if (!handler) {
        throw new CoordCliError(
          `ERROR unknown base command "${inv.baseCmd}"`,
          2,
        );
      }
      return handler.handler(inv, ctx);
    }
    const matchingGroupCommands = this.listGroupCommands(inv.group);
    if (matchingGroupCommands.length === 0) {
      const hint = this.listGroups().includes('foundation')
        ? ' (did you mean "foundation"?)'
        : '';
      throw new CoordCliError(
        `ERROR unknown command group "${inv.group}"${hint}`,
        3,
      );
    }
    const handler = this.commandHandlers.get(inv.fullCmd);
    if (!handler) {
      const example = matchingGroupCommands[0];
      throw new CoordCliError(
        `ERROR unknown command "${inv.fullCmd}"${example ? ` (try "coord -${example.replace('foundation:', '')}")` : ''}`,
        4,
      );
    }
    return handler.handler(inv, ctx);
  }
}

/** Thin CLI dispatcher that parses argv, invokes the registry, and prints output. */
export class CoordDispatcher implements Dispatcher {
  constructor(private readonly registry: CoordCommandRegistry) {}

  /** Dispatch one argv array and return the desired process exit code. */
  async dispatch(argv: string[], ctx?: unknown): Promise<number> {
    try {
      const invocation = await parseInvocation(argv);
      const result = await this.registry.invoke(invocation, ctx);
      if (invocation.options.json) {
        output.write(
          `${JSON.stringify(result, null, invocation.options.pretty ? 2 : 0)}\n`,
        );
      } else if (typeof result === 'string') {
        output.write(result.endsWith('\n') ? result : `${result}\n`);
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

/** Convert runtime failures into stable CLI-facing exit codes and messages. */
function normalizeCliError(error: unknown): CoordCliError {
  if (error instanceof CoordCliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed out')) {
    return new CoordCliError(`ERROR timeout: ${message}`, 6);
  }
  if (message.includes('Target ') && message.includes(' is not available')) {
    return new CoordCliError(`ERROR transport: ${message}`, 7);
  }
  if (
    message.includes('cannot reach') ||
    message.includes('no route to') ||
    message.includes('route denied') ||
    message.includes('proxy hop exceeds 1')
  ) {
    return new CoordCliError(`ERROR transport: ${message}`, 7);
  }
  if (message.includes('Unknown RPC method')) {
    return new CoordCliError(`ERROR remote method: ${message}`, 8);
  }
  if (message.includes('Unauthorized')) {
    return new CoordCliError(`ERROR permission denied: ${message}`, 9);
  }
  return new CoordCliError(`ERROR ${message}`, 1);
}
