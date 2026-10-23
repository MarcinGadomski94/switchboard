import { describe, expect, it } from 'vitest';
import { planRunFolderDefault } from '../../src/core/plan-run-folder.ts';
import { SIDEBAR_FOLDER_NAME_MAX, type SidebarFolder, type SidebarLayout, cutSidebarFolderName, placeRunInFolder, runSubfolder } from '../../src/core/sidebar-layout.ts';
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
