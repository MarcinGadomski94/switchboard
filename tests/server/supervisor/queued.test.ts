import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { parseStreamLine } from '../../../src/core/stream-json.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import type { CanUseToolContext } from '../../../src/server/supervisor/supervisor.ts';
import { FIXTURES_DIR } from '../../../tools/fake-claude/fixtures.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D44 queued messages (`docs/derivations.md` → *Queued messages*): the recorder
 * marks a user message `queued` while the agent has not taken it up (written while
 * a turn runs: `turn`; written to a process started for it because the session had
 * none: `resume`) and clears it at the pickup the CLI reports (the turn that starts
 * on it, `system/init`, or its replay), re-sending the event (the `/hub` path).
 * First over the M0 recordings (`multiturn`: two turns in one process), then on the
 * real path with fake-claude.
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

async function fixtureLines(name: string): Promise<string[]> {
  return (await readFile(path.join(FIXTURES_DIR, `${name}.ndjson`), 'utf8')).split('\n').filter((line) => line.trim() !== '');
}

/** A recorder over a temp store; `emitted` = every event it inserted or updated, in order. */
async function recorderWorld() {
  tmp = await makeTempDir('queued');
  store = await openTempStore(tmp);
  const session = await store.sessions.create({ name: 'queued', claudeSessionId: 'c-1', task: 't', mode: 'single', cwd: path.join(tmp, 'ws'), status: 'run' });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'main', status: 'run' });
  const emitted: EventRecord[] = [];
  const recorder = new StreamRecorder({ store, session, mainAgentId: main.id, onEvent: (event) => emitted.push(event) });
  const s = store;
  return {
    recorder,
    emitted,
    async feed(lines: readonly string[]): Promise<void> {
      for (const line of lines) await recorder.handle(parseStreamLine(line));
    },
    async payload(id: number): Promise<UserPayload> {
      return (await s.events.get(id))?.payload as UserPayload;
    },
    /** The payloads `onEvent` carried for event `id`, in order. */
    versions(id: number): UserPayload[] {
      return emitted.filter((e) => e.id === id).map((e) => e.payload as UserPayload);
    },
  };
}

const FIRST = 'Remember the code word: zeppelin. Reply with just OK.';
const SECOND = 'What code word did I ask you to remember? Reply with just the word.';

