/**
 * M2.4 restart recovery in process: the rules of `recoverSessions` (src/server/supervisor/recovery.ts)
 * against the real supervisor + fake-claude, with stubbed process control where a
 * real leftover cannot be staged. The kill/restart oracle is restart.test.ts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LifecyclePayload, RequestPayload, ToolPayload, UserPayload } from '../../../src/core/event-payload.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import {
  type LiveClaudeProcess,
  type ProcessControl,
  RESTART_MESSAGE,
  RESTART_NOTE,
  claudeAgentsLister,
  parseAgentsJson,
  recoverSessions,
  stopProcess,
} from '../../../src/server/supervisor/recovery.ts';
import { type ControlRequestHandler, SessionSupervisor } from '../../../src/server/supervisor/supervisor.ts';
import { fakeClaudeCommand } from '../../../tools/fake-claude/command.ts';
import { delay, spawnFake, userLine } from '../../helpers/fake-claude.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  payloadType,
  spawnedArgv,
  stdinOf,
  until,
  waitForEvent,
  waitForStatus,
} from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;
const extra: SessionSupervisor[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const supervisor of extra.splice(0)) await supervisor.shutdown();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await world?.cleanup();
  world = undefined;
});

/** A second supervisor on the same store and env: the service after its restart. */
function restarted(w: SupervisorWorld, options: { readonly controlHandler?: ControlRequestHandler } = {}): SessionSupervisor {
  const supervisor = new SessionSupervisor({
    store: w.store,
    claudeCommand: fakeClaudeCommand(),
    env: w.env,
    timeouts: { ack: 3_000, result: 5_000, exit: 5_000, signal: 2_000 },
    ...(options.controlHandler ? { controlHandler: options.controlHandler } : {}),
    onError: (error) => w.errors.push(error),
  });
  extra.push(supervisor);
  return supervisor;
}

function lifecycle(events: ReadonlyArray<{ payload: unknown }>, action: string): LifecyclePayload | undefined {
  return events.map((e) => e.payload as LifecyclePayload).find((p) => p?.type === 'lifecycle' && p.action === action);
}

/** Process control over a set of fake pids: `kill` ends a pid unless it ignores that signal. */
function stubProcesses(alive: Set<number>, ignores: Record<number, NodeJS.Signals[]> = {}): ProcessControl & { kills: Array<[number, string]> } {
  const kills: Array<[number, string]> = [];
  return {
    kills,
    isAlive: (pid) => alive.has(pid),
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (!alive.has(pid)) return false;
      if (!(ignores[pid] ?? []).includes(signal)) alive.delete(pid);
      return true;
    },
  };
}

/** A stored session as a crashed service left it (no process here). */
async function crashed(w: SupervisorWorld, patch: Partial<SessionRecord> & { name: string }): Promise<SessionRecord> {
  const session = await w.store.sessions.create({
    name: patch.name,
    task: 'task',
    claudeSessionId: patch.claudeSessionId ?? crypto.randomUUID(),
    status: patch.status ?? 'run',
    workType: 'feature',
    mode: 'single',
    solutions: ['acme-app-front'],
    attached: patch.attached ?? true,
    cwd: w.workspace,
    pid: patch.pid ?? null,
    stopReason: patch.stopReason ?? null,
  });
  await w.store.agents.create({ sessionId: session.id, kind: 'main', name: 'acme-app-front', status: session.status });
  return session;
}

const lister = (rows: LiveClaudeProcess[] | null) => async () => rows;

/** The fake logs its argv once node has started: wait for `n` session processes (not `agents` calls). */
async function sessionSpawns(file: string, n: number) {
  return until(async () => {
    const lines = (await spawnedArgv(file)).filter((line) => line.argv?.includes('-p'));
    return lines.length >= n ? lines : undefined;
  }, `${n} spawned session processes`);
}

