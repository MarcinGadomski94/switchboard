/**
 * D131 · the v2 UI's addresses (`docs/v2.md` → *Routes*). Pure, unit-tested.
 *
 * | Path | Area (owner lane) |
 * |---|---|
 * | `/` | Home (H) |
 * | `/needs-you` | Needs you (H) |
 * | `/agents` | Agents: List / Chats / Board (A); `?show=closed` = closed agents (History) |
 * | `/agents/:id[/:tab]` | One agent (S); tab `changes` · `results` · `timeline` · `helpers` (none = the chat) |
 * | `/agents/:id/helpers/:helperId[/events/:eventId]` | A helper's own chat (S) |
 * | `/agents/:id/results/:resultId` | The agent's Results tab with that result open (S) |
 * | `/agents/:id/events/:eventId` | The chat at that message (a search hit) (S) |
 * | `/projects`, `/projects/:id` | Projects (P) |
 * | `/crews`, `/crews/:id` | Crews (P) |
 * | `/results` | Results (R) |
 * | `/search` | Search (R), the query in `?q=` |
 * | `/insights` | Insights (R) |
 * | `/settings[/:section[/:sub]]` | Settings (R): `usage`, `computers`, `phones`, `rules`, `appearance`, `advanced[/<classic section>]` |
 * | `/notes`, `/routines`, `/tasks` | Notes, Routines, Tasks (A) |
 * | `/tools/:id`, `/share` | An embedded tool, a phone's share (R) |
 * | `/more` | The phone's More tab (F: the shell) |
 *
 * Every classic address still opens the same page in v2 (push notifications,
 * paired machines and old bookmarks use them): {@link toV2Path} turns it into the
 * v2 one, and {@link toClassicPath} does the opposite when this browser switches
 * back to the classic UI. Both leave an address of their own UI unchanged.
 */

/** The agent view's tabs (`/agents/:id/<tab>`; `chat` has no segment). */
export const AGENT_TABS = ['chat', 'changes', 'results', 'timeline', 'helpers'] as const;
/** An agent view tab. */
export type AgentTab = (typeof AGENT_TABS)[number];

/** The v2 Settings sections (`/settings/<section>`), in the order the Settings list shows them (fix after 2.0: the everyday ones first). `advanced` holds the classic sections (`/settings/advanced/<key>`). */
export const V2_SETTINGS_SECTIONS = ['usage', 'rules', 'appearance', 'computers', 'phones', 'advanced'] as const;
/** A v2 Settings section. */
export type V2SettingsSection = (typeof V2_SETTINGS_SECTIONS)[number];

/** A parsed v2 address. */
export type V2Route =
  | { readonly area: 'home' | 'needs-you' | 'agents' | 'projects' | 'crews' | 'results' | 'search' | 'insights' | 'notes' | 'routines' | 'tasks' | 'share' | 'more' }
  | {
      readonly area: 'agent';
      readonly id: string;
      readonly tab: AgentTab;
      /** A helper's own chat (`/agents/:id/helpers/:helperId`). */
      readonly helperId?: string;
      /** The Results tab opens this result. */
      readonly resultId?: string;
      /** The chat opens at this message, highlighted. */
      readonly eventId?: number;
    }
  | { readonly area: 'project'; readonly id: string }
  | { readonly area: 'crew'; readonly id: string }
  | { readonly area: 'tool'; readonly id: string }
  | { readonly area: 'settings'; readonly section: V2SettingsSection | null; readonly sub: string | null };

/** The seven rail destinations, in order (Tasks: fix after 2.0, `docs/design/v2-decisions.md`). */
export const RAIL_AREAS = ['home', 'agents', 'projects', 'crews', 'results', 'tasks', 'settings'] as const;
/** A rail destination. */
export type RailArea = (typeof RAIL_AREAS)[number];

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const enc = encodeURIComponent;

function isEventId(value: string | undefined): value is string {
  return value !== undefined && /^[1-9][0-9]{0,15}$/.test(value);
}

const SIMPLE: ReadonlyArray<V2Route['area']> = ['needs-you', 'agents', 'projects', 'crews', 'results', 'search', 'insights', 'notes', 'routines', 'tasks', 'share', 'more'];

