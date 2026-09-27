import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { NewSession } from '../../src/core/api.ts';
import type { SessionStatus } from '../../src/core/model.ts';
import type { EventRecord } from '../../src/server/db/repos/events.ts';
import type { SessionRecord } from '../../src/server/db/repos/sessions.ts';
import type { Store } from '../../src/server/db/store.ts';
import { type ControlRequestHandler, SessionSupervisor, type StopTimeouts } from '../../src/server/supervisor/supervisor.ts';
import { fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from './net.ts';
import { openTempStore } from './store.ts';

/** A temp world for supervisor tests: workspace root, CLAUDE_CONFIG_DIR, fake log, store, supervisor. */
export interface SupervisorWorld {
  readonly root: string;
  /** Canonical workspace root (the sessions' cwd). */
  readonly workspace: string;
  readonly configDir: string;
  readonly logFile: string;
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
  const store = await openTempStore(root);
  const env: NodeJS.ProcessEnv = {
    ...cleanParentEnv(),
    ...options.parentEnv,
    CLAUDE_CONFIG_DIR: configDir,
    FAKE_CLAUDE_LOG: logFile,
    ...(options.scenario ? { FAKE_CLAUDE_SCENARIO: options.scenario } : {}),
  };
  const errors: unknown[] = [];
  const supervisor = new SessionSupervisor({
    store,
    claudeCommand: options.command ?? fakeClaudeCommand(),
    claudeExtraArgs: options.extraArgs ?? [],
    workspaceRoot: workspace,
    env,
    timeouts: { ack: 3_000, result: 5_000, exit: 5_000, signal: 2_000, ...options.timeouts },
    ...(options.controlHandler ? { controlHandler: options.controlHandler } : {}),
    onError: (error) => errors.push(error),
  });
  return {
    root,
    workspace,
    configDir,
    logFile,
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

/** The stdin lines one process received, parsed. */
export async function stdinOf(file: string, pid: number): Promise<Array<Record<string, unknown>>> {
  return (await readFakeLog(file))
    .filter((line) => line.kind === 'stdin' && line.pid === pid && typeof line.line === 'string')
    .map((line) => JSON.parse(line.line as string) as Record<string, unknown>);
}
