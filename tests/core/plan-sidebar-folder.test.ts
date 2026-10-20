import { describe, expect, it } from 'vitest';
import {
  type PlanFolderSession,
  addPlanSidebarFolder,
  defaultPlanSidebarFolder,
  planSidebarFolderName,
  planSidebarFolderProblem,
  uniqueSidebarFolderName,
} from '../../src/core/plans-jira.ts';
import { SIDEBAR_FOLDER_NAME_MAX, type SidebarFolder, type SidebarLayout } from '../../src/core/sidebar-layout.ts';

/** D119 · the imported plan's own sidebar subfolder: its name, the unique-name rule, the write, and the dialog's default. */

function folder(id: string, name: string, sessionIds: string[], parentId: string | null = null): SidebarFolder {
  return { id, name, collapsed: false, sessionIds, parentId };
}

const WORK = { id: 'f-acme', path: '/src/acme' };

function session(id: string, extra: Partial<PlanFolderSession> = {}): PlanFolderSession {
  return { id, folder: WORK.id, folderPath: WORK.path, lastActivityAt: '2026-10-20T10:00:00.000Z', createdAt: '2026-10-20T09:00:00.000Z', ...extra };
}

describe('planSidebarFolderName / uniqueSidebarFolderName', () => {
  it('uses the session title, cut to the folder limit at a word break', () => {
    expect(planSidebarFolderName('Plan · PROJ-123 Acme checkout')).toBe('Plan · PROJ-123 Acme checkout');
    const long = planSidebarFolderName('Plan · PROJ-123 Acme checkout with a very long summary that goes on and on');
    expect(long.length).toBeLessThanOrEqual(SIDEBAR_FOLDER_NAME_MAX);
    expect(long).toBe('Plan · PROJ-123 Acme checkout with a very long summary…');
    // A title the session already cut (80 characters, "…") gets one "…", not two.
    expect(planSidebarFolderName(`Plan · ${'x'.repeat(72)}…`)).toMatch(/^Plan · x+…$/);
    expect(planSidebarFolderName(`Plan · ${'x'.repeat(72)}…`).length).toBe(SIDEBAR_FOLDER_NAME_MAX);
    expect(planSidebarFolderName('  ')).toBe('Plan · Jira epic');
  });

  it('adds " (2)", " (3)"… only for an exact name taken at that level', () => {
    expect(uniqueSidebarFolderName('Plan · A', ['Plan · B', 'plan · a'])).toBe('Plan · A');
    expect(uniqueSidebarFolderName('Plan · A', ['Plan · A'])).toBe('Plan · A (2)');
    expect(uniqueSidebarFolderName('Plan · A', ['Plan · A', 'Plan · A (2)'])).toBe('Plan · A (3)');
    const full = `Plan · ${'word '.repeat(20)}`.slice(0, SIDEBAR_FOLDER_NAME_MAX);
    const next = uniqueSidebarFolderName(full, [full]);
    expect(next.endsWith(' (2)')).toBe(true);
    expect(next.length).toBeLessThanOrEqual(SIDEBAR_FOLDER_NAME_MAX);
  });
});

describe('addPlanSidebarFolder', () => {
  const layout: SidebarLayout = { pinned: ['s-pin'], folders: [folder('acme', 'Acme', ['s-old']), folder('plan', 'Plan · A', [], 'acme')], loose: ['s-new'] };

  it('makes the subfolder in the chosen folder with the session first (out of where it was)', () => {
    const next = addPlanSidebarFolder(layout, { folderId: 'p2', name: 'Plan · A', parentId: 'acme', sessionId: 's-new' });
    expect(next?.name).toBe('Plan · A (2)');
    expect(next?.layout.folders.find((f) => f.id === 'p2')).toMatchObject({ name: 'Plan · A (2)', parentId: 'acme', sessionIds: ['s-new'] });
    expect(next?.layout.loose).toEqual([]);
  });

  it('root → a top-level subfolder (the name is free there); a vanished or full parent → the top level', () => {
    expect(addPlanSidebarFolder(layout, { folderId: 'p3', name: 'Plan · A', parentId: null, sessionId: 's1' })).toMatchObject({ name: 'Plan · A', parentId: null });
    expect(addPlanSidebarFolder(layout, { folderId: 'p4', name: 'Plan · B', parentId: 'gone', sessionId: 's1' })?.parentId).toBeNull();
    const deep: SidebarLayout = { pinned: [], folders: [folder('l1', 'L1', []), folder('l2', 'L2', [], 'l1'), folder('l3', 'L3', [], 'l2'), folder('l4', 'L4', [], 'l3'), folder('l5', 'L5', [], 'l4')] };
    expect(planSidebarFolderProblem(deep, 'l5')?.kind).toBe('invalid');
    expect(planSidebarFolderProblem(deep, 'l4')).toBeNull();
    expect(planSidebarFolderProblem(deep, 'nope')?.kind).toBe('not-found');
    expect(planSidebarFolderProblem(deep, null)).toBeNull();
    expect(addPlanSidebarFolder(deep, { folderId: 'p5', name: 'Plan · C', parentId: 'l5', sessionId: 's1' })?.parentId).toBeNull();
  });
});

