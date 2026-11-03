import { describe, expect, it } from 'vitest';
import { RUN_PARENT_ROOT, type RunFolderOwner, folderPathText, movedRunFolders, planRunFolderDefault, runFolderMoveBlock, runFolderMovedText, runFolderRunningText, runParentBody, runParentDefault, runParentOptions, runParentProblem } from '../../src/core/plan-run-folder.ts';
import { SIDEBAR_FOLDER_NAME_MAX, type SidebarFolder, type SidebarLayout, cutSidebarFolderName, moveFolder, placeRunInFolder, runParentFolder, runSubfolder } from '../../src/core/sidebar-layout.ts';
import { type FolderRecord, type SidebarRecords, liveFolderFor } from '../../src/core/sidebar-records.ts';

/** D130 · the plan's runs' sidebar subfolder: the Start dialog's prefill, the find-or-make rule, the run's place, the deleted-folder fallback. */

function folder(id: string, name: string, sessionIds: string[], parentId: string | null = null): SidebarFolder {
  return { id, name, collapsed: false, sessionIds, parentId };
}

const LAYOUT: SidebarLayout = {
  pinned: ['s-pin'],
  folders: [folder('acme', 'Acme', ['s-src', 's-other']), folder('epic', 'Acme epic', ['s-old-run'], 'acme'), folder('jira', 'Plan · PROJ-123 Acme checkout', ['s-owner'], 'acme')],
  loose: ['s-loose'],
};