describe('recoverSessions · after a clean shutdown (statuses kept, no leftovers)', () => {
  it('run → --resume + the restart message; need → resumed idle, the note waits and goes with the next message; paused stays paused', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const run = await w.supervisor.start(newSession({ name: 'running', task: '[fake:hang] Work.' }), w.place);
    const need = await w.supervisor.start(newSession({ name: 'asking', task: '[fake:ask-2q] Ask.' }), w.place);
    const paused = await w.supervisor.start(newSession({ name: 'resting', task: 'Reply with OK.' }), w.place);
    await waitForStatus(w.store, run.id, ['run']);
    await waitForStatus(w.store, need.id, ['need']);
    await waitForStatus(w.store, paused.id, ['done']);
    await w.supervisor.pause(paused.id);
    await w.supervisor.shutdown();
    expect(await w.store.sessions.get(run.id)).toMatchObject({ status: 'run', pid: null });
    expect(await w.store.sessions.get(need.id)).toMatchObject({ status: 'need', pid: null });
    const before = (await spawnedArgv(w.logFile)).length;

    const next = restarted(w);
    const listed: string[] = [];
    const report = await recoverSessions({
      store: w.store,
      supervisor: next,
      listLive: async () => {
        listed.push('agents');
        return [];
      },
    });
    expect(listed).toEqual(['agents']);
    expect(Object.fromEntries(report.sessions.map((s) => [s.sessionId, s.action]))).toEqual({ [run.id]: 'resumed', [need.id]: 'resumed-idle' });

    const spawned = (await sessionSpawns(w.logFile, before + 2)).slice(before);
    expect(spawned).toHaveLength(2);
    const runPid = (await w.store.sessions.get(run.id))?.pid as number;
    const needPid = (await w.store.sessions.get(need.id))?.pid as number;
    expect(spawned.find((l) => l.pid === runPid)?.argv).toContain('--resume');
    expect(spawned.find((l) => l.pid === runPid)?.argv?.[spawned.find((l) => l.pid === runPid)?.argv?.indexOf('--resume') as number + 1]).toBe(run.claudeSessionId);
    expect(spawned.find((l) => l.pid === needPid)?.argv).toContain(need.claudeSessionId);

    await until(async () => (await stdinOf(w.logFile, runPid)).length > 0 || undefined, 'the restart message');
    expect(await stdinOf(w.logFile, runPid)).toEqual([userLine(RESTART_MESSAGE)]);
    const restartEvent = await waitForEvent(w.store, run.id, (e) => payloadType(e) === 'user' && (e.payload as UserPayload).text === RESTART_MESSAGE);
    expect((restartEvent.payload as UserPayload).origin).toBe('service');
    expect(lifecycle(await w.store.events.list(run.id), 'recovered')).toMatchObject({ pid: runPid });

    await delay(200);
    expect(await stdinOf(w.logFile, needPid)).toEqual([]);
    expect((await w.store.sessions.get(need.id))?.status).toBe('idle');
    expect((await w.store.pendingMessages.pending(need.id)).map((m) => [m.kind, m.text])).toEqual([['restart-note', RESTART_NOTE]]);
    expect((await w.store.sessions.get(paused.id))?.status).toBe('paused');

    await next.sendMessage(need.id, 'My answers.');
    await until(async () => (await stdinOf(w.logFile, needPid)).length > 0 || undefined, 'the answers');
    expect(await stdinOf(w.logFile, needPid)).toEqual([userLine(`${RESTART_NOTE}\n\nMy answers.`)]);
    expect(await w.store.pendingMessages.pending(need.id)).toEqual([]);
    await waitForStatus(w.store, need.id, ['done']);
    expect(w.errors).toEqual([]);
  });

  it('nothing to do: no candidates → agents --json is not even called', async () => {
    world = await makeSupervisorWorld();
    const s = await world.supervisor.start(newSession({ task: 'Reply with OK.' }), world.place);
    await waitForStatus(world.store, s.id, ['done']);
    await world.supervisor.shutdown();
    let calls = 0;
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: async () => {
        calls++;
        return [];
      },
    });
    expect(report.sessions).toEqual([]);
    expect(calls).toBe(0);
  });

  it('a supervisor that is already shutting down resumes nothing and keeps the stored status for the next start', async () => {
    world = await makeSupervisorWorld();
    const run = await crashed(world, { name: 'running', status: 'run' });
    const next = restarted(world);
    await next.shutdown();
    const report = await recoverSessions({ store: world.store, supervisor: next, listLive: lister([]), onError: () => undefined });
    expect(report.sessions).toEqual([{ sessionId: run.id, action: 'not-resumed', reason: 'the service is shutting down' }]);
    expect((await world.store.sessions.get(run.id))?.status).toBe('run');
  });

  it('a second restart before the note went out queues it only once', async () => {
    world = await makeSupervisorWorld();
    const need = await crashed(world, { name: 'asking', status: 'need' });
    await world.store.pendingMessages.enqueue({ sessionId: need.id, kind: 'restart-note', text: RESTART_NOTE });
    await recoverSessions({ store: world.store, supervisor: restarted(world), listLive: lister([]) });
    expect(await world.store.pendingMessages.pending(need.id)).toHaveLength(1);
  });
});

