import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, freeTestPorts } from './net.ts';

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

/** Environment for a test server: the parent env without any SWITCHBOARD_* plus `env`. */
export function testServerEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SWITCHBOARD_')) clean[key] = value;
  }
  return { ...clean, ...env };
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
 * Starts the real server entry point on the first free test port (4871–4879) and
 * waits for "Server listening". Retries the next port if another test took it.
 * `env` must point SWITCHBOARD_DATA_DIR at a temp folder.
 */
export async function startServer(env: Record<string, string>, timeoutMs = 15_000): Promise<ServerProcess> {
  let lastOutput = '';
  for (const port of await freeTestPorts()) {
    const spawned = spawnServer(port, env);
    const listening = `Server listening at http://127.0.0.1:${port}`;
    const outcome = await new Promise<'up' | 'exited' | 'timeout'>((resolve) => {
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
  throw new Error(`server did not start on a free test port (4871-4879):\n${lastOutput}`);
}
