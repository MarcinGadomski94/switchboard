import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../../src/core/api.ts';
import { bringInEntry, bringInFolder, bringInList, bringInMatches, bringInRows, bringInStage } from '../../src/web/v2/new/bring-in-model.ts';
import type { MoveItem } from '../../src/web/views/history-move.ts';

/** D16 in v2 · + New › From a terminal: the pure part (`src/web/v2/new/bring-in-model.ts`). */

function row(over: Partial<HistoryItem> & Pick<HistoryItem, 'claudeSessionId'>): HistoryItem {
  return {
    sessionId: null,
    startedAt: '2026-10-20T10:00:00.000Z',
    name: 'Fix the login page',
    mode: 'terminal',
    summary: '',
    branches: [],
    solutions: [],
    outcome: 'ended',
    status: 'idle',
    folder: 'f1',
    folderPath: '/Users/dev/work',
    terminal: true,
    firstPrompt: 'Fix the login redirect',
    cwd: '/Users/dev/work/web-app',
    ...over,
  };
}

const A = row({ claudeSessionId: 'aaaa-1111', startedAt: '2026-10-20T10:00:00.000Z' });
const B = row({ claudeSessionId: 'bbbb-2222', startedAt: '2026-10-25T09:00:00.000Z', name: 'Lantern', firstPrompt: 'Remember the code word: lantern', cwd: '/Users/dev/other/api', folder: null, folderPath: '/Users/dev/other' });
const STORED = row({ claudeSessionId: 'cccc-3333', sessionId: 's1', terminal: undefined, startedAt: '2026-10-27T09:00:00.000Z' });
const HOOKED = row({ claudeSessionId: 'dddd-4444', sessionId: 's2', terminal: undefined, hooked: true });
const PEER = row({ claudeSessionId: 'eeee-5555', machine: { id: 'm1', name: 'Studio' } as HistoryItem['machine'] });
const CODEX = row({ claudeSessionId: 'codex:019a', provider: 'codex', nativeId: '019a', name: '', firstPrompt: 'Port the parser', startedAt: '2026-10-21T08:00:00.000Z' });

describe('v2 bring in · which rows', () => {
  it('keeps this computer’s terminal conversations not in Switchboard yet, newest first', () => {
    expect(bringInRows([A, STORED, B, HOOKED, PEER, CODEX]).map((r) => r.claudeSessionId)).toEqual(['bbbb-2222', 'codex:019a', 'aaaa-1111']);
  });

  it('orders rows started at the same time by id (a stable list)', () => {
    const later = row({ claudeSessionId: 'zz', startedAt: A.startedAt });
    expect(bringInRows([later, A]).map((r) => r.claudeSessionId)).toEqual(['aaaa-1111', 'zz']);
  });
});

describe('v2 bring in · search', () => {
  it('matches the folder, the first prompt, the name and the id, case-insensitively', () => {
    expect(bringInMatches(B, 'other/api')).toBe(true);
    expect(bringInMatches(B, 'CODE WORD')).toBe(true);
    expect(bringInMatches(B, 'lantern')).toBe(true);
    expect(bringInMatches(B, 'bbbb-22')).toBe(true);
    expect(bringInMatches(A, 'web-app')).toBe(true);
    expect(bringInMatches(CODEX, 'codex parser')).toBe(true);
    expect(bringInMatches(CODEX, '019a')).toBe(true);
  });

  it('needs every word; an empty query matches all', () => {
    expect(bringInMatches(B, 'lantern login')).toBe(false);
    expect(bringInMatches(A, '   ')).toBe(true);
    expect(bringInList([A, B, STORED], 'login').map((r) => r.claudeSessionId)).toEqual(['aaaa-1111']);
    expect(bringInList([A, B, STORED], '').map((r) => r.claudeSessionId)).toEqual(['bbbb-2222', 'aaaa-1111']);
    expect(bringInList([A, B], 'nothing like this')).toEqual([]);
  });
});

describe('v2 bring in · an entry', () => {
  it('has the title, the first prompt when it differs, the folder by name and the CLI', () => {
    expect(bringInEntry(A)).toEqual({ id: 'aaaa-1111', title: 'Fix the login page', prompt: 'Fix the login redirect', where: 'web-app', wherePath: '/Users/dev/work/web-app', cli: null, startedAt: A.startedAt });
    // No name: the first prompt is the title (and not repeated).
    expect(bringInEntry(CODEX)).toMatchObject({ title: 'Port the parser', prompt: null, cli: 'Codex CLI' });
    // The code project is added when it is not the folder's own name.
    expect(bringInEntry(row({ claudeSessionId: 'x', cwd: '/w/ws', solutions: ['api'] })).where).toBe('ws · api');
    expect(bringInEntry(row({ claudeSessionId: 'x', cwd: '/w/api', solutions: ['api'] })).where).toBe('api');
    expect(bringInEntry(row({ claudeSessionId: 'x', cwd: null, folderPath: null, name: '', firstPrompt: null })).title).toBe('x');
  });

  it('lands in its own saved folder, or none (the move then asks to add it)', () => {
    const folders = [{ id: 'f1', displayName: 'work' }];
    expect(bringInFolder(A, folders)).toEqual({ id: 'f1', displayName: 'work' });
    expect(bringInFolder(B, folders)).toBeNull();
    expect(bringInFolder(row({ claudeSessionId: 'x', folder: 'gone' }), folders)).toBeNull();
  });
});

describe('v2 bring in · the confirm step’s stage', () => {
  const item = (state: MoveItem['state']): MoveItem => ({ claudeSessionId: 'aaaa-1111', title: 't', addFolder: false, confirm: false, state });
  it('follows the single move', () => {
    expect(bringInStage(null, 'aaaa-1111')).toBe('pick');
    expect(bringInStage([item({ kind: 'waiting' })], null)).toBe('pick');
    expect(bringInStage([item({ kind: 'waiting' })], 'aaaa-1111')).toBe('moving');
    expect(bringInStage([item({ kind: 'moving' })], 'aaaa-1111')).toBe('moving');
    expect(bringInStage([item({ kind: 'skipped' })], 'aaaa-1111')).toBe('pick');
    expect(bringInStage([item({ kind: 'terminal-open', reasons: [{ kind: 'liveness-unknown' }] })], 'aaaa-1111')).toBe('terminal-open');
    expect(bringInStage([item({ kind: 'needs-folder', check: { path: '/x', kind: 'workspace' } as never })], 'aaaa-1111')).toBe('needs-folder');
    expect(bringInStage([item({ kind: 'refused', reason: 'no' })], 'aaaa-1111')).toBe('refused');
    expect(bringInStage([item({ kind: 'moved', sessionId: 's', name: 'n' })], 'aaaa-1111')).toBe('moved');
    expect(bringInStage([item({ kind: 'moving' })], 'other')).toBe('pick');
  });
});
