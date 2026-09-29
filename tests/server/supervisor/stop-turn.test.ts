import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestPayload, ResultPayload, StopPayload, ToolPayload, UserPayload } from '../../../src/core/event-payload.ts';
import { deriveSessionStatus } from '../../../src/core/derive/status.ts';
import { parseStreamLine } from '../../../src/core/stream-json.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import type { CanUseToolContext } from '../../../src/server/supervisor/supervisor.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import {
  type SupervisorWorld,
  makeSupervisorWorld,
  newSession,
  payloadType,
  stdinOf,
  until,
  waitForEvent,
  waitForStatus,
} from '../../helpers/supervisor.ts';

/**
 * D50 · Stop the current turn (`docs/supervisor.md` → *Stop the current turn*):
 * the interrupt `control_request` with `cancel_queued: true`; the process stays
 * alive and the session becomes idle; messages the agent had not taken up are
 * withdrawn (their events get `withdrawn`, their texts come back for the
 * composer) and never run; open requests go to the handler's `stopped`. First the
 * recorder alone (the turn accounting, the race where a withdrawn message was
 * taken up after all, a foreground subagent cut off), then the real path with
 * fake-claude: stop with 0, 1 and 2 queued messages, at a tool boundary, with a
 * permission prompt open, twice at once, when idle, and a CLI that never
 * acknowledges.
 */

let tmp: string | undefined;
let store: Store | undefined;
let world: SupervisorWorld | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
  await world?.cleanup();
  world = undefined;
});

const line = (value: unknown): string => JSON.stringify(value);
const init = line({ type: 'system', subtype: 'init', session_id: 's', permissionMode: 'auto', model: 'm' });
const replay = (text: string, uuid = `u-${text.length}`): string =>
  line({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: 's', uuid, isReplay: true });
const abortedResult = (reason = 'aborted_streaming'): string =>
  line({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: reason, session_id: 's', uuid: `r-${reason}` });
const successResult = line({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 's', uuid: 'r-ok' });

async function recorderWorld() {
  tmp = await makeTempDir('stop-turn');
  store = await openTempStore(tmp);
  const session = await store.sessions.create({ name: 'stop', claudeSessionId: 'c-1', task: 't', mode: 'single', cwd: path.join(tmp, 'ws'), status: 'run' });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'main', status: 'run' });
  const emitted: EventRecord[] = [];
  const recorder = new StreamRecorder({ store, session, mainAgentId: main.id, onEvent: (event) => emitted.push(event) });
  const s = store;
  return {
    recorder,
    session,
    store: s,
    async feed(...lines: string[]): Promise<void> {
      for (const l of lines) await recorder.handle(parseStreamLine(l));
    },
    async payload<P>(id: number): Promise<P> {
      return (await s.events.get(id))?.payload as P;
    },
    status: () => deriveSessionStatus(recorder.statusInput()),
  };
}