describe('recoverSessions · after a crash (recorded pids)', () => {
  it('a live leftover listed with the same id is stopped (SIGINT → SIGTERM → SIGKILL) before --resume', async () => {
    world = await makeSupervisorWorld();
    const run = await crashed(world, { name: 'running', status: 'run', pid: 91_001 });
    const processes = stubProcesses(new Set([91_001]), { 91_001: ['SIGINT'] });
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: lister([{ pid: 91_001, sessionId: run.claudeSessionId }]),
      processes,
      signalTimeoutMs: 50,
      pollMs: 5,
    });
    expect(processes.kills).toEqual([[91_001, 'SIGINT'], [91_001, 'SIGTERM']]);
    expect(report.sessions).toEqual([{ sessionId: run.id, action: 'resumed', leftover: { pid: 91_001, stoppedBy: 'SIGTERM' } }]);
    const events = await world.store.events.list(run.id);
    expect(lifecycle(events, 'leftover-stopped')).toMatchObject({ leftoverPid: 91_001, stoppedBy: 'SIGTERM' });
    // The leftover's event comes before the new process.
    expect(events.findIndex((e) => (e.payload as LifecyclePayload).action === 'leftover-stopped')).toBeLessThan(
      events.findIndex((e) => (e.payload as LifecyclePayload).action === 'recovered'),
    );
    const [spawned] = await sessionSpawns(world.logFile, 1);
    expect(spawned?.argv).toEqual(expect.arrayContaining(['--resume', run.claudeSessionId]));
  });

  it('D14: claude agents --json is asked once per session cwd, and each session resumes in its own folder', async () => {
    world = await makeSupervisorWorld();
    const other = path.join(world.root, 'other folder');
    await mkdir(other, { recursive: true });
    const a = await crashed(world, { name: 'in-ws-a', status: 'run', pid: 91_010 });
    const b = await crashed(world, { name: 'in-ws-b', status: 'run', pid: 91_011 });
    const c = await crashed(world, { name: 'in-other', status: 'run', pid: 91_012 });
    await world.store.sessions.update(c.id, { cwd: other, root: other, rootKind: 'repo' });
    const asked: Array<string | null | undefined> = [];
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: async (cwd) => {
        asked.push(cwd);
        return [];
      },
      processes: stubProcesses(new Set([91_010, 91_011, 91_012])),
    });
    expect([...asked].sort()).toEqual([other, world.workspace].sort());
    expect(report.sessions.map((r) => r.action)).toEqual(['resumed', 'resumed', 'resumed']);
    const spawns = await sessionSpawns(world.logFile, 3);
    const cwdOf = (session: SessionRecord) => spawns.find((line) => line.argv?.includes(session.claudeSessionId))?.cwd;
    expect([cwdOf(a), cwdOf(b), cwdOf(c)]).toEqual([world.workspace, world.workspace, other]);
  });

  it('a live pid that agents --json cannot confirm (the list failed) is never signalled, and the session is not resumed', async () => {
    world = await makeSupervisorWorld();
    const run = await crashed(world, { name: 'running', status: 'run', pid: 91_002 });
    const processes = stubProcesses(new Set([91_002]));
    const report = await recoverSessions({ store: world.store, supervisor: restarted(world), listLive: lister(null), processes, onError: () => undefined });
    expect(processes.kills).toEqual([]);
    expect(report.sessions[0]).toMatchObject({ action: 'not-resumed', reason: expect.stringContaining('claude agents --json failed') });
    expect(await world.store.sessions.get(run.id)).toMatchObject({ status: 'paused', pid: null });
    const event = (await world.store.events.list(run.id)).find((e) => (e.payload as LifecyclePayload).action === 'not-resumed');
    expect(event?.kind).toBe('error');
    await delay(300); // a spawn would have logged its argv by now
    expect(await spawnedArgv(world.logFile)).toEqual([]);
  });

  it('a live pid listed under another session id (pid reused) is left alone and the session is resumed', async () => {
    world = await makeSupervisorWorld();
    const run = await crashed(world, { name: 'running', status: 'run', pid: 91_003 });
    const processes = stubProcesses(new Set([91_003]));
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: lister([{ pid: 91_003, sessionId: 'someone-else' }]),
      processes,
    });
    expect(processes.kills).toEqual([]);
    expect(report.sessions[0]?.action).toBe('resumed');
    expect(report.sessions[0]?.leftover).toBeUndefined();
    const [spawned] = await sessionSpawns(world.logFile, 1);
    expect(spawned?.argv).toEqual(expect.arrayContaining(['--resume', run.claudeSessionId]));
  });

  it('the id held by another live process (e.g. a terminal) → not resumed, that process untouched', async () => {
    world = await makeSupervisorWorld();
    const need = await crashed(world, { name: 'asking', status: 'need', pid: null });
    const processes = stubProcesses(new Set([91_004]));
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: lister([{ pid: 91_004, sessionId: need.claudeSessionId }]),
      processes,
    });
    expect(processes.kills).toEqual([]);
    expect(report.sessions[0]).toMatchObject({ action: 'not-resumed', reason: expect.stringContaining('pid 91004') });
    expect((await world.store.sessions.get(need.id))?.status).toBe('paused');
    expect(await world.store.pendingMessages.pending(need.id)).toEqual([]);
    await delay(300); // a spawn would have logged its argv by now
    expect(await spawnedArgv(world.logFile)).toEqual([]);
  });

  it('a pause or detach the crash cut short is finished (paused), never resumed', async () => {
    world = await makeSupervisorWorld();
    const pausing = await crashed(world, { name: 'pausing', status: 'run', pid: 91_005, stopReason: 'pause' });
    const detaching = await crashed(world, { name: 'detaching', status: 'need', pid: 91_006, stopReason: 'detach' });
    const report = await recoverSessions({ store: world.store, supervisor: restarted(world), listLive: lister([]), processes: stubProcesses(new Set()) });
    expect(report.sessions.map((s) => s.action).sort()).toEqual(['paused', 'paused']);
    expect(await world.store.sessions.get(pausing.id)).toMatchObject({ status: 'paused', attached: true, pid: null, stopReason: null });
    expect(await world.store.sessions.get(detaching.id)).toMatchObject({ status: 'paused', attached: false, pid: null });
    expect(lifecycle(await world.store.events.list(detaching.id), 'detached')).toMatchObject({ message: 'finished after a Switchboard restart' });
    await delay(300); // a spawn would have logged its argv by now
    expect(await spawnedArgv(world.logFile)).toEqual([]);
  });

  it('a live-but-idle session (done) is only cleaned up: leftover stopped, pid cleared, not resumed; detached and paused ones are untouched', async () => {
    world = await makeSupervisorWorld();
    const done = await crashed(world, { name: 'finished', status: 'done', pid: 91_007 });
    const detached = await crashed(world, { name: 'terminal', status: 'paused', attached: false });
    const processes = stubProcesses(new Set([91_007]));
    const report = await recoverSessions({
      store: world.store,
      supervisor: restarted(world),
      listLive: lister([{ pid: 91_007, sessionId: done.claudeSessionId }]),
      processes,
      pollMs: 5,
    });
    expect(report.sessions).toEqual([{ sessionId: done.id, action: 'cleaned', leftover: { pid: 91_007, stoppedBy: 'SIGINT' } }]);
    expect(await world.store.sessions.get(done.id)).toMatchObject({ status: 'done', pid: null });
    expect(await world.store.sessions.get(detached.id)).toMatchObject({ status: 'paused', attached: false });
    await delay(300); // a spawn would have logged its argv by now
    expect(await spawnedArgv(world.logFile)).toEqual([]);
  });

  it('requests still open become stale (orphaned hook), running subagents idle', async () => {
    world = await makeSupervisorWorld();
    const need = await crashed(world, { name: 'asking', status: 'need', pid: 91_008 });
    const ask = await world.store.events.append({
      sessionId: need.id,
      kind: 'ask',
      label: 'AskUserQuestion',
      payload: { type: 'tool', name: 'AskUserQuestion', toolUseId: 'toolu_1', input: {}, requestId: 'req-ask', requestState: 'open' } satisfies ToolPayload,
    });
    const perm = await world.store.events.append({
      sessionId: need.id,
      kind: 'ask',
      label: 'Bash',
      payload: {
        type: 'request',
        requestId: 'req-perm',
        toolName: 'Bash',
        toolUseId: 'toolu_2',
        input: {},
        agentId: null,
        description: null,
        decisionReason: null,
        state: 'open',
      } satisfies RequestPayload,
    });
    const sub = await world.store.agents.create({ sessionId: need.id, name: 'Explore', status: 'run' });
    const orphaned: Array<[string, readonly string[]]> = [];
    const next = restarted(world, { controlHandler: { orphaned: (id, ids) => void orphaned.push([id, ids]) } });
    const report = await recoverSessions({ store: world.store, supervisor: next, listLive: lister([]), processes: stubProcesses(new Set()) });
    expect(report.sessions[0]?.action).toBe('resumed-idle');
    expect(orphaned).toEqual([[need.id, ['req-ask', 'req-perm']]]);
    expect(((await world.store.events.get(ask.id))?.payload as ToolPayload).requestState).toBe('stale');
    expect(((await world.store.events.get(perm.id))?.payload as RequestPayload).state).toBe('stale');
    expect((await world.store.agents.get(sub.id))?.status).toBe('idle');
  });
});

