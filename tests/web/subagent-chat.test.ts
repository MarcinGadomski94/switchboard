import { beforeAll, describe, expect, it } from 'vitest';
import type { Agent, Question, SessionEvent } from '../../src/core/api.ts';
import { isAsyncAgentLaunch } from '../../src/core/derive/background.ts';
import { subagentActivityLine } from '../../src/web/activity/activity.ts';
import { chatItems, hasSubagentChat, subagentChat, subagentChats } from '../../src/web/views/session/chat.ts';
import {
  OPEN_SUBAGENT_CHAT,
  SUBAGENT_NOTE,
  escGoesBack,
  mainChatPlace,
  rememberMainChat,
  subagentTitle,
} from '../../src/web/views/session/subagent-chat.ts';

/**
 * D36: a subagent's own chat (src/web/views/session/chat.ts `subagentChat`,
 * subagent-chat.ts, the router; docs/chat.md → *Subagent chats*): the route, the
 * items built from the session's events (brief, messages and steps, result), the
 * entry points (the Agent step's link, which agents have a chat), Esc, the main
 * chat's remembered place and the subagent's activity line.
 */

const MAIN = 'agent-main';
const SUB = 'agent-sub';
const CALL = 'toolu_01Call';
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

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: MAIN,
    kind: 'main',
    name: 'orchestrator',
    description: null,
    solutionPath: null,
    branch: null,
    status: 'run',
    statusText: null,
    toolUseId: null,
    ...overrides,
  };
}

const user = (text: string, origin = 'user') => ({ type: 'user', text, origin, delivered: true });
const assistant = (text: string) => ({ type: 'assistant', text, messageId: null });
const prompt = (text: string) => ({ type: 'agent-prompt', text });
const BRIEF = 'Read the file hello.txt in the current directory and reply with its first line only.';
const agentCall = (extra: Record<string, unknown> = {}) => ({
  type: 'tool',
  name: 'Agent',
  toolUseId: CALL,
  input: { description: 'Read hello.txt and return first line', prompt: BRIEF, subagent_type: 'general-purpose' },
  ...extra,
});
const read = (extra: Record<string, unknown> = {}) => ({ type: 'tool', name: 'Read', toolUseId: 'toolu_read', input: { file_path: '/w/hello.txt' }, ...extra });

const subagent = agent({ id: SUB, kind: 'subagent', name: 'general-purpose', description: 'Read hello.txt and return first line', status: 'done', toolUseId: CALL });
const agents = [agent(), subagent];

/** The `subagent-forward` recording as the recorder stores it (docs/derivations.md → *Agents*). */
function forward(result: string | null = 'alpha line one'): SessionEvent[] {
  return [
    event(1, user('Ask a subagent for the first line.', 'task'), { label: 'Ask a subagent' }),
    event(2, agentCall(result === null ? {} : { result, isError: false }), { kind: 'tool', label: 'Agent · general-purpose · Read hello.txt and return first line', endTs: result === null ? null : 'x' }),
    event(3, prompt(BRIEF), { agentId: SUB, label: 'Read the file' }),
    event(4, assistant("I'll read the hello.txt file from the current directory."), { agentId: SUB }),
    event(5, read({ result: '1\talpha line one', isError: false }), { agentId: SUB, kind: 'plan', label: 'Read · hello.txt', endTs: 'x' }),
    event(6, assistant('alpha line one'), { agentId: SUB }),
    event(7, assistant('alpha line one')),
    event(8, { type: 'result', subtype: 'success', isError: false, text: 'alpha line one' }, { kind: 'ok', label: 'alpha line one' }),
  ];
}

describe('D36 route', () => {
  /** The router module, imported at run time (the server tsconfig has no JSX; Vitest transforms it). */
  const ROUTER = '../../src/web/router.tsx';
  type RouteLike = { readonly view: string; readonly id?: string; readonly tab?: string; readonly agentId?: string };
  let parseRoute: (pathname: string) => RouteLike;
  let routePath: (route: RouteLike) => string;
  beforeAll(async () => {
    ({ parseRoute, routePath } = (await import(/* @vite-ignore */ ROUTER)) as { parseRoute: typeof parseRoute; routePath: typeof routePath });
  });

  it('/sessions/{id}/agents/{agentId} is the chat tab in subagent mode, parsed and printed', () => {
    expect(parseRoute('/sessions/s1/agents/a%201')).toEqual({ view: 'session', id: 's1', tab: 'chat', agentId: 'a 1' });
    expect(routePath({ view: 'session', id: 's1', tab: 'chat', agentId: 'a 1' })).toBe('/sessions/s1/agents/a%201');
    expect(routePath(parseRoute('/sessions/s1/agents/sub-9'))).toBe('/sessions/s1/agents/sub-9');
  });

  it('the main chat stays /sessions/{id}; the other tabs are unchanged; /agents without an id is the main chat', () => {
    expect(parseRoute('/sessions/s1')).toEqual({ view: 'session', id: 's1', tab: 'chat' });
    expect(routePath({ view: 'session', id: 's1', tab: 'chat' })).toBe('/sessions/s1');
    expect(parseRoute('/sessions/s1/timeline')).toEqual({ view: 'session', id: 's1', tab: 'timeline' });
    expect(routePath({ view: 'session', id: 's1', tab: 'diff' })).toBe('/sessions/s1/diff');
    expect(parseRoute('/sessions/s1/agents')).toEqual({ view: 'session', id: 's1', tab: 'chat' });
  });
});

