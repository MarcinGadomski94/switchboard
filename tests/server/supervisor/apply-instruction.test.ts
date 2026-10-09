import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTRUCTION_UPDATED_DIVIDER, applySummary, staleInstructionCount } from '../../../src/core/standing-instruction.ts';
import { applyInstructionToOpenSessions } from '../../../src/server/settings/apply-instruction.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D91 oracle: Apply the standing instruction to open sessions (and a session's
 * Reload instruction) against fake-claude: an idle session's process is restarted
 * with `--resume` of the same id and the new `--append-system-prompt`, no message;
 * a busy one after its turn; a paused one is untouched and counted; hooked and
 * closed ones are skipped; a restart that cannot run leaves the session as it was.
 */
let world: SupervisorWorld | undefined;

afterEach(async () => {
  const errors = world?.errors ?? [];
  await world?.cleanup();
  world = undefined;
  // Nothing went to the supervisor's error handler (a refusal is an answer, not an error).
  expect(errors).toEqual([]);
});

const FLAG = '--append-system-prompt';
const NEW_TEXT = 'Write out any table before asking about it.';

function textAfterFlag(argv: readonly string[] | undefined): string | undefined {
  const at = argv?.indexOf(FLAG) ?? -1;
  return at >= 0 ? argv?.[at + 1] : undefined;
}

async function sessionSpawns(w: SupervisorWorld) {
  return (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('-p'));
}

/** The logged argv of the process `pid` (the fake writes it once it runs). */
async function spawnOf(w: SupervisorWorld, pid: number | null) {
  return until(async () => (await sessionSpawns(w)).find((s) => s.pid === pid), `the argv of ${String(pid)}`);
}

/** The session's process ids in spawn order (the fake logs one argv line per process, with its cwd = the session's). */
async function pidOf(w: SupervisorWorld, id: string): Promise<number> {
  return until(async () => w.supervisor.pid(id) ?? undefined, `the pid of ${id}`);
}

async function outdated(w: SupervisorWorld, id: string): Promise<boolean> {
  const record = await w.store.sessions.get(id);
  if (!record) throw new Error('gone');
  return (await toSession(w.store, record, null)).instructionOutdated === true;
}

/** A started session whose first turn ended (its process stays, idle). */
async function idleSession(w: SupervisorWorld, name: string) {
  const session = await w.supervisor.start(newSession({ name, task: 'first' }), w.place);
  await waitForStatus(w.store, session.id, ['done', 'idle']);
  await until(async () => (w.supervisor.isLive(session.id) && !w.supervisor.turnRunning(session.id)) || undefined, `${name} idle`);
  return session;
}

