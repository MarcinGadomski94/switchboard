import type { InboxAction, InboxItem, PermissionRequest, Question } from '../../../core/api.ts';
import { type MemoryEntry, changeKindOf } from '../../../core/memory.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import type { MachineState } from '../../../core/peers.ts';
import type { TeamCharter, TeamNeedsYouItem, TeamRequest } from '../../../core/team.ts';
import { type NeedsKind, SYSTEM_LABELS } from '../glossary.ts';

/**
 * D131 · the one "Needs you" list (`docs/v2.md` → *Needs you*): every source that
 * waits for the developer merged into one list of {@link NeedsItem}s, each with a
 * source tag, a crew tag, a computer tag and what answering it means. Pure (the
 * store, `needs-you.ts`, feeds it and keeps it live); unit-tested.
 *
 * Sources and how they become items:
 * - `GET /api/inbox` (this computer's and the paired ones', D48 / D113): question
 *   batches → `question` / `multi`; permission requests → `approval`; system items
 *   by their actions / kind: "Waiting for you" (D124) → `ask`; a plan's or a PR's
 *   Merge (D102 / D109) → `ready`; "Confirm done" → `ready`; "Pick repositories"
 *   (D115) → `pick`; a failed routine (M3.3) → `routine`; a plan step stopped (D120)
 *   and failing tests (D109) → `stopped`; memory proposals (D107) → `note`; the rest
 *   (update available, PR merged, …) → `alert`.
 * - `GET /api/team/needs-you?teamId=all` (D100): the crew's Inbox items (the same ids:
 *   they only add the crew tag) and its own requests: access → `access`, charter
 *   proposals (D105) → `jd`, gates and budgets → `approval`.
 * - `GET /api/memory/entries?scope=` for each scope with a memory-proposals item:
 *   each proposed note → `note`, a proposed change of an approved one (D135) →
 *   `note-edit` / `note-removal` (they replace that scope's summary item).
 * - Usage (`GET /api/system`, live via `system`): an account out of usage or paying
 *   from paid extra usage → `alert` (dismissed per browser).
 */

/** Where an item comes from (its source tag). */
export type NeedsSource = 'inbox' | 'crew' | 'notes' | 'usage';

/** The computer an item waits on; `null` in {@link NeedsItem.computer} = this one. */
export interface NeedsComputer {
  readonly id: string;
  readonly name: string;
  readonly state: 'online' | 'reconnecting' | 'offline';
}

/** The crew an item belongs to (a teammate's). */
export interface NeedsCrew {
  readonly id: string | null;
  readonly name: string;
  readonly teammate: string;
  readonly memberId: string;
}

/** One answer option (a question's, or a code project to pick). */
export interface NeedsOption {
  readonly label: string;
  readonly description?: string;
}

/** One "needs you" item, whatever its source. */
export interface NeedsItem {
  /** Unique across sources: `<source>:<id>`. */
  readonly key: string;
  /** The source's own id (Inbox item / batch id, team request id, memory entry id, usage alert key). */
  readonly id: string;
  readonly source: NeedsSource;
  readonly kind: NeedsKind;
  /** What it asks, one line ("Which quarter should the report cover?"). */
  readonly title: string;
  /** More words under it (the context, the reason); may be empty. */
  readonly text: string;
  /** A quoted ask or proposal (an agent's waiting ask, a note, a job description). */
  readonly quote?: string;
  /**
   * Fix after 2.0: an `ask` the text check read from the agent's last message (its
   * Inbox label "Waiting for you · detected"), not one the agent declared with
   * `turn_status`; the card says "detected", as the classic session header does.
   */
  readonly detected?: boolean;
  /** An approval's command or call, verbatim (D139: an account's "needs you" item's terminal command, copyable). */
  readonly command?: string;
  /** The questions of a batch (`question` / `multi`). */
  readonly questions?: readonly Question[];
  /** Options for `pick`. */
  readonly options?: readonly NeedsOption[];
  readonly createdAt: string;
  /** Who asks: the agent (session) and its display name; `null` for a system-wide item (usage). */
  readonly agent: { readonly sessionId: string | null; readonly name: string } | null;
  /** The project (plan) or scope it is about, when known ("PROJ-100 Checkout v2", "Folder · Checkout"). */
  readonly context?: string;
  readonly crew: NeedsCrew | null;
  /** The paired computer it waits on; `null` = this computer. */
  readonly computer: NeedsComputer | null;
  /** A system item's actions as the server offers them (first = primary). */
  readonly actions: readonly InboxAction[];
  /** The page an "open" action goes to, when the server named one. */
  readonly route?: string | null;
  /** An external page (a PR) an action opens. */
  readonly url?: string | null;
  /** The raw source records, for the answer calls. */
  readonly inbox?: InboxItem;
  readonly request?: TeamRequest;
  readonly charter?: { readonly before: TeamCharter; readonly after: TeamCharter; readonly notes: string };
  readonly memory?: MemoryEntry;
  /** The permission request (`approval` from the Inbox). */
  readonly permission?: PermissionRequest;
}