describe('SessionSupervisor.holdCommands (commands wait while recovery runs)', () => {
  it('sendMessage / resume / attach / pause / detach wait for the release; the recovery steps do not', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const run = await crashed(w, { name: 'running', status: 'run' });
    const idle = await crashed(w, { name: 'resting', status: 'paused' });
    const next = restarted(w);
    const release = next.holdCommands();
    const order: string[] = [];
    const message = next.sendMessage(idle.id, 'Hello.').then(() => order.push('message'));
    const detach = next.detach(run.id).then(() => order.push('detach'));
    await delay(200);
    expect(order).toEqual([]);
    expect(next.isLive(idle.id)).toBe(false);
    await next.resumeAfterRestart(run.id, RESTART_MESSAGE);
    order.push('recovered');
    expect(next.isLive(run.id)).toBe(true);
    release();
    await Promise.all([message, detach]);
    expect(order).toEqual(['recovered', 'message', 'detach']);
    // The detach acted on the recovered process (D7 stop), not on a session without one.
    expect(await w.store.sessions.get(run.id)).toMatchObject({ attached: false, status: 'paused' });
  });
});

describe('stopProcess (real processes)', () => {
  const node = (code: string): ChildProcess => {
    const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', shell: false });
    children.push(child);
    return child;
  };
  const real: ProcessControl = {
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
  };
  const ready = () => delay(300);

  it('SIGINT is enough for a process that exits on it', async () => {
    const child = node('setInterval(() => {}, 1000)');
    await ready();
    expect(await stopProcess(child.pid as number, { processes: real, timeoutMs: 2_000, pollMs: 10 })).toBe('SIGINT');
  });

  it('escalates to SIGTERM, then SIGKILL', async () => {
    const term = node("process.on('SIGINT', () => {}); setInterval(() => {}, 1000)");
    const kill = node("process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    await ready();
    expect(await stopProcess(term.pid as number, { processes: real, timeoutMs: 300, pollMs: 10 })).toBe('SIGTERM');
    expect(await stopProcess(kill.pid as number, { processes: real, timeoutMs: 300, pollMs: 10 })).toBe('SIGKILL');
  });

  it('a process that is already gone → exited; one that survives SIGKILL → null', async () => {
    expect(await stopProcess(91_009, { processes: stubProcesses(new Set()), timeoutMs: 10, pollMs: 1 })).toBe('exited');
    const stuck = stubProcesses(new Set([91_010]), { 91_010: ['SIGINT', 'SIGTERM', 'SIGKILL'] });
    expect(await stopProcess(91_010, { processes: stuck, timeoutMs: 10, pollMs: 1 })).toBeNull();
  });
});

describe('claude agents --json', () => {
  it('claudeAgentsLister lists a live fake-claude process with its session id; a failing command → null', async () => {
    world = await makeSupervisorWorld();
    const id = crypto.randomUUID();
    const fake = spawnFake(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--session-id', id], {
      cwd: world.workspace,
      env: { CLAUDE_CONFIG_DIR: world.configDir, FAKE_CLAUDE_SCENARIO: 'hang' },
    });
    children.push(fake.child);
    fake.send(userLine('Work.'));
    await fake.waitFor((line) => line['type'] === 'system' && line['subtype'] === 'init');
    // D14: asked from a session's cwd; a folder that is gone falls back to the service's own folder.
    const list = claudeAgentsLister({ claudeCommand: fakeClaudeCommand(), env: world.env });
    expect(await list(world.workspace)).toEqual([{ pid: fake.child.pid, sessionId: id }]);
    expect(await list(path.join(world.root, 'gone'))).toEqual([{ pid: fake.child.pid, sessionId: id }]);
    const failing = claudeAgentsLister({ claudeCommand: [process.execPath, '-e', 'process.exit(3)'], env: world.env });
    expect(await failing(null)).toBeNull();
    fake.kill('SIGKILL');
    await fake.exited;
  });

  it('parseAgentsJson keeps rows with a numeric pid and a string session id', () => {
    expect(parseAgentsJson('[{"pid":1,"sessionId":"a","cwd":"/x"},{"pid":"2","sessionId":"b"},{"sessionId":"c"},null,{"pid":3,"sessionId":"d"}]')).toEqual([
      { pid: 1, sessionId: 'a' },
      { pid: 3, sessionId: 'd' },
    ]);
    expect(parseAgentsJson('{}')).toBeNull();
    expect(parseAgentsJson('not json')).toBeNull();
    expect(parseAgentsJson('[]')).toEqual([]);
  });
});
