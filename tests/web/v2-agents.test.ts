import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../../src/core/api.ts';
import type { Plan } from '../../src/core/plans.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import type { TeamSummary } from '../../src/core/team.ts';
import { type AgentEntry, GROUP_BYS, askStatusOf, boardLanes, buildAgents, cellOf, chatSections, columnOf, isGroupBy, listSections, matchesQuery, offBoard, openTeammateIds, sortAgents, teammateIds, topFolderOf } from '../../src/web/v2/agents/agents-model.ts';
import { type RunFolderOwner, runFolderOwners } from '../../src/core/plan-run-folder.ts';
import { agentsOf, buildTree, canNest, checkFolderMove, checkMove, deleteSummary, drill, findFolder, flatFolders, folderPickRows, pathOf, pickRows } from '../../src/web/v2/agents/tree-model.ts';

/** D131 · lane A · the Agents page's pure model: agents, sorting, the Board's columns and swimlanes, the folder tree and the move rules. */

function session(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return { id, name: id, status: 'idle', lastActivityAt: '2026-10-25T10:00:00.000Z', closedAt: null, kind: 'session', machine: null, ownedLoops: [], ...over } as unknown as SessionListItem;
}

const teams: TeamSummary[] = [{ id: 't1', name: 'Mobile', order: 0, members: 1, needsYou: 0, roster: [{ id: 'm1', name: 'QA', status: 'idle', sessionRef: 'mate', machineName: 'mac', local: true, current: null, turnStartedAt: null, lastActivityAt: null }] }];
const plans = [{ id: 'p1', title: 'PROJ-100 Checkout v2', items: [{ id: 'i1', state: 'running', runSessionId: 'step' }, { id: 'i2', state: 'done', runSessionId: null }] }] as unknown as Plan[];

const sessions = [
  session('a', { status: 'run', lastActivityAt: '2026-10-25T10:05:00.000Z' }),
  session('b', { status: 'need' }),
  session('c', { status: 'done' }),
  session('chat', { kind: 'chat' }),
  session('loop', { ownedLoops: [{ state: 'active' }] as never }),
  session('mate'),
  session('step', { status: 'run' }),
  session('closed', { closedAt: '2026-10-24T10:00:00.000Z' }),
  session('r~peer~x', { machine: { id: 'peer', name: 'Studio-PC', state: 'offline' } as never }),
];

const agents = buildAgents({ sessions, needs: [{ key: 'inbox:1', kind: 'question', title: 'Which env?', agent: { sessionId: 'b' } }, { key: 'inbox:2', kind: 'ready', title: 'Ready', agent: { sessionId: 'c' } }], teams, plans });
const byId = (id: string): AgentEntry => agents.find((agent) => agent.id === id) as AgentEntry;

describe('buildAgents', () => {
  it('leaves closed agents and teammates out and tells the kinds apart', () => {
    expect(agents.map((a) => a.id)).not.toContain('closed');
    // Fix after 2.0: a teammate is the Crews pages', not an agent of the Agents page.
    expect(agents.map((a) => a.id)).not.toContain('mate');
    expect(teammateIds(teams)).toEqual(new Set(['mate']));
    expect(byId('chat').kind).toBe('conv');
    expect(byId('loop').kind).toBe('routine');
    expect(byId('step').kind).toBe('step');
    expect(byId('step').plan?.title).toBe('PROJ-100 Checkout v2');
    expect(byId('a').kind).toBe('agent');
  });
  it('2026-10-27 (D137 follow-up): Archived lists an archived teammate (to restore it), never an open one', () => {
    const crews = [{ roster: [{ sessionRef: 'mate', archived: false }, { sessionRef: 'gone', archived: true }, { sessionRef: 'old' }] }] as never;
    expect(openTeammateIds(crews)).toEqual(new Set(['mate', 'old']));
    expect(teammateIds(crews)).toEqual(new Set(['mate', 'gone', 'old']));
  });
  it('takes the status from open items first', () => {
    expect(byId('b').status).toBe('needs');
    expect(byId('c').status).toBe('ready');
    expect(byId('a').status).toBe('working');
    expect(askStatusOf([{ kind: 'stopped' }])).toBe('stopped');
    expect(askStatusOf([{ kind: 'stopped' }, { kind: 'question' }])).toBe('needs');
    expect(askStatusOf([])).toBeNull();
  });
  it('marks a paired computer and unread activity', () => {
    expect(byId('r~peer~x').computer).toEqual({ id: 'peer', name: 'Studio-PC', state: 'offline' });
    const seen = buildAgents({ sessions: [session('x', { lastActivityAt: '2026-10-25T10:00:00.000Z' })], needs: [], teams: [], plans: [], seen: { x: '2026-10-25T09:00:00.000Z' } });
    expect(seen[0]?.unread).toBe(true);
    const fresh = buildAgents({ sessions: [session('x')], needs: [], teams: [], plans: [], baseline: '2026-10-25T11:00:00.000Z' });
    expect(fresh[0]?.unread).toBe(false);
  });
});