/** A usage alert the store derives from `GET /api/system` (see `needs-you.ts`). */
export interface UsageAlert {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly createdAt: string;
}

/** What the merge reads. */
export interface NeedsSources {
  readonly inbox: readonly InboxItem[] | null;
  readonly team: readonly TeamNeedsYouItem[] | null;
  /** Proposed notes per memory scope (only scopes with a memory-proposals item are read). */
  readonly notes: Readonly<Record<string, readonly MemoryEntry[]>>;
  readonly usage: readonly UsageAlert[];
  /** Live states of the paired computers (`useMachines`), by id. */
  readonly computers?: Readonly<Record<string, MachineState>>;
}

/** Ids of the Inbox system items' actions the classification keys on (`src/server/inbox/system-items.ts`). */
const READY_ACTIONS = new Set(['plan-merge', 'merge-pr']);

/** `pick` / `routine` / `note` / … for a system item; `null` = not a system item. */
export function systemKindOf(item: Pick<InboxItem, 'kind' | 'systemKind' | 'label' | 'actions'>): NeedsKind | null {
  if (item.kind !== 'system') return null;
  const ids = new Set((item.actions ?? []).map((action) => action.id));
  if (item.systemKind === 'turn-waiting' || item.label.startsWith('Waiting for you')) return 'ask';
  if ([...ids].some((id) => READY_ACTIONS.has(id)) || item.label === 'Confirm done') return 'ready';
  if (ids.has('plan-ask-repos') || item.label === 'Pick repositories') return 'pick';
  if (ids.has('retry-run') || item.label === 'Scheduled run failed') return 'routine';
  if (ids.has('open-memory')) return 'note';
  if (item.label === 'Stopped' || item.label === 'CI keeps failing') return 'stopped';
  return 'alert';
}

/** The kind of any Inbox item. */
export function inboxKindOf(item: InboxItem): NeedsKind {
  if (item.kind === 'questions') return (item.questions ?? []).some((q) => q.multiSelect) ? 'multi' : 'question';
  if (item.kind === 'permission') return 'approval';
  return systemKindOf(item) ?? 'alert';
}

/** A permission request's call as one line: a shell command as it is, else `Tool(input)`. */
export function commandOf(permission: PermissionRequest | undefined): string | undefined {
  if (!permission) return undefined;
  const input = permission.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record['command'] === 'string') return record['command'];
    if (typeof record['file_path'] === 'string') return `${permission.toolName} ${record['file_path']}`;
    if (typeof record['url'] === 'string') return `${permission.toolName} ${record['url']}`;
  }
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return `${permission.toolName}${text && text !== '{}' && text !== 'undefined' ? ` ${text}` : ''}`;
}

/** The memory scope a memory-proposals item is about (its `route`'s `?scope=`), else `null`. */
export function memoryScopeOf(item: Pick<InboxItem, 'route'>): string | null {
  const route = item.route;
  if (!route) return null;
  const cut = route.indexOf('?');
  if (cut < 0) return null;
  const scope = new URLSearchParams(route.slice(cut)).get('scope');
  return scope && scope !== '' ? scope : null;
}

