import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { NewSession } from '../../src/core/api.ts';
import type { SessionStatus } from '../../src/core/model.ts';
import type { EventRecord } from '../../src/server/db/repos/events.ts';
import type { SessionRecord } from '../../src/server/db/repos/sessions.ts';
import type { Store } from '../../src/server/db/store.ts';
import type { FolderRef } from '../../src/server/folders/ref.ts';
import { type LiveProcessLister, claudeAgentsLister } from '../../src/server/supervisor/recovery.ts';
import { type ControlRequestHandler, type SessionPlace, SessionSupervisor, type StopTimeouts } from '../../src/server/supervisor/supervisor.ts';
import { folderRef } from './folders.ts';
import { fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { fakeCodexCommand } from '../../tools/fake-codex/command.ts';
import { fakeOpencodeCommand } from '../../tools/fake-opencode/command.ts';
import { CliRegistry } from '../../src/server/cli/registry.ts';
import { makeTempDir, removeTempDir } from './net.ts';
import { openTempStore } from './store.ts';

/** A temp world for supervisor tests: workspace root, CLAUDE_CONFIG_DIR, fake log, store, supervisor. */
export interface SupervisorWorld {
  readonly root: string;
  /** Canonical workspace root (the sessions' cwd). */
  readonly workspace: string;
  /** D14: the workspace as a folder (not saved: `id` null). */
  readonly folder: FolderRef;
  /** D14: where `supervisor.start` runs a session of this world: the workspace folder, cwd = its root. */
  readonly place: SessionPlace;
  readonly configDir: string;
  readonly logFile: string;
  /** D62: the fake Codex CLI's `CODEX_HOME` (its threads' rollout files) and log. */
  readonly codexHome: string;
  readonly codexLog: string;
  /** D62: the fake OpenCode's `XDG_DATA_HOME` (its sessions) and log. */
  readonly opencodeData: string;
  readonly opencodeLog: string;
  readonly store: Store;
  /** The children's base env; tests change `FAKE_CLAUDE_SCENARIO` between spawns. */
  readonly env: NodeJS.ProcessEnv;
  readonly supervisor: SessionSupervisor;
  readonly errors: unknown[];
  cleanup(): Promise<void>;
}

/** Options for {@link makeSupervisorWorld}. */
export interface WorldOptions {
  readonly scenario?: string;
  readonly command?: readonly string[];
  readonly timeouts?: Partial<StopTimeouts>;
  readonly controlHandler?: ControlRequestHandler;
  /** Extra variables in the parent env (e.g. CLAUDECODE to prove the scrub). */
  readonly parentEnv?: Record<string, string>;
  readonly extraArgs?: readonly string[];
  /** The Attach warning's live-process list; default `claude agents --json` of the world's CLI, `null` = none (liveness unknown). */
  readonly listLive?: LiveProcessLister | null;
  /** D25: how long a `--teleport` process may take to report `system/init` (the supervisor's default when omitted). */
  readonly teleportInitTimeoutMs?: number;
}

/** Parent env without CODEX* / OPENCODE* / FAKE_* of the other fakes either (D62). */
function withoutProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('CODEX') && !key.startsWith('OPENCODE') && !key.startsWith('FAKE_CODEX_') && !key.startsWith('FAKE_OPENCODE_')) out[key] = value;
  }
  return out;
}

/** Parent env without CLAUDE* / FAKE_CLAUDE_* (the test runner may run inside Claude Code). */
function cleanParentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('CLAUDE') && !key.startsWith('FAKE_CLAUDE_')) env[key] = value;
  }
  return env;
}

