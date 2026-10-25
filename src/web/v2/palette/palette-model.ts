/**
 * D131 · lane R · the ⌘K palette's pure part (unit-tested in
 * `tests/web/v2-palette.test.ts`; no DOM, no JSX): the rows, their ranking, the
 * pages it jumps to, the `task …` quick capture and the agent a quick task goes to.
 */
import type { SessionListItem } from '../../../core/api.ts';
import { isChat } from '../../../core/chats.ts';
import { SETTINGS_SECTIONS } from '../../views/settings/model.ts';
import { PALETTE_WORDS, RAIL_LABELS, SETTINGS_LABELS, WORDS } from '../glossary.ts';
import { V2_SETTINGS_SECTIONS } from '../routes.ts';
import { agentName } from '../shared/agent-line.ts';

/** The palette's groups, in the order shown. */
export const PALETTE_GROUPS = ['quick', 'messages', 'agents', 'results', 'pages', 'actions', 'search'] as const;
/** One of {@link PALETTE_GROUPS}. */
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** One row of the palette. What it does is the view's (`action`), so the model stays pure. */
export interface PaletteRow {
  readonly id: string;
  readonly group: PaletteGroup;
  readonly icon: string;
  readonly label: string;
  /** The muted text on the right (where, kind, shortcut). */
  readonly hint?: string;
  /** Extra words it matches (not shown). */
  readonly keywords?: string;
  /** Last activity (ms since epoch): the tiebreak, the most recent first. */
  readonly recency?: number;
  /** A path to go to, or an action id the view runs. */
  readonly action: { readonly go: string } | { readonly run: string; readonly arg?: string };
}

/** At most this many rows. */
export const PALETTE_MAX_ROWS = 12;

/** How well `row` matches the query words: 0 = the label starts with the query, 1 = every word starts a label word, 2 = found inside; `null` = some word is missing. */
export function matchRank(row: Pick<PaletteRow, 'label' | 'keywords'>, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === '') return 2;
  const words = q.split(/\s+/);
  const label = row.label.toLowerCase();
  const hay = `${label} ${(row.keywords ?? '').toLowerCase()}`;
  if (!words.every((word) => hay.includes(word))) return null;
  if (label.startsWith(q)) return 0;
  const starts = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.every((word) => starts.some((start) => start.startsWith(word)))) return 1;
  return 2;
}

/**
 * The rows for `query`: every query word must match; then the best match first
 * (prefix > word start > inside), then the most recent, then the given order.
 * Groups stay together, each where its best row would be (so the first row is
 * the best match), and at most {@link PALETTE_MAX_ROWS} rows are kept.
 */