/** The plan id of a plan's item route (`/plans/<id>`), else `null`. */
export function planIdOf(route: string | null | undefined): string | null {
  const match = route ? /^\/plans\/([^/?#]+)/.exec(route) : null;
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function computerOf(machine: InboxItem['machine'], live: Readonly<Record<string, MachineState>> | undefined): NeedsComputer | null {
  if (!machine) return null;
  const state = live?.[machine.id] ?? machine.state;
  return { id: machine.id, name: machine.name, state: state === 'online' ? 'online' : state === 'reconnecting' ? 'reconnecting' : 'offline' };
}

/** The v2 title of an Inbox item: a question's text, a system item's own title (its kind word in v2 words when it has none). */
function inboxTitle(item: InboxItem, kind: NeedsKind): string {
  if (kind === 'question' || kind === 'multi') {
    const questions = item.questions ?? [];
    if (questions.length === 1) return questions[0]?.text ?? item.title;
  }
  if (kind === 'approval') return item.permission?.description ? 'Wants to run a command' : item.title || 'Wants to run a command';
  if (kind === 'ask') return item.title.replace(/^Waiting for you:\s*/, '') || SYSTEM_LABELS['Waiting for you'] || item.title;
  return item.title;
}

/** One Inbox item as a {@link NeedsItem}. */
export function fromInbox(item: InboxItem, live?: Readonly<Record<string, MachineState>>): NeedsItem {
  const kind = inboxKindOf(item);
  const agentName = item.sourceTitle ?? item.source;
  const base = {
    key: `inbox:${item.id}`,
    id: item.id,
    source: 'inbox' as const,
    kind,
    title: inboxTitle(item, kind),
    createdAt: item.createdAt,
    agent: item.sessionId || item.kind !== 'system' ? { sessionId: item.sessionId, name: agentName } : { sessionId: null, name: SYSTEM_LABELS[item.label] ?? item.source },
    crew: item.teamRole ? { id: null, name: '', teammate: item.teamRole, memberId: '' } : null,
    computer: computerOf(item.machine, live),
    actions: item.actions ?? [],
    route: item.route ?? null,
    url: item.url ?? null,
    inbox: item,
  };
  switch (kind) {
    case 'question':
    case 'multi':
      return { ...base, text: item.detail, questions: item.questions ?? [] };
    case 'approval':
      return { ...base, text: item.permission?.description ?? item.detail, ...(item.context ? { quote: item.context } : {}), ...(commandOf(item.permission) ? { command: commandOf(item.permission) as string } : {}), ...(item.permission ? { permission: item.permission } : {}) };
    case 'ask':
      return { ...base, text: '', quote: item.detail, ...(item.label.endsWith(' · detected') ? { detected: true } : {}) };
    default:
      // D139: an account's "needs you" item carries the terminal command that fixes it.
      return { ...base, text: item.detail, ...(item.command ? { command: item.command } : {}) };
  }
}

/** A crew's own request (`source: team`) as a {@link NeedsItem}; `null` for an Inbox one (merged by id instead). */
export function fromTeam(item: TeamNeedsYouItem): NeedsItem | null {
  if (item.source !== 'team') return null;
  const kind: NeedsKind = item.kind === 'access' ? 'access' : item.kind === 'charter' ? 'jd' : 'approval';
  const crew: NeedsCrew = { id: item.teamId ?? null, name: item.teamName ?? '', teammate: item.memberName, memberId: item.memberId };
  return {
    key: `crew:${item.id}`,
    id: item.id,
    source: 'crew',
    kind,
    title: kind === 'jd' ? `Proposed job description for ${item.memberName}` : item.title,
    text: kind === 'jd' ? '' : item.detail,
    ...(kind === 'jd' && item.charter ? { quote: charterText(item.charter.after) } : {}),
    createdAt: item.createdAt,
    agent: { sessionId: item.sessionRef || null, name: item.memberName },
    crew,
    computer: null,
    actions: [],
    ...(item.request ? { request: item.request } : {}),
    ...(item.charter ? { charter: item.charter } : {}),
  };
}

/** A job description in one paragraph (how it works, what it owns, produces and never does). */
export function charterText(charter: TeamCharter): string {
  const parts = [charter.howItWorks?.trim() || null, charter.owns ? `Owns ${charter.owns}.` : null, charter.produces ? `Produces ${charter.produces}.` : null, charter.neverDoes ? `Never ${charter.neverDoes.replace(/^never\s+/i, '')}.` : null].filter(Boolean);
  return parts.join(' ');
}

/**
 * A proposed note as a {@link NeedsItem}; D135: a proposed edit of an approved note is a
 * `note-edit` (its `quote` the proposed text, `memory.target` the note now), a proposed removal a
 * `note-removal` (its `quote` the note's text).
 */
export function fromNote(entry: MemoryEntry, scopeLabel: string | null, computer: NeedsComputer | null = null): NeedsItem {
  const scope = entry.scopeLabel ? `${scopeLabel ?? 'Folder'} · ${entry.scopeLabel}` : `Folder · ${scopeLabel ?? lastSegment(entry.scope)}`;
  const change = changeKindOf(entry);
  const current = entry.target?.title ?? entry.targetTitle ?? entry.title;
  return {
    key: `notes:${entry.id}`,
    id: entry.id,
    source: 'notes',
    kind: change === 'edit' ? 'note-edit' : change === 'retract' ? 'note-removal' : 'note',
    title: change === 'edit' ? 'Change what agents know?' : change === 'retract' ? 'Remove from what agents know?' : 'Add to what agents know?',
    text: change === 'add' ? entry.title : current,
    quote: entry.text,
    context: scope,
    createdAt: entry.createdAt,
    agent: { sessionId: entry.authorSessionId, name: entry.authorLabel ?? 'An agent' },
    crew: null,
    computer,
    actions: [],
    memory: entry,
  };
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A usage alert as a {@link NeedsItem}. */
export function fromUsage(alert: UsageAlert): NeedsItem {
  return { key: `usage:${alert.key}`, id: alert.key, source: 'usage', kind: 'alert', title: alert.title, text: alert.text, createdAt: alert.createdAt, agent: null, crew: null, computer: null, actions: [] };
}

/** Newest first; equal times keep their order. */
function newestFirst(a: NeedsItem, b: NeedsItem): number {
  return a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1;
}

/**
 * Merges every source into one list, newest first, each item once:
 * - the crew's Inbox items are the Inbox's (same id): they add the crew tag;
 * - a scope's proposed notes replace its memory-proposals summary item;
 * - `hidden` keys (answered here and not yet gone from the server) are left out.
 */
export function mergeNeedsYou(sources: NeedsSources, hidden: ReadonlySet<string> = new Set()): NeedsItem[] {
  const crewByInboxId = new Map<string, TeamNeedsYouItem>();
  for (const item of sources.team ?? []) if (item.source === 'inbox') crewByInboxId.set(item.id, item);
  const out: NeedsItem[] = [];
  const seen = new Set<string>();
  const push = (item: NeedsItem): void => {
    if (seen.has(item.key) || hidden.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  };
  for (const raw of sources.inbox ?? []) {
    let item = fromInbox(raw, sources.computers);
    const crew = crewByInboxId.get(raw.id);
    if (crew) item = { ...item, crew: { id: crew.teamId ?? null, name: crew.teamName ?? '', teammate: crew.memberName, memberId: crew.memberId } };
    if (item.kind === 'note') {
      const scope = memoryScopeOf(raw);
      const entries = scope ? sources.notes[scope] : undefined;
      if (entries && entries.length > 0) {
        for (const entry of entries) if (entry.status === 'proposed') push(fromNote(entry, null, item.computer));
        continue;
      }
    }
    push(item);
  }
  // A crew's Inbox item this page has not read yet still shows (from the crew's copy).
  for (const team of sources.team ?? []) {
    if (team.source === 'inbox' && team.inbox && !seen.has(`inbox:${team.id}`) && !(sources.inbox ?? []).some((raw) => raw.id === team.id)) {
      const raw = team.inbox as InboxItem;
      push({ ...fromInbox(raw, sources.computers), crew: { id: team.teamId ?? null, name: team.teamName ?? '', teammate: team.memberName, memberId: team.memberId } });
    }
    const own = fromTeam(team);
    if (own) push(own);
  }
  for (const alert of sources.usage) push(fromUsage(alert));
  return out.sort(newestFirst);
}

/** The items of one agent (its chat shows them as answer cards). */
export function itemsOfSession(items: readonly NeedsItem[], sessionId: string): NeedsItem[] {
  return items.filter((item) => item.agent?.sessionId === sessionId);
}

/** How many items each crew has (the rail's Crews badge, the crew filters). */
export function countByCrew(items: readonly NeedsItem[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.crew) continue;
    const key = item.crew.id ?? item.crew.name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
