import { SIDEBAR_FOLDER_DEPTH_MAX, type SidebarFolder, type SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { type AgentEntry, isPlanFolderName, needy } from './agents-model.ts';

/**
 * D131 · lane A · the folder tree left of Agents (pure; unit-tested): the shared
 * sidebar layout (D54 pins and folders, D58 subfolders up to
 * {@link SIDEBAR_FOLDER_DEPTH_MAX} levels, D71 order and sharing with paired
 * computers) read as the v2 tree — Pinned, the folders with their subfolders
 * (project subfolders "Plan · …" marked), the Crews (each crew's teammates), the
 * agents in no folder — with counts and Needs-you badges, plus the rules for
 * moving an agent. The classic sidebar reads the same layout, so both themes
 * show the same organisation.
 */

/** A folder of the tree with what it holds. */
export interface TreeFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** 1 = top level. */
  readonly level: number;
  readonly collapsed: boolean;
  /** A project's own subfolder ("Plan · …"). */
  readonly plan: boolean;
  readonly children: readonly TreeFolder[];
  /** The agents directly in it, in the dragged order. */
  readonly agents: readonly AgentEntry[];
  /** Agents in it and its subfolders. */
  readonly count: number;
  /** Of those, the ones that need you. */
  readonly needs: number;
}

/** A crew in the tree: its teammates. */
export interface TreeCrew {
  readonly id: string;
  readonly name: string;
  readonly members: readonly AgentEntry[];
  readonly needs: number;
}

/** The whole tree. */
export interface AgentTree {
  readonly pinned: readonly AgentEntry[];
  readonly folders: readonly TreeFolder[];
  readonly crews: readonly TreeCrew[];
  /** In no folder (and not pinned, not a teammate). */
  readonly loose: readonly AgentEntry[];
  readonly all: number;
  readonly needs: number;
}

/** Builds the tree from the layout, the agents and the crews. */
export function buildTree(layout: SidebarLayout, agents: readonly AgentEntry[], teams: readonly Pick<TeamSummary, 'id' | 'name'>[]): AgentTree {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const placed = new Set<string>();
  const pinned = layout.pinned.map((id) => byId.get(id)).filter((agent): agent is AgentEntry => agent !== undefined);
  for (const agent of pinned) placed.add(agent.id);
  for (const folder of layout.folders) for (const id of folder.sessionIds) placed.add(id);
  const kids = new Map<string | null, SidebarFolder[]>();
  for (const folder of layout.folders) {
    const parent = folder.parentId ?? null;
    const list = kids.get(parent) ?? [];
    list.push(folder);
    kids.set(parent, list);
  }
  const build = (folder: SidebarFolder, level: number): TreeFolder => {
    const children = level < 16 ? (kids.get(folder.id) ?? []).map((child) => build(child, level + 1)) : [];
    const own = folder.sessionIds.map((id) => byId.get(id)).filter((agent): agent is AgentEntry => agent !== undefined);
    return {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId ?? null,
      level,
      collapsed: folder.collapsed,
      plan: isPlanFolderName(folder.name),
      children,
      agents: own,
      count: own.length + children.reduce((sum, child) => sum + child.count, 0),
      needs: own.filter(needy).length + children.reduce((sum, child) => sum + child.needs, 0),
    };
  };
  const folders = (kids.get(null) ?? []).map((folder) => build(folder, 1));
  const crewIds = new Set(teams.map((team) => team.id));
  const crewList = teams.map((team) => ({ id: team.id, name: team.name }));
  for (const agent of agents) if (agent.crew && !crewIds.has(agent.crew.id)) {
    crewIds.add(agent.crew.id);
    crewList.push({ id: agent.crew.id, name: agent.crew.name });
  }
  const crews = crewList.map((crew) => {
    const members = agents.filter((agent) => agent.kind === 'mate' && agent.crew?.id === crew.id);
    return { id: crew.id, name: crew.name, members, needs: members.filter(needy).length };
  });
  const loose = agents.filter((agent) => !placed.has(agent.id) && agent.kind !== 'mate');
  return { pinned, folders, crews, loose, all: agents.length, needs: agents.filter(needy).length };
}