describe('queued messages · the recorder over the M0 recordings (D44)', () => {
  it('multiturn: a message written while the first turn runs is queued (turn) until the next turn\'s init; its replay then delivers it', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('multiturn');
    const firstResult = lines.findIndex((l) => l.includes('"type":"result"'));
    const secondInit = lines.findIndex((l, i) => i > firstResult && l.includes('"subtype":"init"'));
    const secondReplay = lines.findIndex((l, i) => i > secondInit && l.includes('"isReplay":true'));

    // Sent idle: never queued.
    const first = await w.recorder.recordUserMessage(FIRST, 'task');
    expect(first.payload).toEqual({ type: 'user', text: FIRST, origin: 'task', delivered: false });
    // The first turn starts (init, thinking ticks); the second message is written meanwhile.
    await w.feed(lines.slice(0, 5));
    const second = await w.recorder.recordUserMessage(SECOND, 'user');
    expect(second.payload).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: false, queued: 'turn' });

    // The first message's replay, its reply and its result: the second still waits.
    await w.feed(lines.slice(5, secondInit));
    expect(await w.payload(first.id)).toEqual({ type: 'user', text: FIRST, origin: 'task', delivered: true });
    expect(await w.payload(second.id)).toMatchObject({ delivered: false, queued: 'turn' });

    // The next turn's init: the CLI starts on it, so the clock goes (re-sent: the `/hub` event), not delivered yet.
    await w.feed([lines[secondInit] as string]);
    expect(await w.payload(second.id)).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: false });
    // Thinking ticks, then its replay: delivered.
    await w.feed(lines.slice(secondInit + 1, secondReplay + 1));
    expect(await w.payload(second.id)).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: true });
    await w.feed(lines.slice(secondReplay + 1));

    expect(w.versions(second.id)).toEqual([
      { type: 'user', text: SECOND, origin: 'user', delivered: false, queued: 'turn' },
      { type: 'user', text: SECOND, origin: 'user', delivered: false },
      { type: 'user', text: SECOND, origin: 'user', delivered: true },
    ]);
    expect(w.recorder.statusInput().turnRunning).toBe(false);
    // The message sent idle never carried `queued`.
    expect(w.versions(first.id).some((p) => 'queued' in p)).toBe(false);
  });

  it('a message a running turn absorbs (its replay comes mid-turn, no init) is taken up by the replay; the turn\'s one result ends both', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('multiturn');
    const firstResult = lines.findIndex((l) => l.includes('"type":"result"'));
    await w.recorder.recordUserMessage(FIRST, 'task');
    await w.feed(lines.slice(0, 7));
    const second = await w.recorder.recordUserMessage(SECOND, 'user');
    expect((await w.payload(second.id)).queued).toBe('turn');
    const echo = { type: 'user', message: { role: 'user', content: SECOND }, parent_tool_use_id: null, session_id: 's', uuid: 'u-absorbed', isReplay: true };
    await w.feed([JSON.stringify(echo)]);
    expect(await w.payload(second.id)).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: true });
    expect(w.recorder.statusInput().turnRunning).toBe(true);
    await w.feed(lines.slice(7, firstResult + 1));
    expect(await w.payload(second.id)).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: true });
    // No result of its own follows: the session is not left running.
    expect(w.recorder.statusInput()).toMatchObject({ turnRunning: false, lastOutcome: 'success' });
  });

  it('resume: a message written to a process started for it is queued (resume) until that process starts its turn', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('multiturn');
    const init = lines.findIndex((l) => l.includes('"subtype":"init"'));
    const message = await w.recorder.recordUserMessage(FIRST, 'user', { resuming: true });
    expect(message.payload).toMatchObject({ delivered: false, queued: 'resume' });
    // The startup lines (SessionStart hooks) take nothing up.
    await w.feed(lines.slice(0, init));
    expect((await w.payload(message.id)).queued).toBe('resume');
    await w.feed([lines[init] as string]);
    expect(await w.payload(message.id)).toEqual({ type: 'user', text: FIRST, origin: 'user', delivered: false });
  });

  it('the process ends with a message still queued: it loses the clock (never taken up), the others stay as they are', async () => {
    const w = await recorderWorld();
    const lines = await fixtureLines('multiturn');
    const first = await w.recorder.recordUserMessage(FIRST, 'task');
    await w.feed(lines.slice(0, 5));
    const second = await w.recorder.recordUserMessage(SECOND, 'user');
    await w.recorder.closeQueued();
    expect(await w.payload(second.id)).toEqual({ type: 'user', text: SECOND, origin: 'user', delivered: false });
    expect(await w.payload(first.id)).toEqual({ type: 'user', text: FIRST, origin: 'task', delivered: false });
    expect(w.versions(second.id)).toHaveLength(2);
  });
});

/** The supervisor's `event` notifications (the `/hub` `event` payloads) for one event id. */
function eventVersions(list: ReadonlyArray<{ sessionId: string; event: SessionEvent }>, id: number): UserPayload[] {
  return list.filter((m) => m.event.id === id).map((m) => m.event.payload as UserPayload);
}

