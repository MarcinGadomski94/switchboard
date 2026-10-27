/**
 * D100 · Team (`docs/team.md`, contract → *Team (D100)*): run a set of role agents
 * ("members") from one page. Each member wraps an ordinary Switchboard session. This
 * module holds the wire types and the pure rules shared by the server and the UI:
 * the record shapes (stored in the separate `<dataDir>/team.db` and synced between
 * paired machines), the derived status, the charter text a member's agent gets, the
 * gate kinds and the Needs-you item shape.
 *
 * Everything Team adds lives in `src/core/team*.ts`, `src/server/team/` and
 * `src/web/team/`; `docs/team-removal.md` lists the hooks into the rest.
 */

import type { TeamAccessEntryView } from './team-access.ts';

/**
 * The team every install has, the first team. D100 follow-up 2026-10-14 (multiple
 * teams): it keeps this id and its data; the routes without a team id act on it
 * (compatibility) while it exists, an older peer sees only it. It can be deleted
 * while another team remains (ruling 2026-10-14); the routes then act on the first
 * remaining team in order, and it is only made again on a fresh `team.db`.
 */
export const DEFAULT_TEAM_ID = 'team';

/** D100 follow-up 2026-10-14: the Team page's "All teams" tab (`/team/all`, `GET /api/team/needs-you?teamId=all`); never a team's id. */
export const ALL_TEAMS = 'all';

/** D100 follow-up 2026-10-14: at most this many teams (the sync reads 20). */
export const TEAMS_MAX = 20;

/** Its default name. */
export const DEFAULT_TEAM_NAME = 'Team';

/** A member's role name / a team's name: 1–40 characters, one line. */
export const TEAM_NAME_MAX = 40;

/** Each charter field (owns / produces / how it works / never does): at most this many characters. */
export const CHARTER_FIELD_MAX = 2_000;

/**
 * D105 · how long an unanswered charter ask (`POST /api/team/members/{id}/charter/ask`)
 * blocks a new one: after this the ask counts as lapsed and a new ask replaces it.
 */
export const CHARTER_ASK_STALE_MS = 24 * 3600_000;

/** D105 · a charter proposal's `notes` (`team_propose_charter`): at most this many characters. */
export const CHARTER_NOTES_MAX = 2_000;

/** A hand-off's brief and expected result: at most this many characters each. */
export const HANDOFF_TEXT_MAX = 4_000;

/** A report line (`team_report`): at most this many characters. */
export const REPORT_MAX = 500;

/** The activity feed keeps the newest this many entries per team (older ones are dropped). */
export const ACTIVITY_CAP = 500;

/** Members per team. */
export const MEMBERS_MAX = 30;

// ── gates ────────────────────────────────────────────────────────────────

/**
 * The action kinds a member can need the developer for ("needs you for"). A gated
 * action becomes a Needs-you request the developer approves or declines.
 * `outward-facing` (anything that leaves this computer: a push, a PR, a comment, a
 * message, an external write) is always on and cannot be removed.
 */
export const GATE_KINDS = ['outward-facing', 'merge-default-branch', 'external-write', 'delete-data', 'release', 'spend'] as const;

/** A gate kind. */
export type TeamGateKind = (typeof GATE_KINDS)[number];

/** The gate that is always on. */
export const ALWAYS_ON_GATE: TeamGateKind = 'outward-facing';

/** How each gate kind reads ("Needs you for: …"). */
export const GATE_LABELS: Readonly<Record<TeamGateKind, string>> = {
  'outward-facing': 'anything outward-facing',
  'merge-default-branch': 'merging into a protected or default branch',
  'external-write': 'writes to external tools (issue trackers, wikis)',
  'delete-data': 'deleting data',
  release: 'releases and deployments',
  spend: 'spending money',
};

/** `true` for a {@link TeamGateKind}. */
export function isGateKind(value: unknown): value is TeamGateKind {
  return typeof value === 'string' && (GATE_KINDS as readonly string[]).includes(value);
}

/** A member's gates as stored: the given ones (unknown dropped, no duplicates) with {@link ALWAYS_ON_GATE} always first. */
export function normalizeGates(value: unknown): TeamGateKind[] {
  const given = Array.isArray(value) ? value.filter(isGateKind) : [];
  return [ALWAYS_ON_GATE, ...GATE_KINDS.filter((kind) => kind !== ALWAYS_ON_GATE && given.includes(kind))];
}