describe('planRunFolderDefault / cutSidebarFolderName', () => {
  it('prefills the plan title, cut to 60 characters at a word break', () => {
    expect(planRunFolderDefault(LAYOUT, 's-src', '  PROJ-100 Acme checkout ')).toBe('PROJ-100 Acme checkout');
    const long = planRunFolderDefault(LAYOUT, 's-src', 'PROJ-100 Acme checkout with a very long summary that goes on and on');
    expect(long).toBe('PROJ-100 Acme checkout with a very long summary that goes…');
    expect(long.length).toBeLessThanOrEqual(SIDEBAR_FOLDER_NAME_MAX);
    expect(cutSidebarFolderName('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
  });

  it('a source inside a D119 "Plan · …" subfolder prefills that folder\'s name', () => {
    expect(planRunFolderDefault(LAYOUT, 's-owner', 'PROJ-123 Acme checkout')).toBe('Plan · PROJ-123 Acme checkout');
    // Any other folder of the source does not count.
    expect(planRunFolderDefault(LAYOUT, 's-old-run', 'Other')).toBe('Other');
  });
});

describe('runSubfolder', () => {
  it('makes a new folder at the end of the source\'s folder; the source stays', () => {
    const sub = runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Second epic', newId: 'new' });
    expect(sub).toMatchObject({ ok: true, folderId: 'new', name: 'Second epic', parentId: 'acme' });
    if (!sub.ok || !sub.layout) throw new Error('no layout');
    expect(sub.layout.folders.find((f) => f.id === 'new')).toMatchObject({ parentId: 'acme', sessionIds: [] });
    expect(sub.layout.folders.find((f) => f.id === 'acme')?.sessionIds).toEqual(['s-src', 's-other']);
  });

  it('reuses a folder with the exact name at that level (case matters)', () => {
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Acme epic', newId: 'new' })).toEqual({ ok: true, folderId: 'epic', name: 'Acme epic', parentId: 'acme', layout: null });
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'acme epic', newId: 'new' })).toMatchObject({ ok: true, folderId: 'new' });
  });

  it('a source in a D119 subfolder named so: that folder itself, no second one nested', () => {
    expect(runSubfolder(LAYOUT, { sourceId: 's-owner', name: 'Plan · PROJ-123 Acme checkout', newId: 'new' })).toEqual({ ok: true, folderId: 'jira', name: 'Plan · PROJ-123 Acme checkout', parentId: 'acme', layout: null });
  });

  it('a loose, pinned or unknown source: the top level', () => {
    for (const sourceId of ['s-loose', 's-pin', 's-unknown']) expect(runSubfolder(LAYOUT, { sourceId, name: 'Acme epic', newId: 'new' })).toMatchObject({ ok: true, folderId: 'new', parentId: null });
    expect(runSubfolder(LAYOUT, { sourceId: 's-loose', name: 'Acme', newId: 'new' })).toMatchObject({ ok: true, folderId: 'acme', layout: null });
  });

  it('refuses when the source\'s folder is five levels deep; a reusable folder there is still fine', () => {
    const deep: SidebarLayout = { pinned: [], folders: [folder('l1', 'L1', []), folder('l2', 'L2', [], 'l1'), folder('l3', 'L3', [], 'l2'), folder('l4', 'L4', [], 'l3'), folder('l5', 'Plan · X', ['s-deep'], 'l4')], loose: [] };
    const refused = runSubfolder(deep, { sourceId: 's-deep', name: 'Acme epic', newId: 'new' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('5 levels');
    expect(runSubfolder(deep, { sourceId: 's-deep', name: 'Plan · X', newId: 'new' })).toMatchObject({ ok: true, folderId: 'l5' });
  });
});

describe('D150 · runSubfolder in a chosen parent', () => {
  const deep: SidebarLayout = { pinned: [], folders: [folder('l1', 'L1', ['s-top']), folder('l2', 'L2', [], 'l1'), folder('l3', 'L3', [], 'l2'), folder('l4', 'L4', [], 'l3'), folder('l5', 'L5', ['s-deep'], 'l4')], loose: [] };

  it('the top level: a new top-level folder, or the top-level one with that exact name reused', () => {
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Second epic', newId: 'new', parentId: null })).toMatchObject({ ok: true, folderId: 'new', parentId: null });
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Acme', newId: 'new', parentId: null })).toEqual({ ok: true, folderId: 'acme', name: 'Acme', parentId: null, layout: null });
  });

  it('a nested folder: made inside it (all levels), the name reused only within that parent', () => {
    const made = runSubfolder(LAYOUT, { sourceId: 's-loose', name: 'Acme epic', newId: 'new', parentId: 'jira' });
    expect(made).toMatchObject({ ok: true, folderId: 'new', parentId: 'jira' });
    if (!made.ok || !made.layout) throw new Error('no layout');
    expect(made.layout.folders.find((f) => f.id === 'new')).toMatchObject({ parentId: 'jira', sessionIds: [] });
    // "Acme epic" sits in Acme: reused there, not in Plan · …
    expect(runSubfolder(LAYOUT, { sourceId: 's-loose', name: 'Acme epic', newId: 'new', parentId: 'acme' })).toMatchObject({ ok: true, folderId: 'epic', layout: null });
  });

  it('the D119 own-name rule only when the parent is the source\'s folder', () => {
    // Parent = the source's folder (given explicitly): the folder itself.
    expect(runSubfolder(LAYOUT, { sourceId: 's-owner', name: 'Plan · PROJ-123 Acme checkout', newId: 'new', parentId: 'jira' })).toMatchObject({ ok: true, folderId: 'jira', layout: null });
    // Another parent: a folder of that name inside it.
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Plan · PROJ-123 Acme checkout', newId: 'new', parentId: 'jira' })).toMatchObject({ ok: true, folderId: 'new', parentId: 'jira' });
  });

  it('refuses an unknown folder and one five levels deep, on sidebarParent', () => {
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'X', newId: 'new', parentId: 'gone' })).toMatchObject({ ok: false, field: 'sidebarParent' });
    const refused = runSubfolder(deep, { sourceId: 's-top', name: 'X', newId: 'new', parentId: 'l5' });
    expect(refused).toMatchObject({ ok: false, field: 'sidebarParent' });
    if (!refused.ok) expect(refused.message).toContain('5 levels');
    // The default (the source's folder) keeps D130's field.
    expect(runSubfolder(deep, { sourceId: 's-deep', name: 'X', newId: 'new' })).toMatchObject({ ok: false, field: 'sidebarFolder' });
  });

  it('absent = the source\'s folder, unchanged', () => {
    expect(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Second epic', newId: 'new' })).toEqual(runSubfolder(LAYOUT, { sourceId: 's-src', name: 'Second epic', newId: 'new', parentId: 'acme' }));
  });
});

