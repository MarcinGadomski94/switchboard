import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Question, SessionEvent } from '../../src/core/api.ts';
import { answeredLines } from '../../src/web/components/question-card.ts';
import {
  ANSWERS_WRITTEN,
  QUICK_REPLIES,
  QUICK_REPLIES_LABEL,
  batchWaiting,
  chatItems,
  composerKeyAction,
  composerPlaceholder,
  draftToSend,
  stepMark,
} from '../../src/web/views/session/chat.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * M4.2: the chat tab's pure state (src/web/views/session/chat.ts, docs/chat.md):
 * the items from events + questions, the step marks, the answers bubble, the
 * composer copy and the quick replies (verbatim from the prototype).
 */

const MAIN = 'agent-main';
const SUB = 'agent-sub';
let clock = 0;

function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return {
    id,
    sessionId: 's',
    agentId: MAIN,
    ts: `2026-09-28T10:00:${String(clock).padStart(2, '0')}.000Z`,
    endTs: null,
    kind: 'text',
    label: '',
    payload,
    ...extra,
  };
}

function question(id: string, batchId: string, answerIndex: number | null = null, source = 'acme-app-front'): Question {
  return {
    id,
    batchId,
    sessionId: 's',
    source,
    text: `${id}?`,
    header: null,
    options: [{ label: 'Red' }, { label: 'Green' }],
    multiSelect: false,
    state: answerIndex === null ? 'open' : 'answered',
    answerIndex,
    answeredAt: answerIndex === null ? null : '2026-09-28T10:01:00.000Z',
  };
}

const user = (text: string, origin = 'user') => ({ type: 'user', text, origin, delivered: true });
const assistant = (text: string) => ({ type: 'assistant', text, messageId: null });
const tool = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'tool', name, toolUseId: `tu-${name}`, input: {}, ...extra });

describe('chatItems', () => {
  it('user bubbles, agent text with the step lines that follow it, in time order; subagent lines stay out', () => {
    const events = [
      event(1, user('Create out.txt', 'task')),
      event(2, tool('Write', { result: 'ok', isError: false }), { label: 'Write · out.txt', endTs: 'x' }),
      event(3, tool('Bash'), { label: 'Bash · ls' }),
      event(4, assistant('DONE')),
      event(5, tool('Read', { result: 'x' }), { label: 'Read · a.ts', agentId: SUB }),
      event(6, assistant('subagent text'), { agentId: SUB }),
      event(7, { type: 'result', subtype: 'success', isError: false, text: 'DONE' }, { kind: 'ok', label: 'DONE' }),
      event(8, user('Next')),
      event(9, assistant('Looking.')),
      event(10, tool('Grep', { result: '', isError: true }), { label: 'Grep · x' }),
      event(11, { type: 'request', requestId: 'r1', toolName: 'Bash', state: 'open' }, { kind: 'ask', label: 'Permission · Bash · rm x' }),
      event(12, { type: 'denied', toolName: 'Write' }, { kind: 'ask', label: 'Denied · Write' }),
      event(13, { type: 'result', subtype: 'error_max_turns', isError: true }, { kind: 'error', label: 'error_max_turns: Reached max turns' }),
      event(14, tool('Edit', { result: '' }), { label: 'Edit · b.ts' }),
    ];
    const items = chatItems(events, [], MAIN);
    expect(items.map((item) => (item.kind === 'agent' ? [item.kind, item.text, item.steps.map((s) => `${s.mark} ${s.label}`)] : [item.kind]))).toEqual([
      ['user'],
      ['agent', '', ['✓ Write · out.txt', '● Bash · ls']],
      ['agent', 'DONE', []],
      ['user'],
      ['agent', 'Looking.', ['✕ Grep · x', '⏸ Permission · Bash · rm x', '✕ Denied · Write', '✕ error_max_turns: Reached max turns']],
      ['agent', '', ['✓ Edit · b.ts']],
    ]);
  });

  it('sorts by ts then id (imported terminal turns carry older timestamps) and a lifecycle event ends the block', () => {
    const events = [
      event(5, assistant('late'), { ts: '2026-09-28T10:05:00.000Z' }),
      event(2, { type: 'lifecycle', action: 'paused' }, { ts: '2026-09-28T10:02:00.000Z' }),
      event(3, tool('Bash', { result: '' }), { ts: '2026-09-28T10:03:00.000Z', label: 'Bash · npm test' }),
      event(1, assistant('first'), { ts: '2026-09-28T10:01:00.000Z' }),
    ];
    const items = chatItems(events, [], MAIN);
    expect(items.map((item) => (item.kind === 'agent' ? [item.text, item.steps.length] : null))).toEqual([['first', 0], ['', 1], ['late', 0]]);
  });

  it('events of no agent are the main conversation; without a known main agent every event is', () => {
    const events = [event(1, user('hi'), { agentId: null }), event(2, assistant('sub'), { agentId: SUB })];
    expect(chatItems(events, [], MAIN).map((item) => item.kind)).toEqual(['user']);
    expect(chatItems(events, [], null).map((item) => item.kind)).toEqual(['user', 'agent']);
  });

  it('a batch sits at its AskUserQuestion call (by request id): the card while it waits, the answers once answered; the rest go last', () => {
    const events = [
      event(1, user('Ask me')),
      event(2, tool('AskUserQuestion', { requestId: 'b1', requestState: 'open' }), { kind: 'ask', label: '2 questions · q1?' }),
      event(3, assistant('after')),
      event(4, tool('AskUserQuestion', { requestId: 'b2', requestState: 'responded', result: 'answered' }), { kind: 'ask', label: '1 question · q3?' }),
      event(5, tool('AskUserQuestion', { requestState: 'open' }), { kind: 'ask', label: '1 question · unread' }),
    ];
    const questions = [question('q1', 'b1'), question('q2', 'b1'), question('q3', 'b2', 1), question('q4', 'b3')];
    const items = chatItems(events, questions, MAIN);
    expect(items.map((item) => (item.kind === 'questions' ? [item.batchId, item.waiting, item.questions.map((q) => q.id)] : item.kind === 'agent' ? [item.text, item.steps.map((s) => `${s.mark} ${s.label}`)] : item.kind))).toEqual([
      'user',
      ['b1', true, ['q1', 'q2']],
      ['after', []],
      ['b2', false, ['q3']],
      ['', ['⏸ 1 question · unread']],
      ['b3', true, ['q4']],
    ]);
  });

  it('batches without any event (the demo seed) follow the messages in batch order', () => {
    const items = chatItems([event(1, user('task', 'task')), event(2, assistant('text'))], [question('a', 'x'), question('b', 'y', 0)], MAIN);
    expect(items.map((item) => item.key)).toEqual(['u:1', 'a:2', 'q:x', 'q:y']);
  });
});