describe('sorting and sections', () => {
  it('puts the ones that need you first, then by status', () => {
    const order = sortAgents(agents).map((a) => a.id);
    expect(order.slice(0, 2)).toEqual(['b', 'c']);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('chat'));
  });
  it('lists every agent in one section, no crew sections', () => {
    const sections = listSections(agents);
    expect(sections.map((s) => s.id)).toEqual(['plain']);
    expect(sections[0]?.items.map((a) => a.id)).not.toContain('mate');
    expect(sections[0]?.items).toHaveLength(agents.length);
    expect(listSections([])).toEqual([]);
  });
  it('floats the chats that need you to the top, no crew sections', () => {
    const sections = chatSections(agents);
    expect(sections.map((s) => s.kind)).toEqual(['needs', 'plain']);
    expect(sections[0]?.items.map((a) => a.id)).toEqual(['b', 'c']);
    expect(sections.flatMap((s) => s.items.map((a) => a.id))).not.toContain('mate');
  });
});

const layout: SidebarLayout = {
  pinned: ['a'],
  folders: [
    { id: 'f1', name: 'Checkout', collapsed: true, sessionIds: ['b'], parentId: null },
    { id: 'f2', name: 'Payments', collapsed: false, sessionIds: ['c'], parentId: 'f1' },
    { id: 'f3', name: 'Plan · PROJ-100 Checkout v2', collapsed: false, sessionIds: ['step'], parentId: null },
  ],
  loose: [],
};

describe('Board', () => {
  it('maps statuses onto the four columns', () => {
    expect(columnOf('stopped')).toBe('needs');
    expect(columnOf('queued')).toBe('working');
    expect(columnOf('ready')).toBe('ready');
    expect(columnOf('done')).toBe('done');
    expect(columnOf('idle')).toBeNull();
    expect(offBoard(agents).map((a) => a.id)).toContain('chat');
  });
  it('groups by project: each project, then the agents (no crew lanes)', () => {
    const lanes = boardLanes(agents, 'project', { plans, layout });
    expect(lanes.map((l) => l.id)).toEqual(['plan:p1', 'agents']);
    expect(lanes[0]?.plan).toEqual({ id: 'p1', done: 1, total: 2 });
    expect(cellOf(lanes[0] as never, 'working').map((a) => a.id)).toEqual(['step']);
  });
  it('groups by project or top folder only (no Crew grouping)', () => {
    expect(GROUP_BYS).toEqual(['project', 'folder']);
    expect(isGroupBy('crew')).toBe(false);
    const byFolder = boardLanes(agents, 'folder', { plans, layout });
    expect(byFolder.map((l) => l.id)).toEqual(['fold:pinned', 'fold:f1', 'fold:f3']);
    expect(byFolder[1]?.items.map((a) => a.id).sort()).toEqual(['b', 'c']);
    expect(topFolderOf(layout, 'c')).toBe('f1');
    expect(topFolderOf(layout, 'a')).toBe('pinned');
    expect(topFolderOf(layout, 'zzz')).toBeNull();
  });
});

