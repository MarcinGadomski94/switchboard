import { describe, expect, it } from 'vitest';
import type { Session, Solution, SolutionGroup, Tool } from '../../src/core/api.ts';
import {
  PALETTE_MAX_RESULTS,
  PALETTE_PLACEHOLDER,
  type PaletteEntry,
  clampIndex,
  filterPalette,
  moveIndex,
  paletteEntries,
} from '../../src/web/modals/palette.ts';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    name: 'free-talk-feature',
    claudeSessionId: 'c1',
    status: 'run',
    workType: null,
    mode: null,
    phase: null,
    coordination: null,
    qaStack: null,
    ultracode: false,
    worktrees: false,
    solutions: [],
    attached: true,
    createdAt: '2026-09-28T09:00:00.000Z',
    lastActivityAt: null,
    agents: [],
    openQuestionCount: 0,
    cwd: null,
    folder: null,
    folderPath: null,
    folderKind: null,
    live: false,
    resumeCommand: 'claude --resume c1',
    chips: [],
    loops: [],
    ...overrides,
  };
}

function solution(overrides: Partial<Solution>): Solution {
  return {
    name: 'x',
    path: '/ws/x',
    relativePath: 'x',
    type: 'Web',
    status: 'idle',
    rule: 'editable',
    phase: '—',
    changes: '—',
    flag: '',
    conflict: false,
    conflictSessions: [],
    branches: [],
    ledger: null,
    artifacts: [],
    codebaseMemory: 'fresh',
    ...overrides,
  };
}

const TOOLS: Tool[] = [
  { id: 'cm', name: 'Codebase Memory', url: 'http://localhost:13000', description: 'code graph', showInSidebar: true, frameUrl: null },
  { id: 'sw', name: 'Acme Tool', url: null, description: null, showInSidebar: false, frameUrl: null },
];

const SESSIONS: Session[] = [
  session({ id: 'id-1', name: 'free-talk-feature', mode: 'orchestrator', workType: 'feature', phase: 'ui-first' }),
  session({ id: 'id-2', name: 'calendar-func-fix', mode: 'single' }),
];

const GROUPS: SolutionGroup[] = [
  {
    folder: 'microfrontends/',
    note: '',
    rule: 'editable',
    solutions: [solution({ name: 'acme-app-front', path: '/ws/microfrontends/acme-app-front' }), solution({ name: 'auth-front', path: '/ws/microfrontends/auth-front' })],
  },
  { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution({ name: 'mobile', path: '/ws/mobile', type: 'Mobile' })] },
  {
    folder: 'read-only',
    note: 'deprecated/ · never edited',
    rule: 'read-only',
    solutions: [solution({ name: 'old-chat-front', path: '/ws/deprecated/microfrontends/old-chat-front', rule: 'read-only' })],
  },
];

function rows(entries: readonly PaletteEntry[]): string[] {
  return entries.map((e) => `${e.kind} | ${e.label} | ${e.hint}`);
}

