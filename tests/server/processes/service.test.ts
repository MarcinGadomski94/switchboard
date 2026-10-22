import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { SESSION_MARKER_ENV } from '../../../src/core/processes.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { processAlive } from '../../../src/server/hooks/terminal-stop.ts';
import { platformScanner } from '../../../src/server/processes/scan.ts';
import { KEEP_SETTING, ProcessService, type ProcessSessions } from '../../../src/server/processes/service.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D127 (`docs/processes.md`): the process tracker against real processes on this machine:
 * dummy `node` sleepers this test starts (and kills in `afterEach`), some carrying a session's
 * marker the way a CLI's descendants do, one without it. Nothing else is ever signalled: the
 * tracker only acts on its own store's sessions, and every pid it stops is one of these.
 */

const POSIX = process.platform === 'darwin' || process.platform === 'linux';

/** Every pid this test started (killed in `afterEach`, whatever happened). */
const started = new Set<number>();

function sleeper(env: NodeJS.ProcessEnv, options: { readonly ignoreTerm?: boolean } = {}): Promise<ChildProcess> {
  const code = options.ignoreTerm ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')" : "setTimeout(() => {}, 120000); console.log('ready')";
  const child = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  if (child.pid) started.add(child.pid);
  return new Promise((resolve, reject) => {
    child.stdout?.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

/** A parent that starts a detached grandchild with its environment and exits at once: the grandchild's pid. */
async function orphan(env: NodeJS.ProcessEnv): Promise<number> {
  const code = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', env: process.env }); c.unref(); console.log(c.pid);";
  const parent = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (parent.pid) started.add(parent.pid);
  let out = '';
  parent.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  await new Promise((resolve) => parent.once('close', resolve));
  const pid = Number(out.trim());
  started.add(pid);
  return pid;
}

function markerEnv(sessionId: string): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], [SESSION_MARKER_ENV]: sessionId };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out: ${what}`);
}

describe.skipIf(!POSIX)('D127 · the process tracker (real dummy processes)', () => {
  let dir: string;
  let store: Store;
  let service: ProcessService;
  let notes: Array<{ sessionId: string; label: string; payload: LifecyclePayload }>;

  function make(options: { readonly idleDelayMs?: number; readonly graceMs?: number } = {}): ProcessService {
    const sessions: ProcessSessions = {
      livePid: () => null,
      activity: () => null,
      liveSessionIds: () => [],
      record: async (sessionId, label, payload) => {
        notes.push({ sessionId, label, payload });
      },
    };
    service = new ProcessService({ store, sessions, scanner: platformScanner(), idleDelayMs: options.idleDelayMs ?? 60 * 60_000, graceMs: options.graceMs ?? 2_000, onError: () => undefined });
    return service;
  }

  async function session(): Promise<string> {
    const record = await store.sessions.create({ name: `procs-${randomUUID().slice(0, 8)}`, claudeSessionId: randomUUID(), solutions: [], worktrees: false });
    await store.sessions.update(record.id, { status: 'done', lastActivityAt: new Date().toISOString() });
    return record.id;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sb-procs-'));
    store = await openTempStore(dir);
    notes = [];
  });

  afterEach(async () => {
    await service?.close();
    for (const pid of started) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    started.clear();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('finds a marked process after its parent exits, and never one without the marker', async () => {
    const id = await session();
    make();
    const left = await orphan(markerEnv(id));
    const unmarked = await sleeper({ PATH: process.env['PATH'] });
    const view = await service.forSession(id, { fresh: true });
    expect(view.tracking).toBe('marker');
    expect(view.processes.map((p) => p.pid)).toEqual([left]);
    expect(view.processes[0]).toMatchObject({ name: 'node -e', kind: 'other', keep: false });
    expect(view.processes[0]?.rssBytes).toBeGreaterThan(0);
    expect(view.processes.some((p) => p.pid === unmarked.pid)).toBe(false);
    expect((await service.overview()).map((s) => s.sessionId)).toEqual([id]);
    expect(service.totals()).toMatchObject({ count: 1 });
  });

  it('idle ≥ the delay: stops the leftovers, keeps the kept one, notes it on the timeline; never the unmarked one', async () => {
    const id = await session();
    make({ idleDelayMs: 1_000 });
    const a = await sleeper(markerEnv(id));
    const b = await sleeper(markerEnv(id));
    const unmarked = await sleeper({ PATH: process.env['PATH'] });
    await store.sessions.update(id, { lastActivityAt: new Date().toISOString() });
    await service.sample();
    // Not idle long enough yet.
    expect(processAlive(a.pid as number)).toBe(true);
    await service.setKeep(id, b.pid as number, true, 'review server');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await service.sample();
    await until(() => !processAlive(a.pid as number), 'the idle process to stop');
    expect(processAlive(b.pid as number)).toBe(true);
    expect(processAlive(unmarked.pid as number)).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.label).toMatch(/^Stopped 1 process \(\d+ MB\) after 0 min idle$/);
    expect(notes[0]?.payload).toMatchObject({ action: 'processes-stopped', reason: 'idle', stoppedProcesses: [{ pid: a.pid }] });
    const view = await service.forSession(id, { fresh: true });
    expect(view.processes.map((p) => [p.pid, p.keep, p.keptBy, p.keepReason])).toEqual([[b.pid, true, 'developer', 'review server']]);
    // The Keep mark is stored (a restart keeps it), by pid and start.
    expect(await store.settings.get(KEEP_SETTING)).toEqual([expect.objectContaining({ sessionId: id, pid: b.pid, by: 'developer' })]);
  });

  it('never while the session works; a close stops them at once', async () => {
    const id = await session();
    make({ idleDelayMs: 1 });
    const a = await sleeper(markerEnv(id));
    await store.sessions.update(id, { status: 'run' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.sample();
    expect(processAlive(a.pid as number)).toBe(true);
    // Closed while it works: still nothing (a close stops the process first; working wins).
    await store.sessions.update(id, { closedAt: new Date().toISOString() });
    await service.sample();
    expect(processAlive(a.pid as number)).toBe(true);
    await store.sessions.update(id, { status: 'paused' });
    await service.sample();
    await until(() => !processAlive(a.pid as number), 'the closed session’s process to stop');
    expect(notes[0]?.payload).toMatchObject({ reason: 'closed' });
    expect(notes[0]?.label).toMatch(/when the session was closed$/);
  });

  it('a close stops them even with the idle stop off (delay 0)', async () => {
    const id = await session();
    make({ idleDelayMs: 0 });
    const a = await sleeper(markerEnv(id));
    await service.sample();
    expect(processAlive(a.pid as number)).toBe(true);
    await store.sessions.update(id, { closedAt: new Date().toISOString() });
    await service.sample();
    await until(() => !processAlive(a.pid as number), 'the process to stop on close');
  });

  it('Stop escalates to SIGKILL when SIGTERM is ignored', async () => {
    const id = await session();
    make({ graceMs: 300 });
    const stubborn = await sleeper(markerEnv(id), { ignoreTerm: true });
    const after = await service.stopOne(id, stubborn.pid as number);
    expect(processAlive(stubborn.pid as number)).toBe(false);
    expect(after.processes).toEqual([]);
    expect(notes[0]?.label).toMatch(/\(Stop in Processes\)$/);
    expect(notes[0]?.payload).toMatchObject({ reason: 'developer' });
  });

  it('refuses a pid that is not the session’s (another session’s, an unmarked one)', async () => {
    const id = await session();
    const other = await session();
    make();
    const theirs = await sleeper(markerEnv(other));
    const unmarked = await sleeper({ PATH: process.env['PATH'] });
    await expect(service.stopOne(id, theirs.pid as number)).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.stopOne(id, unmarked.pid as number)).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.setKeep(id, theirs.pid as number, true)).rejects.toMatchObject({ code: 'not-found' });
    expect(processAlive(theirs.pid as number)).toBe(true);
    expect(processAlive(unmarked.pid as number)).toBe(true);
  });

  it("the agent's process_keep: by match or pid, only its own session's; a marker of an unknown session is ignored", async () => {
    const id = await session();
    make();
    const a = await sleeper(markerEnv(id));
    const stranger = await sleeper(markerEnv(randomUUID()));
    const kept = await service.agentKeep(id, { match: 'setTimeout', keep: true, reason: 'dev server for the review' });
    expect(kept.processes.map((p) => [p.pid, p.keep, p.keptBy])).toEqual([[a.pid, true, 'agent']]);
    await expect(service.agentKeep(id, { pid: stranger.pid, keep: true })).rejects.toMatchObject({ code: 'not-found' });
    await expect(service.agentKeep(id, { keep: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.agentKeep(id, { pid: a.pid })).rejects.toMatchObject({ code: 'invalid' });
    const back = await service.agentKeep(id, { pid: a.pid, keep: false });
    expect(back.processes[0]?.keep).toBe(false);
    expect((await service.overview()).map((s) => s.sessionId)).toEqual([id]);
  });
});