describe('folder tree', () => {
  const tree = buildTree(layout, agents);
  it('nests folders with counts and needs', () => {
    expect(tree.pinned.map((a) => a.id)).toEqual(['a']);
    expect(tree.folders.map((f) => f.name)).toEqual(['Checkout', 'Plan · PROJ-100 Checkout v2']);
    const checkout = tree.folders[0];
    expect(checkout?.count).toBe(2);
    expect(checkout?.needs).toBe(2);
    expect(checkout?.collapsed).toBe(true);
    expect(tree.folders[1]?.plan).toBe(true);
    expect(flatFolders(tree).map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(pathOf(tree, 'f2').map((f) => f.name)).toEqual(['Checkout', 'Payments']);
    expect(findFolder(tree, 'f2')?.level).toBe(2);
  });
  it('lists loose agents and selections, without crews or teammates', () => {
    expect('crews' in tree).toBe(false);
    expect(tree.loose.map((a) => a.id)).not.toContain('mate');
    expect(tree.all).toBe(agents.length);
    // A pinned or filed teammate is left out of the tree and its counts too.
    const filed = buildTree({ ...layout, pinned: ['a', 'mate'], folders: layout.folders.map((f) => (f.id === 'f1' ? { ...f, sessionIds: ['b', 'mate'] } : f)) }, agents);
    expect(filed.pinned.map((a) => a.id)).toEqual(['a']);
    expect(filed.folders[0]?.count).toBe(2);
    expect(tree.loose.map((a) => a.id)).toContain('chat');
    expect(agentsOf('folder:f1', tree, agents).map((a) => a.id).sort()).toEqual(['b', 'c']);
    expect(agentsOf('needs', tree, agents).map((a) => a.id).sort()).toEqual(['b', 'c']);
  });
  it('applies the move rules', () => {
    expect(checkMove(byId('chat'), { kind: 'folder', folderId: 'f2' }, layout, tree)).toEqual({ ok: true, via: 'place' });
    expect(checkMove(byId('b'), { kind: 'folder', folderId: 'f1' }, layout, tree).ok).toBe(false);
    expect(checkMove(byId('chat'), { kind: 'folder', folderId: 'f3' }, layout, tree).ok).toBe(false);
    expect(checkMove(byId('step'), { kind: 'loose' }, layout, tree).ok).toBe(false);
    expect(checkMove(byId('chat'), { kind: 'loose' }, layout, tree).ok).toBe(false);
  });
  it('builds the Move-to-folder list', () => {
    const rows = pickRows(byId('chat'), layout, tree);
    expect(rows.map((r) => [r.value, r.depth])).toEqual([
      ['loose', 0],
      ['f1', 0],
      ['f2', 1],
      ['f3', 0],
    ]);
    expect(rows[0]?.current).toBe(true);
    expect(rows[3]?.disabled).toBe('project steps only');
  });
  it('limits nesting, describes a delete and drills down', () => {
    expect(canNest({ level: 4, plan: false })).toBe(true);
    expect(canNest({ level: 5, plan: false })).toBe(false);
    expect(deleteSummary(findFolder(tree, 'f1') as never, null)).toBe('No agents are deleted. The 1 agent inside moves to Not in a folder, along with 1 subfolder.');
    const level = drill(tree, ['f1', 'f2']);
    expect(level.crumbs.map((f) => f.name)).toEqual(['Checkout', 'Payments']);
    expect(level.agents.map((a) => a.id)).toEqual(['c']);
    expect(drill(tree, ['nope']).folder).toBeNull();
  });
  it('searches closed agents by every word', () => {
    expect(matchesQuery('Fix flaky payment test · Studio-PC', 'payment studio')).toBe(true);
    expect(matchesQuery('Fix flaky payment test', 'coupon')).toBe(false);
  });
});

describe('moving a folder (2.4.16)', () => {
  const folder = (id: string, parentId: string | null): SidebarLayout['folders'][number] => ({ id, name: id.toUpperCase(), collapsed: false, sessionIds: [], parentId });
  // A > B > C (3 levels), D > E > F > G (4 levels), H at the top.
  const nested: SidebarLayout = { pinned: [], loose: [], folders: [folder('a', null), folder('b', 'a'), folder('c', 'b'), folder('d', null), folder('e', 'd'), folder('f', 'e'), folder('g', 'f'), folder('h', null)] };
  const nestedTree = buildTree(nested, []);
  it('takes another folder or the top level', () => {
    expect(checkFolderMove(nested, 'h', 'a')).toEqual({ ok: true });
    expect(checkFolderMove(nested, 'c', null)).toEqual({ ok: true });
    expect(checkFolderMove(nested, 'b', 'h')).toEqual({ ok: true });
  });
  it('refuses itself, its own subfolders and its present place, with the reason', () => {
    expect(checkFolderMove(nested, 'a', 'a')).toEqual({ ok: false, reason: 'A folder can’t go inside itself.' });
    expect(checkFolderMove(nested, 'a', 'b')).toEqual({ ok: false, reason: 'A folder can’t go inside one of its own subfolders.' });
    expect(checkFolderMove(nested, 'a', 'c')).toEqual({ ok: false, reason: 'A folder can’t go inside one of its own subfolders.' });
    // D151: its present place is `unchanged` (a drop or a pick there does nothing, silently).
    expect(checkFolderMove(nested, 'b', 'a')).toEqual({ ok: false, reason: 'B is already there.', unchanged: true });
    expect(checkFolderMove(nested, 'h', null)).toEqual({ ok: false, reason: 'H is already there.', unchanged: true });
    expect(checkFolderMove(nested, 'nope', null)).toEqual({ ok: false, reason: 'That folder no longer exists.' });
    expect(checkFolderMove(nested, 'h', 'nope')).toEqual({ ok: false, reason: 'That folder no longer exists.' });
  });
  it('refuses a place where its deepest subfolder would pass 5 levels (D58)', () => {
    // A spans 3 levels: under G (level 4) it would reach 7, under F (level 3) 6; under E (level 2) 5 is fine.
    expect(checkFolderMove(nested, 'a', 'g')).toEqual({ ok: false, reason: 'Folders nest up to 5 levels.' });
    expect(checkFolderMove(nested, 'a', 'f')).toEqual({ ok: false, reason: 'Folders nest up to 5 levels.' });
    expect(checkFolderMove(nested, 'a', 'e')).toEqual({ ok: true });
    expect(checkFolderMove(nested, 'a', 'd')).toEqual({ ok: true });
    expect(checkFolderMove(nested, 'h', 'g')).toEqual({ ok: true });
  });
  it('builds the Move-folder list: Top level and the tree, the bad places disabled with the reason', () => {
    const rows = folderPickRows(nested, nestedTree, 'b');
    expect(rows.map((r) => [r.value, r.label, r.depth])).toEqual([
      ['loose', 'Top level', 0],
      ['a', 'A', 0],
      ['b', 'B', 1],
      ['c', 'C', 2],
      ['d', 'D', 0],
      ['e', 'E', 1],
      ['f', 'F', 2],
      ['g', 'G', 3],
      ['h', 'H', 0],
    ]);
    const by = new Map(rows.map((r) => [r.value, r]));
    // Its parent is picked at first and not disabled ("already there" when moved there).
    expect(by.get('a')).toMatchObject({ current: true, disabled: null });
    expect(by.get('loose')).toMatchObject({ current: false, disabled: null });
    expect(by.get('b')?.disabled).toBe('A folder can’t go inside itself.');
    expect(by.get('c')?.disabled).toBe('A folder can’t go inside one of its own subfolders.');
    // B spans 2 levels: under F (level 3) it reaches 5, under G (level 4) 6.
    expect(by.get('f')?.disabled).toBeNull();
    expect(by.get('g')?.disabled).toBe('Folders nest up to 5 levels.');
    expect(by.get('h')?.disabled).toBeNull();
    // A top-level folder: Top level is its present place.
    expect(folderPickRows(nested, nestedTree, 'h')[0]).toMatchObject({ value: 'loose', current: true, disabled: null });
  });

  describe('D151 · a project\'s runs folder', () => {
    const running = (folderId: string, state: RunFolderOwner['state'] = 'running'): RunFolderOwner[] => [{ planId: 'p1', title: 'Acme epic', state, folderId }];
    const why = 'The project “Acme epic” is running: pause it to move its folder.';
    it('a running project\'s runs folder, and a folder holding it, stay where they are, with the reason', () => {
      expect(checkFolderMove(nested, 'c', null, running('c'))).toEqual({ ok: false, reason: why });
      expect(checkFolderMove(nested, 'c', 'h', running('c'))).toEqual({ ok: false, reason: why });
      // A holds C: moving A moves C.
      expect(checkFolderMove(nested, 'a', 'h', running('c'))).toEqual({ ok: false, reason: why });
      // Its present place stays unchanged (no toast), and another folder may go into it.
      expect(checkFolderMove(nested, 'c', 'b', running('c'))).toEqual({ ok: false, reason: 'C is already there.', unchanged: true });
      expect(checkFolderMove(nested, 'h', 'c', running('c'))).toEqual({ ok: true });
    });
    it('paused, done, cancelled and draft projects do not hold their folder', () => {
      for (const state of ['paused', 'done', 'cancelled', 'draft'] as const) expect(checkFolderMove(nested, 'c', 'h', running('c', state))).toEqual({ ok: true });
    });
    it('the Move-folder list disables every other place with the reason; its present place stays pickable', () => {
      const by = new Map(folderPickRows(nested, nestedTree, 'c', running('c')).map((r) => [r.value, r]));
      expect(by.get('b')).toMatchObject({ current: true, disabled: null });
      for (const value of ['loose', 'a', 'd', 'e', 'h']) expect(by.get(value)?.disabled).toBe(why);
    });
    it('reads the owners from the plans (only those with a runs folder)', () => {
      expect(runFolderOwners([{ id: 'p1', title: 'Acme epic', state: 'running', sidebarFolder: { id: 'c', name: 'C' } }, { id: 'p2', title: 'Other', state: 'draft', sidebarFolder: null }, { id: 'p3', title: 'Old', state: 'done' }])).toEqual(running('c'));
    });
  });
});