/** Branch names a merge into is "into a protected or default branch" (the `merge-default-branch` gate). */
export const PROTECTED_BRANCH = /^(?:main|master|trunk|develop|dev|release(?:[/-].*)?)$/;

// ── records ──────────────────────────────────────────────────────────────

/** What a member is for (shown on its card and given to its agent). */
export interface TeamCharter {
  /** What it owns ("the board of PROJ tickets"). */
  readonly owns: string;
  /** What it produces ("a daily status note"). */
  readonly produces: string;
  /** What it never does ("never merges", "never writes to the tracker"). */
  readonly neverDoes: string;
  /**
   * D105 · how it works today, in a short paragraph ("runs feedback rounds on input
   * from the developer and the testers, then adjusts the feature"). Optional and
   * additive: absent (or empty) on older records and templates.
   */
  readonly howItWorks?: string;
}

/** One Switchboard loop (D94) in a member's rhythm. The loop id is the session's; prompt and schedule find it again after a move. */
export interface TeamRhythmLoop {
  readonly loopId: string;
  readonly label: string | null;
  readonly prompt: string;
  readonly scheduleText: string;
}

/** When a member works: its Switchboard loops and / or whenever a hand-off arrives. */
export interface TeamRhythm {
  readonly loops: readonly TeamRhythmLoop[];
  /** A new hand-off is sent to the member's agent as a message (else it only lands in its todo list). */
  readonly onHandoff: boolean;
}

/** A member's share of the daily usage. */
export interface TeamBudget {
  /** % of the account's daily allowance (a seventh of the weekly window) the member may use per day; `null` = no budget. */
  readonly dailyPct: number | null;
  /** The account profile (D63) it runs on; `null` = the session's own. */
  readonly profileId: string | null;
}

/** Where a member works. */
export interface TeamWorkplace {
  /** Folders or solutions (paths or names, as given); empty = none. */
  readonly folders: readonly string[];
}

/** Where the session sat in the sidebar (D54 / D71) when it was adopted; put back on return. */
export interface TeamOriginalPlace {
  readonly place: 'pinned' | 'folder' | 'loose' | 'none';
  readonly folderId: string | null;
  /** Its index in that group (the whole loose list for `loose`). */
  readonly index: number | null;
}

/**
 * T2 seam (access requests): one access a member uses (a token, a login, a tool's
 * credential). Secrets never travel and are never part of sync: only the entry's
 * name and where it is set up. After a move the entry reads "needs setup on <PC>".
 */
export interface TeamAccessEntry {
  readonly id: string;
  readonly name: string;
  /** The machine ids it is set up on. */
  readonly setUpOn: readonly string[];
}