export function rankRows(rows: readonly PaletteRow[], query: string, max = PALETTE_MAX_ROWS): PaletteRow[] {
  const scored = rows
    .map((row, index) => ({ row, index, rank: matchRank(row, query) }))
    .filter((entry): entry is { row: PaletteRow; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || (b.row.recency ?? 0) - (a.row.recency ?? 0) || a.index - b.index)
    .slice(0, max);
  // A group sits where its best row would (the list is already best first), ties in PALETTE_GROUPS order.
  const firstAt = new Map<PaletteGroup, number>();
  scored.forEach((entry, position) => {
    if (!firstAt.has(entry.row.group)) firstAt.set(entry.row.group, position);
  });
  const order = (group: PaletteGroup): number => (firstAt.get(group) ?? 0) * PALETTE_GROUPS.length + PALETTE_GROUPS.indexOf(group);
  return scored
    .map((entry, position) => ({ ...entry, position }))
    .sort((a, b) => order(a.row.group) - order(b.row.group) || a.position - b.position)
    .map((entry) => entry.row);
}

/** The title of a `task …` quick capture (`task Fix the banner` → `Fix the banner`), `null` for anything else. */
export function quickTaskTitle(query: string): string | null {
  const match = /^\s*task\s+(\S.*)$/i.exec(query);
  return match ? (match[1] ?? '').trim().slice(0, 120) : null;
}

/** `true` while the query is only "task" (the capture's start, not yet a title). */
export function isTaskPrefix(query: string): boolean {
  return /^\s*task\s*$/i.test(query);
}

/** An open agent a task can go to (not a conversation, not closed). */
function taskable(session: SessionListItem): boolean {
  return !isChat(session) && !session.closedAt;
}

/**
 * The agent a quick task goes to: the agent on screen when it can hold tasks, else
 * the most recently active open agent (this computer's first on a tie); `null` without one.
 */
export function quickTaskAgent(sessions: readonly SessionListItem[] | null, current: string | null): SessionListItem | null {
  const open = (sessions ?? []).filter(taskable);
  const here = current ? open.find((session) => session.id === current) : undefined;
  if (here) return here;
  const time = (session: SessionListItem): number => Date.parse(session.lastActivityAt ?? session.createdAt) || 0;
  return [...open].sort((a, b) => time(b) - time(a) || Number(Boolean(a.machine)) - Number(Boolean(b.machine)))[0] ?? null;
}

/** v2's names of the classic sections under Advanced (classic's label otherwise). */
const ADVANCED_NAMES: Readonly<Record<string, string>> = {
  clis: 'AI engines',
  ci: 'CI & change requests',
  tutorial: 'What’s new tours',
  workspace: 'Folders',
};

/** The classic sections that have a v2 page of their own (not under Advanced). */
const OWN_PAGES: ReadonlySet<string> = new Set(['accounts', 'machines', 'devices', 'appearance']);

/** The Advanced pages (`/settings/advanced/<key>`): Code projects and Connections, then every other classic section. */
export function advancedPages(): ReadonlyArray<{ readonly key: string; readonly label: string }> {
  return [
    { key: 'code-projects', label: 'Code projects' },
    { key: 'connections', label: 'Connections' },
    ...SETTINGS_SECTIONS.filter((section) => !OWN_PAGES.has(section.key)).map((section) => ({ key: section.key, label: ADVANCED_NAMES[section.key] ?? section.label })),
  ];
}

/** Every v2 page the palette jumps to. */
export function pageRows(): PaletteRow[] {
  const page = (id: string, label: string, icon: string, go: string, keywords = ''): PaletteRow => ({ id: `page:${id}`, group: 'pages', icon, label, hint: PALETTE_WORDS.page, keywords, action: { go } });
  return [
    page('home', RAIL_LABELS.home, 'home', '/', 'start'),
    page('needs', WORDS.needsYou, 'hand', '/needs-you', 'inbox questions approvals'),
    page('agents', RAIL_LABELS.agents, 'agents', '/agents', 'sessions list chats board'),
    page('projects', RAIL_LABELS.projects, 'projects', '/projects', 'plans'),
    page('crews', RAIL_LABELS.crews, 'crew', '/crews', 'team teammates'),
    page('results', RAIL_LABELS.results, 'results', '/results', 'artifacts files reports'),
    page('search', WORDS.search, 'search', '/search', 'find'),
    page('insights', WORDS.insights, 'insights', '/insights', 'cost tokens forecast estimates'),
    page('tasks', 'Tasks', 'task', '/tasks', 'todos'),
    page('routines', 'Routines', 'routine', '/routines', 'schedules loops'),
    page('notes', 'Notes', 'book', '/notes', 'memory'),
    page('closed', PALETTE_WORDS.actions.closed, 'clock', '/agents?show=closed', 'history closed'),
    page('settings', RAIL_LABELS.settings, 'settings', '/settings', 'preferences'),
    ...V2_SETTINGS_SECTIONS.map((section) => page(`settings-${section}`, `${PALETTE_WORDS.settingsPrefix} ${SETTINGS_LABELS[section]}`, 'settings', `/settings/${section}`, 'settings')),
    ...advancedPages().map((entry) => page(`advanced-${entry.key}`, `${PALETTE_WORDS.advancedPrefix} ${entry.label}`, 'sliders', `/settings/advanced/${entry.key}`, 'settings advanced')),
  ];
}

/** The actions (New …, quick task, search, theme, shortcuts, tours, routines). */
export function actionRows(): PaletteRow[] {
  const a = PALETTE_WORDS.actions;
  const run = (id: string, label: string, icon: string, keywords: string, hint?: string, arg?: string): PaletteRow => ({ id: `action:${id}${arg ? `:${arg}` : ''}`, group: 'actions', icon, label, keywords, ...(hint ? { hint } : {}), action: { run: id, ...(arg ? { arg } : {}) } });
  return [
    run('new', a.newAgent, 'plus', 'start something new agent', undefined, 'agent'),
    run('new', a.newConversation, 'chat', 'start new conversation chat', undefined, 'conversation'),
    run('new', a.newTask, 'task', 'add new task todo', undefined, 'task'),
    run('new', a.newProject, 'projects', 'new project plan', undefined, 'project'),
    run('new', a.newRoutine, 'routine', 'new routine schedule loop', undefined, 'routine'),
    run('new', a.newTeammate, 'crew', 'new teammate crew member', undefined, 'teammate'),
    run('new', a.newCrew, 'crew', 'new crew team', undefined, 'crew'),
    run('task-prefix', a.quickTask, 'task', 'task add quick capture todo'),
    run('search', a.searchEverything, 'search', 'search find messages', '⌘⇧F'),
    run('theme-classic', a.classic, 'sliders', 'theme classic old look'),
    run('scheme', a.light, 'sun', 'theme light look scheme', undefined, 'light'),
    run('scheme', a.dark, 'moon', 'theme dark look scheme night', undefined, 'dark'),
    run('scheme', a.system, 'half', 'theme automatic system look scheme', undefined, 'system'),
    run('shortcuts', a.shortcuts, 'cmd', 'keyboard shortcuts keys help', '?'),
    { id: 'action:tours', group: 'actions', icon: 'sparkle', label: a.tours, keywords: 'tour tours whats new tutorial', action: { go: '/settings/advanced/tutorial' } },
    { id: 'action:routines', group: 'actions', icon: 'routine', label: a.routines, keywords: 'routines schedules loops', action: { go: '/routines' } },
    { id: 'action:pair-phone', group: 'actions', icon: 'qr', label: a.pairPhone, keywords: 'pair phone qr device', action: { go: '/settings/phones' } },
    { id: 'action:add-computer', group: 'actions', icon: 'desktop', label: a.addComputer, keywords: 'pair computer machine peer', action: { go: '/settings/computers' } },
  ];
}

/** An agent's row (a conversation is labelled so; another computer's is tagged with its name). */
export function agentRow(session: SessionListItem): PaletteRow {
  const where = session.machine ? ` · ${session.machine.name}` : '';
  const chat = isChat(session);
  return {
    id: `agent:${session.id}`,
    group: 'agents',
    icon: chat ? 'chat' : 'agents',
    label: agentName(session),
    hint: `${chat ? PALETTE_WORDS.conversation : 'Agent'}${where}`,
    keywords: `${session.name} ${chat ? 'conversation chat' : 'agent'}`,
    recency: Date.parse(session.lastActivityAt ?? session.createdAt) || 0,
    action: { go: `/agents/${encodeURIComponent(session.id)}` },
  };
}

/** The Results page's deep link for an artifact (`/results?open=<id>&agent=<session>[&computer=<machine>]`, the contract the Results page owns). */
export function resultPath(artifactId: string, sessionId: string | null, machineId: string | null | undefined): string {
  const params = new URLSearchParams({ open: artifactId });
  if (sessionId) params.set('agent', sessionId);
  if (machineId) params.set('computer', machineId);
  return `/results?${params.toString()}`;
}

/** The search row: "Search everything for “…”" (→ `/search?q=`). */
export function searchRow(query: string): PaletteRow {
  const q = query.trim();
  return { id: 'search', group: 'search', icon: 'search', label: PALETTE_WORDS.searchFor(q), hint: '⌘⇧F', action: { go: `/search?q=${encodeURIComponent(q)}` } };
}

/** Where a search hit goes in v2: a message to its event, a session to the agent, an artifact to Results, a todo to Tasks, history to Closed. */
export function hitPath(target: { readonly type: string; readonly sessionId?: string | null; readonly eventId?: number; readonly agentId?: string | null; readonly artifactId?: string; readonly todoId?: string }, machineId: string | null | undefined): string {
  const enc = encodeURIComponent;
  switch (target.type) {
    case 'event':
      return target.agentId ? `/agents/${enc(target.sessionId ?? '')}/helpers/${enc(target.agentId)}/events/${target.eventId}` : `/agents/${enc(target.sessionId ?? '')}/events/${target.eventId}`;
    case 'session':
      return `/agents/${enc(target.sessionId ?? '')}`;
    case 'artifact':
      return resultPath(target.artifactId ?? '', target.sessionId ?? null, machineId);
    case 'todo':
      return '/tasks';
    default:
      return '/agents?show=closed';
  }
}
