/**
 * D96 (`docs/chat.md` → *Progress notes*): on the newest models the text a model
 * writes between tool calls comes back as a non-empty `thinking` block. It is
 * agent text: recorded as an `assistant` event (`note: true`) right where it was
 * written (so directly above the question card it introduces), the Inbox question
 * item's context, read from a hooked session's transcript too, and never twice.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantPayload, ToolPayload } from '../../../src/core/event-payload.ts';
import { transcriptTurn } from '../../../src/core/derive/hooked-activity.ts';
import { parseStreamLine, progressNoteText } from '../../../src/core/stream-json.ts';
import { parseTranscript as parseHistoryTranscript } from '../../../src/core/transcript.ts';
import { transcriptItems } from '../../../src/core/transcript-sync.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import { questionBatchItem, questionContext } from '../../../src/server/inbox/wire.ts';
import { importTerminalTurns } from '../../../src/server/supervisor/attach.ts';
import type { ControlRequestHandler } from '../../../src/server/supervisor/supervisor.ts';
import { noteToken } from '../../../tools/fake-claude/scenarios.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

const NOTE = "I've reviewed the campaign setup, the tag workspace and the form tracking (all read-only checks). Two decisions are yours:";

/** The real shape (Claude Code 2.1.296, Opus 5.5): one message, three lines: empty thinking, the note as thinking, the ask. */
function noteMessage(ids: { readonly message: string; readonly uuids: readonly [string, string, string] }, parent: string | null, ts: string) {
  const line = (uuid: string, parentUuid: string | null, content: unknown[]) => ({
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp: ts,
    message: { id: ids.message, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: 'tool_use' },
  });
  const [a, b, c] = ids.uuids;
  return [
    line(a, parent, [{ type: 'thinking', thinking: '', signature: 's1' }]),
    line(b, a, [{ type: 'thinking', thinking: NOTE, signature: 's2' }]),
    line(c, b, [{ type: 'tool_use', id: 'toolu_note_ask', name: 'AskUserQuestion', input: { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] } }]),
  ];
}

let world: SupervisorWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

/** A supervisor world whose control requests go to the question pipeline (as `createSessionServices` joins them). */
async function setup(): Promise<SupervisorWorld> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const forward: ControlRequestHandler = {
    canUseTool: (context) => holder.pipeline?.canUseTool(context),
    cancelled: (sessionId, requestId) => holder.pipeline?.cancelled(sessionId, requestId),
    orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
    pendingDelivered: (sessionId, messages) => holder.pipeline?.pendingDelivered(sessionId, messages),
  };
  world = await makeSupervisorWorld({ controlHandler: forward });
  holder.pipeline = new QuestionPipeline({ store: world.store, bus: new HubBus() }).bind(world.supervisor);
  return world;
}

const isNote = (event: EventRecord): boolean => (event.payload as AssistantPayload | null)?.type === 'assistant' && (event.payload as AssistantPayload).note === true;

describe('D96 · progress notes (parsing)', () => {
  it('a thinking block keeps its text; only a non-empty one is a note (redacted and empty ones are not)', () => {
    const lines = noteMessage({ message: 'msg_p1', uuids: ['u1', 'u2', 'u3'] }, null, '2026-10-13T10:00:00.000Z').map((line) => parseStreamLine(JSON.stringify({ ...line, parent_tool_use_id: null })));
    const blocks = lines.flatMap((message) => (message.kind === 'assistant' ? message.blocks : []));
    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'thinking', 'tool_use']);
    expect(blocks.map(progressNoteText)).toEqual([null, NOTE, null]);
    const redacted = parseStreamLine(JSON.stringify({ type: 'assistant', uuid: 'r', message: { id: 'm', content: [{ type: 'redacted_thinking', data: 'x' }] } }));
    expect(redacted.kind === 'assistant' ? redacted.blocks.map(progressNoteText) : 'not assistant').toEqual([null]);
    const blank = parseStreamLine(JSON.stringify({ type: 'assistant', uuid: 'b', message: { id: 'm', content: [{ type: 'thinking', thinking: ' \n ' }] } }));
    expect(blank.kind === 'assistant' ? blank.blocks.map(progressNoteText) : 'not assistant').toEqual([null]);
  });

  it('transcript items: the note is agent text (`note`), the ask follows; History\'s last text and the live line read it too', () => {
    const ts = '2026-10-13T10:00:00.000Z';
    const prompt = { type: 'user', uuid: 'p0', parentUuid: null, isSidechain: false, timestamp: ts, message: { role: 'user', content: 'Check the setup.' } };
    const lines = [prompt, ...noteMessage({ message: 'msg_p2', uuids: ['t1', 't2', 't3'] }, 'p0', ts)];
    const items = transcriptItems(lines);
    expect(items.map((item) => [item.kind, 'note' in item ? item.note : undefined])).toEqual([['prompt', undefined], ['text', true], ['tool-use', undefined]]);
    expect(items[1]).toMatchObject({ kind: 'text', text: NOTE, messageId: 'msg_p2' });
    // D53: while the note is the newest line, the agent is writing (not thinking).
    expect(transcriptTurn(lines.slice(0, 3))).toMatchObject({ running: true, state: 'writing' });
    // History's summary (`lastText`) of a session whose last words were a note.
    const facts = parseHistoryTranscript('sid', lines.map((line) => JSON.stringify(line)).join('\n'));
    expect(facts.lastText).toBe(NOTE);
  });

  it('fake-claude [fake:note] token: one JSON string, else an error', () => {
    expect(noteToken(`[fake:ask-2q] [fake:note ${JSON.stringify(NOTE)}] Ask me.`)).toEqual({ text: NOTE });
    expect(noteToken('no token')).toBeNull();
    expect(noteToken('[fake:note]')).toMatchObject({ error: expect.any(String) });
    expect(noteToken('[fake:note ""]')).toMatchObject({ error: expect.any(String) });
  });
});

