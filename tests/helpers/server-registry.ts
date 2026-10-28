import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every test server (`node src/server/main.ts`) a test process spawns, so none
 * outlives its test run (CONTRIBUTING.md → *Test servers never outlive a run*).
 *
 * A server is tracked synchronously at spawn, before anything awaits its start, so
 * a test or hook that times out while `startServer` / `pairedNodes` is still
 * waiting cannot lose it. On POSIX each server leads its own process group
 * (`detached: true`), so a stop can take the server and everything it started
 * (`process.kill(-pgid)`); on Windows `taskkill /T` takes the tree.
 *
 * Four nets, from the narrowest:
 * 1. `stopServersUnder(dir)`: `removeTempDir` / `removeWorld` stop the servers whose
 *    data folder is inside the folder they remove, and refuse new ones there.
 * 2. `stopAllServers()`: an `afterAll` of every Vitest file (`tests/helpers/vitest-setup.ts`).
 * 3. `exit` / `SIGINT` / `SIGTERM` / `SIGHUP` of the test process: SIGKILL every group still alive.
 * 4. A pid file per server in the run's folder (`SWITCHBOARD_TEST_RUN_DIR`, made by the Vitest
 *    and Playwright global setups); the global teardown kills what is still listed there. Only
 *    this run's files: never another run's servers, never the developer's Switchboard.
 */

/** The env var naming this run's pid-file folder (set by the global setups). */
export const TEST_RUN_DIR_ENV = 'SWITCHBOARD_TEST_RUN_DIR';

/** What a pid file holds. */
export interface ServerPidFile {
  readonly pid: number;
  /** The process group (= `pid` on POSIX, where the server leads its own group). */
  readonly pgid: number | null;
  readonly dataDir: string | null;
  readonly cwd: string;
  /** The test process that spawned it. */
  readonly owner: number;
}

interface Tracked {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly group: boolean;
  readonly dataDir: string | null;
  readonly pidFile: string | null;
  exited: boolean;
  /** The running stop, so a second stop (the per-test one, then a sweep) waits for the same one. */
  stopping: Promise<number | null> | null;
  readonly closed: Promise<number | null>;
}

interface Registry {
  readonly servers: Map<number, Tracked>;
  readonly closedRoots: Set<string>;
  readonly spawnListeners: Set<(pid: number) => void>;
  stopGraceMs: number;
  handlersInstalled: boolean;
}

// One registry per test process: Vitest re-evaluates helpers per file in a reused worker,
// and the exit / signal handlers must be installed once.
const KEY = Symbol.for('switchboard.test-server-registry');
const registry: Registry = ((globalThis as Record<symbol, unknown>)[KEY] as Registry | undefined) ?? {
  servers: new Map(),
  closedRoots: new Set(),
  spawnListeners: new Set(),
  stopGraceMs: 5_000,
  handlersInstalled: false,
};
(globalThis as Record<symbol, unknown>)[KEY] = registry;

const POSIX = process.platform !== 'win32';

/** Whether a server should lead its own process group (`spawn`'s `detached`): POSIX only. */
export const SERVER_DETACHED = POSIX;

/** How long {@link stopTrackedServer} waits after SIGTERM before SIGKILL (tests of the registry shorten it). */
export function setStopGraceMs(ms: number): void {
  registry.stopGraceMs = ms;
}

/** Calls `listener` with each server pid as it is spawned; returns the unsubscribe. */
export function onServerSpawned(listener: (pid: number) => void): () => void {
  registry.spawnListeners.add(listener);
  return () => registry.spawnListeners.delete(listener);
}

function isInside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Throws when `dataDir` is inside a folder a test already removed (a late start of a timed-out test). */
export function assertSpawnAllowed(dataDir: string | null): void {
  if (dataDir === null) return;
  for (const root of registry.closedRoots) {
    if (isInside(path.resolve(dataDir), root)) throw new Error(`refusing to start a test server in ${dataDir}: its temp folder ${root} was already cleaned up`);
  }
}