describe('queued messages · real path (fake-claude, D44)', () => {
  it('a message sent while a turn thinks ([fake:hold]) is queued (turn) until the next turn starts on it, then delivered; live over `event`', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    w.supervisor.on('event', (payload) => events.push(payload));
    const session = await w.supervisor.start(newSession({ task: '[fake:hold 1.5] Think for a while.' }), w.place);
    await waitForStatus(w.store, session.id, ['run']);
    const task = (await w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).type === 'user');
    expect(task?.payload).not.toHaveProperty('queued');

    await w.supervisor.sendMessage(session.id, 'Also: keep it short.');
    const queued = (await w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).text === 'Also: keep it short.');
    expect(queued?.payload).toEqual({ type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false, queued: 'turn' });
    await until(async () => ((await w.store.events.get(queued?.id ?? -1))?.payload as UserPayload).delivered || undefined, 'the queued message delivered');
    await waitForStatus(w.store, session.id, ['done']);
    // Live: first queued, then (same id) without `queued` when its turn started, then delivered by its replay.
    expect(eventVersions(events, queued?.id ?? -1)).toEqual([
      { type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false, queued: 'turn' },
      { type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false },
      { type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: true },
    ]);
    // Two turns, two results.
    expect((await w.store.events.list(session.id)).filter((e) => (e.payload as { type?: string }).type === 'result')).toHaveLength(2);
  });

  it('a message sent while a question holds the turn is absorbed at the tool boundary the answer makes: queued, then delivered mid-turn; the one result leaves the session done', async () => {
    const seen: CanUseToolContext[] = [];
    world = await makeSupervisorWorld({ scenario: 'ask-2q', controlHandler: { canUseTool: (context) => void seen.push(context) } });
    const w = world;
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    w.supervisor.on('event', (payload) => events.push(payload));
    const session = await w.supervisor.start(newSession({ task: 'Ask me two questions.' }), w.place);
    await waitForStatus(w.store, session.id, ['need']);

    await w.supervisor.sendMessage(session.id, 'Also: keep it short.');
    const queued = (await w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).text === 'Also: keep it short.');
    expect(queued?.payload).toEqual({ type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false, queued: 'turn' });
    expect((await w.store.sessions.get(session.id))?.status).toBe('need');

    const request = seen[0]?.request;
    const answers = { 'Which color should the button be?': 'Green', 'Which size should it be?': 'Small' };
    await w.supervisor.respond(session.id, request?.requestId ?? '', { behavior: 'allow', updatedInput: { ...request?.input, answers } });
    await waitForStatus(w.store, session.id, ['done']);
    expect((await w.store.events.get(queued?.id ?? -1))?.payload).toEqual({ type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: true });
    expect(eventVersions(events, queued?.id ?? -1)).toEqual([
      { type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: false, queued: 'turn' },
      { type: 'user', text: 'Also: keep it short.', origin: 'user', delivered: true },
    ]);
    // One turn, one result: the absorbed message gets none of its own, and the session is not left running.
    expect((await w.store.events.list(session.id)).filter((e) => (e.payload as { type?: string }).type === 'result')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await w.store.sessions.get(session.id))?.status).toBe('done');
  });

  it('a message to a paused session resumes it and is queued (resume) until the new process takes it up; a message sent idle is never queued', async () => {
    // The CLI needs a moment to start (SessionStart hooks, MCP servers): FAKE_CLAUDE_STARTUP_MS stands for it.
    world = await makeSupervisorWorld({ parentEnv: { FAKE_CLAUDE_STARTUP_MS: '600' } });
    const w = world;
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    w.supervisor.on('event', (payload) => events.push(payload));
    const session = await w.supervisor.start(newSession({ task: 'Remember the code word: zeppelin. Reply with just OK.' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    // Sent idle to the live process: never queued.
    await w.supervisor.sendMessage(session.id, 'Still there?');
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    expect((await w.store.sessions.get(session.id))?.status).toBe('paused');

    const sentAt = Date.now();
    await w.supervisor.sendMessage(session.id, 'Are you back?');
    const message = (await w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).text === 'Are you back?');
    expect(message?.payload).toMatchObject({ delivered: false, queued: 'resume' });
    await until(async () => !('queued' in ((await w.store.events.get(message?.id ?? -1))?.payload as object)) || undefined, 'the clock cleared');
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(500);
    await waitForStatus(w.store, session.id, ['done']);
    expect(eventVersions(events, message?.id ?? -1)).toEqual([
      { type: 'user', text: 'Are you back?', origin: 'user', delivered: false, queued: 'resume' },
      { type: 'user', text: 'Are you back?', origin: 'user', delivered: false },
      { type: 'user', text: 'Are you back?', origin: 'user', delivered: true },
    ]);
    const idle = (await w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).text === 'Still there?');
    expect(eventVersions(events, idle?.id ?? -1).some((p) => 'queued' in p)).toBe(false);
    // The Resume button's "Continue." is the resume itself: never queued.
    await w.supervisor.pause(session.id);
    await w.supervisor.resume(session.id);
    const resumed = (await w.store.events.list(session.id)).filter((e) => (e.payload as UserPayload).origin === 'resume');
    expect(resumed).toHaveLength(1);
    expect(eventVersions(events, resumed[0]?.id ?? -1).some((p) => 'queued' in p)).toBe(false);
  });

  it('a service crash left a message queued: the clean-up before a restart clears it', async () => {
    world = await makeSupervisorWorld();
    const w = world;
    const session = await w.store.sessions.create({ name: 'crashed', claudeSessionId: 'c-9', task: 't', mode: 'single', cwd: w.workspace, status: 'run' });
    const event = await w.store.events.append({
      sessionId: session.id,
      kind: 'text',
      label: 'Queued',
      payload: { type: 'user', text: 'Queued', origin: 'user', delivered: false, queued: 'turn' },
    });
    const events: Array<{ sessionId: string; event: SessionEvent }> = [];
    w.supervisor.on('event', (payload) => events.push(payload));
    await w.supervisor.settleAfterCrash(session.id);
    expect((await w.store.events.get(event.id))?.payload).toEqual({ type: 'user', text: 'Queued', origin: 'user', delivered: false });
    expect(eventVersions(events, event.id)).toEqual([{ type: 'user', text: 'Queued', origin: 'user', delivered: false }]);
  });
});
