import { appendFile, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { FullEventAnswer } from '../../../src/core/api.ts';
import { type AssistantPayload, PAYLOAD_TEXT_LIMIT, type ToolPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import { NOT_IN_TRANSCRIPT, TRANSCRIPT_GONE, restoreFullEvent } from '../../../src/server/sessions/full-event.ts';
import { ATTACH_RECENT_MS, claudeConfigDir, findTranscriptFile, importTerminalTurns } from '../../../src/server/supervisor/attach.ts';
import { generateToken } from '../../../src/server/token.ts';
import { SAY_LONG_END } from '../../../tools/fake-claude/scenarios.ts';
import { listTranscripts, runFake } from '../../helpers/fake-claude.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, payloadType, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * Fix · long messages on the real path (fake-claude with a temp CLAUDE_CONFIG_DIR):
 * a long reply is stored whole (live and imported from a terminal's turn), tool
 * output is still cut at 4,000, and `GET /api/sessions/{id}/events/{eventId}/full`
 * restores a message stored cut before the fix from the session's transcript
 * (written back, published), a tool call's whole output (answered, not stored), a
 * subagent's prompt from its own file, and says when the transcript is gone.
 */

const PORT = 4874;
const HOST = `127.0.0.1:${PORT}`;

let world: SupervisorWorld | undefined;
let app: FastifyInstance | undefined;
let token = '';

afterEach(async () => {
  await app?.close();
  await world?.cleanup();
  app = undefined;
  world = undefined;
});

async function setup(): Promise<SupervisorWorld> {
  world = await makeSupervisorWorld();
  token = generateToken();
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
  await seedFolder(world.store, world.workspace);
  app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor });
  await app.ready();
  return world;
}

function getFull(sessionId: string, eventId: number | string) {
  if (!app) throw new Error('no app');
  return app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/events/${eventId}/full`, headers: { host: HOST, cookie: `sb_token=${token}` } });
}

/** The world's env as plain strings (for the terminal run this test starts itself). */
function envOf(w: SupervisorWorld): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(w.env)) if (value !== undefined) out[key] = value;
  return out;
}

const assistantEvents = async (w: SupervisorWorld, sessionId: string): Promise<EventRecord[]> =>
  (await w.store.events.list(sessionId)).filter((event) => payloadType(event) === 'assistant');

/** Makes an event look as the recorder stored it before the fix: its text cut at 4,000, no flag. */
async function cutLikeBefore(w: SupervisorWorld, event: EventRecord): Promise<EventRecord> {
  const payload = event.payload as AssistantPayload;
  const updated = await w.store.events.update(event.id, { payload: { type: payload.type, text: payload.text.slice(0, PAYLOAD_TEXT_LIMIT), messageId: payload.messageId } });
  if (!updated) throw new Error('no event');
  return updated;
}

describe('Fix · long messages', () => {
  it('live: a 9,000-character reply is stored whole; an event cut before the fix is restored from the transcript, written back and published', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Write a long reply. [fake:say-long 9000]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const [reply] = await assistantEvents(w, session.id);
    const text = (reply?.payload as AssistantPayload).text;
    expect(text).toHaveLength(9000);
    expect(text.endsWith(SAY_LONG_END)).toBe(true);
    expect((reply?.payload as AssistantPayload).truncated).toBeUndefined();

    const published: number[] = [];
    const cut = await cutLikeBefore(w, reply as EventRecord);
    const answer = await restoreFullEvent(
      { store: w.store, findTranscript: (id) => w.supervisor.findTranscript(id), publish: (event) => published.push(event.id) },
      session.id,
      cut.id,
    );
    expect('status' in answer).toBe(false);
    const full = answer as FullEventAnswer;
    expect(full.saved).toBe(true);
    expect(full.event.payload).toMatchObject({ type: 'assistant', text, truncated: false });
    expect(published).toEqual([cut.id]);
    expect(((await w.store.events.get(cut.id))?.payload as AssistantPayload).text).toBe(text);

    // Through the route: whole now, so answered as it is.
    const again = await getFull(session.id, cut.id);
    expect(again.statusCode).toBe(200);
    expect((again.json() as FullEventAnswer).event.payload).toMatchObject({ text });
  }, 30_000);

  it('the route: a tool call\'s whole input from the transcript (not stored), refusals, and a gone transcript', async () => {
    const w = await setup();
    const long = 'L'.repeat(6000);
    const session = await w.supervisor.start(newSession({ task: `Write it. [fake:tool Write {"file_path":"notes.txt","content":"${long}"}]` }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const events = await w.store.events.list(session.id);
    const call = events.find((event) => payloadType(event) === 'tool');
    const stored = call?.payload as ToolPayload;
    expect(stored.inputTruncated).toBe(true);
    expect(stored.input['content']).toHaveLength(PAYLOAD_TEXT_LIMIT);

    const answer = await getFull(session.id, call?.id ?? 0);
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as FullEventAnswer;
    expect(body.saved).toBe(false);
    expect((body.event.payload as ToolPayload).input['content']).toBe(long);
    expect((body.event.payload as ToolPayload).inputTruncated).toBeUndefined();
    // Tool output stays cut in the database.
    expect(((await w.store.events.get(call?.id ?? 0))?.payload as ToolPayload).inputTruncated).toBe(true);

    // Refusals.
    const lifecycle = events.find((event) => payloadType(event) === 'lifecycle');
    expect((await getFull(session.id, lifecycle?.id ?? 0)).json()).toMatchObject({ error: 'not-restorable' });
    expect((await getFull(session.id, lifecycle?.id ?? 0)).statusCode).toBe(422);
    expect((await getFull(session.id, 999_999)).statusCode).toBe(404);
    expect((await getFull(session.id, 'abc')).statusCode).toBe(404);
    expect((await getFull('no-such-session', call?.id ?? 0)).statusCode).toBe(404);

    // A message cut before the fix, with the transcript gone: 410 and the words the chat shows.
    const [reply] = await assistantEvents(w, session.id);
    await w.store.events.update(reply?.id ?? 0, { payload: { type: 'assistant', text: 'x'.repeat(PAYLOAD_TEXT_LIMIT), messageId: null } });
    // The transcript has no message starting with x's: not in the transcript.
    const missing = await getFull(session.id, reply?.id ?? 0);
    expect(missing.statusCode).toBe(410);
    expect(missing.json()).toEqual({ error: 'not-in-transcript', message: NOT_IN_TRANSCRIPT });
    for (const file of await listTranscripts(w.configDir)) await rm(file);
    const gone = await getFull(session.id, reply?.id ?? 0);
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({ error: 'transcript-gone', message: TRANSCRIPT_GONE });
  }, 30_000);

  it('attached terminal turns: a long reply typed in the terminal is imported whole; cut before the fix, it is restored', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Reply with just OK.' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.detach(session.id);
    const run = await runFake(['-p', '--resume', session.claudeSessionId, 'Now a long one. [fake:say-long 7000]'], { cwd: w.workspace, env: envOf(w) });
    expect(run.code, run.stderr).toBe(0);
    const [file] = await listTranscripts(w.configDir);
    const old = new Date(Date.now() - ATTACH_RECENT_MS - 60_000);
    await utimes(file as string, old, old);
    await w.supervisor.attach(session.id, { confirm: true });
    await waitForStatus(w.store, session.id, ['idle']);
    const replies = await assistantEvents(w, session.id);
    const long = replies.find((event) => (event.payload as AssistantPayload).text.length === 7000);
    expect(long, JSON.stringify(replies.map((event) => (event.payload as AssistantPayload).text.length))).toBeDefined();
    expect((long?.payload as AssistantPayload).text.endsWith(SAY_LONG_END)).toBe(true);

    const cut = await cutLikeBefore(w, long as EventRecord);
    const answer = await getFull(session.id, cut.id);
    expect(answer.statusCode).toBe(200);
    expect((answer.json() as FullEventAnswer).event.payload).toMatchObject({ text: (long?.payload as AssistantPayload).text, truncated: false });
    await w.supervisor.pause(session.id);
  }, 30_000);

  it('a subagent\'s prompt cut before the fix is restored from its own file (`subagents/agent-<id>.jsonl`)', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Reply with just OK.' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    const transcript = await findTranscriptFile(claudeConfigDir(w.env), session.claudeSessionId);
    expect(transcript).not.toBeNull();
    const brief = `${'S'.repeat(5000)} the brief's end`;
    const folder = path.join(path.dirname(transcript as string), session.claudeSessionId, 'subagents');
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, 'agent-a1.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'sub-u1', parentUuid: null, isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: brief } })}\n`,
    );
    const event = await w.store.events.append({ sessionId: session.id, kind: 'text', label: 'brief', payload: { type: 'agent-prompt', text: brief.slice(0, PAYLOAD_TEXT_LIMIT) }, uuid: 'sub-u1' });
    const answer = await getFull(session.id, event.id);
    expect(answer.statusCode).toBe(200);
    expect((answer.json() as FullEventAnswer).event.payload).toEqual({ type: 'agent-prompt', text: brief, truncated: false });
  }, 30_000);

  it('importTerminalTurns: a transcript\'s long reply and long subagent prompt whole, its tool result still cut at 4,000', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Reply with just OK.' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    const record = await w.store.sessions.get(session.id);
    const mainId = (await w.store.agents.listBySession(session.id)).find((agent) => agent.kind === 'main')?.id ?? '';
    const file = path.join(w.root, 'import.jsonl');
    const ts = new Date().toISOString();
    const lines = [
      { type: 'user', uuid: 'i-u1', parentUuid: null, timestamp: ts, message: { role: 'user', content: 'Go.' } },
      { type: 'assistant', uuid: 'i-m1', parentUuid: 'i-u1', timestamp: ts, message: { id: 'msg_i1', model: 'claude', content: [{ type: 'text', text: 'T'.repeat(3000) }] } },
      { type: 'assistant', uuid: 'i-m2', parentUuid: 'i-m1', timestamp: ts, message: { id: 'msg_i1', model: 'claude', content: [{ type: 'text', text: 'U'.repeat(3000) }] } },
      { type: 'assistant', uuid: 'i-m3', parentUuid: 'i-m2', timestamp: ts, message: { id: 'msg_i2', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_i', name: 'Bash', input: { command: 'cat big' } }] } },
      { type: 'user', uuid: 'i-r1', parentUuid: 'i-m3', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_i', content: 'O'.repeat(9000) }] } },
    ];
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'));
    await appendFile(file, '\n');
    const result = await importTerminalTurns({ store: w.store, session: { ...(record as NonNullable<typeof record>), lastTranscriptUuid: null }, transcript: file, mainAgentId: mainId, onEvent: () => undefined, fromStart: true });
    expect(result.found).toBe(true);
    const events = await w.store.events.list(session.id);
    const merged = events.find((event) => (event.payload as AssistantPayload).messageId === 'msg_i1');
    expect((merged?.payload as AssistantPayload).text).toBe(`${'T'.repeat(3000)}\n\n${'U'.repeat(3000)}`);
    const tool = events.find((event) => event.toolUseId === 'toolu_i');
    expect(tool?.payload).toMatchObject({ result: 'O'.repeat(PAYLOAD_TEXT_LIMIT), resultTruncated: true });

    // A subagent's file: its prompt whole.
    const subFile = path.join(w.root, 'agent-x.jsonl');
    await writeFile(subFile, `${JSON.stringify({ type: 'user', uuid: 'x-u1', parentUuid: null, isSidechain: true, timestamp: ts, message: { role: 'user', content: 'V'.repeat(6000) } })}\n`);
    await importTerminalTurns({ store: w.store, session: record as NonNullable<typeof record>, transcript: subFile, mainAgentId: mainId, onEvent: () => undefined, subagent: { agentId: mainId } });
    const prompt = (await w.store.events.list(session.id)).find((event) => event.uuid === 'x-u1');
    expect(prompt?.payload).toEqual({ type: 'agent-prompt', text: 'V'.repeat(6000) });
  }, 30_000);
});
