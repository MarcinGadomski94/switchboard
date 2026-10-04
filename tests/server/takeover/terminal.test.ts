import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalAgentRow } from '../../../src/core/hooks.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { createSessionServices } from '../../../src/server/app.ts';
import { HookError, HookService } from '../../../src/server/hooks/service.ts';
import { processAlive, stopProcess } from '../../../src/server/hooks/terminal-stop.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { HOOK_TOKEN_FILE } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { assistantTextLine, lastUuid, terminalUserLine, writeTranscript } from '../../helpers/transcripts.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over* → *Hooked terminal sessions*):
 * stopping a terminal's `claude` after its conversation and files were captured.
 * The approach per OS (SIGTERM then SIGKILL; `taskkill /T` then `/F`) with the
 * signals replaced, and the real thing on a harmless child process: only the
 * process the live registry names for the session is stopped.
 */

const CS = '5d3a7a38-aaaa-4bbb-8ccc-0123456789ab';

let children: ChildProcess[] = [];
let cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  children = [];
  for (const run of cleanup.reverse()) await run();
  cleanup = [];
});

/** A process that does nothing until it is stopped (a stand-in for the terminal's claude). */
function fakeTerminal(): { readonly child: ChildProcess; readonly exited: Promise<string> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
  children.push(child);
  const exited = new Promise<string>((resolve) => child.once('exit', (code, signal) => resolve(signal ?? String(code))));
  return { child, exited };
}

describe('stopProcess: the approach per OS', () => {
  it('macOS / Linux: SIGTERM first, SIGKILL only when it survives the grace time', async () => {
    const sent: string[] = [];
    let alive = true;
    // Leaves at SIGTERM.
    expect(
      await stopProcess(4242, {
        platform: 'darwin',
        graceMs: 200,
        alive: () => alive,
        signal: (_pid, signal) => {
          sent.push(signal);
          alive = false;
        },
      }),
    ).toBe('terminated');
    expect(sent).toEqual(['SIGTERM']);
    // Ignores SIGTERM: killed.
    sent.length = 0;
    alive = true;
    expect(
      await stopProcess(4242, {
        platform: 'linux',
        graceMs: 120,
        alive: () => alive,
        signal: (_pid, signal) => {
          sent.push(signal);
          if (signal === 'SIGKILL') alive = false;
        },
      }),
    ).toBe('killed');
    expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    // Already gone: nothing is sent.
    sent.length = 0;
    expect(await stopProcess(4242, { platform: 'linux', alive: () => false, signal: (_pid, signal) => sent.push(signal) })).toBe('gone');
    expect(sent).toEqual([]);
  });

  it('Windows: taskkill /T asks it to close, taskkill /F after the grace time', async () => {
    const calls: boolean[] = [];
    let alive = true;
    expect(await stopProcess(77, { platform: 'win32', graceMs: 100, alive: () => alive, taskkill: async (_pid, force) => { calls.push(force); if (force) alive = false; } })).toBe('killed');
    expect(calls).toEqual([false, true]);
    calls.length = 0;
    alive = true;
    expect(await stopProcess(77, { platform: 'win32', graceMs: 500, alive: () => alive, taskkill: async (_pid, force) => { calls.push(force); alive = false; } })).toBe('terminated');
    expect(calls).toEqual([false]);
  });

  it('refuses a pid that is not a process id and reports a process that will not die', async () => {
    await expect(stopProcess(0)).rejects.toThrow('not a process id');
    await expect(stopProcess(1)).rejects.toThrow('not a process id');
    await expect(stopProcess(4242, { platform: 'linux', graceMs: 50, alive: () => true, signal: () => undefined })).rejects.toThrow('still running after SIGKILL');
  }, 10_000);

  it('stops a real process with SIGTERM', async () => {
    const { child, exited } = fakeTerminal();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processAlive(child.pid as number)).toBe(true);
    expect(await stopProcess(child.pid as number, { graceMs: 5_000 })).toBe('terminated');
    expect(await exited).toBe('SIGTERM');
    expect(processAlive(child.pid as number)).toBe(false);
  });
});