/** Parses a v2 pathname; an unknown one is Home. */
export function parseV2Route(pathname: string): V2Route {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  const [head, a, b, c, d, e] = parts;
  if (head === undefined) return { area: 'home' };
  if (parts.length === 1 && (SIMPLE as readonly string[]).includes(head)) return { area: head as 'needs-you' };
  if (head === 'agents' && a) {
    if (b === 'helpers' && c && d === 'events' && isEventId(e)) return { area: 'agent', id: a, tab: 'chat', helperId: c, eventId: Number(e) };
    if (b === 'helpers' && c) return { area: 'agent', id: a, tab: 'chat', helperId: c };
    if (b === 'events' && isEventId(c)) return { area: 'agent', id: a, tab: 'chat', eventId: Number(c) };
    if (b === 'results' && c) return { area: 'agent', id: a, tab: 'results', resultId: c };
    const tab = (AGENT_TABS as readonly string[]).includes(b ?? '') ? (b as AgentTab) : 'chat';
    return { area: 'agent', id: a, tab };
  }
  if (head === 'projects' && a && parts.length === 2) return { area: 'project', id: a };
  if (head === 'crews' && a && parts.length === 2) return { area: 'crew', id: a };
  if (head === 'tools' && a) return { area: 'tool', id: a };
  if (head === 'settings') {
    const section = (V2_SETTINGS_SECTIONS as readonly string[]).includes(a ?? '') ? (a as V2SettingsSection) : null;
    return { area: 'settings', section, sub: section ? (b ?? null) : null };
  }
  return { area: 'home' };
}

/** The pathname of a {@link V2Route}. */
export function v2Path(route: V2Route): string {
  switch (route.area) {
    case 'home':
      return '/';
    case 'agent': {
      const base = `/agents/${enc(route.id)}`;
      if (route.helperId) return `${base}/helpers/${enc(route.helperId)}${route.eventId === undefined ? '' : `/events/${route.eventId}`}`;
      if (route.tab === 'chat' && route.eventId !== undefined) return `${base}/events/${route.eventId}`;
      if (route.tab === 'results' && route.resultId) return `${base}/results/${enc(route.resultId)}`;
      return route.tab === 'chat' ? base : `${base}/${route.tab}`;
    }
    case 'project':
      return `/projects/${enc(route.id)}`;
    case 'crew':
      return `/crews/${enc(route.id)}`;
    case 'tool':
      return `/tools/${enc(route.id)}`;
    case 'settings':
      if (!route.section) return '/settings';
      return `/settings/${route.section}${route.sub ? `/${enc(route.sub)}` : ''}`;
    default:
      return `/${route.area}`;
  }
}

/** The rail item an area belongs to (`null`: none lights up, e.g. Search). */
export function railAreaOf(route: V2Route): RailArea | null {
  switch (route.area) {
    case 'home':
    case 'needs-you':
      return 'home';
    case 'agents':
    case 'agent':
    case 'notes':
    case 'routines':
      return 'agents';
    case 'tasks':
      return 'tasks';
    case 'projects':
    case 'project':
      return 'projects';
    case 'crews':
    case 'crew':
      return 'crews';
    case 'results':
      return 'results';
    case 'settings':
    case 'tool':
    case 'insights':
      return 'settings';
    default:
      return null;
  }
}

// ── Classic ⇄ v2 ──────────────────────────────────────────────────────

/** Classic session tabs → v2 agent tabs. */
const TAB_TO_V2: Readonly<Record<string, AgentTab>> = { chat: 'chat', timeline: 'timeline', diff: 'changes', artifacts: 'results' };
/** v2 agent tabs → classic session tabs (`helpers` has no classic tab: the chat). */
const TAB_TO_CLASSIC: Readonly<Record<AgentTab, string>> = { chat: 'chat', timeline: 'timeline', changes: 'diff', results: 'artifacts', helpers: 'chat' };

/** Classic Settings sections with a v2 page of their own; every other one is under Advanced. */
const SETTINGS_TO_V2: Readonly<Record<string, string>> = { accounts: 'usage', machines: 'computers', devices: 'phones', appearance: 'appearance' };
/** v2 Settings sections → classic ones (`rules` = the standing instruction in Sessions & worktrees). */
const SETTINGS_TO_CLASSIC: Readonly<Record<string, string>> = { usage: 'accounts', computers: 'machines', phones: 'devices', rules: 'sessions', appearance: 'appearance' };
/** v2 Advanced pages that are classic pages of their own (not Settings sections). */
const ADVANCED_PAGES: Readonly<Record<string, string>> = { 'code-projects': '/solutions', connections: '/mcp' };

/** Splits `path?query` into its parts. */
function splitTarget(target: string): { readonly path: string; readonly query: string } {
  const cut = target.indexOf('?');
  return cut < 0 ? { path: target, query: '' } : { path: target.slice(0, cut), query: target.slice(cut) };
}

/**
 * The v2 address of a classic one (`/sessions/a/diff` → `/agents/a/changes`), with
 * its query; a v2 address (or one both UIs share) comes back unchanged.
 */
