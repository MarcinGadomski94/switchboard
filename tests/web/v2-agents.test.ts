import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '../../src/core/api.ts';
import type { Plan } from '../../src/core/plans.ts';
import type { SidebarLayout } from '../../src/core/sidebar-layout.ts';
import type { TeamSummary } from '../../src/core/team.ts';
import { type AgentEntry, GROUP_BYS, askStatusOf, boardLanes, buildAgents, cellOf, chatSections, columnOf, isGroupBy, listSections, matchesQuery, offBoard, sortAgents, teammateIds, topFolderOf } from '../../src/web/v2/agents/agents-model.ts';
import { agentsOf, buildTree, canNest, checkMove, deleteSummary, drill, findFolder, flatFolders, pathOf, pickRows } from '../../src/web/v2/agents/tree-model.ts';

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