describe('stop · the recorder (D50)', () => {
  it('withdraws the messages no turn started on (queued ones and one whose turn has not started), in order; the stopped result leaves it idle', async () => {
    const w = await recorderWorld();
    const first = await w.recorder.recordUserMessage('Task.', 'task');
    await w.feed(init, replay('Task.'));
    const a = await w.recorder.recordUserMessage('A queued.', 'user');
    const b = await w.recorder.recordUserMessage('B queued.', 'service');
    expect(w.status()).toBe('run');

    const withdrawn = await w.recorder.withdrawQueued();
    expect(withdrawn.map((m) => [m.eventId, m.text, m.wasQueued])).toEqual([
      [a.id, 'A queued.', true],
      [b.id, 'B queued.', true],
    ]);
    expect(await w.payload<UserPayload>(a.id)).toEqual({ type: 'user', text: 'A queued.', origin: 'user', delivered: false, withdrawn: true });
    expect(await w.payload<UserPayload>(b.id)).toMatchObject({ withdrawn: true });
    expect(await w.payload<UserPayload>(first.id)).toEqual({ type: 'user', text: 'Task.', origin: 'task', delivered: true });
    // Still running: the turn is open until its result.
    expect(w.status()).toBe('run');
    w.recorder.beginInterrupt();
    await w.feed(abortedResult());
    expect(w.recorder.statusInput()).toMatchObject({ turnRunning: false, lastOutcome: 'stopped' });
    expect(w.status()).toBe('idle');
    const stopped = (await w.store.events.list(w.session.id)).filter((e) => payloadType(e) === 'result');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ kind: 'text', label: 'Stopped' });
    expect(stopped[0]?.payload).toMatchObject({ stopped: true, isError: true, terminalReason: 'aborted_streaming' });

    // The next message runs normally: its result is an outcome again.
    await w.recorder.recordUserMessage('Next.', 'user');
    await w.feed(init, replay('Next.'), successResult);
    expect(w.recorder.statusInput()).toMatchObject({ turnRunning: false, lastOutcome: 'success' });
    expect(w.status()).toBe('done');
  });

  it('a message written idle whose turn has not started yet is withdrawn too; one its turn started on (init) stays', async () => {
    const w = await recorderWorld();
    const started = await w.recorder.recordUserMessage('Started.', 'user');
    await w.feed(init);
    expect(await w.recorder.withdrawQueued()).toEqual([]);
    expect(await w.payload<UserPayload>(started.id)).not.toHaveProperty('withdrawn');
    w.recorder.beginInterrupt();
    await w.feed(abortedResult());
    expect(w.status()).toBe('idle');

    const idle = await w.recorder.recordUserMessage('Not started yet.', 'user');
    expect(idle.payload).not.toHaveProperty('queued');
    const withdrawn = await w.recorder.withdrawQueued();
    expect(withdrawn.map((m) => [m.text, m.wasQueued])).toEqual([['Not started yet.', false]]);
    expect(w.recorder.statusInput().turnRunning).toBe(false);
  });

  it('a withdrawn message the CLI had taken up after all (its echo was on its way): delivered again, and the count stays right', async () => {
    const w = await recorderWorld();
    await w.recorder.recordUserMessage('Task.', 'task');
    await w.feed(init, replay('Task.'));
    const late = await w.recorder.recordUserMessage('Absorbed late.', 'user');
    await w.recorder.withdrawQueued();
    w.recorder.beginInterrupt();
    // The running turn had absorbed it at a tool boundary just before the interrupt landed.
    await w.feed(replay('Absorbed late.', 'u-late'));
    expect(await w.payload<UserPayload>(late.id)).toEqual({ type: 'user', text: 'Absorbed late.', origin: 'user', delivered: true });
    expect((await w.store.events.get(late.id))?.uuid).toBe('u-late');
    await w.feed(abortedResult('aborted_tools'));
    expect(w.recorder.statusInput()).toMatchObject({ turnRunning: false, lastOutcome: 'stopped' });
  });

  it('an aborted result without a Stop is a failure; a turn that finished before the interrupt landed keeps its success', async () => {
    const w = await recorderWorld();
    await w.recorder.recordUserMessage('Task.', 'task');
    await w.feed(init, replay('Task.'), abortedResult());
    expect(w.status()).toBe('fail');

    await w.recorder.recordUserMessage('Again.', 'user');
    await w.feed(init, replay('Again.'));
    w.recorder.beginInterrupt();
    await w.feed(successResult);
    expect(w.status()).toBe('done');
    // A second aborted result of the same Stop (a late latch) adds no second "Stopped" line.
    await w.feed(abortedResult(), abortedResult());
    const lines = (await w.store.events.list(w.session.id)).filter((e) => (e.payload as ResultPayload).stopped);
    expect(lines).toHaveLength(1);
    expect(w.status()).toBe('idle');
  });

  it('a foreground subagent the Stop cut off (its Agent call returns the interrupt error) is idle and no longer keeps the session running', async () => {
    const w = await recorderWorld();
    await w.recorder.recordUserMessage('Delegate.', 'task');
    await w.feed(
      init,
      replay('Delegate.'),
      line({ type: 'assistant', message: { id: 'm1', model: 'm', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'Look', prompt: 'Look around', subagent_type: 'general-purpose' } }] }, parent_tool_use_id: null, session_id: 's', uuid: 'a1' }),
      line({ type: 'system', subtype: 'task_started', task_id: 't-sub', tool_use_id: 'toolu_A', description: 'Look', task_type: 'local_agent', session_id: 's' }),
    );
    expect(w.recorder.statusInput().runningAgents).toBe(1);
    w.recorder.beginInterrupt();
    await w.feed(
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', is_error: true, content: 'Interrupted' }] }, parent_tool_use_id: null, session_id: 's', uuid: 'tr1' }),
      abortedResult('aborted_tools'),
    );
    expect(w.recorder.statusInput()).toMatchObject({ runningAgents: 0, turnRunning: false, lastOutcome: 'stopped' });
    const sub = (await w.store.agents.listBySession(w.session.id)).find((agent) => agent.kind === 'subagent');
    expect(sub).toMatchObject({ status: 'idle', statusText: null });
    expect(w.status()).toBe('idle');
  });

  it('requests still open after the stopped turn are closed as cancelled (the fallback when the CLI withdrew none)', async () => {
    const w = await recorderWorld();
    await w.recorder.recordUserMessage('Write it.', 'task');
    await w.feed(
      init,
      replay('Write it.'),
      line({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_B' } }),
    );
    expect(w.status()).toBe('need');
    w.recorder.beginInterrupt();
    await w.feed(abortedResult('aborted_tools'));
    expect(await w.recorder.cancelRequests(['req-1', 'req-unknown'])).toEqual(['req-1']);
    const ask = (await w.store.events.list(w.session.id)).find((e) => payloadType(e) === 'request');
    expect((ask?.payload as RequestPayload).state).toBe('cancelled');
    expect(w.status()).toBe('idle');
  });
});