describe('D96 · progress notes (supervised session, fake-claude)', () => {
  it('[empty thinking, note, AskUserQuestion]: one note event right before the ask; the Inbox item carries it as the context', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: `[fake:ask-2q] [fake:note ${JSON.stringify(NOTE)}] Ask me two questions.` }), w.place);
    await waitForStatus(w.store, session.id, ['need']);
    const [batch] = await until(async () => {
      const list = await w.store.questions.listBatches({ sessionId: session.id });
      return list.length > 0 ? list : undefined;
    }, 'a question batch');
    const events = await w.store.events.list(session.id);
    const notes = events.filter(isNote);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.payload).toMatchObject({ type: 'assistant', text: NOTE, note: true });
    expect(notes[0]?.kind).toBe('text');
    // The chat order: the note, then the AskUserQuestion call (the card), nothing between them.
    const main = events.filter((event) => event.agentId === notes[0]?.agentId);
    const at = main.findIndex(isNote);
    expect((main[at + 1]?.payload as ToolPayload | null)?.name).toBe('AskUserQuestion');
    expect(notes[0]?.messageId).toBe(main[at + 1]?.messageId);

    expect(await questionContext(w.store, batch!)).toBe(NOTE);
    expect(await questionBatchItem(w.store, batch!)).toMatchObject({ kind: 'questions', detail: NOTE });
  }, 30_000);

  it('a question without agent text right above it has no context', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: '[fake:ask-2q] Ask me two questions.' }), w.place);
    await waitForStatus(w.store, session.id, ['need']);
    const [batch] = await until(async () => {
      const list = await w.store.questions.listBatches({ sessionId: session.id });
      return list.length > 0 ? list : undefined;
    }, 'a question batch');
    expect((await w.store.events.list(session.id)).filter(isNote)).toHaveLength(0);
    expect(await questionBatchItem(w.store, batch!)).toMatchObject({ kind: 'questions', detail: '' });
  }, 30_000);
});

describe('D96 · progress notes (transcript import: hooked / terminal sessions)', () => {
  it('imports the note once: a duplicated line in the same sync and in a later sync adds nothing', async () => {
    const w = await setup();
    const session = await w.supervisor.start(newSession({ task: 'Reply with just OK.' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    const record = (await w.store.sessions.get(session.id))!;
    const mainId = (await w.store.agents.listBySession(session.id)).find((agent) => agent.kind === 'main')?.id ?? '';
    const before = (await w.store.events.list(session.id)).length;
    const file = path.join(w.root, 'notes.jsonl');
    const ts = new Date().toISOString();
    const prompt = { type: 'user', uuid: 'n-p0', parentUuid: null, isSidechain: false, timestamp: ts, message: { role: 'user', content: 'Check the setup.' } };
    const [empty, note, ask] = noteMessage({ message: 'msg_dup', uuids: ['n-a', 'n-b', 'n-c'] }, 'n-p0', ts);
    // The CLI repeated the note line (same message id, another uuid).
    const dup = { ...note, uuid: 'n-b2', parentUuid: 'n-b' };
    const first = [prompt, empty, note, dup];
    await writeFile(file, `${first.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const one = await importTerminalTurns({ store: w.store, session: { ...record, lastTranscriptUuid: null }, transcript: file, mainAgentId: mainId, onEvent: () => undefined });
    expect(one.found).toBe(true);
    let notes = (await w.store.events.list(session.id)).filter(isNote);
    expect(notes).toHaveLength(1);
    expect((notes[0]?.payload as AssistantPayload).text).toBe(NOTE);

    // A later sync: the same note once more, then the ask.
    const again = { ...note, uuid: 'n-b3', parentUuid: 'n-b2' };
    await appendFile(file, `${[again, { ...ask, parentUuid: 'n-b3' }].map((line) => JSON.stringify(line)).join('\n')}\n`);
    await importTerminalTurns({ store: w.store, session: { ...record, lastTranscriptUuid: one.tip }, transcript: file, mainAgentId: mainId, onEvent: () => undefined });
    const events = await w.store.events.list(session.id);
    notes = events.filter(isNote);
    expect(notes).toHaveLength(1);
    expect((notes[0]?.payload as AssistantPayload).text).toBe(NOTE);
    const added = events.slice(before).map((event) => (event.payload as { type?: string; name?: string }).name ?? (isNote(event) ? 'note' : (event.payload as { type?: string }).type));
    expect(added).toEqual(['user', 'note', 'AskUserQuestion']);
  }, 30_000);
});