describe('D150 · runParentFolder (no subfolder name)', () => {
  it('the source\'s folder or absent: none (next to the source); another folder: that folder', () => {
    expect(runParentFolder(LAYOUT, { sourceId: 's-src' })).toEqual({ ok: true, folder: null });
    expect(runParentFolder(LAYOUT, { sourceId: 's-src', parentId: 'acme' })).toEqual({ ok: true, folder: null });
    expect(runParentFolder(LAYOUT, { sourceId: 's-loose', parentId: null })).toEqual({ ok: true, folder: null });
    expect(runParentFolder(LAYOUT, { sourceId: 's-src', parentId: 'jira' })).toEqual({ ok: true, folder: { id: 'jira', name: 'Plan · PROJ-123 Acme checkout' } });
  });

  it('refuses the top level for a source in a folder, and an unknown folder', () => {
    expect(runParentFolder(LAYOUT, { sourceId: 's-src', parentId: null })).toMatchObject({ ok: false, field: 'sidebarParent' });
    expect(runParentFolder(LAYOUT, { sourceId: 's-src', parentId: 'gone' })).toMatchObject({ ok: false, field: 'sidebarParent' });
  });
});

describe('D150 · the Start dialog\'s parent picker', () => {
  it('lists Top level, then every folder in tree order, indented by level; defaults to the source\'s folder', () => {
    expect(runParentOptions(LAYOUT).map((o) => [o.value, o.label, o.depth])).toEqual([
      [RUN_PARENT_ROOT, 'Top level', 0],
      ['acme', 'Acme', 1],
      ['epic', '\u00a0\u00a0\u00a0Acme epic', 2],
      ['jira', '\u00a0\u00a0\u00a0Plan · PROJ-123 Acme checkout', 2],
    ]);
    expect(runParentDefault(LAYOUT, 's-owner')).toBe('jira');
    expect(runParentDefault(LAYOUT, 's-loose')).toBe(RUN_PARENT_ROOT);
    expect(runParentDefault(LAYOUT, 's-pin')).toBe(RUN_PARENT_ROOT);
  });

  it('the body: nothing when not picked (older servers unchanged), null for the top level, else the id', () => {
    expect(runParentBody(null)).toEqual({});
    expect(runParentBody(RUN_PARENT_ROOT)).toEqual({ sidebarParent: null });
    expect(runParentBody('epic')).toEqual({ sidebarParent: 'epic' });
  });

  it('says why Start would refuse, with the server\'s rules', () => {
    const deep: SidebarLayout = { pinned: [], folders: [folder('l1', 'L1', ['s-top']), folder('l2', 'L2', [], 'l1'), folder('l3', 'L3', [], 'l2'), folder('l4', 'L4', [], 'l3'), folder('l5', 'L5', [], 'l4')], loose: [] };
    expect(runParentProblem(LAYOUT, { sourceSessionId: 's-src', parent: 'epic', name: 'New' })).toBeNull();
    expect(runParentProblem(LAYOUT, { sourceSessionId: 's-src', parent: 'epic', name: '' })).toBeNull();
    expect(runParentProblem(LAYOUT, { sourceSessionId: 's-src', parent: RUN_PARENT_ROOT, name: '' })).toContain('top level');
    expect(runParentProblem(LAYOUT, { sourceSessionId: 's-src', parent: 'gone', name: 'X' })).toContain('gone');
    expect(runParentProblem(deep, { sourceSessionId: 's-top', parent: 'l5', name: 'X' })).toContain('5 levels');
    expect(runParentProblem(deep, { sourceSessionId: 's-top', parent: 'l5', name: '' })).toBeNull();
  });
});

describe('placeRunInFolder', () => {
  it('appends the run (later runs after earlier ones); a placed run or a missing folder changes nothing', () => {
    const once = placeRunInFolder(LAYOUT, 's-run', 'epic');
    expect(once?.folders.find((f) => f.id === 'epic')?.sessionIds).toEqual(['s-old-run', 's-run']);
    expect(placeRunInFolder(once as SidebarLayout, 's-run', 'acme')).toBeNull();
    expect(placeRunInFolder(LAYOUT, 's-new', 'gone')).toBeNull();
  });
});