describe('palette model (M8.3)', () => {
  it('lists views, New session, tools, sessions and solutions in the prototype order', () => {
    const entries = paletteEntries({ sessions: SESSIONS, tools: TOOLS, solutions: GROUPS });
    expect(rows(entries)).toEqual([
      'view | Inbox | ',
      'view | Solutions | ',
      'view | Schedules & loops | ',
      'view | Artifacts | ',
      'view | History | ',
      'view | Settings | ',
      'action | New session | ',
      'tool | Codebase Memory | localhost:13000',
      'tool | Acme Tool | ',
      'session | free-talk-feature | orch · feature · UI-first',
      'session | calendar-func-fix | single',
      'solution | acme-app-front | microfrontends/',
      'solution | auth-front | microfrontends/',
      'solution | mobile | mobile/',
      'solution | old-chat-front | read-only',
    ]);
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    expect(PALETTE_PLACEHOLDER).toBe('Jump to a session, solution, view or tool…');
  });

  it('targets: view and tool and session routes, the New-session modal, a solution by path', () => {
    const entries = paletteEntries({ sessions: SESSIONS, tools: TOOLS, solutions: GROUPS });
    const by = (label: string) => entries.find((e) => e.label === label)?.target;
    expect(by('Inbox')).toEqual({ type: 'route', route: { view: 'inbox' } });
    expect(by('Schedules & loops')).toEqual({ type: 'route', route: { view: 'schedules' } });
    expect(by('Settings')).toEqual({ type: 'route', route: { view: 'settings', section: null } });
    expect(by('New session')).toEqual({ type: 'new-session' });
    expect(by('Acme Tool')).toEqual({ type: 'route', route: { view: 'tool', id: 'sw' } });
    expect(by('calendar-func-fix')).toEqual({ type: 'route', route: { view: 'session', id: 'id-2', tab: 'chat' } });
    expect(by('mobile')).toEqual({ type: 'solution', path: '/ws/mobile' });
  });

  it('lists nothing it does not have: unavailable lists (null) add no entries', () => {
    const entries = paletteEntries({ sessions: null, tools: null, solutions: null });
    expect(rows(entries)).toEqual([
      'view | Inbox | ',
      'view | Solutions | ',
      'view | Schedules & loops | ',
      'view | Artifacts | ',
      'view | History | ',
      'view | Settings | ',
      'action | New session | ',
    ]);
  });

  it('filters on "label kind hint", case-insensitive, keeping list order, max 10', () => {
    const entries = paletteEntries({ sessions: SESSIONS, tools: TOOLS, solutions: GROUPS });
    expect(filterPalette(entries, '')).toHaveLength(PALETTE_MAX_RESULTS);
    expect(filterPalette(entries, '').map((e) => e.label)).toEqual(entries.slice(0, 10).map((e) => e.label));
    // by label
    expect(rows(filterPalette(entries, 'SWAP'))).toEqual(['tool | Acme Tool | ', 'solution | acme-app-front | microfrontends/']);
    // by kind
    expect(filterPalette(entries, 'view').map((e) => e.label)).toEqual(['Inbox', 'Solutions', 'Schedules & loops', 'Artifacts', 'History', 'Settings']);
    expect(filterPalette(entries, 'Session').map((e) => e.label)).toEqual(['New session', 'free-talk-feature', 'calendar-func-fix']);
    // by hint
    expect(filterPalette(entries, 'microfrontends/').map((e) => e.label)).toEqual(['acme-app-front', 'auth-front']);
    expect(filterPalette(entries, 'localhost').map((e) => e.label)).toEqual(['Codebase Memory']);
    expect(filterPalette(entries, 'ui-first').map((e) => e.label)).toEqual(['free-talk-feature']);
    // across the joined fields (prototype: label + ' ' + kind + ' ' + hint)
    expect(filterPalette(entries, 'mobile solution mobile/').map((e) => e.label)).toEqual(['mobile']);
    expect(filterPalette(entries, 'nothing like this')).toEqual([]);
  });

  it('cuts any result list to 10', () => {
    const many = Array.from({ length: 25 }, (_, i) => session({ id: `id-${i}`, name: `loop-${i}` }));
    const result = filterPalette(paletteEntries({ sessions: many, tools: null, solutions: null }), 'loop-');
    expect(result.map((e) => e.label)).toEqual(Array.from({ length: 10 }, (_, i) => `loop-${i}`));
  });

  it('↑ ↓ move the highlight and stop at the ends; the index is clamped into the results', () => {
    expect(moveIndex(0, 5, 1)).toBe(1);
    expect(moveIndex(4, 5, 1)).toBe(4);
    expect(moveIndex(1, 5, -1)).toBe(0);
    expect(moveIndex(0, 5, -1)).toBe(0);
    expect(moveIndex(0, 0, 1)).toBe(0);
    expect(moveIndex(0, 0, -1)).toBe(0);
    expect(moveIndex(9, 3, -1)).toBe(1);
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(2, 0)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
  });
});
