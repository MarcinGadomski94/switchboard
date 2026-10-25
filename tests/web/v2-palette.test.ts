import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../../src/core/api.ts';
import { V2_WELCOME_ID, isV2Tour } from '../../src/core/tutorial.ts';
import {
  type PaletteRow,
  actionRows,
  advancedPages,
  hitPath,
  isTaskPrefix,
  matchRank,
  pageRows,
  quickTaskAgent,
  quickTaskTitle,
  rankRows,
  resultPath,
  searchRow,
} from '../../src/web/v2/palette/palette-model.ts';

const row = (id: string, label: string, extra: Partial<PaletteRow> = {}): PaletteRow => ({ id, group: 'pages', icon: 'home', label, action: { go: `/${id}` }, ...extra });

describe('⌘K · ranking', () => {
  it('ranks prefix > word start > inside, and every word must match', () => {
    expect(matchRank(row('a', 'Crews'), 'cre')).toBe(0);
    expect(matchRank(row('b', 'New crew'), 'cre')).toBe(1);
    expect(matchRank(row('c', 'Screenshots'), 'cre')).toBe(2);
    expect(matchRank(row('d', 'Crews'), 'cre zzz')).toBeNull();
    expect(matchRank(row('e', 'Checkout', { keywords: 'payments' }), 'pay')).toBe(1);
  });

  it('puts the best match first, recency breaks ties, groups stay together', () => {
    const rows = [
      row('settings', 'Settings › Crews', { group: 'pages' }),
      row('a1', 'Crew helper old', { group: 'agents', recency: 1 }),
      row('a2', 'Crew helper new', { group: 'agents', recency: 5 }),
      row('crews', 'Crews', { group: 'pages' }),
    ];
    const ranked = rankRows(rows, 'crew');
    expect(ranked[0]?.id).toBe('a2');
    expect(ranked.map((r) => r.id)).toEqual(['a2', 'a1', 'crews', 'settings']);
    expect(rankRows(rows, 'crews').map((r) => r.id)).toEqual(['crews', 'settings']);
  });

  it('keeps at most the cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`p${i}`, `Page ${i}`));
    expect(rankRows(many, 'page')).toHaveLength(12);
    expect(rankRows(many, 'page', 3)).toHaveLength(3);
  });
});

describe('⌘K · quick task', () => {
  it('reads "task …"', () => {
    expect(quickTaskTitle('task Fix the banner')).toBe('Fix the banner');
    expect(quickTaskTitle('TASK  x')).toBe('x');
    expect(quickTaskTitle('task')).toBeNull();
    expect(quickTaskTitle('tasks')).toBeNull();
    expect(isTaskPrefix('task ')).toBe(true);
    expect(isTaskPrefix('task x')).toBe(false);
  });

  it('goes to the agent on screen, else the most recent open agent', () => {
    const s = (id: string, at: string, extra: Partial<SessionListItem> = {}) => ({ id, name: id, createdAt: at, lastActivityAt: at, closedAt: null, kind: 'session', ...extra }) as unknown as SessionListItem;
    const sessions = [s('old', '2026-10-01T00:00:00Z'), s('new', '2026-10-20T00:00:00Z'), s('chat', '2026-10-25T00:00:00Z', { kind: 'chat' } as Partial<SessionListItem>), s('gone', '2026-10-24T00:00:00Z', { closedAt: '2026-10-24T01:00:00Z' })];
    expect(quickTaskAgent(sessions, 'old')?.id).toBe('old');
    expect(quickTaskAgent(sessions, 'chat')?.id).toBe('new');
    expect(quickTaskAgent(sessions, null)?.id).toBe('new');
    expect(quickTaskAgent([], null)).toBeNull();
  });
});

describe('⌘K · pages, actions and links', () => {
  it('reaches every v2 page, every Settings section and every Advanced page', () => {
    const paths = pageRows().map((r) => ('go' in r.action ? r.action.go : ''));
    for (const path of ['/', '/needs-you', '/agents', '/projects', '/crews', '/results', '/search', '/insights', '/tasks', '/routines', '/notes', '/settings/usage', '/settings/computers', '/settings/phones', '/settings/rules', '/settings/appearance', '/settings/advanced']) {
      expect(paths).toContain(path);
    }
    const keys = advancedPages().map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['code-projects', 'connections', 'clis', 'sessions', 'schedules', 'tools', 'github', 'ci', 'processes', 'jira', 'updates', 'tutorial', 'cleanup']));
    expect(keys).not.toContain('accounts');
    expect(keys).not.toContain('appearance');
  });

  it('offers New for every kind and the theme switch', () => {
    const actions = actionRows();
    const kinds = actions.filter((r) => 'run' in r.action && r.action.run === 'new').map((r) => ('run' in r.action ? r.action.arg : ''));
    expect(kinds).toEqual(['agent', 'conversation', 'task', 'project', 'routine', 'teammate', 'crew']);
    expect(rankRows(actions, 'classic')[0]?.id).toBe('action:theme-classic');
  });

  it('replays the v2 welcome tour directly (the prototype\'s "Replay tour: what\'s new in Switchboard 2")', () => {
    const replay = actionRows().find((r) => r.id === `action:replay-tour:${V2_WELCOME_ID}`);
    expect(replay?.label).toBe('Replay tour: what’s new in Switchboard 2');
    expect(replay?.action).toEqual({ run: 'replay-tour', arg: V2_WELCOME_ID });
    expect(isV2Tour(V2_WELCOME_ID)).toBe(true);
    expect(rankRows(actionRows(), 'replay tour')[0]?.id).toBe(replay?.id);
    expect(rankRows(actionRows(), 'whats new').map((r) => r.id)).toContain(replay?.id);
  });

  it('links results, search hits and the search page', () => {
    expect(resultPath('a1', 's1', null)).toBe('/results?open=a1&agent=s1');
    expect(resultPath('a1', 's1', 'm2')).toBe('/results?open=a1&agent=s1&computer=m2');
    expect(hitPath({ type: 'event', sessionId: 's1', eventId: 42, agentId: null }, null)).toBe('/agents/s1/events/42');
    expect(hitPath({ type: 'event', sessionId: 's1', eventId: 42, agentId: 'h1' }, null)).toBe('/agents/s1/helpers/h1/events/42');
    expect(hitPath({ type: 'todo', sessionId: 's1', todoId: 't' }, null)).toBe('/tasks');
    expect(searchRow(' tests green ').action).toEqual({ go: '/search?q=tests%20green' });
  });
});
