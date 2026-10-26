import type { SessionListItem } from '../../../core/api.ts';
import type { Plan } from '../../../core/plans.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import type { TeamSummary } from '../../../core/team.ts';
import { type NeedsKind, type V2Status, sessionStatusToV2 } from '../glossary.ts';
import type { BoardColumn } from '../shared/board-model.ts';

/**
 * D131 · lane A · the Agents page's model (pure; unit-tested in
 * `tests/web/v2-agents.test.ts`): every open agent (Switchboard sessions, chats,
 * routines' sessions, project steps, this computer's and the paired ones') as
 * one {@link AgentEntry}, the List / Chats sort and sections, and the Board's
 * columns and swimlanes (group by Project | Folder). Teammates (D100) are not
 * agents here: the Crews pages own them (fix after 2.0), as the classic sidebar
 * hides member sessions from SESSIONS.
 */

/** What an agent is, beyond a plain Switchboard session. */
export type AgentKind = 'agent' | 'conv' | 'routine' | 'step';

/** The open "needs you" item of an agent, as much as the rows need. */
export interface AgentAsk {
  readonly key: string;
  readonly kind: NeedsKind;
  readonly title: string;
}

/** One agent on the Agents page. */
export interface AgentEntry {
  readonly id: string;
  readonly session: SessionListItem;
  readonly name: string;
  readonly kind: AgentKind;
  /** The v2 status: its open item's (needs / stopped / ready) first, else its session's. */
  readonly status: V2Status;
  /** Its open items (first = the one the row shows). */
  readonly asks: readonly AgentAsk[];
  /** The project it is a step of. */
  readonly plan: { readonly id: string; readonly title: string } | null;
  /** The paired computer it runs on (`null` = this one), with its live state. */
  readonly computer: { readonly id: string; readonly name: string; readonly state: 'online' | 'reconnecting' | 'offline' } | null;
  /** The composer holds an unsent message (its text). */
  readonly draft: string | null;
  /** New replies since the developer last looked (per browser). */
  readonly unread: boolean;
}

/** An open item in the store's shape (only what the model reads). */
export interface NeedsLike {
  readonly key: string;
  readonly kind: NeedsKind;
  readonly title: string;
  readonly agent: { readonly sessionId: string | null } | null;
}

/** What {@link buildAgents} reads. */
export interface AgentSources {
  readonly sessions: readonly SessionListItem[];
  readonly needs: readonly NeedsLike[];
  /** The crews: their teammates' sessions are left out. */
  readonly teams: readonly Pick<TeamSummary, 'roster'>[];
  readonly plans: readonly Plan[];
  /** Composer drafts by session id (text). */
  readonly drafts?: Readonly<Record<string, string>>;
  /** When this browser last looked at each agent (ISO), and the first visit (`baseline`). */
  readonly seen?: Readonly<Record<string, string>>;
  readonly baseline?: string | null;
}

/** The item kinds that colour an agent `stopped` / `ready`; every other kind = `needs`. */
const STOPPED_KINDS: ReadonlySet<NeedsKind> = new Set(['stopped', 'routine']);
const READY_KINDS: ReadonlySet<NeedsKind> = new Set(['ready']);

/** The status an agent's open items give it (`null` = none open). */
export function askStatusOf(asks: readonly Pick<AgentAsk, 'kind'>[]): V2Status | null {
  if (asks.length === 0) return null;
  if (asks.some((ask) => !STOPPED_KINDS.has(ask.kind) && !READY_KINDS.has(ask.kind))) return 'needs';
  if (asks.some((ask) => STOPPED_KINDS.has(ask.kind))) return 'stopped';
  return 'ready';
}

/** `true` for a routine's session: it has a Switchboard loop that has not ended. */
export function hasRoutine(session: Pick<SessionListItem, 'ownedLoops'>): boolean {
  return (session.ownedLoops ?? []).some((loop) => loop.state !== 'ended');
}

/** The agent's display name. */
export function nameOf(session: Pick<SessionListItem, 'displayTitle' | 'title' | 'name'>): string {
  return session.displayTitle ?? session.title ?? session.name;
}

function unreadOf(session: SessionListItem, seen: Readonly<Record<string, string>>, baseline: string | null | undefined): boolean {
  if (!session.lastActivityAt || session.status === 'run') return false;
  const since = seen[session.id] ?? baseline ?? null;
  if (!since) return false;
  return Date.parse(session.lastActivityAt) > Date.parse(since);
}

/** The session ids of every crew's teammates (D100). */
export function teammateIds(teams: readonly Pick<TeamSummary, 'roster'>[]): Set<string> {
  const out = new Set<string>();
  for (const team of teams) for (const member of team.roster ?? []) out.add(member.sessionRef);
  return out;
}