export function toV2Path(target: string): string {
  const { path, query } = splitTarget(target);
  const parts = path.split('/').filter(Boolean);
  const [head, a, b, c, d, e] = parts;
  const raw = (segment: string | undefined): string => segment ?? '';
  switch (head) {
    case 'inbox':
      return `/needs-you${query}`;
    case 'sessions': {
      if (!a) return `/agents${query}`;
      const base = `/agents/${raw(a)}`;
      if (b === 'agents' && c) return `${base}/helpers/${raw(c)}${d === 'events' && e ? `/events/${e}` : ''}${query}`;
      if (b === 'events' && c) return `${base}/events/${c}${query}`;
      if (b === 'artifacts' && c) return `${base}/results/${raw(c)}${query}`;
      const tab = TAB_TO_V2[b ?? 'chat'] ?? 'chat';
      return `${tab === 'chat' ? base : `${base}/${tab}`}${query}`;
    }
    case 'solutions':
      return '/settings/advanced/code-projects';
    case 'mcp':
      return '/settings/advanced/connections';
    case 'schedules':
      return `/routines${query}`;
    case 'artifacts':
      return `/results${query}`;
    case 'history':
      return '/agents?show=closed';
    case 'todos':
      return `/tasks${query}`;
    case 'memory':
      return `/notes${query}`;
    case 'team':
      return a && a !== 'all' ? `/crews/${raw(a)}${query}` : `/crews${query}`;
    case 'plans':
      return a ? `/projects/${raw(a)}${query}` : `/projects${query}`;
    case 'settings': {
      if (!a || (V2_SETTINGS_SECTIONS as readonly string[]).includes(a)) return target;
      const own = SETTINGS_TO_V2[a];
      return own ? `/settings/${own}${query}` : `/settings/advanced/${raw(a)}${query}`;
    }
    default:
      return target;
  }
}

/**
 * The classic address of a v2 one (`/agents/a/changes` → `/sessions/a/diff`), with
 * its query; a classic address (or one both UIs share) comes back unchanged.
 */
export function toClassicPath(target: string): string {
  const { path, query } = splitTarget(target);
  const parts = path.split('/').filter(Boolean);
  const [head, a, b, c, d, e] = parts;
  const raw = (segment: string | undefined): string => segment ?? '';
  switch (head) {
    case 'needs-you':
      return '/inbox';
    case 'agents': {
      if (!a) return /[?&]show=closed\b/.test(query) ? '/history' : '/';
      const base = `/sessions/${raw(a)}`;
      if (b === 'helpers' && c) return `${base}/agents/${raw(c)}${d === 'events' && e ? `/events/${e}` : ''}`;
      if (b === 'events' && c) return `${base}/events/${c}`;
      if (b === 'results' && c) return `${base}/artifacts/${raw(c)}`;
      const tab = (AGENT_TABS as readonly string[]).includes(b ?? '') ? TAB_TO_CLASSIC[b as AgentTab] : 'chat';
      return tab === 'chat' ? base : `${base}/${tab}`;
    }
    case 'projects':
      return a ? `/plans/${raw(a)}` : '/plans';
    case 'crews':
      return a ? `/team/${raw(a)}` : '/team';
    case 'results':
      return `/artifacts${query}`;
    case 'notes':
      return `/memory${query}`;
    case 'routines':
      return '/schedules';
    case 'tasks':
      return '/todos';
    case 'settings': {
      if (!a || !(V2_SETTINGS_SECTIONS as readonly string[]).includes(a)) return target;
      if (a === 'advanced') {
        if (!b) return '/settings';
        return ADVANCED_PAGES[b] ?? `/settings/${raw(b)}`;
      }
      return `/settings/${SETTINGS_TO_CLASSIC[a] ?? raw(a)}`;
    }
    default:
      return target;
  }
}

/** The phone's bottom tabs, in order. */
export const PHONE_TAB_IDS = ['home', 'needs', 'agents', 'results', 'more'] as const;
/** A phone tab. */
export type PhoneTab = (typeof PHONE_TAB_IDS)[number];

/** The phone tab an area belongs to (everything without a tab of its own is under More). */
export function phoneTabOf(route: V2Route): PhoneTab {
  switch (route.area) {
    case 'home':
      return 'home';
    case 'needs-you':
      return 'needs';
    case 'agents':
    case 'agent':
      return 'agents';
    case 'results':
      return 'results';
    default:
      return 'more';
  }
}

/** `true` when `pathname` is a classic address that v2 shows under another one (the v2 shell then replaces it). */
export function isClassicOnlyPath(target: string): boolean {
  return toV2Path(target) !== target;
}
