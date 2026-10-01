import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_LIMIT, PAYLOAD_TEXT_LIMIT, clip, clipMessage } from '../../src/core/event-payload.ts';
import { findFullText, findFullTool } from '../../src/core/full-text.ts';
import { resultText, workflowAgentEvents } from '../../src/core/derive/workflows.ts';

/**
 * Fix · long messages (src/core/full-text.ts, event-payload.ts, derive/workflows.ts;
 * docs/chat.md → *Cut messages*): the message cap, finding a cut message's whole
 * text in a transcript (message id, uuid, the clipped prefix), a tool call's whole
 * input and result, and a Workflow agent's chat read whole.
 */

const iso = (second: number): string => `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`;

/** An assistant transcript line with one text block. */
function textLine(uuid: string, messageId: string | null, text: string, second: number, extra: object = {}) {
  return { type: 'assistant', uuid, parentUuid: null, timestamp: iso(second), message: { ...(messageId ? { id: messageId } : {}), model: 'claude', content: [{ type: 'text', text }] }, ...extra };
}

const partA = `${'A'.repeat(3000)} first block`;
const partB = `${'B'.repeat(3000)} second block`;
const merged = `${partA}\n\n${partB}`;
const other = `${'A'.repeat(3000)} another message`;

const entries = [
  { type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso(1), message: { role: 'user', content: 'Write two long blocks.' } },
  textLine('m1', 'msg_1', partA, 2),
  textLine('m2', 'msg_1', partB, 2),
  textLine('m3', 'msg_2', other, 30),
  { type: 'assistant', uuid: 'm4', parentUuid: null, timestamp: iso(31), message: { id: 'msg_3', model: 'claude', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { content: 'C'.repeat(6000) } }] } },
  { type: 'user', uuid: 'r1', parentUuid: 'm4', timestamp: iso(32), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'R'.repeat(7000) }] } },
];

describe('the message cap', () => {
  it('message text is kept whole up to 1,000,000 characters; tool text is still cut at 4,000', () => {
    expect(clipMessage('x'.repeat(5000))).toEqual({ text: 'x'.repeat(5000), truncated: false });
    const huge = clipMessage('y'.repeat(MESSAGE_TEXT_LIMIT + 5));
    expect(huge.truncated).toBe(true);
    expect(huge.text).toHaveLength(MESSAGE_TEXT_LIMIT);
    expect(clip('z'.repeat(5000)).text).toHaveLength(PAYLOAD_TEXT_LIMIT);
  });
});

describe('findFullText', () => {
  const cutOf = (text: string) => text.slice(0, PAYLOAD_TEXT_LIMIT);

  it('by message id: the text blocks of one message merged with a blank line, as the recorder merged them', () => {
    expect(findFullText(entries, { type: 'assistant', text: cutOf(merged), uuid: 'm1', messageId: 'msg_1', ts: iso(2) })).toBe(merged);
  });

  it('by uuid when the event has no message id; by the clipped prefix (closest in time) when it has neither', () => {
    expect(findFullText(entries, { type: 'assistant', text: cutOf(other), uuid: 'm3', messageId: null, ts: null })).toBe(other);
    // Both messages start with 3,000 A's: the stored prefix tells them apart, else the time does.
    expect(findFullText(entries, { type: 'assistant', text: cutOf(other), uuid: null, messageId: null, ts: iso(29) })).toBe(other);
    expect(findFullText(entries, { type: 'assistant', text: 'A'.repeat(100), uuid: null, messageId: null, ts: iso(29) })).toBe(other);
    expect(findFullText(entries, { type: 'assistant', text: 'A'.repeat(100), uuid: null, messageId: null, ts: iso(3) })).toBe(merged);
  });

  it('a key whose text does not start with the stored text is no match; nothing fits → null', () => {
    expect(findFullText(entries, { type: 'assistant', text: cutOf(other), uuid: null, messageId: 'msg_1', ts: null })).toBe(other);
    expect(findFullText(entries, { type: 'assistant', text: 'Q'.repeat(4000), uuid: 'm1', messageId: 'msg_1', ts: null })).toBeNull();
    expect(findFullText([], { type: 'assistant', text: 'x', uuid: null, messageId: null, ts: null })).toBeNull();
  });

  it('a subagent\'s prompt: by uuid in its own file (sidechain lines read too), else by prefix', () => {
    const brief = `${'P'.repeat(4500)} end of brief`;
    const subagent = [
      { type: 'user', uuid: 'p1', parentUuid: null, isSidechain: true, timestamp: iso(5), message: { role: 'user', content: brief } },
      textLine('s1', 'msg_s', 'Done.', 6, { isSidechain: true }),
    ];
    expect(findFullText(subagent, { type: 'agent-prompt', text: cutOf(brief), uuid: 'p1', messageId: null, ts: null })).toBe(brief);
    expect(findFullText(subagent, { type: 'agent-prompt', text: cutOf(brief), uuid: null, messageId: null, ts: null })).toBe(brief);
  });
});