describe('defaultPlanSidebarFolder', () => {
  const layout: SidebarLayout = {
    pinned: ['pinned'],
    folders: [folder('acme', 'Acme', ['a1', 'a2']), folder('ops', 'Ops', ['o1', 'o2']), folder('misc', 'Misc', ['m1', 'm2', 'm3']), folder('plan', 'Plan · Old', ['p1', 'p2', 'p3'], 'acme')],
    loose: ['loose1'],
  };

  it('picks the folder with the most open sessions in that working folder (by saved folder or path)', () => {
    const sessions = [session('a1'), session('a2', { folder: null }), session('o1'), session('m1', { folder: 'other', folderPath: '/src/other' }), session('m2', { folder: 'other', folderPath: '/src/other' }), session('m3', { folder: 'other', folderPath: '/src/other' })];
    // Acme: a1 and a2 (a2 by its path); Misc's sessions run elsewhere.
    expect(defaultPlanSidebarFolder({ layout: { ...layout, folders: layout.folders.filter((f) => f.id !== 'plan') }, sessions, machine: null, workingFolder: WORK })).toBe('acme');
  });

  it('counts a plan subfolder\'s sessions for the folder it sits in, and skips closed, chats, pinned, loose and other machines', () => {
    const sessions = [
      session('a1'),
      session('o1'),
      session('o2'),
      session('p1'),
      session('p2'),
      session('m1', { closedAt: '2026-10-20T11:00:00.000Z' }),
      session('m2', { kind: 'chat' }),
      session('m3', { machine: { id: 'peer' } }),
      session('pinned'),
      session('loose1'),
    ];
    expect(defaultPlanSidebarFolder({ layout, sessions, machine: null, workingFolder: WORK })).toBe('acme');
  });

  it('a tie goes to the most recently active folder', () => {
    const sessions = [session('a1', { lastActivityAt: '2026-10-20T08:00:00.000Z' }), session('o1', { lastActivityAt: null, createdAt: '2026-10-20T12:00:00.000Z' })];
    expect(defaultPlanSidebarFolder({ layout, sessions, machine: null, workingFolder: WORK })).toBe('ops');
  });

  it('a paired machine: only its sessions count', () => {
    const sessions = [session('m1', { machine: { id: 'peer' } }), session('a1'), session('a2')];
    expect(defaultPlanSidebarFolder({ layout, sessions, machine: 'peer', workingFolder: WORK })).toBe('misc');
  });

  it('a folder too deep for one more level gives the nearest one above it', () => {
    const deep: SidebarLayout = { pinned: [], folders: [folder('l1', 'L1', []), folder('l2', 'L2', [], 'l1'), folder('l3', 'L3', [], 'l2'), folder('l4', 'L4', [], 'l3'), folder('l5', 'L5', ['a1'], 'l4')] };
    expect(defaultPlanSidebarFolder({ layout: deep, sessions: [session('a1')], machine: null, workingFolder: WORK })).toBe('l4');
  });

  it('none → the last choice while that folder exists, else the root', () => {
    expect(defaultPlanSidebarFolder({ layout, sessions: [], machine: null, workingFolder: WORK, lastChoice: 'ops' })).toBe('ops');
    expect(defaultPlanSidebarFolder({ layout, sessions: [], machine: null, workingFolder: WORK, lastChoice: 'gone' })).toBeNull();
    expect(defaultPlanSidebarFolder({ layout, sessions: [], machine: null, workingFolder: WORK, lastChoice: null })).toBeNull();
    expect(defaultPlanSidebarFolder({ layout, sessions: [], machine: null, workingFolder: WORK })).toBeNull();
    expect(defaultPlanSidebarFolder({ layout, sessions: [session('a1')], machine: null, workingFolder: null, lastChoice: 'ops' })).toBe('ops');
  });
});
