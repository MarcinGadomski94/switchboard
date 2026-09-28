/** CLI version the fixtures were recorded with (`manifest.json` → `cliVersion`). */
export const CLI_VERSION = '2.1.283';

/** `--permission-mode` choices accepted by CLI 2.1.283 (`default` is an undocumented alias of `manual`). */
export const PERMISSION_MODES: readonly string[] = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'manual', 'plan'];

/** Options of a session run (`-p …`). */
export interface RunArgs {
  /** `-p` / `--print` (headless). The fake has no interactive mode. */
  print: boolean;
  /** The positional prompt, or `null` (stream-json input or stdin text). */
  prompt: string | null;
  inputFormat: 'text' | 'stream-json';
  outputFormat: 'text' | 'stream-json';
  verbose: boolean;
  model: string | null;
  /** D31: `--effort <level>` as given (the run warns about a value that is not a level and ignores it, like the CLI); `null` without it. */
  effort: string | null;
  maxTurns: number | null;
  permissionMode: string | null;
  permissionPromptTool: string | null;
  allowedTools: string[];
  settings: string | null;
  includeHookEvents: boolean;
  forwardSubagentText: boolean;
  replayUserMessages: boolean;
  sessionId: string | null;
  resume: string | null;
  forkSession: boolean;
  name: string | null;
  /** `--teleport <id>` (D25): a local copy of a remote session (`teleport.ts`); `null` otherwise. */
  teleport: string | null;
}

/** What one invocation of the fake does. */
export type FakeCommand =
  | { kind: 'version' }
  | { kind: 'auth-status'; json: boolean }
  | { kind: 'agents'; json: boolean; all: boolean; cwd: string | null }
  | { kind: 'run'; args: RunArgs };

/** A usage error: printed to stderr, exit code 1 (like the real CLI's commander errors). */
export class UsageError extends Error {
  override name = 'UsageError';
}

function defaults(): RunArgs {
  return {
    print: false,
    prompt: null,
    inputFormat: 'text',
    outputFormat: 'text',
    verbose: false,
    model: null,
    effort: null,
    maxTurns: null,
    permissionMode: null,
    permissionPromptTool: null,
    allowedTools: [],
    settings: null,
    includeHookEvents: false,
    forwardSubagentText: false,
    replayUserMessages: false,
    sessionId: null,
    resume: null,
    forkSession: false,
    name: null,
    teleport: null,
  };
}

function choice(flag: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    throw new UsageError(`error: option '${flag}' argument '${value}' is invalid. Allowed choices are ${allowed.join(', ')}.`);
  }
  return value;
}

function parseSubcommandFlags(
  name: string,
  rest: readonly string[],
  known: Record<string, 'bool' | 'value'>,
): Map<string, string | true> {
  const found = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    const kind = known[arg];
    if (kind === undefined) throw new UsageError(`error: unknown option '${arg}' (claude ${name})`);
    if (kind === 'bool') {
      found.set(arg, true);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`error: option '${arg} <value>' argument missing`);
    found.set(arg, value);
    i++;
  }
  return found;
}

/**
 * Parses the fake's argv (everything after the script path). Accepts every flag
 * that appears in `fixtures/manifest.json` (scenarios and textRuns), plus
 * `--version`, `auth status` and `agents --json`. Anything else is a
 * {@link UsageError}, which the entry point turns into exit code 1.
 */
export function parseArgv(argv: readonly string[]): FakeCommand {
  if (argv[0] === 'auth') {
    if (argv[1] !== 'status') throw new UsageError(`error: unknown command 'auth ${argv[1] ?? ''}'`.trimEnd());
    const flags = parseSubcommandFlags('auth status', argv.slice(2), { '--json': 'bool', '--text': 'bool' });
    return { kind: 'auth-status', json: flags.has('--json') };
  }
  if (argv[0] === 'agents') {
    const flags = parseSubcommandFlags('agents', argv.slice(1), { '--json': 'bool', '--all': 'bool', '--cwd': 'value' });
    const cwd = flags.get('--cwd');
    return { kind: 'agents', json: flags.has('--json'), all: flags.has('--all'), cwd: typeof cwd === 'string' ? cwd : null };
  }

  const args = defaults();
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i] ?? '';
    let inline: string | undefined;
    if (flag.startsWith('--') && flag.includes('=')) {
      inline = flag.slice(flag.indexOf('=') + 1);
      flag = flag.slice(0, flag.indexOf('='));
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`error: option '${flag} <value>' argument missing`);
      i++;
      return next;
    };
    switch (flag) {
      case '-v':
      case '--version':
        return { kind: 'version' };
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--input-format':
        args.inputFormat = choice('--input-format <format>', value(), ['text', 'stream-json']) as RunArgs['inputFormat'];
        break;
      case '--output-format':
        args.outputFormat = choice('--output-format <format>', value(), ['text', 'stream-json']) as RunArgs['outputFormat'];
        break;
      case '--model':
        args.model = value();
        break;
      case '--effort':
        args.effort = value();
        break;
      case '--max-turns': {
        const raw = value();
        if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError(`error: option '--max-turns <turns>' argument '${raw}' is invalid.`);
        args.maxTurns = Number(raw);
        break;
      }
      case '--permission-mode':
        args.permissionMode = choice('--permission-mode <mode>', value(), PERMISSION_MODES);
        break;
      case '--permission-prompt-tool':
        args.permissionPromptTool = value();
        break;
      case '--allowedTools':
      case '--allowed-tools':
        args.allowedTools.push(value());
        break;
      case '--settings':
        args.settings = value();
        break;
      case '--include-hook-events':
        args.includeHookEvents = true;
        break;
      case '--forward-subagent-text':
        args.forwardSubagentText = true;
        break;
      case '--replay-user-messages':
        args.replayUserMessages = true;
        break;
      case '--session-id':
        args.sessionId = value();
        break;
      case '--resume':
        args.resume = value();
        break;
      case '--fork-session':
        args.forkSession = true;
        break;
      case '--name':
        args.name = value();
        break;
      case '--teleport':
        args.teleport = value();
        break;
      default:
        if (flag.startsWith('-') && flag !== '-') throw new UsageError(`error: unknown option '${flag}'`);
        if (args.prompt !== null) throw new UsageError('error: too many arguments. Expected 1 argument but got 2.');
        args.prompt = flag;
    }
  }
  if (args.teleport !== null && (args.resume !== null || args.sessionId !== null || args.forkSession)) {
    // The fake's own guard (D25): the local copy always gets a fresh id; the real CLI's answer to the mix was never probed.
    throw new UsageError('error: --teleport cannot be combined with --resume, --session-id or --fork-session (fake-claude)');
  }
  return { kind: 'run', args };
}