// ── real path ─────────────────────────────────────────────────────────────

async function userEvents(w: SupervisorWorld, id: string): Promise<EventRecord[]> {
  return (await w.store.events.list(id)).filter((e) => payloadType(e) === 'user');
}

async function resultEvents(w: SupervisorWorld, id: string): Promise<EventRecord[]> {
  return (await w.store.events.list(id)).filter((e) => payloadType(e) === 'result');
}

/** The stdin `interrupt` requests one process got. */
async function interrupts(w: SupervisorWorld, pid: number): Promise<Array<Record<string, unknown>>> {
  return (await stdinOf(w.logFile, pid)).filter((l) => l['type'] === 'control_request' && (l['request'] as { subtype?: string }).subtype === 'interrupt');
}

/** A session thinking without a tool call for `seconds` ([fake:hold]). */
async function holding(w: SupervisorWorld, seconds = 8) {
  const session = await w.supervisor.start(newSession({ task: `[fake:hold ${seconds}] Think it through.` }), w.place);
  await waitForEvent(w.store, session.id, (e) => payloadType(e) === 'user' && (e.payload as UserPayload).delivered);
  return session;
}

/** Sends the next message and waits for its turn to end: the process works normally after the Stop. */
async function nextRunsNormally(w: SupervisorWorld, id: string, pid: number | null): Promise<void> {
  await w.supervisor.sendMessage(id, 'Reply with exactly: resumed-ok');
  await waitForStatus(w.store, id, ['done']);
  expect(w.supervisor.pid(id)).toBe(pid);
  const results = await resultEvents(w, id);
  expect(results.at(-1)?.payload).toMatchObject({ isError: false, subtype: 'success' });
  expect(results.at(-1)?.payload).not.toHaveProperty('stopped');
}