/** Every open agent as an {@link AgentEntry} (closed ones and teammates are left out), in the service's order. */
export function buildAgents(sources: AgentSources): AgentEntry[] {
  const mates = teammateIds(sources.teams);
  const planOf = new Map<string, { id: string; title: string }>();
  for (const plan of sources.plans) {
    for (const item of plan.items) if (item.runSessionId) planOf.set(item.runSessionId, { id: plan.id, title: plan.title });
  }
  const asksOf = new Map<string, AgentAsk[]>();
  for (const item of sources.needs) {
    const id = item.agent?.sessionId;
    if (!id) continue;
    const list = asksOf.get(id) ?? [];
    list.push({ key: item.key, kind: item.kind, title: item.title });
    asksOf.set(id, list);
  }
  const drafts = sources.drafts ?? {};
  const seen = sources.seen ?? {};
  return sources.sessions
    .filter((session) => !session.closedAt && !mates.has(session.id))
    .map((session): AgentEntry => {
      const plan = planOf.get(session.id) ?? null;
      const asks = asksOf.get(session.id) ?? [];
      const kind: AgentKind = plan ? 'step' : session.kind === 'chat' ? 'conv' : hasRoutine(session) ? 'routine' : 'agent';
      const machine = session.machine ?? null;
      const computer = machine ? { id: machine.id, name: machine.name, state: machine.state === 'online' ? ('online' as const) : machine.state === 'reconnecting' ? ('reconnecting' as const) : ('offline' as const) } : null;
      return {
        id: session.id,
        session,
        name: nameOf(session),
        kind,
        status: askStatusOf(asks) ?? sessionStatusToV2(session.status),
        asks,
        plan,
        computer,
        draft: drafts[session.id] ?? null,
        unread: unreadOf(session, seen, sources.baseline),
      };
    });
}

/** `true` when the agent waits for the developer (an open item, or a needs / stopped / ready status). */
export function needy(agent: Pick<AgentEntry, 'status' | 'asks'>): boolean {
  return agent.asks.length > 0 || agent.status === 'needs' || agent.status === 'stopped' || agent.status === 'ready';
}

/** `true` when the agent's computer is not reachable (its actions are disabled). */
export function offline(agent: Pick<AgentEntry, 'computer'>): boolean {
  return agent.computer !== null && agent.computer.state !== 'online';
}

/** The sort rank of a status (the prototype's `RANK`). */
export const STATUS_RANK: Readonly<Record<V2Status, number>> = {
  needs: 0,
  stopped: 0,
  ready: 1,
  working: 2,
  waiting: 2,
  userstop: 2,
  reconnecting: 2,
  queued: 3,
  done: 4,
  online: 4,
  idle: 5,
  paused: 5,
  offline: 6,
};

/** List / Chats order: the ones that need you first, then by status, then the most recent activity first. */
export function sortAgents<T extends Pick<AgentEntry, 'status' | 'asks' | 'session'>>(list: readonly T[]): T[] {
  const at = (agent: T): number => (agent.session.lastActivityAt ? Date.parse(agent.session.lastActivityAt) : 0);
  return [...list].sort((x, y) => (needy(x) ? 0 : 1) - (needy(y) ? 0 : 1) || STATUS_RANK[x.status] - STATUS_RANK[y.status] || at(y) - at(x));
}

/** A section of the List or Chats view. */
export interface AgentSection {
  readonly id: string;
  /** `needs` = the Needs-you group (Chats), `plain` = the agents and conversations. */
  readonly kind: 'needs' | 'plain';
  readonly items: readonly AgentEntry[];
}

/** The List's sections: every agent, nothing hidden (teammates are the Crews pages'). */
export function listSections(agents: readonly AgentEntry[]): AgentSection[] {
  const sorted = sortAgents(agents);
  return sorted.length ? [{ id: 'plain', kind: 'plain', items: sorted }] : [];
}

/** The Chats' sections: the ones that need you float to the top, then the rest. */
export function chatSections(agents: readonly AgentEntry[]): AgentSection[] {
  const sorted = sortAgents(agents);
  const needs = sorted.filter(needy);
  const rest = sorted.filter((agent) => !needy(agent));
  const out: AgentSection[] = [];
  if (needs.length) out.push({ id: 'needs', kind: 'needs', items: needs });
  if (rest.length) out.push({ id: 'plain', kind: 'plain', items: rest });
  return out;
}

// ── Board ────────────────────────────────────────────────────────────

/** The Board's columns, in order: the shared board's (`../shared/board-model.ts`). */
export { BOARD_COLUMNS, type BoardColumn } from '../shared/board-model.ts';