export async function makeSupervisorWorld(options: WorldOptions = {}): Promise<SupervisorWorld> {
  const root = await realpath(await makeTempDir('supervisor'));
  const workspace = path.join(root, 'work space');
  const configDir = path.join(root, 'claude-config');
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const logFile = path.join(root, 'fake.log');
  const codexHome = path.join(root, 'codex-home');
  const opencodeData = path.join(root, 'opencode-data');
  const codexLog = path.join(root, 'fake-codex.log');
  const opencodeLog = path.join(root, 'fake-opencode.log');
  await mkdir(codexHome, { recursive: true });
  await mkdir(opencodeData, { recursive: true });
  const store = await openTempStore(root);
  const env: NodeJS.ProcessEnv = {
    ...withoutProviderEnv(cleanParentEnv()),
    ...options.parentEnv,
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_CLAUDE_LOG: logFile,
    // D62: the fake Codex / OpenCode keep their state in the world (never the home folder).
    CODEX_HOME: codexHome,
    FAKE_CODEX_LOG: codexLog,
    XDG_DATA_HOME: opencodeData,
    FAKE_OPENCODE_LOG: opencodeLog,
    ...(options.scenario ? { FAKE_CLAUDE_SCENARIO: options.scenario } : {}),
  };
  const errors: unknown[] = [];
  const claudeCommand = options.command ?? fakeClaudeCommand();
  const supervisor = new SessionSupervisor({
    store,
    // D62: the fakes stand in for every CLI (tests never run a real one).
    providers: new CliRegistry({ commands: { claude: claudeCommand, codex: fakeCodexCommand(), opencode: fakeOpencodeCommand() }, settings: store.settings }),
    claudeCommand,
    claudeExtraArgs: options.extraArgs ?? [],
    env,
    // M4.1: the Attach warning's `claude agents --json` through the same CLI (the fake lists its live-process files).
    listLive: options.listLive === undefined ? claudeAgentsLister({ claudeCommand, env }) : options.listLive ?? undefined,
    timeouts: { ack: 3_000, result: 5_000, exit: 5_000, signal: 2_000, ...options.timeouts },
    ...(options.controlHandler ? { controlHandler: options.controlHandler } : {}),
    ...(options.teleportInitTimeoutMs !== undefined ? { teleportInitTimeoutMs: options.teleportInitTimeoutMs } : {}),
    onError: (error) => errors.push(error),
  });
  const folder = folderRef(workspace);
  return {
    root,
    workspace,
    folder,
    place: { folder, cwd: workspace },
    configDir,
    logFile,
    codexHome,
    codexLog,
    opencodeData,
    opencodeLog,
    store,
    env,
    supervisor,
    errors,
    async cleanup() {
      await supervisor.shutdown();
      await store.close();
      await removeTempDir(root);
    },
  };
}

/** A valid NewSession (feature, single, one solution, no worktrees). */
export function newSession(overrides: Partial<NewSession> = {}): NewSession {
  return {
    name: 'demo-session',
    task: 'Remember the code word: zeppelin. Reply with just OK.',
    workType: 'feature',
    mode: 'single',
    solutions: ['acme-app-front'],
    phase: 'ui-first',
    coordination: 'none',
    qa: null,
    worktrees: false,
    ultracode: false,
    ...overrides,
  };
}

/** Polls until `check` returns a value (not `undefined`/`false`), or throws after `timeoutMs`. */
export async function until<T>(check: () => Promise<T | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    last = value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${String(last)})`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits until the session has one of `statuses`. */
export function waitForStatus(store: Store, id: string, statuses: readonly SessionStatus[], timeoutMs = 10_000): Promise<SessionRecord> {
  return until(async () => {
    const session = await store.sessions.get(id);
    return session && statuses.includes(session.status) ? session : undefined;
  }, `status ${statuses.join('|')} of ${id}`, timeoutMs);
}

/** Waits for the first event matching `predicate`. */
export function waitForEvent(store: Store, id: string, predicate: (event: EventRecord) => boolean, timeoutMs = 10_000): Promise<EventRecord> {
  return until(async () => (await store.events.list(id)).find(predicate), `an event of ${id}`, timeoutMs);
}

/** `payload.type` of an event. */
export function payloadType(event: EventRecord): string {
  return String((event.payload as { type?: unknown } | null)?.type);
}

/** One line of the fake's FAKE_CLAUDE_LOG. */
export interface FakeLogLine {
  readonly kind: 'argv' | 'stdin';
  readonly pid: number;
  readonly cwd?: string;
  readonly argv?: string[];
  readonly env?: Record<string, string>;
  readonly claudeEnvKeys?: string[];
  readonly line?: string;
}

/** The fake's log so far. */
export async function readFakeLog(file: string): Promise<FakeLogLine[]> {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FakeLogLine);
}

/** The argv entries of the fake's log, one per spawned process, in order. */
export async function spawnedArgv(file: string): Promise<FakeLogLine[]> {
  return (await readFakeLog(file)).filter((line) => line.kind === 'argv');
}

/** `true` for the `initialize` control request the supervisor writes first to every process (D24, the Remote Control handshake). */
export function isHandshake(line: Record<string, unknown>): boolean {
  return line['type'] === 'control_request' && (line['request'] as { subtype?: unknown } | undefined)?.subtype === 'initialize';
}

/**
 * The stdin lines one process received, parsed, without the spawn handshake
 * (`initialize`, D24: every process gets it first; {@link isHandshake}), unless
 * `options.all`.
 */
export async function stdinOf(file: string, pid: number, options: { readonly all?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  return (await readFakeLog(file))
    .filter((line) => line.kind === 'stdin' && line.pid === pid && typeof line.line === 'string')
    .map((line) => JSON.parse(line.line as string) as Record<string, unknown>)
    .filter((line) => options.all === true || !isHandshake(line));
}