describe('D36 subagent chat items', () => {
  it('the brief (the Agent call\'s prompt), its own messages and steps as the main chat shows them, then the result', () => {
    const chat = subagentChat(forward(), [], subagent, agents);
    expect(chat.brief).toBe(BRIEF);
    // The first prompt line is the brief delivered: not repeated.
    expect(chat.items.map((item) => (item.kind === 'agent' ? [item.kind, item.text, item.steps.map((s) => `${s.mark} ${s.label}`)] : [item.kind]))).toEqual([
      ['agent', "I'll read the hello.txt file from the current directory.", ['✓ Read · hello.txt']],
      ['agent', 'alpha line one', []],
    ]);
    expect(chat.result).toEqual({ text: 'alpha line one', isError: false });
  });

  it('no result before the call returned, nor for a background agent (its call returns only the launch notice)', () => {
    expect(subagentChat(forward(null), [], subagent).result).toBeNull();
    const launched = 'Async agent launched successfully. (This tool result is internal metadata …)\nagentId: ab90806fa9f2200ee (internal ID …)';
    expect(isAsyncAgentLaunch(launched)).toBe(true);
    expect(isAsyncAgentLaunch('alpha line one')).toBe(false);
    expect(subagentChat(forward(launched), [], subagent).result).toBeNull();
    // An interrupted or failed call is still its result, marked.
    const failed = forward('[Request interrupted by user for tool use]').map((e) => (e.id === 2 ? { ...e, payload: { ...(e.payload as object), isError: true } } : e));
    expect(subagentChat(failed, [], subagent).result).toEqual({ text: '[Request interrupted by user for tool use]', isError: true });
  });

  it('without the call, the brief is its first prompt line; later prompt lines are user bubbles; nothing seen → no brief', () => {
    const events = forward().filter((e) => e.id !== 2);
    events.push(event(9, prompt('Also read README.md.'), { agentId: SUB }));
    const chat = subagentChat(events, [], subagent);
    expect(chat.brief).toBe(BRIEF);
    expect(chat.items.at(-1)).toMatchObject({ kind: 'user', text: 'Also read README.md.', origin: 'agent-prompt' });
    expect(chat.result).toBeNull();
    expect(subagentChat([], [], subagent)).toEqual({ brief: null, items: [], result: null });
  });

  it('only its own events (not the main agent\'s, not another subagent\'s), in time order', () => {
    const other = event(10, assistant('another subagent'), { agentId: 'agent-other' });
    const early = event(11, assistant('first, by its timestamp'), { agentId: SUB, ts: '2026-09-28T09:00:00.000Z' });
    const texts = subagentChat([...forward(), other, early], [], subagent).items.filter((i) => i.kind === 'agent').map((i) => (i.kind === 'agent' ? i.text : ''));
    expect(texts).toEqual(['first, by its timestamp', "I'll read the hello.txt file from the current directory.", 'alpha line one']);
  });

  it('its question batches sit at its AskUserQuestion calls; batches it did not ask stay out', () => {
    const q = (id: string, batchId: string): Question => ({
      id,
      batchId,
      sessionId: 's',
      source: 'general-purpose',
      text: `${id}?`,
      header: null,
      options: [{ label: 'Staging' }, { label: 'Production' }],
      multiSelect: false,
      state: 'open',
      answerIndex: null,
      answeredAt: null,
    });
    const ask = event(12, { type: 'tool', name: 'AskUserQuestion', toolUseId: 'toolu_ask', input: {}, requestId: 'b-sub', requestState: 'open' }, { agentId: SUB, kind: 'ask' });
    const chat = subagentChat([...forward(), ask], [q('q1', 'b-main'), q('q2', 'b-sub')], subagent);
    const batches = chat.items.filter((item) => item.kind === 'questions');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ batchId: 'b-sub', waiting: true });
  });
});