/** The column a status sits in; `null` = not on the Board (idle, paused, offline). */
export function columnOf(status: V2Status): BoardColumn | null {
  switch (status) {
    case 'needs':
    case 'stopped':
      return 'needs';
    case 'working':
    case 'waiting':
    case 'queued':
    case 'userstop':
    case 'reconnecting':
      return 'working';
    case 'ready':
      return 'ready';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

/** How the Board's rows (swimlanes) are grouped. */
export const GROUP_BYS = ['project', 'folder'] as const;
/** A grouping. */
export type GroupBy = (typeof GROUP_BYS)[number];

/** `true` for a known grouping. */
export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === 'string' && (GROUP_BYS as readonly string[]).includes(value);
}

/** One swimlane of the Board. */
export interface BoardLane {
  readonly id: string;
  readonly title: string;
  readonly icon: 'projects' | 'folder' | 'agents' | 'pin';
  readonly plan?: { readonly id: string; readonly done: number; readonly total: number };
  readonly items: readonly AgentEntry[];
}

/** The top-level folder an agent sits in (through its subfolders), `null` when loose; `pinned` when pinned. */
export function topFolderOf(layout: SidebarLayout, sessionId: string): string | 'pinned' | null {
  if (layout.pinned.includes(sessionId)) return 'pinned';
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]));
  let folder = layout.folders.find((f) => f.sessionIds.includes(sessionId));
  if (!folder) return null;
  for (let guard = 0; guard < 16 && folder.parentId; guard += 1) {
    const parent = byId.get(folder.parentId);
    if (!parent) break;
    folder = parent;
  }
  return folder.id;
}

/** The Board's swimlanes for `agents` (only the ones on the Board), grouped by `groupBy`; empty lanes are left out. */
export function boardLanes(agents: readonly AgentEntry[], groupBy: GroupBy, context: { readonly plans: readonly Plan[]; readonly layout: SidebarLayout }): BoardLane[] {
  const on = agents.filter((agent) => columnOf(agent.status) !== null);
  const lanes: BoardLane[] = [];
  if (groupBy === 'folder') {
    const top = new Map(on.map((agent) => [agent.id, topFolderOf(context.layout, agent.id)]));
    lanes.push({ id: 'fold:pinned', title: 'Pinned', icon: 'pin', items: on.filter((agent) => top.get(agent.id) === 'pinned') });
    for (const folder of context.layout.folders.filter((f) => !f.parentId)) lanes.push({ id: `fold:${folder.id}`, title: folder.name, icon: isPlanFolderName(folder.name) ? 'projects' : 'folder', items: on.filter((agent) => top.get(agent.id) === folder.id) });
    lanes.push({ id: 'fold:none', title: 'Not in a folder', icon: 'agents', items: on.filter((agent) => top.get(agent.id) === null) });
  } else {
    for (const plan of context.plans) {
      const done = plan.items.filter((item) => item.state === 'done').length;
      lanes.push({ id: `plan:${plan.id}`, title: plan.title, icon: 'projects', plan: { id: plan.id, done, total: plan.items.length }, items: on.filter((agent) => agent.plan?.id === plan.id) });
    }
    lanes.push({ id: 'agents', title: 'Agents', icon: 'agents', items: on.filter((agent) => agent.kind !== 'step') });
  }
  return lanes.filter((lane) => lane.items.length > 0);
}

/** The agents of one Board column of a lane, in the List's order. */
export function cellOf(lane: Pick<BoardLane, 'items'>, column: BoardColumn): AgentEntry[] {
  return sortAgents(lane.items.filter((agent) => columnOf(agent.status) === column));
}

/** The agents not on the Board (idle, paused, offline): the footer names them. */
export function offBoard(agents: readonly AgentEntry[]): AgentEntry[] {
  return agents.filter((agent) => columnOf(agent.status) === null);
}

/** D119 · a project's own subfolder ("Plan · …", made by a Jira import or a run). */
export const PLAN_FOLDER_PREFIX = 'Plan · ';

/** `true` for a project's subfolder by its name. */
export function isPlanFolderName(name: string): boolean {
  return name.startsWith(PLAN_FOLDER_PREFIX);
}

// ── Views and preferences ────────────────────────────────────────────

/** The Agents page's views (desktop and tablet). */
export const AGENT_VIEWS = ['list', 'chats', 'board'] as const;
/** A view. */
export type AgentView = (typeof AGENT_VIEWS)[number];

/** The phone's views (the folder tree is a drill-down list there). */
export const PHONE_VIEWS = ['chats', 'folders', 'board'] as const;
/** A phone view. */
export type PhoneView = (typeof PHONE_VIEWS)[number];

/** `true` for a known view. */
export function isAgentView(value: unknown): value is AgentView {
  return typeof value === 'string' && (AGENT_VIEWS as readonly string[]).includes(value);
}

/** `true` for a known phone view. */
export function isPhoneView(value: unknown): value is PhoneView {
  return typeof value === 'string' && (PHONE_VIEWS as readonly string[]).includes(value);
}

/** The per-browser keys the page remembers its choices under (localStorage). */
export const PREF_KEYS = {
  view: 'switchboard.v2.agents.view',
  phoneView: 'switchboard.v2.agents.phoneView',
  groupBy: 'switchboard.v2.agents.groupBy',
  treeHidden: 'switchboard.v2.agents.treeHidden',
  advanced: 'switchboard.v2.agents.advanced',
  lanesClosed: 'switchboard.v2.agents.lanesClosed',
  seen: 'switchboard.v2.agents.seen',
  baseline: 'switchboard.v2.agents.seenBaseline',
} as const;

/** The closed-agents search: name, folder path or computer contains every word of `query` (case-insensitive). */
export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** The AI engine (CLI) in words, shown only under Advanced. */
export function engineLabel(provider: string | undefined): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Claude Code';
  }
}
