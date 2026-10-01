import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Agent, SessionEvent } from '../../src/core/api.ts';
import { MESSAGE_TEXT_LIMIT, PAYLOAD_TEXT_LIMIT, textCutAt } from '../../src/core/event-payload.ts';
import { chatItems, subagentChat } from '../../src/web/views/session/chat.ts';
import { LOADING_FULL, SHOW_FULL, cutNote, fullTextError, isCut, messageCut, withRestored } from '../../src/web/views/session/full-text.ts';

/**
 * Fix · long messages (src/web/views/session/full-text.ts, chat.ts, FullText.tsx;
 * docs/chat.md → *Cut messages*): which bubbles read as cut, the note's words, the
 * restored events standing in for cut ones, and the "Show full message" note.
 */

const MAIN = 'agent-main';
const SUB = 'agent-sub';
const CALL = 'toolu_01Long';
let clock = 0;

function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return { id, sessionId: 's', agentId: MAIN, ts: `2026-10-01T10:00:${String(clock).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label: '', payload, ...extra };
}

const at4000 = 'x'.repeat(PAYLOAD_TEXT_LIMIT);
const assistant = (text: string, extra: object = {}) => ({ type: 'assistant', text, messageId: 'msg_1', ...extra });

describe('which texts read as cut', () => {
  it('textCutAt: an unflagged message of exactly 4,000 characters (stored before the fix), a flagged one at its length; whole otherwise', () => {
    expect(textCutAt(assistant(at4000))).toBe(PAYLOAD_TEXT_LIMIT);
    expect(textCutAt({ type: 'agent-prompt', text: at4000 })).toBe(PAYLOAD_TEXT_LIMIT);
    expect(textCutAt(assistant('short', { truncated: true }))).toBe(5);
    // Restored and whole: an exactly-4,000 message marked `truncated: false` is not offered again.
    expect(textCutAt(assistant(at4000, { truncated: false }))).toBeNull();
    expect(textCutAt(assistant(`${at4000}y`))).toBeNull();
    expect(textCutAt(assistant('x'.repeat(3999)))).toBeNull();
    expect(textCutAt({ type: 'user', text: at4000 })).toBeNull();
    expect(textCutAt({ type: 'tool', result: at4000 })).toBeNull();
    expect(textCutAt(null)).toBeNull();
    expect(MESSAGE_TEXT_LIMIT).toBe(1_000_000);
  });

  it('isCut: message text, or a tool call with a cut input or result', () => {
    expect(isCut(event(1, assistant(at4000)))).toBe(true);
    expect(isCut(event(2, assistant('whole')))).toBe(false);
    expect(isCut(event(3, { type: 'tool', name: 'Agent', toolUseId: CALL, input: {}, result: 'r', resultTruncated: true }))).toBe(true);
    expect(isCut(event(4, { type: 'tool', name: 'Agent', toolUseId: CALL, input: {}, inputTruncated: true }))).toBe(true);
    expect(isCut(event(5, { type: 'tool', name: 'Agent', toolUseId: CALL, input: {}, result: 'r' }))).toBe(false);
  });

  it('the note: "Message cut at 4,000 characters · Show full message"; a tool output "Output truncated at …"', () => {
    expect(cutNote({ at: 4000, kind: 'message' })).toBe('Message cut at 4,000 characters');
    expect(cutNote({ at: 1_000_000, kind: 'message' })).toBe('Message cut at 1,000,000 characters');
    expect(cutNote({ at: 4000, kind: 'output' })).toBe('Output truncated at 4,000 characters');
    expect(SHOW_FULL).toEqual({ message: 'Show full message', output: 'Show full output' });
    expect(fullTextError(410, { error: 'transcript-gone', message: 'The transcript is gone.' })).toBe('The transcript is gone.');
    expect(fullTextError(500, null)).toBe('The full text could not be fetched (HTTP 500).');
    expect(fullTextError(0, null)).toContain('not reachable');
  });
});

describe('the chat items carry the cut', () => {
  it('main chat: a cut assistant text carries its event, a whole one none; a long whole text is shown as it is', () => {
    const long = `${'y'.repeat(9000)} END`;
    const items = chatItems([event(1, assistant(at4000)), event(2, { type: 'user', text: 'next', origin: 'user', delivered: true }), event(3, assistant(long))], [], MAIN);
    expect(items[0]).toMatchObject({ kind: 'agent', cut: { eventId: 1, at: 4000, kind: 'message' } });
    expect(items[1]).toMatchObject({ kind: 'user', cut: null });
    expect(items[2]).toMatchObject({ kind: 'agent', text: long, cut: null });
    expect(messageCut(event(9, assistant('ok')))).toBeNull();
  });

  it('subagent chat: a brief cut with the call input, a cut prompt line, a cut result ("Show full output"); a Workflow agent\'s chat offers nothing', () => {
    const subagent: Pick<Agent, 'id' | 'toolUseId'> = { id: SUB, toolUseId: CALL };
    const call = event(10, { type: 'tool', name: 'Agent', toolUseId: CALL, input: { prompt: at4000 }, inputTruncated: true, result: 'r'.repeat(4000), resultTruncated: true }, { kind: 'tool' });
    const reply = event(11, assistant(at4000), { agentId: SUB });
    const chat = subagentChat([call, reply], [], subagent);
    expect(chat.briefCut).toEqual({ eventId: 10, at: 4000, kind: 'message' });
    expect(chat.resultCut).toEqual({ eventId: 10, at: 4000, kind: 'output' });
    expect(chat.items[0]).toMatchObject({ kind: 'agent', cut: { eventId: 11 } });

    // Without the call: the first prompt line is the brief.
    const prompt = event(12, { type: 'agent-prompt', text: at4000 }, { agentId: SUB });
    expect(subagentChat([prompt], [], { id: SUB, toolUseId: null }).briefCut).toEqual({ eventId: 12, at: 4000, kind: 'message' });

    // A prompt that was not the cut string of the input: no note.
    const otherCut = event(13, { type: 'tool', name: 'Agent', toolUseId: CALL, input: { prompt: 'short', description: 'd' }, inputTruncated: true }, { kind: 'tool' });
    expect(subagentChat([otherCut], [], subagent).briefCut).toBeNull();

    const workflow = subagentChat([call, reply], [], subagent, [], { restorable: false });
    expect(workflow.briefCut).toBeNull();
    expect(workflow.resultCut).toBeNull();
    expect(workflow.items[0]).toMatchObject({ cut: null });
  });

  it('withRestored: a restored event stands in while its event is still cut; the /hub update (whole) wins', () => {
    const cut = event(20, assistant(at4000));
    const whole = { ...cut, payload: assistant(`${at4000} and the rest`, { truncated: false }) };
    const restored = new Map([[20, whole]]);
    expect(withRestored([cut], restored)[0]).toBe(whole);
    const fromHub = { ...cut, payload: assistant(`${at4000} and the rest, from /hub`, { truncated: false }) };
    expect(withRestored([fromHub], restored)[0]).toBe(fromHub);
    const events = [cut];
    expect(withRestored(events, new Map())).toBe(events);
    // Another session's event with the same id is left alone.
    expect(withRestored([{ ...cut, sessionId: 'other' }], restored)[0]?.sessionId).toBe('other');
    // After the restore, the item shows the whole text and no note.
    expect(chatItems(withRestored([cut], restored), [], MAIN)[0]).toMatchObject({ text: `${at4000} and the rest`, cut: null });
  });
});

describe('the note under a cut bubble (FullText.tsx)', () => {
  /** The component module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
  const COMPONENT = '../../src/web/views/session/FullText.tsx';
  let CutNote: (props: object) => unknown;
  beforeAll(async () => {
    ({ CutNote } = (await import(/* @vite-ignore */ COMPONENT)) as { CutNote: (props: object) => unknown });
  });
  const render = (props: object): string => renderToStaticMarkup(createElement(CutNote as never, props));
  const cut = { eventId: 7, at: 4000, kind: 'message' as const };

  it('offers "Show full message"; while loading says so; a failure shows the reason and the button again; no control, no note', () => {
    const idle = render({ cut, control: { state: () => null, restore: () => undefined } });
    expect(idle).toContain('data-testid="chat-cut"');
    expect(idle).toContain('data-event-id="7"');
    expect(idle).toContain('Message cut at 4,000 characters');
    expect(idle).toContain('>Show full message</button>');
    const busy = render({ cut, control: { state: () => ({ busy: true, error: null }), restore: () => undefined } });
    expect(busy).toContain(LOADING_FULL);
    expect(busy).not.toContain('<button');
    const failed = render({ cut, control: { state: () => ({ busy: false, error: 'The transcript is gone.' }), restore: () => undefined } });
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The transcript is gone.');
    expect(failed).toContain('<button');
    expect(render({ cut: { ...cut, kind: 'output' }, control: { state: () => null, restore: () => undefined } })).toContain('Output truncated at 4,000 characters');
    expect(render({ cut, control: undefined })).toBe('');
  });
});