async function rig(rows: () => TerminalAgentRow[] | null): Promise<{ readonly hooks: HookService; readonly store: Store; readonly sessionId: string; readonly cwd: string }> {
  const root = await makeTempDir('takeover-terminal');
  cleanup.push(() => removeTempDir(root));
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'claude-config');
  const cwd = path.join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const store = await openTempStore(dataDir);
  cleanup.push(() => store.close());
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: 4961 };
  const bus = new HubBus();
  const { questions } = createSessionServices(config, store, bus);
  const hooks = new HookService({
    config,
    store,
    bus,
    questions,
    hookTokenFile: path.join(dataDir, HOOK_TOKEN_FILE),
    env: { CLAUDE_CONFIG_DIR: configDir },
    listAgents: async () => rows(),
    cliVersion: async () => '2.1.284 (Claude Code)',
    stop: { graceMs: 5_000 },
  });
  cleanup.push(() => hooks.close());
  const lines = [terminalUserLine({ sessionId: CS, cwd, content: 'Refactor.', parentUuid: null, timestamp: '2026-10-04T10:00:00.000Z' })];
  lines.push(assistantTextLine({ sessionId: CS, cwd, text: 'Done.', parentUuid: lastUuid(lines), timestamp: '2026-10-04T10:00:05.000Z' }));
  await writeTranscript(configDir, cwd, CS, lines);
  return { hooks, store, sessionId: '', cwd };
}

describe('HookService.stopTerminal', () => {
  it('stops the process the registry names for the hooked session, after verifying pid and session id', async () => {
    const { child, exited } = fakeTerminal();
    const holder: { rows: TerminalAgentRow[] | null } = { rows: [] };
    const world = await rig(() => holder.rows);
    holder.rows = [{ pid: child.pid as number, sessionId: CS, cwd: world.cwd, kind: 'interactive', name: 'term', status: 'idle', waitingFor: null, startedAt: Date.now() }];
    const { session } = await world.hooks.hook(CS);
    expect(await world.hooks.terminalPid(session.id)).toBe(child.pid);
    const stopped = await world.hooks.stopTerminal(session.id);
    expect(stopped).toEqual({ pid: child.pid, how: 'terminated' });
    expect(await exited).toBe('SIGTERM');
  });

  it('touches nothing when the registry has no such session (a reused pid) or cannot be read', async () => {
    const { child } = fakeTerminal();
    const holder: { rows: TerminalAgentRow[] | null } = { rows: [] };
    const world = await rig(() => holder.rows);
    holder.rows = [{ pid: child.pid as number, sessionId: CS, cwd: world.cwd, kind: 'interactive', name: 'term', status: 'idle', waitingFor: null, startedAt: Date.now() }];
    const { session } = await world.hooks.hook(CS);
    // The pid now belongs to another session: not ours to stop.
    holder.rows = [{ pid: child.pid as number, sessionId: 'someone-else', cwd: world.cwd, kind: 'interactive', name: 'x', status: 'idle', waitingFor: null, startedAt: Date.now() }];
    expect(await world.hooks.stopTerminal(session.id)).toEqual({ pid: null, how: 'gone' });
    expect(processAlive(child.pid as number)).toBe(true);
    // The registry cannot be read: nothing is stopped, and it says why.
    holder.rows = null;
    await expect(world.hooks.stopTerminal(session.id)).rejects.toMatchObject({ status: 502, code: 'agents-unavailable' } satisfies Partial<HookError>);
    expect(processAlive(child.pid as number)).toBe(true);
    // Not a hooked session.
    const plain = await world.store.sessions.create({ name: 'plain', claudeSessionId: 'plain-1' });
    await expect(world.hooks.stopTerminal(plain.id)).rejects.toMatchObject({ status: 404, code: 'not-hooked' });
    expect(await world.hooks.terminalPid(plain.id)).toBeNull();
  });
});