describe('stop · real path (fake-claude, D50)', () => {
  it('0 queued: interrupt with cancel_queued, the "Stopped" line, status idle, process alive; the next message runs', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await holding(w);
    const pid = w.supervisor.pid(session.id);
    expect((await w.store.sessions.get(session.id))?.status).toBe('run');

    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('stopped');
    expect(reply.withdrawn).toEqual([]);
    expect(reply.record.status).toBe('idle');
    expect(w.supervisor.isLive(session.id)).toBe(true);
    expect(w.supervisor.pid(session.id)).toBe(pid);
    expect(w.supervisor.activity(session.id)).toBeNull();
    const sent = await interrupts(w, pid ?? -1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.['request']).toEqual({ subtype: 'interrupt', cancel_queued: true });
    const [stopped] = await resultEvents(w, session.id);
    expect(stopped).toMatchObject({ kind: 'text', label: 'Stopped' });
    expect(stopped?.payload).toMatchObject({ stopped: true, terminalReason: 'aborted_streaming' });
    expect((await w.store.agents.listBySession(session.id)).find((a) => a.kind === 'main')?.status).toBe('idle');

    await nextRunsNormally(w, session.id, pid);
  });

  it('1 queued: withdrawn (event marked, text returned), never run; the turn accounting leaves it idle', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await holding(w);
    await w.supervisor.sendMessage(session.id, 'Also: keep it short.');
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply).toMatchObject({ outcome: 'stopped', withdrawn: ['Also: keep it short.'] });
    expect(reply.record.status).toBe('idle');
    const queued = (await userEvents(w, session.id)).find((e) => (e.payload as UserPayload).text === 'Also: keep it short.');
    expect(queued?.payload).toEqual({ type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false, withdrawn: true });
    // It never runs: no turn, no echo, still idle a while later.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await resultEvents(w, session.id)).toHaveLength(1);
    expect((await w.store.events.get(queued?.id ?? -1))?.payload).toMatchObject({ delivered: false, withdrawn: true });
    expect((await w.store.sessions.get(session.id))?.status).toBe('idle');
    await nextRunsNormally(w, session.id, w.supervisor.pid(session.id));
  });

  it('2 queued: both withdrawn, oldest first; still idle; the next message runs', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await holding(w);
    await w.supervisor.sendMessage(session.id, 'First queued.');
    await w.supervisor.sendMessage(session.id, 'Second queued.');
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.withdrawn).toEqual(['First queued.', 'Second queued.']);
    expect(reply.record.status).toBe('idle');
    const withdrawn = (await userEvents(w, session.id)).filter((e) => (e.payload as UserPayload).withdrawn);
    expect(withdrawn.map((e) => (e.payload as UserPayload).text)).toEqual(['First queued.', 'Second queued.']);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await resultEvents(w, session.id)).toHaveLength(1);
    await nextRunsNormally(w, session.id, w.supervisor.pid(session.id));
  });

  it('at a tool boundary ([fake:interrupt-tool]): the tool closes as an error, aborted_tools, idle', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: '[fake:interrupt-tool] Run the long command.' }), w.place);
    const bash = await waitForEvent(w.store, session.id, (e) => e.kind === 'impl');
    expect((await w.store.sessions.get(session.id))?.status).toBe('run');
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('stopped');
    expect(reply.record.status).toBe('idle');
    expect(((await w.store.events.get(bash.id))?.payload as ToolPayload).isError).toBe(true);
    const [stopped] = await resultEvents(w, session.id);
    expect(stopped?.payload).toMatchObject({ stopped: true, terminalReason: 'aborted_tools' });
    await nextRunsNormally(w, session.id, w.supervisor.pid(session.id));
  });

  it('a permission prompt open: the CLI withdraws it, it goes to the handler\'s stopped (not cancelled), idle', async () => {
    const seen: CanUseToolContext[] = [];
    const stopped: string[] = [];
    const cancelled: string[] = [];
    world = await makeSupervisorWorld({
      scenario: 'perm-allow',
      controlHandler: {
        canUseTool: (context) => void seen.push(context),
        stopped: (_s, ids) => void stopped.push(...ids),
        cancelled: (_s, id) => void cancelled.push(id),
      },
    });
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'Run ls.' }), w.place);
    await waitForStatus(w.store, session.id, ['need']);
    const ask = await waitForEvent(w.store, session.id, (e) => payloadType(e) === 'request');
    const requestId = (ask.payload as RequestPayload).requestId;
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('stopped');
    expect(reply.record.status).toBe('idle');
    expect(stopped).toEqual([requestId]);
    expect(cancelled).toEqual([]);
    expect(((await w.store.events.get(ask.id))?.payload as RequestPayload).state).toBe('cancelled');
    // Never answered.
    expect((await stdinOf(w.logFile, session.pid ?? -1)).some((l) => l['type'] === 'control_response')).toBe(false);
    await expect(w.supervisor.respond(session.id, requestId, { behavior: 'allow', updatedInput: {} })).rejects.toMatchObject({ code: 'request-not-open' });
  });

  it('a second Stop while the first waits is harmless: one interrupt written, both stopped, the texts only once', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await holding(w);
    await w.supervisor.sendMessage(session.id, 'Queued.');
    const [one, two] = await Promise.all([w.supervisor.interrupt(session.id), w.supervisor.interrupt(session.id)]);
    expect(one).toMatchObject({ outcome: 'stopped', withdrawn: ['Queued.'] });
    expect(two).toMatchObject({ outcome: 'stopped', withdrawn: [] });
    expect(await interrupts(w, w.supervisor.pid(session.id) ?? -1)).toHaveLength(1);
    // And one more after it finished: nothing runs, nothing is written.
    const three = await w.supervisor.interrupt(session.id);
    expect(three).toMatchObject({ outcome: 'idle', withdrawn: [] });
    expect(await interrupts(w, w.supervisor.pid(session.id) ?? -1)).toHaveLength(1);
    expect((await w.store.sessions.get(session.id))?.status).toBe('idle');
  });

  it('idle (the turn is done) or no live process: `idle`, nothing is written', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession(), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply).toMatchObject({ outcome: 'idle', withdrawn: [] });
    expect(reply.record.status).toBe('done');
    expect(await interrupts(w, session.pid ?? -1)).toHaveLength(0);
    await w.supervisor.pause(session.id);
    expect((await w.supervisor.interrupt(session.id)).outcome).toBe('idle');
    await expect(w.supervisor.interrupt('no-such-session')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a message sent while the Stop waits goes out after it: never withdrawn, it runs', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await holding(w);
    const stop = w.supervisor.interrupt(session.id);
    const send = w.supervisor.sendMessage(session.id, 'After the stop.');
    const reply = await stop;
    await send;
    expect(reply.withdrawn).toEqual([]);
    await waitForStatus(w.store, session.id, ['done']);
    const message = (await userEvents(w, session.id)).find((e) => (e.payload as UserPayload).text === 'After the stop.');
    expect(message?.payload).toMatchObject({ delivered: true });
    expect(message?.payload).not.toHaveProperty('withdrawn');
  });

  it('a CLI that never acknowledges: `timeout`, an error line, nothing killed; Pause still ends the process', async () => {
    world = await makeSupervisorWorld({ parentEnv: { FAKE_CLAUDE_IGNORE_INTERRUPT: '1' }, timeouts: { ack: 400, result: 400, exit: 3_000 } });
    const w = world;
    const session = await holding(w, 4);
    const pid = w.supervisor.pid(session.id);
    const reply = await w.supervisor.interrupt(session.id);
    expect(reply.outcome).toBe('timeout');
    expect(w.supervisor.isLive(session.id)).toBe(true);
    expect(w.supervisor.pid(session.id)).toBe(pid);
    const error = await waitForEvent(w.store, session.id, (e) => payloadType(e) === 'stop');
    expect(error.kind).toBe('error');
    expect(error.label).toBe('Stop: the agent did not stop within 1 s. Pause ends the process.');
    expect(error.payload as StopPayload).toEqual({ type: 'stop', outcome: 'timeout', waitedMs: 400, missing: 'ack' });
    const paused = await w.supervisor.pause(session.id);
    expect(paused.status).toBe('paused');
    await until(async () => !w.supervisor.isLive(session.id) || undefined, 'the process ended');
  });
});