/** Every folder of the tree, depth first (each followed by its subfolders). */
export function flatFolders(tree: Pick<AgentTree, 'folders'>): TreeFolder[] {
  const out: TreeFolder[] = [];
  const walk = (list: readonly TreeFolder[]): void => {
    for (const folder of list) {
      out.push(folder);
      walk(folder.children);
    }
  };
  walk(tree.folders);
  return out;
}

/** The folder `id`, or `null`. */
export function findFolder(tree: Pick<AgentTree, 'folders'>, id: string): TreeFolder | null {
  return flatFolders(tree).find((folder) => folder.id === id) ?? null;
}

/** The folders from the top level down to `id` (empty for an unknown id). */
export function pathOf(tree: Pick<AgentTree, 'folders'>, id: string): TreeFolder[] {
  const all = new Map(flatFolders(tree).map((folder) => [folder.id, folder]));
  const out: TreeFolder[] = [];
  let folder = all.get(id);
  for (let guard = 0; folder && guard < 32; guard += 1) {
    out.unshift(folder);
    folder = folder.parentId ? all.get(folder.parentId) : undefined;
  }
  return out;
}

/** Every agent in `folder` and its subfolders. */
export function agentsUnder(folder: TreeFolder): AgentEntry[] {
  return [...folder.agents, ...folder.children.flatMap(agentsUnder)];
}

/** What the page lists: a smart group, a folder, a crew, the loose agents or the drafts. */
export type Selection = 'all' | 'needs' | 'pinned' | 'loose' | 'drafts' | `folder:${string}` | `crew:${string}`;

/** The agents a selection lists. */
export function agentsOf(selection: Selection, tree: AgentTree, agents: readonly AgentEntry[]): AgentEntry[] {
  if (selection === 'all' || selection === 'drafts') return [...agents];
  if (selection === 'needs') return agents.filter(needy);
  if (selection === 'pinned') return [...tree.pinned];
  if (selection === 'loose') return [...tree.loose];
  if (selection.startsWith('crew:')) return [...(tree.crews.find((crew) => `crew:${crew.id}` === selection)?.members ?? [])];
  const folder = findFolder(tree, selection.slice('folder:'.length));
  return folder ? agentsUnder(folder) : [];
}

/** `true` while the selection still exists (a deleted folder or crew falls back to All agents). */
export function selectionExists(selection: Selection, tree: AgentTree): boolean {
  if (selection.startsWith('folder:')) return findFolder(tree, selection.slice('folder:'.length)) !== null;
  if (selection.startsWith('crew:')) return tree.crews.some((crew) => `crew:${crew.id}` === selection);
  return true;
}

// ── Moving ───────────────────────────────────────────────────────────

/** Where an agent can be moved. */
export type MoveTarget = { readonly kind: 'folder'; readonly folderId: string } | { readonly kind: 'loose' } | { readonly kind: 'crew'; readonly crewId: string };

/** What a move does: a sidebar placement, a crew change, or nothing with the reason. */
export type MoveCheck = { readonly ok: true; readonly via: 'place' | 'crew' } | { readonly ok: false; readonly reason: string };

/** The folder an agent sits in now (`pinned`, a folder id, or `null` = loose). */
export function placeOfAgent(layout: SidebarLayout, sessionId: string): 'pinned' | string | null {
  if (layout.pinned.includes(sessionId)) return 'pinned';
  return layout.folders.find((folder) => folder.sessionIds.includes(sessionId))?.id ?? null;
}

/**
 * The prototype's move rules: project steps stay in their project's subfolder,
 * a project's subfolder takes only project steps, teammates live in their crew
 * (dropping one on another crew moves it there), a crew takes only teammates.
 */
export function checkMove(agent: Pick<AgentEntry, 'id' | 'name' | 'kind' | 'crew'>, target: MoveTarget, layout: SidebarLayout, tree: Pick<AgentTree, 'folders' | 'crews'>): MoveCheck {
  const now = placeOfAgent(layout, agent.id);
  const nowFolder = now && now !== 'pinned' ? findFolder(tree, now) : null;
  if (target.kind === 'crew') {
    if (agent.kind !== 'mate') return { ok: false, reason: `Only teammates live in a crew. Make “${agent.name}” a teammate from its ⋯ menu first.` };
    if (agent.crew?.id === target.crewId) return { ok: false, reason: `${agent.name} is already there.` };
    return { ok: true, via: 'crew' };
  }
  if (agent.kind === 'mate') return { ok: false, reason: 'Teammates live in their crew’s folder. Use ⋯ › Move to crew… to change crews.' };
  if (agent.kind === 'step' && nowFolder?.plan) return { ok: false, reason: `Project steps stay in their project’s folder (${nowFolder.name}).` };
  if (target.kind === 'loose') return now === null ? { ok: false, reason: `${agent.name} is already there.` } : { ok: true, via: 'place' };
  const folder = findFolder(tree, target.folderId);
  if (!folder) return { ok: false, reason: 'That folder no longer exists.' };
  if (now === folder.id) return { ok: false, reason: `${agent.name} is already there.` };
  if (folder.plan && agent.kind !== 'step') return { ok: false, reason: `Only the project’s own steps live in “${folder.name}”.` };
  return { ok: true, via: 'place' };
}