describe('findFullTool', () => {
  it('the whole input and result of a tool call; an unknown call → null', () => {
    const tool = findFullTool(entries, 'toolu_1');
    expect(tool?.input).toEqual({ content: 'C'.repeat(6000) });
    expect(tool?.result).toEqual({ text: 'R'.repeat(7000), isError: false });
    expect(findFullTool(entries, 'toolu_nope')).toBeNull();
  });
});

describe('a Workflow agent\'s chat is read whole', () => {
  it('its brief, messages and result past 4,000 characters; its tool results stay cut', () => {
    const envelope = { isSidechain: true, agentId: 'a1', cwd: '/ws', sessionId: 's' };
    const brief = 'B'.repeat(6000);
    const lines = [
      { ...envelope, type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso(1), message: { role: 'user', content: brief } },
      { ...envelope, type: 'assistant', uuid: 'm1', parentUuid: 'u1', timestamp: iso(2), message: { id: 'msg1', model: 'claude', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/ws/a.md' } }] } },
      { ...envelope, type: 'user', uuid: 'r1', parentUuid: 'm1', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R'.repeat(6000) }] } },
      { ...envelope, type: 'assistant', uuid: 'm2', parentUuid: 'r1', timestamp: iso(4), message: { id: 'msg2', model: 'claude', content: [{ type: 'text', text: partA }] } },
      { ...envelope, type: 'assistant', uuid: 'm3', parentUuid: 'm2', timestamp: iso(4), message: { id: 'msg2', model: 'claude', content: [{ type: 'text', text: partB }] } },
    ];
    const events = workflowAgentEvents(lines, 'session-1', 'wf_x--a1');
    expect(events[0]?.payload).toEqual({ type: 'agent-prompt', text: brief });
    expect(events[1]?.payload).toMatchObject({ result: 'R'.repeat(4000), resultTruncated: true });
    expect(events[2]?.payload).toEqual({ type: 'assistant', text: merged, messageId: 'msg2' });
    expect(resultText('Z'.repeat(9000))).toHaveLength(9000);
  });
});

describe('fake-claude `[fake:say-long <chars>]`', () => {
  it('a reply of exactly that many characters, ending with its marker; malformed tokens are errors', async () => {
    const { SAY_LONG_END, longReply, sayLongToken } = await import('../../tools/fake-claude/scenarios.ts');
    for (const chars of [30, 4001, 9000, 123_457]) {
      const text = longReply(chars);
      expect(text).toHaveLength(chars);
      expect(text.endsWith(SAY_LONG_END)).toBe(true);
    }
    expect(sayLongToken('Go. [fake:say-long 5000]')).toEqual({ text: longReply(5000) });
    expect(sayLongToken('Go.')).toBeNull();
    expect(sayLongToken('[fake:say-long]')).toHaveProperty('error');
    expect(sayLongToken('[fake:say-long 10]')).toHaveProperty('error');
    expect(sayLongToken('[fake:say-long lots]')).toHaveProperty('error');
  });
});
