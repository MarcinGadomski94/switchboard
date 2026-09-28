import { describe, expect, it } from 'vitest';
import type { Agent, SessionEvent } from '../../src/core/api.ts';
import { loadDemoData } from '../../src/server/demo/data.ts';
import { DEMO_CURSOR, demoResult } from '../../src/server/demo/seed.ts';
import {
  BASH_OUTPUT_LINES,
  TERMINAL_CURSOR,
  TERMINAL_TAIL_LINES,
  WORKSPACE_ROOT,
  agentCards,
  rootPath,
  agentSummary,
  lineTone,
  terminalLines,
} from '../../src/web/views/session/right-panel.ts';

/**
 * M4.3: the right panel's pure state (src/web/views/session/right-panel.ts,
 * docs/session-panel.md): the agent cards, their summary and the terminal tail
 * from real event payloads, plus the prototype's line tones.
 */

const MAIN = 'agent-main';
const SUB = 'agent-sub';
let clock = 0;

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
    ...overrides,
  };
}

function event(id: number, payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent {
  clock += 1;
  return {
    id,
    sessionId: 's',
    agentId: MAIN,
    ts: `2026-09-28T10:00:${String(clock).padStart(2, '0')}.000Z`,
    endTs: null,
    kind: 'tool',
    label: '',
    payload,
    ...extra,
  };
}

const tool = (name: string, input: Record<string, unknown>, done?: { result: string; isError?: boolean }) => ({
  type: 'tool',
  name,
  toolUseId: `tu-${name}`,
  input,
  ...(done ? { result: done.result, isError: done.isError ?? false } : {}),
});

describe('agent cards', () => {
  it('status copy: the agent\'s own text, else the status word (prototype words)', () => {
    const cards = agentCards(
      [
        agent({ status: 'need' }),
        agent({ id: 'a', kind: 'subagent', name: 'general-purpose', status: 'run', statusText: 'Reading hello.txt' }),
        agent({ id: 'b', kind: 'subagent', name: 'b', status: 'run' }),
        agent({ id: 'c', kind: 'subagent', name: 'c', status: 'done' }),
        agent({ id: 'd', kind: 'subagent', name: 'd', status: 'fail' }),
        agent({ id: 'e', kind: 'subagent', name: 'e', status: 'idle' }),
      ],
      { status: 'need', task: 'Task' },
    );
    expect(cards.map((c) => [c.name, c.statusText, c.status])).toEqual([
      ['orchestrator', 'needs you', 'need'],
      ['general-purpose', 'Reading hello.txt', 'run'],
      ['b', 'running', 'run'],
      ['c', 'done', 'done'],
      ['d', 'failed', 'fail'],
      ['e', 'idle', 'idle'],
    ]);
  });

  it('a paused session: the main agent reads paused, subagents the pause cut off (idle) read paused too; finished ones keep theirs', () => {
    const cards = agentCards(
      [
        agent({ status: 'paused' }),
        agent({ id: 'a', kind: 'subagent', name: 'a', status: 'idle', statusText: 'stale progress' }),
        agent({ id: 'b', kind: 'subagent', name: 'b', status: 'done' }),
      ],
      { status: 'paused', task: 'Task' },
    );
    expect(cards.map((c) => [c.statusText, c.status])).toEqual([
      ['paused', 'paused'],
      ['paused', 'paused'],
      ['done', 'done'],
    ]);
  });

  it('description: the agent\'s own; the main agent without one shows the task\'s first line; path falls back to workspace root', () => {
    const cards = agentCards(
      [
        agent(),
        agent({ id: 'a', kind: 'subagent', name: 'general-purpose', description: 'Read hello.txt', solutionPath: 'microfrontends/app-front', branch: 'session/x' }),
        agent({ id: 'b', kind: 'subagent', name: 'b' }),
      ],
      { status: 'run', task: '  Fix the reminders.\nThey fire late.' },
    );
    expect(cards.map((c) => [c.description, c.path, c.branch])).toEqual([
      ['Fix the reminders.', WORKSPACE_ROOT, null],
      ['Read hello.txt', 'microfrontends/app-front', 'session/x'],
      ['', WORKSPACE_ROOT, null],
    ]);
    // D14: a repo session's agents run in its one solution, the repo.
    const repo = agentCards([agent()], { status: 'run', task: 'x', folderKind: 'repo', folderPath: '/src/switchboard' });
    expect(repo.map((c) => c.path)).toEqual(['switchboard']);
    expect(rootPath({ folderKind: 'workspace', folderPath: '/ws' })).toBe(WORKSPACE_ROOT);
    expect(rootPath({})).toBe(WORKSPACE_ROOT);
  });

  it('summary: agents · distinct solution folders (not workspace root / read-only) · distinct branches, in the prototype\'s words (never singular)', () => {
    expect(agentSummary([agent()])).toBe('1 agents · 0 solutions · 0 branches');
    expect(
      agentSummary([
        agent({ solutionPath: 'functions/calendar-func', branch: 'fix/timezone-dst' }),
      ]),
    ).toBe('1 agents · 1 solutions · 1 branches');
    expect(
      agentSummary([
        agent({ solutionPath: 'workspace root' }),
        agent({ solutionPath: 'microfrontends/acme-app-front', branch: 'feature/free-talk-360' }),
        agent({ solutionPath: 'mobile/', branch: 'feature/free-talk-360' }),
        agent({ solutionPath: 'read-only' }),
      ]),
    ).toBe('4 agents · 2 solutions · 1 branches');
  });

  it('the demo data gives the prototype\'s summaries (prototype agentSummary)', async () => {
    const data = await loadDemoData();
    const summaries = data.sessions.map((s) =>
      agentSummary(s.agents.map((a) => ({ solutionPath: a.solutionPath, branch: a.branch === '' ? null : a.branch }))),
    );
    expect(summaries).toEqual([
      '4 agents · 2 solutions · 1 branches',
      '4 agents · 3 solutions · 3 branches',
      '2 agents · 2 solutions · 2 branches',
      '3 agents · 3 solutions · 2 branches',
      '1 agents · 1 solutions · 1 branches',
      '1 agents · 0 solutions · 0 branches',
    ]);
  });
});

describe('terminal tail', () => {
  const agents = [agent(), agent({ id: SUB, kind: 'subagent', name: 'general-purpose' })];

  it('Bash: `$ <first line of the command>`, then the last output lines once it finished', () => {
    const lines = terminalLines(
      [
        event(1, tool('Bash', { command: 'npm test\n# second line' }), { label: 'Bash · npm test' }),
        event(2, tool('Bash', { command: 'ls' }, { result: 'a.txt\n\nb.txt\nc.txt\nd.txt  \n' }), { label: 'Bash · ls', endTs: '2026-09-28T10:01:00.000Z' }),
      ],
      agents,
      'done',
    );
    expect(lines.map((l) => [l.text, l.tone])).toEqual([
      ['$ npm test', 'cmd'],
      ['$ ls', 'cmd'],
      ['b.txt', 'out'],
      ['c.txt', 'out'],
      ['d.txt', 'out'],
    ]);
    expect(BASH_OUTPUT_LINES).toBe(3);
  });

  it('the main agent\'s other tool calls are the chat\'s step lines (not here); a subagent\'s are, prefixed and marked', () => {
    const lines = terminalLines(
      [
        event(1, tool('Write', { file_path: '/w/out.txt' }, { result: 'ok' }), { label: 'Write · out.txt' }),
        event(2, tool('Agent', { subagent_type: 'general-purpose' }), { label: 'Agent · general-purpose · Read' }),
        event(3, tool('Read', { file_path: '/w/hello.txt' }), { agentId: SUB, label: 'Read · hello.txt' }),
        event(4, tool('Read', { file_path: '/w/x.txt' }, { result: 'x' }), { agentId: SUB, label: 'Read · x.txt' }),
        event(5, tool('Grep', { pattern: 'y' }, { result: 'no', isError: true }), { agentId: SUB, label: 'Grep · y' }),
        event(6, tool('Bash', { command: 'git status' }, { result: 'clean' }), { agentId: SUB, label: 'Bash · git status' }),
      ],
      agents,
      'done',
    );
    expect(lines.map((l) => [l.text, l.tone])).toEqual([
      ['[general-purpose] Read · hello.txt', 'out'],
      ['[general-purpose] ✓ Read · x.txt', 'ok'],
      ['[general-purpose] ✕ Grep · y', 'fail'],
      ['[general-purpose] $ git status', 'cmd'],
      ['[general-purpose] clean', 'out'],
    ]);
  });

  it('waits and refusals: AskUserQuestion ⏸ → ✓, permission requests ⏸ / ✓ / ✕, denials ✕, a mode mismatch ⚠', () => {
    const ask = { ...tool('AskUserQuestion', {}), requestId: 'r1', requestState: 'open' };
    const request = (state: string, behavior?: string) => ({ type: 'request', requestId: 'r', toolName: 'Bash', toolUseId: null, input: {}, agentId: null, description: null, decisionReason: null, state, ...(behavior ? { behavior } : {}) });
    const lines = terminalLines(
      [
        event(1, ask, { kind: 'ask', label: '2 questions · Which color?' }),
        event(2, { ...ask, requestState: 'responded', result: 'answered' }, { kind: 'ask', label: '1 question · Size?' }),
        event(3, request('open'), { kind: 'ask', label: 'Permission · Bash · rm x' }),
        event(4, request('responded', 'allow'), { kind: 'ask', label: 'Permission · Bash · ls' }),
        event(5, request('responded', 'deny'), { kind: 'ask', label: 'Permission · Bash · rm y' }),
        event(6, request('stale'), { kind: 'ask', label: 'Permission · Bash · rm z' }),
        event(7, { type: 'denied', toolName: 'Write', toolUseId: null, message: null }, { kind: 'ask', label: 'Denied · Write' }),
        event(8, { type: 'mode-mismatch', requested: 'acceptEdits', observed: 'default' }, { kind: 'error', label: 'Permission mode mismatch: requested acceptEdits, the CLI reports default' }),
      ],
      agents,
      'need',
    );
    expect(lines.map((l) => [l.text, l.tone])).toEqual([
      ['⏸ 2 questions · Which color?', 'wait'],
      ['✓ 1 question · Size?', 'ok'],
      ['⏸ Permission · Bash · rm x', 'wait'],
      ['✓ Permission · Bash · ls', 'ok'],
      ['✕ Permission · Bash · rm y', 'fail'],
      ['✕ Permission · Bash · rm z', 'fail'],
      ['✕ Denied · Write', 'fail'],
      ['⚠ Permission mode mismatch: requested acceptEdits, the CLI reports default', 'wait'],
    ]);
  });

  it('turn results show their text (✕ when failed), lifecycle its label (✕ when failed); conversation text is not shown', () => {
    const result = (isError: boolean) => ({ type: 'result', subtype: isError ? 'error_max_turns' : 'success', isError, text: null, terminalReason: null, errors: [], taskNotification: false, numTurns: 1, durationMs: 1, costUsd: 0 });
    const lines = terminalLines(
      [
        event(1, { type: 'lifecycle', action: 'started', pid: 1 }, { kind: 'text', label: 'Started' }),
        event(2, { type: 'user', text: 'Hi', origin: 'task', delivered: true }, { kind: 'text', label: 'Hi' }),
        event(3, { type: 'assistant', text: 'Hello', messageId: 'm' }, { kind: 'text', label: 'Hello' }),
        event(4, { type: 'agent-prompt', text: 'Read it' }, { kind: 'text', agentId: SUB, label: 'Read it' }),
        event(5, result(false), { kind: 'ok', label: 'Hello' }),
        event(6, result(true), { kind: 'error', label: 'error_max_turns: Reached maximum number of turns (1)' }),
        event(7, { type: 'lifecycle', action: 'failed', code: 1 }, { kind: 'error', label: 'claude exited unexpectedly (code 1)' }),
        event(8, { source: 'demo', channel: 'timeline', lane: 'x' }, { kind: 'plan', label: 'recon' }),
      ],
      agents,
      'fail',
    );
    expect(lines.map((l) => [l.text, l.tone])).toEqual([
      ['Started', 'out'],
      ['Hello', 'out'],
      ['✕ error_max_turns: Reached maximum number of turns (1)', 'fail'],
      ['✕ claude exited unexpectedly (code 1)', 'fail'],
    ]);
  });

  it('time order (ts, then id), the cursor ▍ while the session runs, and only the newest lines', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      event(100 + i, tool('Bash', { command: `echo ${i}` }), { ts: `2026-09-28T11:00:${String(i).padStart(2, '0')}.000Z` }),
    );
    // An imported terminal turn carries an older timestamp than its id suggests.
    const older = event(999, tool('Bash', { command: 'first' }), { ts: '2026-09-28T09:00:00.000Z' });
    const all = terminalLines([...many, older], agents, 'done');
    expect(all).toHaveLength(TERMINAL_TAIL_LINES);
    expect(all.map((l) => l.text)).toEqual(['$ echo 4', '$ echo 5', '$ echo 6', '$ echo 7', '$ echo 8', '$ echo 9', '$ echo 10', '$ echo 11']);
    const running = terminalLines([older, many[0] as SessionEvent], agents, 'run');
    expect(running.map((l) => [l.text, l.tone, l.key])).toEqual([
      ['$ first', 'cmd', '999:0'],
      ['$ echo 0', 'cmd', '100:0'],
      [TERMINAL_CURSOR, 'out', 'cursor'],
    ]);
    expect(terminalLines([], agents, 'need')).toEqual([]);
  });

  it('line tones follow the prototype\'s lineColor, after an optional [agent] prefix', () => {
    expect(['$ dotnet build', '✓ ok', '⏸ wait', '⚠ warn', '✕ no', 'plain', '[web] $ x', '[qa-web] ✓ y', '⏸ [web] question', '[a.b] ✓ z'].map(lineTone)).toEqual([
      'cmd',
      'ok',
      'wait',
      'wait',
      'fail',
      'out',
      'cmd',
      'ok',
      'wait',
      'out',
    ]);
  });

  it('the demo seed\'s terminal events (turn results) render the prototype\'s lines verbatim, the cursor from the status', async () => {
    const data = await loadDemoData();
    for (const s of data.sessions) {
      const events = s.terminal
        .filter((line) => line !== DEMO_CURSOR)
        .map((line, i) => event(i + 1, demoResult(line), { kind: 'text', label: line, agentId: null }));
      const lines = terminalLines(events, [agent()], s.status);
      expect(lines.map((l) => l.text), s.name).toEqual(s.terminal);
    }
  });
});
