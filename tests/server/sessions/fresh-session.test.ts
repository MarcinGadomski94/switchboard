import { afterEach, describe, expect, it } from 'vitest';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { toSession } from '../../../src/server/sessions/wire.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, stdinOf, until, waitForStatus } from '../../helpers/supervisor.ts';

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function lifecycle(payload: unknown): LifecyclePayload | null {
  return payload && typeof payload === 'object' && (payload as { type?: string }).type === 'lifecycle' ? (payload as LifecyclePayload) : null;
}

describe('D83 · continuing a session in a fresh session', () => {
  it('handover turn → a new session in the same cwd / branch / CLI / model with the handover first; linked both ways; the old one closed', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const old = await w.supervisor.start({ ...newSession({ name: 'fix-login', title: 'Fix login', task: 'first task', model: 'sonnet', effort: 'low' }) }, w.place);
    await waitForStatus(w.store, old.id, ['done']);
    const moved: Array<[string, string]> = [];
    const closedInbox: string[] = [];
    const started = await w.supervisor.continueFresh(old.id, {
      percent: 82,
      onStarted: async (from, to) => {
        moved.push([from.id, to.id]);
      },
      beforeClosePublish: async (id) => {
        closedInbox.push(id);
      },
    });
    expect(w.supervisor.currentFresh(old.id)).toEqual({ step: 'handover' });
    expect((await toSession(w.store, started.record)).freshContinue).toEqual({ step: 'handover' });
    // A message meanwhile is refused (the continuation sends the next ones itself).
    await expect(w.supervisor.sendMessage(old.id, 'meanwhile')).rejects.toMatchObject({ code: 'switching' });
    const outcome = await started.done;
    if (!outcome.ok) throw new Error(outcome.reason);
    const fresh = outcome.session;
    expect(w.supervisor.currentFresh(old.id)).toBeNull();

    // The old agent got the handover request (a service message, one turn).
    const oldStdin = JSON.stringify(await stdinOf(w.logFile, old.pid ?? -1, { all: true }));
    expect(oldStdin).toContain('Switchboard is continuing this session in a fresh session now: its context is 82% full.');
    expect(oldStdin).toContain('the goal, the current state, the decisions made so far, the files you touched, the open questions, and the next steps');

    // The fresh session: same folder, cwd, CLI, model, effort; named and titled after the old one; a new conversation.
    expect(fresh).toMatchObject({ name: 'fix-login-2', title: 'Fix login (2)', cwd: w.workspace, provider: 'claude', model: 'sonnet', effort: 'low', continuedFrom: old.id, task: 'first task' });
    expect(fresh.claudeSessionId).not.toBe(old.claudeSessionId);
    await waitForStatus(w.store, fresh.id, ['done']);
    const spawns = (await spawnedArgv(w.logFile)).filter((line) => line.argv?.includes('--name'));
    const freshSpawn = spawns.find((line) => line.argv?.includes(fresh.claudeSessionId));
    expect(freshSpawn?.argv).toEqual(expect.arrayContaining(['--session-id', fresh.claudeSessionId, '--model', 'sonnet', '--effort', 'low']));
    const first = JSON.stringify((await stdinOf(w.logFile, freshSpawn?.pid ?? -1)).find((line) => line['type'] === 'user'));
    expect(first).toContain('You are continuing the session \\"Fix login\\" in a fresh session');
    expect(first).toMatch(/---\\nOK\\n---/);
    expect(moved).toEqual([[old.id, fresh.id]]);

    // Linked both ways: the dividers and the records.
    const freshEvents = await w.store.events.list(fresh.id);
    const from = freshEvents.find((event) => lifecycle(event.payload)?.action === 'continued-from');
    expect(from?.label).toBe('Continued from Fix login');
    expect(from?.payload).toMatchObject({ linkedSessionId: old.id, linkedTitle: 'Fix login' });
    const oldEvents = await w.store.events.list(old.id);
    const into = oldEvents.find((event) => lifecycle(event.payload)?.action === 'continued-in');
    expect(into?.label).toBe('Continued in Fix login (2)');
    expect(into?.payload).toMatchObject({ linkedSessionId: fresh.id });
    const closed = (await w.store.sessions.get(old.id)) as SessionRecord;
    expect(closed.closedAt).not.toBeNull();
    expect(closed.continuedTo).toBe(fresh.id);
    expect(closedInbox).toEqual([old.id]);
    expect(oldEvents.some((event) => lifecycle(event.payload)?.action === 'closed')).toBe(true);
    const wire = await toSession(w.store, closed);
    expect(wire.continuedTo).toEqual({ sessionId: fresh.id, title: 'Fix login (2)' });
    expect((await toSession(w.store, fresh)).continuedFrom).toEqual({ sessionId: old.id, title: 'Fix login' });

    // A second continuation counts on: fix-login-3, "Fix login (3)".
    const again = await w.supervisor.continueFresh(fresh.id);
    const next = await again.done;
    if (!next.ok) throw new Error(next.reason);
    expect(next.session).toMatchObject({ name: 'fix-login-3', title: 'Fix login (3)', continuedFrom: fresh.id });
  });

  it('refusals: while a turn runs, a closed session, a detached one; a hooked one says why', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const running = await w.supervisor.start(newSession({ name: 'busy-one', task: '[fake:hold 2] think' }), w.place);
    await until(async () => (await w.store.sessions.get(running.id))?.status === 'run', 'the turn runs');
    await expect(w.supervisor.continueFresh(running.id)).rejects.toMatchObject({ code: 'turn-running', message: expect.stringContaining('wait for it to end') });
    await waitForStatus(w.store, running.id, ['done']);
    await w.supervisor.detach(running.id);
    await expect(w.supervisor.continueFresh(running.id)).rejects.toMatchObject({ code: 'detached' });
    await w.supervisor.close(running.id, { confirm: true });
    await expect(w.supervisor.continueFresh(running.id)).rejects.toMatchObject({ code: 'closed' });
    const hooked = await w.store.sessions.create({ name: 'hooked-one', claudeSessionId: 'hooked-cid', task: '', hooked: true, cwd: w.workspace } as never);
    await expect(w.supervisor.continueFresh(hooked.id)).rejects.toMatchObject({ code: 'not-available', message: expect.stringContaining('hooked terminal session') });
  });

  it('a handover that fails leaves the old session open and as it was; nothing of a new session is kept', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const old = await w.supervisor.start(newSession({ name: 'will-fail', task: 'go' }), w.place);
    await waitForStatus(w.store, old.id, ['done']);
    // The handover turn crashes the CLI: no reply.
    w.env['FAKE_CLAUDE_SCENARIO'] = 'crash';
    await w.supervisor.pause(old.id);
    const started = await w.supervisor.continueFresh(old.id, { handoverTimeoutMs: 5_000 });
    const outcome = await started.done;
    expect(outcome.ok).toBe(false);
    const after = (await w.store.sessions.get(old.id)) as SessionRecord;
    expect(after.closedAt).toBeNull();
    expect(after.continuedTo).toBeNull();
    expect((await w.store.sessions.list()).map((s) => s.name)).toEqual(['will-fail']);
    const events = await w.store.events.list(old.id);
    expect(events.some((event) => event.kind === 'error' && event.label.startsWith('Could not continue in a fresh session:'))).toBe(true);
  });
});
