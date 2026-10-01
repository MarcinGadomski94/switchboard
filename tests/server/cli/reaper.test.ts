import { type ChildProcess, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * The orphan reaper (`src/server/cli/reaper.ts`, OPEN D62-orphan-opencode): a
 * stand-in for Switchboard registers a server (one that ignores its stdin, as
 * `opencode serve` does, with a child of its own) and is then SIGKILLed, so its
 * own shutdown never runs. The reaper stops the server's whole process group; a
 * server Switchboard unregistered is left alone.
 */

const REAPER = path.resolve(import.meta.dirname, '../../../src/server/cli/reaper.ts');
const posix = process.platform !== 'win32';

let tmp: string;
const spawned: ChildProcess[] = [];
const pids: number[] = [];

beforeEach(async () => {
  tmp = await makeTempDir('reaper');
});
afterEach(async () => {
  for (const child of spawned) child.kill('SIGKILL');
  spawned.length = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  pids.length = 0;
  await removeTempDir(tmp);
});

/** Starts the stand-in; resolves with the server's pid and its child's pid once registered. */
async function standIn(unregister: boolean): Promise<{ readonly parent: ChildProcess; readonly server: number; readonly grandchild: number }> {
  const script = path.join(tmp, 'switchboard-stand-in.ts');
  await writeFile(
    script,
    `import { spawn } from 'node:child_process';
import { registerServer, serverSpawnOptions, unregisterServer } from ${JSON.stringify(REAPER)};
const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
const server = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], ...serverSpawnOptions });
server.stdout.setEncoding('utf8');
server.stdout.once('data', (chunk) => {
  registerServer(server.pid);
  if (${unregister}) unregisterServer(server.pid);
  setTimeout(() => console.log(JSON.stringify({ server: server.pid, grandchild: Number(chunk.trim()) })), 300);
});
setInterval(() => {}, 1000);
`,
  );
  const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  spawned.push(parent);
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    parent.stdout?.setEncoding('utf8');
    parent.stdout?.on('data', (chunk: string) => {
      out += chunk;
      if (out.includes('\n')) resolve(out.trim());
    });
    parent.once('exit', () => reject(new Error(`stand-in exited: ${out}`)));
  });
  const { server, grandchild } = JSON.parse(line) as { server: number; grandchild: number };
  pids.push(server, grandchild);
  return { parent, server, grandchild };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

describe.runIf(posix)('the orphan reaper (OPEN D62-orphan-opencode)', () => {
  it('a SIGKILLed Switchboard: its registered server and that server’s child are stopped', async () => {
    const { parent, server, grandchild } = await standIn(false);
    expect(alive(server) && alive(grandchild)).toBe(true);
    parent.kill('SIGKILL');
    expect(await goneWithin(server, 5_000)).toBe(true);
    expect(await goneWithin(grandchild, 5_000)).toBe(true);
  });

  it('a server Switchboard unregistered (it stopped it itself) is left alone', async () => {
    const { parent, server } = await standIn(true);
    parent.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(alive(server)).toBe(true);
  });
});