/** A member as stored and synced (`team.db`, LWW by {@link TeamSynced.clock}). */
export interface TeamMemberRecord extends TeamSynced {
  readonly id: string;
  readonly teamId: string;
  /** The role name ("Tracker"). */
  readonly name: string;
  readonly charter: TeamCharter;
  /** T3: a charter an agent drafted for the developer to accept; `null` = none. */
  readonly charterDraft: TeamCharter | null;
  readonly templateId: string | null;
  /** The machine (D48 id) whose session it wraps: the member runs there. */
  readonly machineId: string;
  /** That machine's own id of the session. */
  readonly sessionId: string;
  readonly workplace: TeamWorkplace;
  /** D82 routing fields where they exist: the model / effort / CLI the member was set up with (`null` = the session's). */
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly rhythm: TeamRhythm;
  readonly budget: TeamBudget;
  readonly gates: readonly TeamGateKind[];
  readonly paused: boolean;
  /** The loop ids Team paused (pause or budget); resumed by Resume, and only those. */
  readonly pausedLoops: readonly string[];
  /** Why it is paused: the developer, or its budget (`null` while running). */
  readonly pausedBy: 'developer' | 'budget' | null;
  /** CLI-run `/loop` / CronCreate jobs found at adoption: Switchboard cannot manage them (the UI offers to recreate them as Switchboard loops). */
  readonly cliLoops: readonly string[];
  readonly originalPlace: TeamOriginalPlace;
  /** T2 seam. */
  readonly access: readonly TeamAccessEntry[];
  /**
   * D100 follow-up 2026-10-14: its place in the team's order (cards strip, sidebar
   * lists, `team_members`), ascending; `null` = not known (an older peer's record),
   * sorted after the ordered ones by creation ({@link byOrder}).
   */
  readonly order: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The sync fields every shared record has. */
export interface TeamSynced {
  /** Hybrid logical clock (`core/hlc.ts`) of the last write: last writer wins. */
  readonly clock: string;
  /** A tombstone (removed members / hand-offs stay as deleted so the removal syncs). */
  readonly deleted: boolean;
}

/** The team itself. */
export interface TeamRecord extends TeamSynced {
  readonly id: string;
  readonly name: string;
  /** D100 follow-up 2026-10-14: its place among the teams (ascending); `null` = not known (an older peer's record). */
  readonly order: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A hand-off's state. */
export type HandoffState = 'open' | 'accepted' | 'done' | 'declined';

/** The values of {@link HandoffState}. */
export const HANDOFF_STATES: readonly HandoffState[] = ['open', 'accepted', 'done', 'declined'];

/** A written work item from one member to another. It becomes a todo (D68) in the receiver's session. */
export interface TeamHandoffRecord extends TeamSynced {
  readonly id: string;
  readonly teamId: string;
  /** The sender: a member id, or `null` for the developer. */
  readonly fromMemberId: string | null;
  readonly toMemberId: string;
  readonly brief: string;
  readonly expected: string;
  readonly state: HandoffState;
  readonly links: readonly string[];
  /** The todo made in the receiver's session (its machine makes it); `null` until then. */
  readonly todoId: string | null;
  /** When the receiver's agent was told (rhythm "on hand-off"); `null` = not yet. */
  readonly notifiedAt: string | null;
  /** D99 seam: the Plans item this hand-off belongs to (`null` = none). Plans fills it later. */
  readonly planRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a Needs-you request of Team is about. `access` is T2's; D105 `charter`: a member's charter ask and its proposal. */
export type TeamRequestKind = 'gate' | 'budget' | 'access' | 'charter';

/** A request's state. */
export type TeamRequestState = 'open' | 'approved' | 'declined' | 'dismissed';

/** A Team-specific Needs-you item (a gated action, an exceeded budget, later an access request). */
export interface TeamRequestRecord extends TeamSynced {
  readonly id: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly kind: TeamRequestKind;
  /** A gate request's gate kind; `null` for the others. */
  readonly gate: TeamGateKind | null;
  readonly title: string;
  readonly detail: string;
  readonly state: TeamRequestState;
  /** What runs on approval (the machine of the member runs it), e.g. `{ type: 'resume-member' }`. */
  readonly action: TeamRequestAction | null;
  /** The result of the approved action, or the reason it failed. */
  readonly note: string | null;
  /**
   * D105, `kind: charter`: the charter the member's agent proposed (`team_propose_charter`);
   * `null` (or absent) while the ask waits for it. Its notes are the request's `detail`.
   */
  readonly proposal?: TeamCharter | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What an approved request runs. */
export type TeamRequestAction = { readonly type: 'resume-member' } | { readonly type: 'external'; readonly ref: string };

/** Activity kinds. */
export const ACTIVITY_KINDS = ['handoff', 'adopt', 'create', 'return', 'pause', 'resume', 'report', 'approval', 'budget', 'move', 'update', 'team', 'access'] as const;

/** An activity kind. */
export type TeamActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One activity line (the feed; synced as a union, capped). */
export interface TeamActivityRecord {
  readonly id: string;
  readonly teamId: string;
  readonly at: string;
  readonly kind: TeamActivityKind;
  readonly memberId: string | null;
  readonly text: string;
}

// ── API shapes ───────────────────────────────────────────────────────────

/** A member's derived status. */
export type TeamMemberStatus = 'working' | 'needs-you' | 'idle' | 'paused' | 'offline';

/** A member as the API answers it (the record + what this machine derives). */
export interface TeamMember extends Omit<TeamMemberRecord, 'clock' | 'deleted'> {
  readonly status: TeamMemberStatus;
  /** How this machine addresses the session: its own id, or `r~<machine>~<id>` for a paired machine's. */
  readonly sessionRef: string;
  /** The session's display title, when known. */
  readonly sessionTitle: string | null;
  readonly machineName: string;
  /** `true` when it runs on this machine. */
  readonly local: boolean;
  /** CLI loops exist that Switchboard cannot manage (offer to recreate them as Switchboard loops). */
  readonly cliLoopsUnmanaged: boolean;
  /** Its use today, % of its account's daily allowance (`null` = unknown or no budget). */
  readonly usedTodayPct: number | null;
  /** D105: its open charter ask or proposal (`null` = none); additive, absent from older machines. */
  readonly charterRequest?: TeamCharterRequestView | null;
  /** 2026-10-16: the subagents it waits on while its main turn is over (`0` = none); additive. */
  readonly subagents?: number;
  /**
   * 2026-10-16: with its main turn over and no subagent working, the background work it
   * waits on (`github`: a GitHub Actions wait; `background`: another background task;
   * `wakeup`: a scheduled wake-up, at {@link wakeAt}); `null` / absent = none. Additive.
   */
  readonly waitingOn?: TeamWaitKind | null;
  /** 2026-10-16: `waitingOn: 'wakeup'`: when it wakes up (ISO); additive. */
  readonly wakeAt?: string | null;
  /**
   * 2026-10-27 (D137 follow-up, the developer chose B): its session is archived (closed). It
   * stays a member (role, charter, order and the archive's "Kept: a Team member" hold
   * untouched) but the crew views hide it until it is restored, and it gets no new work.
   * Additive: absent from an older machine = not archived.
   */
  readonly archived?: boolean;
}

/** 2026-10-16: the background work a member waits on besides subagents (`docs/team.md` → *Waiting on background work*). */
export type TeamWaitKind = 'github' | 'background' | 'wakeup';

/** D105 · a member's open charter request as the UI sees it. */
export interface TeamCharterRequestView {
  readonly requestId: string;
  /** `asked`: its agent was asked and has not proposed yet; `proposed`: a proposal waits for the developer. */
  readonly state: 'asked' | 'proposed';
  readonly proposal: TeamCharter | null;
  /** The agent's notes for the developer ('' = none). */
  readonly notes: string;
  /** When it was asked (or when the proposal came, without an ask). */
  readonly at: string;
}

/** `GET /api/team/state`: the switch and what the sidebar hides (always answered, also while Team is off). */
export interface TeamState {
  readonly enabled: boolean;
  /** `false` while off, or when `team.db` cannot be opened (then nothing is hidden). */
  readonly available: boolean;
  /** Why it is not available while on (`team.db` broken), else `null`. */
  readonly problem: string | null;
  /** Sessions the sidebar leaves out (members' sessions, this machine's ids and `r~…` ids). Empty unless available. */
  readonly hiddenSessionIds: readonly string[];
  /** Role name per hidden session id (search, Inbox and notifications label member sessions with it). */
  readonly roles: Readonly<Record<string, string>>;
}

/** D100 follow-up 2026-10-14 · one team in `GET /api/team/teams` (in the teams' order). */
export interface TeamSummary {
  readonly id: string;
  readonly name: string;
  readonly order: number | null;
  /** Its members (archived ones included: see {@link archived}). */
  readonly members: number;
  /** Its members that need the developer (the session waits, or Needs-you items are open); archived members never count. */
  readonly needsYou: number;
  /** 2026-10-27 (D137 follow-up): how many of its members are archived (hidden from the crew views); additive, absent = 0. */
  readonly archived?: number;
  /**
   * D100 follow-up 2026-10-16 (the sidebar's member rows): its members in the team's
   * order, each with its status and what it works on. Additive: absent from an older
   * answer (the sidebar then lists nothing under the team).
   */
  readonly roster?: readonly TeamRosterEntry[];
  /** D100 follow-up 2026-10-16: the sidebar shows the team folded to its row (remembered per install; absent / `false` = expanded). */
  readonly collapsed?: boolean;
}

/**
 * D100 follow-up 2026-10-16 · what a member works on now, as the sidebar's member row
 * names it: its todo in progress, else the item its session runs (a todo run, a plan
 * item); `key` = the plan item's ticket key (`PROJ-14`) when it has one.
 */
export interface TeamCurrentItem {
  readonly title: string;
  readonly key: string | null;
}

/** D100 follow-up 2026-10-16 · one member as the sidebar lists it under its team (`TeamSummary.roster`). */
export interface TeamRosterEntry {
  readonly id: string;
  /** The role name. */
  readonly name: string;
  /** As the card shows it: `needs-you` also while Needs-you items of it are open (offline / paused win). */
  readonly status: TeamMemberStatus;
  /** How this machine addresses its session. */
  readonly sessionRef: string;
  readonly machineName: string;
  readonly local: boolean;
  /** While working: its current item when known (this machine's members only), else `null`. */
  readonly current: TeamCurrentItem | null;
  /** While working: when the running turn started (ISO; while it waits on subagents, when the oldest of them started), else `null`. */
  readonly turnStartedAt: string | null;
  /** 2026-10-16: while working with its main turn over, the subagents it waits on (`0` / absent = none). */
  readonly subagents?: number;
  /** 2026-10-16: while working with its main turn over and no subagent working, the background work it waits on (`null` / absent = none). */
  readonly waitingOn?: TeamWaitKind | null;
  /** 2026-10-16: `waitingOn: 'wakeup'`: when it wakes up (ISO). */
  readonly wakeAt?: string | null;
  /** The session's last activity (ISO; an idle member's "idle · 2h"), `null` when unknown. */
  readonly lastActivityAt: string | null;
  /** 2026-10-27 (D137 follow-up): its session is archived; the views leave it out (additive, absent = no). */
  readonly archived?: boolean;
}

/** `GET /api/team`. */
export interface TeamView {
  readonly team: { readonly id: string; readonly name: string };
  readonly self: { readonly id: string; readonly name: string };
  readonly members: readonly TeamMember[];
  readonly handoffs: readonly TeamHandoff[];
  /** Newest first (the newest 100; `GET /api/team/activity` pages the rest). */
  readonly activity: readonly TeamActivityRecord[];
  /**
   * D105 · the one-time "Draft better charters" offer: how many members (every team)
   * have a template-only charter and no open charter request; `0` once the developer
   * acted on it or chose Not now (remembered per install). Additive.
   */
  readonly charterOffer?: number;
}

/** A hand-off as the API answers it. */
export type TeamHandoff = Omit<TeamHandoffRecord, 'clock' | 'deleted'>;

/** A Team request as the API answers it. */
export type TeamRequest = Omit<TeamRequestRecord, 'clock' | 'deleted'>;

/** One item of `GET /api/team/needs-you`. */
export interface TeamNeedsYouItem {
  /** The Inbox item's id (`source: inbox`) or the request's (`source: team`). */
  readonly id: string;
  readonly source: 'inbox' | 'team';
  /** `questions` / `permission` / `system` (from the Inbox), `gate` / `budget` / `access` (Team's). */
  readonly kind: string;
  readonly memberId: string;
  readonly memberName: string;
  /** "Tracker · question". */
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly createdAt: string;
  /** The member's session (how this machine addresses it). */
  readonly sessionRef: string;
  /** `source: inbox`: the Inbox item as `GET /api/inbox` lists it (answer it through the Inbox routes). */
  readonly inbox?: unknown;
  /** D100 follow-up 2026-10-14: the member's team (the All tab labels the item with it); additive. */
  readonly teamId?: string;
  readonly teamName?: string;
  /** `source: team`: the request (approve / decline through `/api/team/requests/{id}/…`). */
  readonly request?: TeamRequest;
  /** D100-T2, `kind: access`: the access asked for (service, host, why, scope, fields, warning); "Set up…" opens the member's Access tab. */
  readonly access?: TeamAccessEntryView;
  /** D105, `kind: charter`: the member's charter now and the proposal (Accept / Edit… / Dismiss). */
  readonly charter?: { readonly before: TeamCharter; readonly after: TeamCharter; readonly notes: string };
}

/** What a suggestion is based on (cheap counts over the last 7 days; `src/server/team/suggestions.ts`). */
export interface SuggestionEvidence {
  /** Repositories the session works in (its solutions, else its folder). */
  readonly repos: number;
  /** Its Switchboard loops (D94) that have not ended. */
  readonly loops: number;
  /** Its CLI-run loops (`/loop`, CronCreate…), which Switchboard cannot manage. */
  readonly cliLoops: number;
  /** Events in the last 7 days. */
  readonly events7d: number;
  readonly edits: number;
  readonly reads: number;
  /** edits / (edits + reads), `null` without either. */
  readonly editRatio: number | null;
  /** Planning calls (todo lists, plan mode, Switchboard todos and hand-offs); additive, absent from older machines. */
  readonly planning?: number;
  /** Days with at least one event in the last 7 (edits per active day); additive, absent from older machines. */
  readonly activeDays?: number;
}

/** How sure a suggestion is: the title and the behaviour agree = high; only one of them = medium; weak = low. */
export type SuggestionConfidence = 'high' | 'medium' | 'low';

/** One candidate member (`GET /api/team/suggestions`): only sessions whose evidence matches a template's pattern. */
export interface TeamSuggestion {
  readonly sessionId: string;
  readonly title: string;
  readonly folder: string | null;
  readonly evidence: SuggestionEvidence;
  /** The template it looks like (a heuristic). */
  readonly templateId: string;
  /** Why, in one line (names the title's words and / or the behaviour it is based on). */
  readonly reason: string;
  /** How sure the heuristic is (`classifySuggestion`); additive, absent from older machines (the Team page then derives one). */
  readonly confidence?: SuggestionConfidence;
  /** Higher = a better candidate (events, loops). */
  readonly score: number;
  /** A drafted charter; always `null` from the server: the Team page drafts one on demand (`src/web/team/charter-draft.ts`). */
  readonly charterDraft: TeamCharter | null;
}

/** A move of a member to another machine (`POST /api/team/members/{id}/move`, `GET /api/team/moves/{runId}`). */
export interface TeamMoveRun {
  readonly id: string;
  readonly memberId: string;
  readonly state: 'running' | 'done' | 'failed';
  /** The take-over run (D65) behind it. */
  readonly takeoverRunId: string | null;
  readonly error: string | null;
  readonly targetMachineId: string;
}

/** `teamChanged` (`/hub`): something of the team changed; the page reads `GET /api/team` again. */
export interface TeamChanged {
  readonly teamId: string;
  /** What changed (a hint, not a contract): `members`, `handoffs`, `activity`, `requests`, `state`. */
  readonly what: readonly string[];
}

// ── rules ────────────────────────────────────────────────────────────────

/**
 * D100 follow-up 2026-10-14 · the stored order of members (or teams): by `order`
 * ascending, records without one (`null`: an older peer's) after them by creation,
 * then by id (stable on every machine). Returns a new array.
 */
export function byOrder<T extends { readonly id: string; readonly order: number | null; readonly createdAt: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => {
    if (a.order !== b.order) {
      if (a.order === null) return 1;
      if (b.order === null) return -1;
      return a.order - b.order;
    }
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

/**
 * A new order from a body's ids (`PUT /api/team/order`, `PUT /api/team/teams/order`):
 * the given ids first, in their order, then the current ones the body left out (one
 * added meanwhile) in their current order. `null` when the body names an unknown id
 * or one twice.
 */
export function reorderIds(current: readonly string[], wanted: unknown): string[] | null {
  if (!Array.isArray(wanted) || wanted.length > 1_000 || !wanted.every((id) => typeof id === 'string')) return null;
  const known = new Set(current);
  const seen = new Set<string>();
  for (const id of wanted as string[]) {
    if (!known.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return [...(wanted as string[]), ...current.filter((id) => !seen.has(id))];
}

/** The next `order` at the end of `records` (max + 1, `0` for none). */
export function nextOrder(records: readonly { readonly order: number | null }[]): number {
  return records.reduce((max, record) => (record.order !== null && record.order >= max ? record.order + 1 : max), 0);
}

/** The session statuses (`SessionStatus`) a status is derived from. */
export type SessionStatusLike = 'need' | 'run' | 'done' | 'fail' | 'idle' | 'paused';

/**
 * A member's status: `offline` when its machine is not reachable (or the session is
 * gone), `needs-you` while its session waits for the developer, `paused` while Team
 * paused it, `working` while a turn runs **or its subagents still work** (2026-10-16:
 * the main turn is over, async agents / a workflow are not; an older machine's session
 * may read `done` meanwhile) **or it waits on background work** (2026-10-16: a GitHub
 * Actions wait, another background task, a wake-up: `waiting`), else `idle`.
 */
export function memberStatus(input: {
  readonly reachable: boolean;
  readonly sessionStatus: SessionStatusLike | null;
  readonly paused: boolean;
  readonly subagents?: number;
  readonly waiting?: boolean;
}): TeamMemberStatus {
  if (!input.reachable || input.sessionStatus === null) return 'offline';
  if (input.sessionStatus === 'need') return 'needs-you';
  if (input.paused) return 'paused';
  if (input.sessionStatus === 'run') return 'working';
  if (((input.subagents ?? 0) > 0 || input.waiting === true) && input.sessionStatus !== 'paused') return 'working';
  return 'idle';
}

/**
 * 2026-10-27 (D137 follow-up, the developer chose B) · why an archived member gets no new
 * work: hand-offs to it, charter asks, "for all members" actions (409 `closed`, the same
 * code as a closed session's other refusals; UI words: archive / restore).
 */
export function archivedMemberText(name: string): string {
  return `${name}'s session is archived: restore it first`;
}

/**
 * 2026-10-27 · a member's session counts as archived when it is closed by the developer: a
 * session closed because it was taken over to another machine (D65 `movedTo`, a member's move)
 * is not archived, it continues there.
 */
export function memberSessionArchived(session: { readonly closedAt?: string | null; readonly movedTo?: unknown }): boolean {
  return session.closedAt !== null && session.closedAt !== undefined && !session.movedTo;
}

/** The members the crew views show: the ones whose session is not archived (2026-10-27). */
export function shownMembers<T extends { readonly archived?: boolean }>(members: readonly T[]): T[] {
  return members.filter((member) => member.archived !== true);
}

/**
 * D100 follow-up 2026-10-14 · a hand-off's receiver as written: "Developer" (in the
 * caller's own team) or "Developer (Growth)" (that team, by name). The team in
 * parentheses is only taken as one when `teams` has it, so a role name that itself
 * ends in parentheses still works.
 */
export function parseHandoffTarget(to: string, teams: readonly string[]): { readonly name: string; readonly team: string | null } {
  const match = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(to.trim());
  if (match) {
    const team = (match[2] as string).trim();
    if (teams.some((name) => name.toLowerCase() === team.toLowerCase())) return { name: (match[1] as string).trim(), team };
  }
  return { name: to.trim(), team: null };
}

/** One charter field, or `—` when empty. */
function charterLine(value: string): string {
  const text = value.trim();
  return text === '' ? '—' : text;
}

/**
 * The text a member's agent gets with its standing instruction (D64's mechanism:
 * appended at every spawn of its CLI): "You are now <role> in team <team>. Charter: …".
 * D105: "How it works: …" when the charter has it.
 */
export function charterInstruction(role: string, team: string, charter: TeamCharter, gates: readonly TeamGateKind[]): string {
  const needs = normalizeGates(gates).map((kind) => GATE_LABELS[kind]).join('; ');
  const how = (charter.howItWorks ?? '').trim().replace(/[.!?]+$/, '');
  return [
    `You are now ${role} in team ${team}. Charter: owns: ${charterLine(charter.owns)}. Produces: ${charterLine(charter.produces)}.${how === '' ? '' : ` How it works: ${how}.`} Never does: ${charterLine(charter.neverDoes)}.`,
    `Ask the developer before: ${needs}.`,
    'Work arrives as hand-offs in your todo list. Use team_members to see the team, team_handoff to give another member work, and team_report to post a short status line. Save deliverables with artifact_save.',
  ].join(' ');
}

/** The note a returned session's agent gets: its role ended. */
export function returnNote(role: string, team: string): string {
  return `You are no longer ${role} in team ${team}: that charter no longer applies. Carry on as a plain session.`;
}

/** "Tracker · question". */
export function needsYouLabel(memberName: string, kind: string): string {
  // D124: `waiting` = its turn ended waiting for the developer (the "Waiting for you" Inbox item).
  const what: Record<string, string> = { questions: 'question', permission: 'permission', system: 'system', waiting: 'waiting for you', gate: 'approval', budget: 'budget', access: 'access', charter: 'charter' };
  return `${memberName} · ${what[kind] ?? kind}`;
}

/** A role or team name, trimmed to one line; `null` when empty or too long. */
export function checkTeamName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' || text.length > TEAM_NAME_MAX ? null : text;
}

/** A charter from a body (`null` for anything that is not one; each field ≤ {@link CHARTER_FIELD_MAX}). */
export function readCharter(value: unknown): TeamCharter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const field = (key: string): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) return '';
    return typeof raw === 'string' && raw.length <= CHARTER_FIELD_MAX ? raw.trim() : null;
  };
  const owns = field('owns');
  const produces = field('produces');
  const neverDoes = field('neverDoes');
  // D105: optional; kept only when it says something (so older charters read the same).
  const howItWorks = field('howItWorks');
  if (owns === null || produces === null || neverDoes === null || howItWorks === null) return null;
  return howItWorks === '' ? { owns, produces, neverDoes } : { owns, produces, howItWorks, neverDoes };
}

/** D105 · `true` when two charters say the same (each field trimmed; an absent `howItWorks` = empty). */
export function sameCharter(a: TeamCharter, b: TeamCharter): boolean {
  const f = (c: TeamCharter): string[] => [c.owns, c.produces, c.howItWorks ?? '', c.neverDoes].map((v) => v.trim());
  return f(a).every((value, index) => value === f(b)[index]);
}

/**
 * D105 · the message Switchboard sends a member's own session to ask for a specific
 * charter (`docs/team.md` → *Better charters*). It names the role, the team and the
 * charter it has now, and asks the agent to summarise its own work and call
 * `team_propose_charter` once. A normal message: it is queued while a turn runs and
 * held while new turns pause (D103), like any other.
 */
export function charterAskText(role: string, team: string, charter: TeamCharter): string {
  const how = (charter.howItWorks ?? '').trim();
  return [
    `Switchboard asks you, ${role} in team ${team}, to draft a specific charter for yourself. Your charter now is:`,
    `- owns: ${charterLine(charter.owns)}`,
    `- produces: ${charterLine(charter.produces)}`,
    `- how it works: ${how === '' ? '—' : how}`,
    `- never does: ${charterLine(charter.neverDoes)}`,
    '',
    'First summarise for yourself what you have done in this session so far. Then call team_propose_charter once, with:',
    '- owns: the specific feature, product area and repositories you are responsible for (name them);',
    '- produces: what you actually deliver and where (commits and branches, pull requests, reports, notes, hand-offs);',
    '- howItWorks: how you work today: your rounds and cadence, the inputs you work from, and who gives you feedback (the developer, other people, other members);',
    '- neverDoes: what you must never do, including working outside your repositories;',
    '- notes (optional): anything the developer should know when reviewing it.',
    '',
    "Base every line on this session's history and keep within your repositories; never invent a responsibility the history does not show. It is a proposal: the developer reviews it and nothing changes until it is accepted. Do no other work for this message.",
  ].join('\n');
}

/** An empty charter. */
export const EMPTY_CHARTER: TeamCharter = { owns: '', produces: '', neverDoes: '' };

/** No budget. */
export const NO_BUDGET: TeamBudget = { dailyPct: null, profileId: null };

/** A budget from a body (`null` when malformed; `dailyPct` a whole number 1–100 or `null`). */
export function readBudget(value: unknown): TeamBudget | null {
  if (value === undefined || value === null) return NO_BUDGET;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pct = record['dailyPct'];
  const profile = record['profileId'];
  if (pct !== undefined && pct !== null && !(typeof pct === 'number' && Number.isInteger(pct) && pct >= 1 && pct <= 100)) return null;
  if (profile !== undefined && profile !== null && !(typeof profile === 'string' && profile !== '' && profile.length <= 100)) return null;
  return { dailyPct: typeof pct === 'number' ? pct : null, profileId: typeof profile === 'string' ? profile : null };
}

/** A rhythm from a body (`null` when malformed). Loops are named by id (resolved against the session's loops by the server). */
export function readRhythmInput(value: unknown): { readonly loopIds: readonly string[]; readonly onHandoff: boolean } | null {
  if (value === undefined || value === null) return { loopIds: [], onHandoff: true };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const loops = record['loopIds'] ?? [];
  if (!Array.isArray(loops) || !loops.every((id) => typeof id === 'string' && id !== '' && id.length <= 100) || loops.length > 50) return null;
  const onHandoff = record['onHandoff'];
  if (onHandoff !== undefined && typeof onHandoff !== 'boolean') return null;
  return { loopIds: [...new Set(loops as string[])], onHandoff: onHandoff !== false };
}

/** A workplace from a body (`null` when malformed). */
export function readWorkplace(value: unknown): TeamWorkplace | null {
  if (value === undefined || value === null) return { folders: [] };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const folders = (value as Record<string, unknown>)['folders'] ?? [];
  if (!Array.isArray(folders) || folders.length > 20 || !folders.every((f) => typeof f === 'string' && f.trim() !== '' && f.length <= 1_000)) return null;
  return { folders: (folders as string[]).map((f) => f.trim()) };
}

/** A hand-off's links from a body (`null` when malformed: at most 20 strings of ≤ 2,000 characters). */
export function readLinks(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((l) => typeof l === 'string' && l.trim() !== '' && l.length <= 2_000)) return null;
  return (value as string[]).map((l) => l.trim());
}