describe('D36 entry points', () => {
  it('the main chat\'s Agent step carries the subagent it opens; other steps and unknown calls do not', () => {
    const events = [...forward(), event(20, { type: 'tool', name: 'Task', toolUseId: 'toolu_unseen', input: {} }, { label: 'Task · subagent' })];
    const steps = chatItems(events, [], MAIN, agents).flatMap((item) => (item.kind === 'agent' ? item.steps : []));
    expect(steps.map((step) => [step.label, step.subagentId ?? null])).toEqual([
      ['Agent · general-purpose · Read hello.txt and return first line', SUB],
      ['Task · subagent', null],
    ]);
    // Without the agents (the old signature) nothing links.
    expect(chatItems(events, [], MAIN).flatMap((item) => (item.kind === 'agent' ? item.steps : [])).every((step) => step.subagentId === undefined)).toBe(true);
  });

  it('a subagent has a chat when Switchboard saw the call that started it; the main agent and the demo\'s agents do not', () => {
    expect(hasSubagentChat(subagent)).toBe(true);
    expect(hasSubagentChat(agent())).toBe(false);
    expect(hasSubagentChat(agent({ id: 'd', kind: 'subagent', toolUseId: null }))).toBe(false);
    expect(hasSubagentChat(agent({ id: 'd', kind: 'subagent' }))).toBe(false);
    expect(hasSubagentChat({ kind: 'subagent' })).toBe(false);
    expect([...subagentChats([agent(), subagent, agent({ id: 'd', kind: 'subagent' })])]).toEqual([[CALL, SUB]]);
  });

  it('copy: the tooltip, the note in the composer\'s place, the top bar\'s title', () => {
    expect(OPEN_SUBAGENT_CHAT).toBe("Open this subagent's chat");
    expect(SUBAGENT_NOTE).toBe('Subagents take no messages · reply in the main chat');
    expect(subagentTitle(subagent)).toBe('general-purpose: Read hello.txt and return first line');
    expect(subagentTitle({ name: 'agent', description: null })).toBe('agent');
  });
});

describe('D36 way back', () => {
  const press = (overrides: Partial<Parameters<typeof escGoesBack>[0]> = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  });
  const free = { editing: false, overlayOpen: false };

  it('Esc goes back unless a modal or popover is open, focus is in a text field, a modifier is held or someone took it', () => {
    expect(escGoesBack(press(), free)).toBe(true);
    expect(escGoesBack(press({ key: 'Enter' }), free)).toBe(false);
    expect(escGoesBack(press(), { editing: false, overlayOpen: true })).toBe(false);
    expect(escGoesBack(press(), { editing: true, overlayOpen: false })).toBe(false);
    expect(escGoesBack(press({ shiftKey: true }), free)).toBe(false);
    expect(escGoesBack(press({ metaKey: true }), free)).toBe(false);
    expect(escGoesBack(press({ defaultPrevented: true }), free)).toBe(false);
    expect(escGoesBack(press({ isComposing: true }), free)).toBe(false);
  });

  it('the main chat\'s place is remembered per session', () => {
    expect(mainChatPlace('never-seen')).toBeNull();
    rememberMainChat('s-1', { top: 420, stick: false });
    rememberMainChat('s-2', { top: 0, stick: true, reveal: 'b1' });
    expect(mainChatPlace('s-1')).toEqual({ top: 420, stick: false });
    expect(mainChatPlace('s-2')).toEqual({ top: 0, stick: true, reveal: 'b1' });
  });

  it('the subagent\'s live line: its card\'s words (Thinking…, no tokens) with the chat line\'s glyphs', () => {
    const now = Date.parse('2026-09-28T10:01:23.000Z');
    const base = { since: '2026-09-28T10:01:00.000Z', startedAt: '2026-09-28T10:00:00.000Z', tool: null, summary: null };
    expect(subagentActivityLine({ ...base, state: 'thinking' }, now)).toEqual({ state: 'thinking', glyph: 'spinner', text: 'Thinking…', time: '1m 23s', tokens: null });
    expect(subagentActivityLine({ ...base, state: 'tool', tool: 'Read', summary: 'hello.txt' }, now)).toMatchObject({ glyph: '●', text: 'Read: hello.txt', time: '0:23' });
    expect(subagentActivityLine({ ...base, state: 'waiting' }, now)).toMatchObject({ glyph: '⏸', text: 'Waiting for you', time: '0:23' });
    expect(subagentActivityLine({ ...base, state: 'writing' }, now)).toMatchObject({ glyph: 'spinner', text: 'Writing…', time: '1m 23s' });
  });
});
