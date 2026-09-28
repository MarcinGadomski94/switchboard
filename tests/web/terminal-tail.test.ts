import { describe, expect, it } from 'vitest';
import type { Agent, SessionEvent } from '../../src/core/api.ts';
import type { EventKind } from '../../src/core/model.ts';
import { TERMINAL_LINES, eventLines, lineTone, terminalTail } from '../../src/web/views/session/terminal-tail.ts';

let nextId = 1;
function ev(kind: EventKind, label: string, payload: unknown, agentId: string | null = 'main', second = nextId): SessionEvent {
  return { id: nextId++, sessionId: 's', agentId, ts: new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString(), endTs: null, kind, label, payload };
}

const agents: Agent[] = [
  { id: 'main', kind: 'main', name: 'orchestrator', description: null, solutionPath: null, branch: null, status: 'run', statusText: null },
  { id: 'sub', kind: 'subagent', name: 'general-purpose', description: null, solutionPath: null, branch: null, status: 'run', statusText: null },
];

describe('lineTone (the prototype lineColor)', () => {
  it('colors by the first character after an [agent] tag', () => {
    expect(lineTone('$ dotnet build')).toBe('cmd');
    expect(lineTone('✓ web 13/14 fields match')).toBe('ok');
    expect(lineTone('⚠ mobile TopicId: required ≠ web nullable')).toBe('warn');
    expect(lineTone('⏸ waiting for your answers')).toBe('warn');
    expect(lineTone('✕ figma: no variant State=Loading')).toBe('err');
    expect(lineTone('[web] $ dotnet test --filter FreeTalk')).toBe('cmd');
    expect(lineTone('[orch] reconcile · contract-adherence report')).toBe('plain');
    expect(lineTone('CS0103 TimeZoneInfo not found')).toBe('plain');
  });
});

describe('eventLines', () => {
  it('renders a Bash call as its command, then its last output line or the error', () => {
    expect(eventLines(ev('impl', 'Bash · ls', { type: 'tool', name: 'Bash', toolUseId: 'a', input: { command: 'ls\n-la' } }))).toEqual(['$ ls']);
    expect(eventLines(ev('impl', 'Bash · ls', { type: 'tool', name: 'Bash', toolUseId: 'a', input: { command: 'ls' }, result: 'a.txt\nb.txt\n\n', isError: false }))).toEqual([
      '$ ls',
      'b.txt',
    ]);
    expect(
      eventLines(ev('impl', 'Bash · dotnet build', { type: 'tool', name: 'Bash', toolUseId: 'a', input: { command: 'dotnet build' }, result: 'CS0103 x\nmore', isError: true })),
    ).toEqual(['$ dotnet build', '✕ CS0103 x']);
  });

  it('marks other tools running, done or failed, and open questions as waiting', () => {
    expect(eventLines(ev('plan', 'Read · a.ts', { type: 'tool', name: 'Read', toolUseId: 'a', input: {} }))).toEqual(['● Read · a.ts']);
    expect(eventLines(ev('impl', 'Write · a.md', { type: 'tool', name: 'Write', toolUseId: 'a', input: {}, result: 'ok', isError: false }))).toEqual(['✓ Write · a.md']);
    expect(eventLines(ev('impl', 'Edit · a.md', { type: 'tool', name: 'Edit', toolUseId: 'a', input: {}, result: 'no', isError: true }))).toEqual(['✕ Edit · a.md']);
    expect(eventLines(ev('ask', '2 questions · Which?', { type: 'tool', name: 'AskUserQuestion', toolUseId: 'q', input: {}, requestState: 'open' }))).toEqual([
      '⏸ 2 questions · Which?',
    ]);
  });

  it('renders requests, denials, results, lifecycle and mode mismatches; skips chat text and unknown shapes', () => {
    expect(eventLines(ev('ask', 'Permission · Bash · rm', { type: 'request', state: 'open' }))).toEqual(['⏸ Permission · Bash · rm']);
    expect(eventLines(ev('ask', 'Permission · Bash · rm', { type: 'request', state: 'responded', behavior: 'deny' }))).toEqual(['✕ Permission · Bash · rm']);
    expect(eventLines(ev('ask', 'Permission · Bash · rm', { type: 'request', state: 'responded', behavior: 'allow' }))).toEqual(['✓ Permission · Bash · rm']);
    expect(eventLines(ev('ask', 'Permission · Bash · rm', { type: 'request', state: 'stale' }))).toEqual(['⚠ Permission · Bash · rm · stale']);
    expect(eventLines(ev('ask', 'Denied · Write', { type: 'denied', toolName: 'Write' }))).toEqual(['✕ Denied · Write']);
    expect(eventLines(ev('ok', 'Done', { type: 'result', isError: false }))).toEqual(['✓ Done']);
    expect(eventLines(ev('error', 'error_max_turns: Reached maximum', { type: 'result', isError: true }))).toEqual(['✕ error_max_turns: Reached maximum']);
    expect(eventLines(ev('text', 'claude started', { type: 'lifecycle', action: 'started' }))).toEqual(['claude started']);
    expect(eventLines(ev('error', 'claude could not start', { type: 'lifecycle', action: 'failed' }))).toEqual(['✕ claude could not start']);
    expect(eventLines(ev('error', 'Permission mode default', { type: 'mode-mismatch', requested: 'acceptEdits', observed: 'default' }))).toEqual([
      '⚠ Permission mode default',
    ]);
    expect(eventLines(ev('text', 'hello', { type: 'user', text: 'hello', origin: 'user', delivered: true }))).toEqual([]);
    expect(eventLines(ev('text', 'hi', { type: 'assistant', text: 'hi', messageId: null }))).toEqual([]);
    expect(eventLines(ev('tool', '✓ web 13/14 fields match', { source: 'demo', channel: 'terminal', line: 'x' }))).toEqual([]);
    expect(eventLines(ev('tool', 'x', null))).toEqual([]);
  });
});

describe('terminalTail', () => {
  it('tags subagent lines, orders by time and keeps the newest lines', () => {
    nextId = 1;
    const events = [
      ev('ok', 'Done', { type: 'result', isError: false }, 'main', 30),
      ev('plan', 'Read · hello.txt', { type: 'tool', name: 'Read', toolUseId: 'r', input: {}, result: 'alpha', isError: false }, 'sub', 20),
      ev('impl', 'Bash · ls', { type: 'tool', name: 'Bash', toolUseId: 'b', input: { command: 'ls' }, result: 'x' }, 'main', 10),
    ];
    const tail = terminalTail(events, agents);
    expect(tail.map((line) => [line.text, line.tone])).toEqual([
      ['$ ls', 'cmd'],
      ['x', 'plain'],
      ['[general-purpose] ✓ Read · hello.txt', 'ok'],
      ['✓ Done', 'ok'],
    ]);
    expect(new Set(tail.map((line) => line.key)).size).toBe(tail.length);

    const many = Array.from({ length: 20 }, (_, i) => ev('ok', `turn ${i}`, { type: 'result', isError: false }, 'main', 40 + i));
    const cut = terminalTail(many, agents);
    expect(cut).toHaveLength(TERMINAL_LINES);
    expect(cut.at(-1)?.text).toBe('✓ turn 19');
  });
});