describe('liveFolderFor', () => {
  const record = (id: string, parentId: string | null, deleted = false): FolderRecord => ({ id, name: id, nameClock: 'c', parentId, order: 'a', placeClock: 'c', deletedClock: deleted ? 'd' : null, collapsed: false });
  const records: SidebarRecords = { folders: [record('acme', null), record('releases', 'acme', true), record('epic', 'releases', true), record('top', null, true)], places: [] };

  it('a live folder is itself; a deleted one its nearest live folder above, else none; an unknown one unknown', () => {
    expect(liveFolderFor(records, 'acme')).toEqual({ known: true, folderId: 'acme' });
    expect(liveFolderFor(records, 'epic')).toEqual({ known: true, folderId: 'acme' });
    expect(liveFolderFor(records, 'top')).toEqual({ known: true, folderId: null });
    expect(liveFolderFor(records, 'peer-only')).toEqual({ known: false });
  });
});

describe('D151 · moving a project\'s runs folder', () => {
  const owner = (state: RunFolderOwner['state'], folderId = 'epic'): RunFolderOwner => ({ planId: 'p1', title: 'Acme epic', state, folderId });
  const other: SidebarLayout = { ...LAYOUT, folders: [...LAYOUT.folders, folder('other', 'Other', [])] };
  const moved = (id: string, index: number, parentId?: string | null): SidebarLayout => moveFolder(other, id, index, parentId) as SidebarLayout;

  it('a running project holds its runs folder and every folder holding it; a re-order or the present parent is no move', () => {
    const running = [owner('running')];
    expect(runFolderMoveBlock(other, 'epic', 'other', running)).toEqual(owner('running'));
    expect(runFolderMoveBlock(other, 'epic', null, running)).toEqual(owner('running'));
    // Acme holds the runs folder: moving it moves the runs folder too.
    expect(runFolderMoveBlock(other, 'acme', 'other', running)).toEqual(owner('running'));
    // No place changes.
    expect(runFolderMoveBlock(other, 'epic', undefined, running)).toBeNull();
    expect(runFolderMoveBlock(other, 'epic', 'acme', running)).toBeNull();
    // Another folder (a sibling, or one going into the runs folder) is free.
    expect(runFolderMoveBlock(other, 'jira', 'other', running)).toBeNull();
    expect(runFolderMoveBlock(other, 'other', 'epic', running)).toBeNull();
    expect(runFolderMoveBlock(other, 'missing', 'other', running)).toBeNull();
  });

  it('paused, done, cancelled and draft projects hold nothing', () => {
    for (const state of ['paused', 'done', 'cancelled', 'draft'] as const) expect(runFolderMoveBlock(other, 'epic', 'other', [owner(state)])).toBeNull();
  });

  it('says why, with the project\'s title', () => {
    expect(runFolderRunningText('Acme epic')).toBe('The project “Acme epic” is running: pause it to move its folder.');
  });

  it('the path and the projects whose runs folder moved', () => {
    expect(folderPathText(other, 'epic')).toBe('Acme › Acme epic');
    expect(folderPathText(other, 'missing')).toBe('');
    const owners = [owner('paused'), owner('done', 'jira'), owner('cancelled', 'other')];
    const intoOther = moved('epic', 0, 'other');
    expect(movedRunFolders(other, intoOther, owners)).toEqual([{ planId: 'p1', path: 'Other › Acme epic' }]);
    // A folder holding two runs folders: both moved.
    const acmeIn = moved('acme', 0, 'other');
    expect(movedRunFolders(other, acmeIn, owners).map((m) => m.path)).toEqual(['Other › Acme › Acme epic', 'Other › Acme › Plan · PROJ-123 Acme checkout']);
    // A re-order changes no path.
    expect(movedRunFolders(other, moved('jira', 0), owners)).toEqual([]);
    expect(runFolderMovedText('Other › Acme epic')).toBe('Runs folder moved to Other › Acme epic');
  });
});