/** Sends `signal` to the server's whole group (POSIX) or tree (Windows); quiet when it is gone. */
function signalTree(entry: Pick<Tracked, 'pid' | 'group'>, signal: NodeJS.Signals): void {
  if (!POSIX) {
    if (signal === 'SIGKILL') {
      // Sync on purpose: also used from `exit`, where nothing async runs.
      spawnSync('taskkill', ['/PID', String(entry.pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(entry.pid, signal);
      } catch {
        // gone
      }
    }
    return;
  }
  try {
    process.kill(entry.group ? -entry.pid : entry.pid, signal);
  } catch {
    // ESRCH: the group is gone.
  }
}

function groupAlive(entry: Pick<Tracked, 'pid' | 'group'>): boolean {
  try {
    process.kill(POSIX && entry.group ? -entry.pid : entry.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function forget(entry: Tracked): void {
  registry.servers.delete(entry.pid);
  if (entry.pidFile) rmSync(entry.pidFile, { force: true });
}

function killNow(entry: Tracked): void {
  signalTree(entry, 'SIGKILL');
  forget(entry);
}

function installHandlers(): void {
  if (registry.handlersInstalled) return;
  registry.handlersInstalled = true;
  process.on('exit', () => {
    for (const entry of [...registry.servers.values()]) killNow(entry);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = (): void => {
      for (const entry of [...registry.servers.values()]) killNow(entry);
      // Keep the default "die on this signal" unless someone else (the runner) handles it.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.once(signal, onSignal);
  }
}

/**
 * Tracks a just-spawned server. Call it synchronously right after `spawn`, before any
 * `await`. `closed` resolves once its process has exited and its output is drained.
 */
export function trackServer(child: ChildProcess, dataDir: string | null, cwd: string, closed: Promise<number | null>): void {
  const pid = child.pid;
  if (pid === undefined) return; // spawn failed; nothing runs
  installHandlers();
  let pidFile: string | null = null;
  const runDir = process.env[TEST_RUN_DIR_ENV];
  if (runDir) {
    mkdirSync(runDir, { recursive: true });
    pidFile = path.join(runDir, `${pid}.json`);
    const record: ServerPidFile = { pid, pgid: SERVER_DETACHED ? pid : null, dataDir, cwd, owner: process.pid };
    writeFileSync(pidFile, JSON.stringify(record));
  }
  const entry: Tracked = { child, pid, group: SERVER_DETACHED, dataDir: dataDir === null ? null : path.resolve(dataDir), pidFile, exited: false, stopping: null, closed };
  registry.servers.set(pid, entry);
  child.once('exit', () => {
    entry.exited = true;
    // Its group may still hold what it started; a sweep takes those. An empty group is done.
    if (!groupAlive(entry)) forget(entry);
  });
  for (const listener of registry.spawnListeners) listener(pid);
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref());
}

/**
 * Stops a tracked server: SIGTERM to the server (it closes the app and exits 0), then,
 * if it has not closed within the grace, SIGKILL to its whole group. Never waits
 * forever: a server whose output never drains resolves `null` after the SIGKILL.
 * @param sweep also SIGKILL whatever is left of its group once it exited (the end-of-file / run sweeps).
 */
export function stopTrackedServer(pid: number, sweep = false): Promise<number | null> {
  const entry = registry.servers.get(pid);
  if (!entry) return Promise.resolve(null);
  entry.stopping ??= (async () => {
    if (!entry.exited) {
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // gone
      }
    }
    let code = await Promise.race([entry.closed, delay(registry.stopGraceMs)]);
    if (code === 'timeout') {
      signalTree(entry, 'SIGKILL');
      code = await Promise.race([entry.closed, delay(3_000)]);
    }
    return code === 'timeout' ? null : code;
  })();
  const stopping = entry.stopping;
  return stopping.then((code) => {
    if (sweep && groupAlive(entry)) signalTree(entry, 'SIGKILL');
    if (sweep || !groupAlive(entry)) forget(entry);
    return code;
  });
}

/** Stops every server whose data folder is inside `root`, and refuses new ones there (the folder is being removed). */
export async function stopServersUnder(root: string): Promise<void> {
  const resolved = path.resolve(root);
  registry.closedRoots.add(resolved);
  const inside = [...registry.servers.values()].filter((entry) => entry.dataDir !== null && isInside(entry.dataDir, resolved));
  await Promise.all(inside.map((entry) => stopTrackedServer(entry.pid, true)));
}

/** Stops every server this test process still tracks (and SIGKILLs what is left of their groups); returns the pids it found. */
export async function stopAllServers(): Promise<number[]> {
  const entries = [...registry.servers.values()];
  await Promise.all(entries.map((entry) => stopTrackedServer(entry.pid, true)));
  return entries.map((entry) => entry.pid);
}

/** The pids this test process still tracks (running, or with a group still alive). */
export function trackedServerPids(): number[] {
  return [...registry.servers.keys()];
}

/** The command line of `pid` (POSIX `ps`), or `null` when it is gone. */
async function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-o', 'command=', '-p', String(pid)], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', () => resolve(null));
    child.once('close', () => resolve(out.trim() || null));
  });
}

/**
 * The global teardown's net: kills what this run's pid files (in `runDir`) still list,
 * then removes the folder. Only those pids / groups: a live leader must still be a
 * `src/server/main.ts`; a gone leader's group still alive can only hold its children.
 * @returns the pids it had to kill.
 */
export async function killLeftoversOfRun(runDir: string): Promise<number[]> {
  let names: string[] = [];
  try {
    names = readdirSync(runDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const killed: number[] = [];
  for (const name of names) {
    let record: ServerPidFile;
    try {
      record = JSON.parse(readFileSync(path.join(runDir, name), 'utf8')) as ServerPidFile;
    } catch {
      continue;
    }
    const entry = { pid: record.pid, group: record.pgid !== null };
    if (!groupAlive(entry)) continue;
    if (POSIX) {
      let leaderAlive = true;
      try {
        process.kill(record.pid, 0);
      } catch {
        leaderAlive = false;
      }
      if (leaderAlive) {
        const command = await commandOf(record.pid);
        if (command === null || !command.includes(path.join('src', 'server', 'main.ts'))) continue; // pid reused: not ours
      }
    }
    signalTree(entry, 'SIGKILL');
    killed.push(record.pid);
  }
  rmSync(runDir, { recursive: true, force: true });
  return killed;
}
