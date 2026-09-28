import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import { chatMessages, upsertEvent } from '../../src/web/views/session/chat.ts';
import { actionErrorText, attachWarningText, handoff, pauseButton, rootLine, tabLabels } from '../../src/web/views/session/session-header.ts';

describe('session header copy and rules (M4.1)', () => {
  it('root line, tabs with counts (prototype TABS)', () => {
    expect(rootLine({ cwd: 'D:\\acme', folderPath: 'D:\\acme', folderKind: 'workspace' })).toBe('D:\\acme · workspace root');
    expect(rootLine({ cwd: null, folderPath: null, folderKind: null })).toBe('workspace root');
    // D14: a repo folder's session runs in the repo, or in its worktree next to it.
    expect(rootLine({ cwd: '/src/switchboard', folderPath: '/src/switchboard', folderKind: 'repo' })).toBe('/src/switchboard · git repo');
    expect(rootLine({ cwd: '/src/switchboard-wt-fix', folderPath: '/src/switchboard', folderKind: 'repo' })).toBe('/src/switchboard-wt-fix · worktree of switchboard');
    expect(rootLine({ cwd: 'D:\\ws\\other\\app-wt-x', folderPath: 'D:\\ws\\other\\app\\', folderKind: 'repo' })).toBe('D:\\ws\\other\\app-wt-x · worktree of app');
    expect(tabLabels(5, 4).map((t) => t.label)).toEqual(['Chat', 'Timeline', 'Diff · 5', 'Artifacts · 4']);
    expect(tabLabels(0, 0).map((t) => t.tab)).toEqual(['chat', 'timeline', 'diff', 'artifacts']);
  });

  it('Pause while live or running, Resume otherwise; disabled while a terminal owns the session', () => {
    expect(pauseButton({ live: true, status: 'done', attached: true })).toEqual({ action: 'pause', label: 'Pause', disabled: false });
    expect(pauseButton({ live: false, status: 'need', attached: true })).toMatchObject({ action: 'pause', label: 'Pause' });
    expect(pauseButton({ live: false, status: 'paused', attached: true })).toEqual({ action: 'resume', label: 'Resume', disabled: false });
    expect(pauseButton({ live: false, status: 'done', attached: true })).toMatchObject({ action: 'resume' });
    expect(pauseButton({ live: false, status: 'paused', attached: false })).toEqual({ action: 'resume', label: 'Resume', disabled: true });
  });

  it('handoff card copy is the prototype text, verbatim', () => {
    expect(handoff(true)).toEqual({
      state: 'attached',
      status: 'done',
      text: 'Running in the background and attached here. Detach to continue in a terminal. The conversation stays in sync both ways.',
    });
    expect(handoff(false)).toEqual({
      state: 'in terminal',
      status: 'need',
      text: 'Detached. Continue in any terminal with the command below. Switchboard keeps showing notifications and syncs back when you attach.',
    });
  });

  it('attach warning says why and what attaching does', () => {
    const now = Date.parse('2026-09-28T10:02:00.000Z');
    expect(attachWarningText([{ kind: 'transcript-recent', modifiedAt: '2026-09-28T10:01:48.000Z' }], now)).toBe(
      'The transcript changed 12 s ago. Attaching while a terminal still has the session open forks the conversation. Close it there first, or attach anyway.',
    );
    expect(attachWarningText([{ kind: 'terminal-live', pid: 4242 }, { kind: 'liveness-unknown' }], now)).toBe(
      'A claude process (pid 4242) has this session open. Switchboard could not check whether a terminal still has this session open. Attaching while a terminal still has the session open forks the conversation. Close it there first, or attach anyway.',
    );
    expect(attachWarningText([{ kind: 'transcript-recent', modifiedAt: '2026-09-28T10:00:30.000Z' }], now)).toMatch(/^The transcript changed 1 min ago\./);
  });

  it('refused actions show the service message', () => {
    expect(actionErrorText(409, { error: 'detached', message: 'the session continues in a terminal; attach it first' })).toBe(
      'the session continues in a terminal; attach it first',
    );
    expect(actionErrorText(500, 'x')).toBe('The request failed (HTTP 500).');
    expect(actionErrorText(0, null)).toBe('Switchboard is not reachable.');
  });
});

describe('chat messages (M4.1: the terminal turns show after Attach)', () => {
  const event = (id: number, ts: string, payload: unknown): SessionEvent => ({ id, sessionId: 's', agentId: null, ts, endTs: null, kind: 'text', label: '', payload });

  it('user and assistant events in time order (imported terminal turns carry older timestamps)', () => {
    const events = [
      event(1, '2026-09-28T10:00:00.000Z', { type: 'user', text: 'task', origin: 'task', delivered: true }),
      event(2, '2026-09-28T10:00:01.000Z', { type: 'assistant', text: 'OK', messageId: 'm1' }),
      event(3, '2026-09-28T10:00:02.000Z', { type: 'lifecycle', action: 'detached' }),
      event(6, '2026-09-28T10:05:00.000Z', { type: 'lifecycle', action: 'attached' }),
      event(4, '2026-09-28T10:03:00.000Z', { type: 'user', text: 'from the terminal', origin: 'terminal', delivered: true }),
      event(5, '2026-09-28T10:03:02.000Z', { type: 'assistant', text: 'tangerine', messageId: 'm2' }),
      event(7, '2026-09-28T10:06:00.000Z', { type: 'agent-prompt', text: 'subagent prompt' }),
    ];
    expect(chatMessages(events).map((m) => [m.role, m.text, m.origin])).toEqual([
      ['user', 'task', 'task'],
      ['agent', 'OK', null],
      ['user', 'from the terminal', 'terminal'],
      ['agent', 'tangerine', null],
    ]);
  });

  it('upsertEvent replaces by id (merged assistant text) or appends', () => {
    const a = event(1, 't', { type: 'assistant', text: 'a', messageId: null });
    const b = event(1, 't', { type: 'assistant', text: 'a\n\nb', messageId: null });
    expect(upsertEvent([a], b)).toEqual([b]);
    expect(upsertEvent([a], event(2, 't', null))).toHaveLength(2);
  });
});