describe('D91 · apply the standing instruction to open sessions', () => {
  it('idle → restarted with --resume and the new text (same id, no message); busy → after its turn; paused counted; hooked / closed skipped', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    await w.store.settings.set('agents.standingInstruction', 'Old rule.');
    const idle = await idleSession(w, 'idle-one');
    const busy = await idleSession(w, 'busy-one');
    const paused = await idleSession(w, 'paused-one');
    await w.supervisor.pause(paused.id);
    const hooked = await idleSession(w, 'hooked-one');
    await w.supervisor.pause(hooked.id);
    await w.store.sessions.update(hooked.id, { hooked: true });
    const closed = await idleSession(w, 'closed-one');
    await w.supervisor.close(closed.id, { confirm: true });

    expect(await outdated(w, idle.id)).toBe(false);
    await w.store.settings.set('agents.standingInstruction', NEW_TEXT);
    // The stale count: the two running ones (paused / hooked / closed have no process).
    const listed = await Promise.all((await w.store.sessions.list()).map((r) => toSession(w.store, r, null)));
    expect(staleInstructionCount(listed)).toBe(2);

    // The busy one: a held turn runs while the apply happens.
    const idlePid = await pidOf(w, idle.id);
    const busyPid = await pidOf(w, busy.id);
    await w.supervisor.sendMessage(busy.id, 'hold on [fake:hold 1.5]');
    await until(async () => w.supervisor.turnRunning(busy.id) || undefined, 'busy turn');

    const result = await applyInstructionToOpenSessions(w.store, w.supervisor);
    expect(result.restarted).toEqual([idle.id]);
    expect(result.pending).toEqual([busy.id]);
    expect(result.notRunning).toBe(1); // the paused one: it gets the text on Resume
    expect(result.skipped).toBe(1); // hooked (closed is not open)
    expect(result.failed).toEqual([]);
    expect(applySummary(result)).toBe('Applied to 2 sessions (1 restarted, 1 not running: on their next start) · 1 after its turn');

    // Idle: a new process, `--resume <same id>`, the new text, no user message; the chat's divider.
    const idleAfter = await w.store.sessions.get(idle.id);
    expect(idleAfter?.claudeSessionId).toBe(idle.claudeSessionId);
    const newIdlePid = w.supervisor.pid(idle.id);
    expect(newIdlePid).not.toBeNull();
    expect(newIdlePid).not.toBe(idlePid);
    const idleSpawn = await spawnOf(w, newIdlePid);
    expect(idleSpawn?.argv).toContain('--resume');
    expect(idleSpawn.argv?.[(idleSpawn.argv?.indexOf('--resume') ?? 0) + 1]).toBe(idle.claudeSessionId);
    expect(textAfterFlag(idleSpawn?.argv)).toBe(NEW_TEXT);
    expect((await stdinOf(w.logFile, newIdlePid as number)).filter((line) => line['type'] === 'user')).toEqual([]);
    await waitForEvent(w.store, idle.id, (e) => e.kind === 'text' && e.label === INSTRUCTION_UPDATED_DIVIDER);
    expect(await outdated(w, idle.id)).toBe(false);
    expect(['idle', 'done']).toContain((await w.store.sessions.get(idle.id))?.status);

    // Busy: marked, still the same process until the turn ends; then restarted the same way.
    const busyNow = await w.store.sessions.get(busy.id);
    expect(busyNow && (await toSession(w.store, busyNow, null)).instructionPending).toBe(true);
    expect(w.supervisor.pid(busy.id)).toBe(busyPid);
    const busyNewPid = await until(async () => {
      const pid = w.supervisor.pid(busy.id);
      return pid !== null && pid !== busyPid ? pid : undefined;
    }, 'the busy session restarted after its turn');
    const busySpawn = await spawnOf(w, busyNewPid);
    expect(busySpawn?.argv).toContain('--resume');
    expect(textAfterFlag(busySpawn?.argv)).toBe(NEW_TEXT);
    // The held turn was not interrupted: its result came before the restart.
    const busyEvents = await w.store.events.list(busy.id);
    const lastResult = busyEvents.filter((e) => (e.payload as { type?: string } | null)?.type === 'result').at(-1);
    const divider = await waitForEvent(w.store, busy.id, (e) => e.label === INSTRUCTION_UPDATED_DIVIDER);
    expect(lastResult && lastResult.id < divider.id).toBe(true);
    expect((lastResult?.payload as { isError?: boolean }).isError).not.toBe(true);

    // Paused, hooked, closed: untouched (no process started).
    for (const id of [paused.id, hooked.id, closed.id]) expect(w.supervisor.isLive(id)).toBe(false);
    expect((await w.store.events.list(paused.id)).some((e) => e.label === INSTRUCTION_UPDATED_DIVIDER)).toBe(false);

    // Applying again: nothing is older now.
    const again = await applyInstructionToOpenSessions(w.store, w.supervisor);
    expect(again.restarted).toEqual([]);
    expect(again.current).toBe(2);
  });

  it('a restart that cannot run leaves the session as it was and reports the reason', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const own = path.join(w.workspace, 'gone-soon');
    await mkdir(own, { recursive: true });
    const session = await w.supervisor.start(newSession({ name: 'fragile', task: 'first' }), { folder: w.folder, cwd: own });
    await waitForStatus(w.store, session.id, ['done', 'idle']);
    const pid = await pidOf(w, session.id);
    const before = await w.store.sessions.get(session.id);
    await w.store.settings.set('agents.standingInstruction', NEW_TEXT);
    await rm(own, { recursive: true, force: true });

    const result = await applyInstructionToOpenSessions(w.store, w.supervisor);
    expect(result.restarted).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ sessionId: session.id, title: 'fragile' });
    expect(result.failed[0]?.reason).toMatch(/folder does not exist/);
    expect(applySummary(result)).toContain('1 failed');
    // Unchanged: the same process, status, still on the older instruction.
    expect(w.supervisor.pid(session.id)).toBe(pid);
    const after = await w.store.sessions.get(session.id);
    expect(after?.status).toBe(before?.status);
    expect(await outdated(w, session.id)).toBe(true);
    await waitForEvent(w.store, session.id, (e) => e.kind === 'error' && e.label.startsWith('Could not reload the standing instruction'));
  });

  it("a session's Reload instruction: restarted when idle; current when already on it; refused for a hooked one", async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await idleSession(w, 'single');
    expect(await w.supervisor.reloadInstruction(session.id)).toBe('current');
    await w.store.settings.set('agents.standingInstruction.enabled', false);
    expect(await outdated(w, session.id)).toBe(true);
    const pid = await pidOf(w, session.id);
    expect(await w.supervisor.reloadInstruction(session.id)).toBe('restarted');
    const next = w.supervisor.pid(session.id);
    expect(next).not.toBe(pid);
    const spawn = await spawnOf(w, next);
    expect(spawn?.argv).toContain('--resume');
    expect(spawn?.argv).not.toContain(FLAG); // off: the new process has none
    expect(await outdated(w, session.id)).toBe(false);
    // A message after the reload goes to the new process, conversation intact.
    await w.supervisor.sendMessage(session.id, 'second');
    await until(async () => (await stdinOf(w.logFile, next as number)).some((line) => line['type'] === 'user') || undefined, 'the message on the new process');

    await w.supervisor.pause(session.id);
    expect(await w.supervisor.reloadInstruction(session.id)).toBe('not-running');
    await w.store.sessions.update(session.id, { hooked: true });
    await expect(w.supervisor.reloadInstruction(session.id)).rejects.toMatchObject({ code: 'not-available' });
  });

  it('Codex: the reload resumes its thread with the new developerInstructions (fake-codex; unverified on the real CLI)', async () => {
    world = await makeSupervisorWorld({ standingInstruction: true });
    const w = world;
    const session = await w.supervisor.start({ ...newSession({ task: 'first' }), provider: 'codex' }, w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.store.settings.set('agents.standingInstruction', NEW_TEXT);
    expect(await outdated(w, session.id)).toBe(true);
    expect(await w.supervisor.reloadInstruction(session.id)).toBe('restarted');
    expect(await outdated(w, session.id)).toBe(false);
    // The bridge reopens the thread when the next message comes; it carries the new text.
    await w.supervisor.sendMessage(session.id, 'second');
    const threads = await until(async () => {
      const found = (await readFile(w.codexLog, 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line['kind'] === 'thread-params');
      return found.length >= 2 ? found : undefined;
    }, 'the resumed thread');
    expect(threads.at(-1)).toMatchObject({ method: 'thread/resume', developerInstructions: NEW_TEXT });
  });
});