describe('step marks', () => {
  it('✓ finished, ● running, ✕ failed or denied, ⏸ waiting; other events are not steps', () => {
    expect(stepMark(event(1, tool('Write', { result: 'ok', isError: false })))).toBe('✓');
    expect(stepMark(event(1, tool('Write'), { endTs: '2026-09-28T10:00:00.000Z' }))).toBe('✓');
    expect(stepMark(event(1, tool('Write')))).toBe('●');
    expect(stepMark(event(1, tool('Write', { result: 'no', isError: true })))).toBe('✕');
    expect(stepMark(event(1, tool('AskUserQuestion', { requestState: 'open' })))).toBe('⏸');
    // D6: Switchboard's own switch to acceptEdits is a notice; a real mismatch is a failure.
    expect(stepMark(event(1, { type: 'mode-mismatch', requested: 'auto', observed: 'default', fallback: 'acceptEdits' }))).toBe('⚠');
    expect(stepMark(event(1, { type: 'mode-mismatch', requested: 'acceptEdits', observed: 'default' }))).toBe('✕');
    expect(stepMark(event(1, { type: 'request', state: 'open' }))).toBe('⏸');
    expect(stepMark(event(1, { type: 'request', state: 'responded', behavior: 'allow' }))).toBe('✓');
    expect(stepMark(event(1, { type: 'request', state: 'responded', behavior: 'deny' }))).toBe('✕');
    expect(stepMark(event(1, { type: 'request', state: 'stale' }))).toBe('✕');
    expect(stepMark(event(1, { type: 'denied' }))).toBe('✕');
    expect(stepMark(event(1, { type: 'mode-mismatch' }))).toBe('✕');
    expect(stepMark(event(1, { type: 'result', isError: true }))).toBe('✕');
    expect(stepMark(event(1, { type: 'result', isError: false }))).toBeNull();
    expect(stepMark(event(1, { type: 'lifecycle', action: 'paused' }))).toBeNull();
    expect(stepMark(event(1, { source: 'demo', channel: 'terminal', line: '$ x' }))).toBeNull();
    expect(stepMark(event(1, null))).toBeNull();
  });
});

describe('answers bubble and composer', () => {
  it('a batch waits while a question has no answer', () => {
    expect(batchWaiting([question('a', 'x'), question('b', 'x', 0)])).toBe(true);
    expect(batchWaiting([question('a', 'x', 1)])).toBe(false);
  });

  it('answer lines use the source name part (prototype ssAnswered)', () => {
    expect(answeredLines([question('a', 'x', 0, 'web · microfrontends/acme-app-front'), question('b', 'x', 1, '(orchestrator)'), question('c', 'x', null)])).toEqual([
      'web: Red',
      '(orchestrator): Green',
      'acme-app-front: —',
    ]);
  });

  it('draft: trimmed, nothing to send when empty; placeholder from the session name', () => {
    expect(draftToSend('  hello  ')).toBe('hello');
    expect(draftToSend('   ')).toBeNull();
    expect(composerPlaceholder('free-talk-640')).toBe('Message free-talk-640…');
  });

  it('D26: Enter sends, Shift+Enter is a new line, Enter while an IME composes does neither', () => {
    const key = (key: string, shiftKey = false, isComposing = false) => composerKeyAction({ key, shiftKey, isComposing });
    expect(key('Enter')).toBe('send');
    expect(key('Enter', true)).toBe('newline');
    expect(key('Enter', false, true)).toBeNull();
    expect(key('Enter', true, true)).toBeNull();
    expect(key('a')).toBeNull();
    expect(key('a', true)).toBeNull();
  });

  it('copy is verbatim from the prototype (quick replies, the answers note)', async () => {
    const proto = await readFile(path.join(REPO_ROOT, 'docs', 'handoff', 'prototype', 'Switchboard App.dc.html'), 'utf8');
    expect(proto).toContain(`const quickDef = [${QUICK_REPLIES.map((q) => `'${q.label}'`).join(', ')}];`);
    for (const reply of QUICK_REPLIES) expect(proto.replaceAll("\\'", "'")).toContain(`'${reply.text}'`);
    expect(proto).toContain(`>${QUICK_REPLIES_LABEL}</span>`);
    expect(proto).toContain(`>${ANSWERS_WRITTEN}</div>`);
    expect(proto).toContain("draftPh: 'Message ' + s.id + '…'");
  });
});