describe('stop background tasks · real path (fake-claude, D50 ruling)', () => {
  it('stop_task for each pending task: the tasks end as stopped, the wait goes; a wake-up is not stoppable', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'Start the dev server. [fake:background 60 npm run dev]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const task = await until(async () => w.supervisor.activity(session.id)?.background[0], 'the pending background task');
    expect(w.supervisor.activity(session.id)?.state).toBe('background');
    // Nothing to interrupt: no turn runs.
    expect((await w.supervisor.interrupt(session.id)).outcome).toBe('idle');

    const reply = await w.supervisor.stopBackground(session.id);
    expect(reply).toMatchObject({ stopped: [task.id], failed: [] });
    expect(w.supervisor.activity(session.id)).toBeNull();
    const sent = (await stdinOf(w.logFile, w.supervisor.pid(session.id) ?? -1)).filter((l) => (l['request'] as { subtype?: string } | undefined)?.subtype === 'stop_task');
    expect(sent.map((l) => l['request'])).toEqual([{ subtype: 'stop_task', task_id: task.id }]);
    expect(reply.record.status).toBe('done');
    // Nothing more comes for it (its end played as stopped, no turn of its own).
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await resultEvents(w, session.id)).toHaveLength(1);
    // Again: nothing left to stop.
    expect(await w.supervisor.stopBackground(session.id)).toMatchObject({ stopped: [], failed: [] });
  });

  it('only the named tasks; a wake-up (no CLI task) is left alone', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.supervisor.start(newSession({ task: 'Wait a bit. [fake:wakeup 60]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const wakeup = await until(async () => w.supervisor.activity(session.id)?.background[0], 'the wake-up');
    expect(wakeup.kind).toBe('wakeup');
    expect(await w.supervisor.stopBackground(session.id)).toMatchObject({ stopped: [], failed: [] });
    expect(await w.supervisor.stopBackground(session.id, [wakeup.id])).toMatchObject({ stopped: [], failed: [] });
    expect(w.supervisor.activity(session.id)?.background).toHaveLength(1);
  });
});
