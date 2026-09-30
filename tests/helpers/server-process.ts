import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { fakeOpenerEnv } from '../../tools/fake-opener/command.ts';
import { fakeTailscaleBinEnv } from '../../tools/fake-tailscale/command.ts';
import { REPO_ROOT, TEST_PORTS, freeTestPorts } from './net.ts';

/** The UI build E2E servers serve (`tests/e2e/global-setup.ts` builds it): never `dist/web`, which a running Switchboard may be serving. */
export const E2E_WEB_ROOT = path.join(REPO_ROOT, '.e2e-dist', 'web');

/** A spawned `node src/server/main.ts`. */
export interface SpawnedServer {
  readonly child: ChildProcess;
  /** stdout + stderr so far. */
  output(): string;
  /** Resolves with the exit code once the process has exited and its output is drained. */
  readonly closed: Promise<number | null>;
}

/** A started server (listening). */
export interface ServerProcess extends SpawnedServer {
  readonly port: number;
  readonly baseUrl: string;
  /** SIGTERM, then SIGKILL after 5 s; resolves with the exit code. */
  stop(): Promise<number | null>;
}

/**
 * Defaults every test server gets unless `env` sets them (M5.3): the fake CLIs, so
 * `GET /api/system` and the `system` hub event never run the real `claude` or `gh`
 * (AGENTS.md), and the setup wizard does not open by itself over the page a spec
 * drives (`tests/e2e/setup-wizard.spec.ts` turns it back on). D35: the fake
 * opener in front of the frame-helper setup's OS openers, so no test opens Chrome,
 * Finder or Explorer. D48: the fake Tailscale CLI (`tools/fake-tailscale`).
 * D55: the updater off (it would check GitHub releases at start).
 */
export function testServerDefaults(): Record<string, string> {
  return {
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    SWITCHBOARD_SETUP_WIZARD: 'off',
    SWITCHBOARD_WEB_ROOT: E2E_WEB_ROOT,
    SWITCHBOARD_OPEN_COMMAND: fakeOpenerEnv(),
    // D48: `tailscale ip -4` of the peer listener never runs the real CLI.
    SWITCHBOARD_TAILSCALE_BIN: fakeTailscaleBinEnv(),
    // D55: the updater never asks the real GitHub; tests/e2e/updates.spec.ts turns it on against a fake.
    SWITCHBOARD_UPDATES: 'off',
  };
}

/** Environment for a test server: the parent env without any SWITCHBOARD_*, the {@link testServerDefaults}, then `env`. */
export function testServerEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SWITCHBOARD_')) clean[key] = value;
  }
  return { ...clean, ...testServerDefaults(), ...env };
}

/** Spawns `node src/server/main.ts` with `env` and `SWITCHBOARD_PORT` = `port` (a raw string tests invalid values). */
export function spawnServer(port: number | string, env: Record<string, string>): SpawnedServer {
  const child = spawn(process.execPath, [path.join('src', 'server', 'main.ts')], {
    cwd: REPO_ROOT,
    env: testServerEnv({ ...env, SWITCHBOARD_PORT: String(port) }),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, output: () => output, closed };
}

function stopper(spawned: SpawnedServer): () => Promise<number | null> {
  return async () => {
    const { child } = spawned;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      const code = await spawned.closed;
      clearTimeout(killTimer);
      return code;
    }
    return spawned.closed;
  };
}

/**
 * The ports {@link startServer} tries: only `SWITCHBOARD_E2E_PORT` when it is set
 * (it must be one of the test ports, `TEST_PORTS`), else every free test port.
 */
export async function candidatePorts(env: NodeJS.ProcessEnv = process.env): Promise<number[]> {
  const pinned = env['SWITCHBOARD_E2E_PORT'];
  if (pinned !== undefined && pinned !== '') {
    const port = Number(pinned);
    if (!TEST_PORTS.includes(port)) throw new Error(`SWITCHBOARD_E2E_PORT must be one of ${TEST_PORTS.join(', ')}, got "${pinned}"`);
    return [port];
  }
  return freeTestPorts();
}

/** Waits until `spawned` listens on `port`, exits, or `timeoutMs` passes. */
function waitListening(spawned: SpawnedServer, port: number, timeoutMs: number): Promise<'up' | 'exited' | 'timeout'> {
  const listening = `Server listening at http://127.0.0.1:${port}`;
  return new Promise<'up' | 'exited' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    const check = (): void => {
      if (spawned.output().includes(listening)) {
        clearTimeout(timer);
        resolve('up');
      }
    };
    spawned.child.stdout?.on('data', check);
    spawned.child.stderr?.on('data', check);
    void spawned.closed.then(() => {
      clearTimeout(timer);
      resolve('exited');
    });
  });
}

/**
 * Starts the real server entry point on exactly `port` (one of `TEST_PORTS`), e.g.
 * to bring a stopped server back at the address a page still has open (D34's
 * offline page). Throws when it does not come up.
 */
export async function startServerOn(port: number, env: Record<string, string>, timeoutMs = 15_000): Promise<ServerProcess> {
  if (!TEST_PORTS.includes(port)) throw new Error(`port ${port} is not a test port (${TEST_PORTS.join(', ')})`);
  const spawned = spawnServer(port, env);
  const outcome = await waitListening(spawned, port, timeoutMs);
  if (outcome === 'up') return { ...spawned, port, baseUrl: `http://127.0.0.1:${port}`, stop: stopper(spawned) };
  await stopper(spawned)();
  throw new Error(`server did not start on ${port} (${outcome}):\n${spawned.output()}`);
}

/**
 * Starts the real server entry point on the first free test port (`TEST_PORTS`), or
 * on `SWITCHBOARD_E2E_PORT` when set, and waits for "Server listening". Retries the
 * next port if another test took it. `env` must point SWITCHBOARD_DATA_DIR at a
 * temp folder.
 */
export async function startServer(env: Record<string, string>, timeoutMs = 15_000): Promise<ServerProcess> {
  let lastOutput = '';
  for (const port of await candidatePorts()) {
    const spawned = spawnServer(port, env);
    const outcome = await waitListening(spawned, port, timeoutMs);
    lastOutput = spawned.output();
    if (outcome === 'up') {
      return { ...spawned, port, baseUrl: `http://127.0.0.1:${port}`, stop: stopper(spawned) };
    }
    if (outcome === 'timeout') {
      await stopper(spawned)();
      throw new Error(`server did not start on ${port} within ${timeoutMs} ms:\n${lastOutput}`);
    }
    if (!lastOutput.includes('EADDRINUSE')) break;
  }
  throw new Error(`server did not start on a free test port (${TEST_PORTS[0]}-${TEST_PORTS.at(-1)}):\n${lastOutput}`);
}