/** One row of the Move-to-folder list. */
export interface PickRow {
  readonly value: 'loose' | string;
  readonly label: string;
  readonly depth: number;
  readonly plan: boolean;
  readonly count: number;
  /** Why it cannot be picked, or `null`. */
  readonly disabled: string | null;
  readonly current: boolean;
}

/** The Move-to-folder list for `agent`: Not in a folder, then every folder in tree order. */
export function pickRows(agent: Pick<AgentEntry, 'id' | 'name' | 'kind' | 'crew'>, layout: SidebarLayout, tree: AgentTree): PickRow[] {
  const now = placeOfAgent(layout, agent.id);
  const rows: PickRow[] = [{ value: 'loose', label: 'Not in a folder', depth: 0, plan: false, count: tree.loose.length, disabled: null, current: now === null }];
  for (const folder of flatFolders(tree)) {
    const check = checkMove(agent, { kind: 'folder', folderId: folder.id }, layout, tree);
    const current = now === folder.id;
    rows.push({ value: folder.id, label: folder.name, depth: folder.level - 1, plan: folder.plan, count: folder.count, disabled: current || check.ok ? null : folder.plan ? 'project steps only' : check.reason, current });
  }
  return rows;
}

/** `true` when a new subfolder fits in `folder` (folders nest up to {@link SIDEBAR_FOLDER_DEPTH_MAX} levels). */
export function canNest(folder: Pick<TreeFolder, 'level' | 'plan'>): boolean {
  return folder.level < SIDEBAR_FOLDER_DEPTH_MAX;
}

/** The folders a new folder may go into ("Inside"): every folder that can still nest. */
export function parentOptions(tree: AgentTree): Array<{ readonly id: string; readonly label: string }> {
  return flatFolders(tree)
    .filter(canNest)
    .map((folder) => ({ id: folder.id, label: `${'— '.repeat(folder.level - 1)}${folder.name}` }));
}

/** What deleting `folder` does, in words ("No agents are deleted. The 3 agents inside move to …"). */
export function deleteSummary(folder: TreeFolder, parentName: string | null): string {
  const n = folder.agents.length;
  const subs = folder.children.length;
  const to = parentName ?? 'Not in a folder';
  const agentsPart = n ? `The ${n} agent${n === 1 ? '' : 's'} inside move${n === 1 ? 's' : ''} to ${to}` : 'It holds no agents';
  const subsPart = subs ? `, along with ${subs} subfolder${subs === 1 ? '' : 's'}` : '';
  return `No agents are deleted. ${agentsPart}${subsPart}.`;
}

// ── Phone drill-down ─────────────────────────────────────────────────

/** What the phone's folder list shows at `path` (folder ids from the top). */
export interface DrillLevel {
  /** The folders down to here (the breadcrumb). */
  readonly crumbs: readonly TreeFolder[];
  readonly folder: TreeFolder | null;
  readonly folders: readonly TreeFolder[];
  readonly agents: readonly AgentEntry[];
}

/** The phone's level at `path`; an unknown id cuts the path there. */
export function drill(tree: AgentTree, path: readonly string[]): DrillLevel {
  const crumbs: TreeFolder[] = [];
  let level: readonly TreeFolder[] = tree.folders;
  for (const id of path) {
    const next = level.find((folder) => folder.id === id);
    if (!next) break;
    crumbs.push(next);
    level = next.children;
  }
  const folder = crumbs[crumbs.length - 1] ?? null;
  return { crumbs, folder, folders: folder ? folder.children : tree.folders, agents: folder ? folder.agents : tree.loose };
}
