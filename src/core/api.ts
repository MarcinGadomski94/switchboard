/**
 * Wire types of the local API (`docs/handoff/contracts/local-api.md`), shared by
 * the server (route modules, providers) and the UI (`src/web/api/client.ts`).
 * JSON, camelCase.
 *
 * The contract names most response types without spelling out their fields. The
 * fields below come from the contract where it has them (`NewSession`, the
 * `/api/system` shape, the hub payloads), otherwise from the ARCHITECTURE data
 * model, otherwise from what the prototype shows. Types marked **provisional**
 * belong to the backlog item named on them (`docs/lanes.md`): that item may
 * refine them, additively where it can, and must keep the server and the UI in
 * step because both import this file.
 */
import type { SessionChip } from './derive/chips.ts';
import type {
  AgentKind,
  ArtifactType,
  Coordination,
  EventKind,
  Phase,
  QaStack,
  QuestionState,
  ScheduleRunResult,
  SessionMode,
  SessionStatus,
  WorkType,
} from './model.ts';

export type { SessionChip } from './derive/chips.ts';

/** `POST /api/sessions` body (contract, locked). `coordination` is `null` when not applicable. */
export interface NewSession {
  readonly name: string;
  readonly task: string;
  readonly workType: WorkType;
  readonly mode: SessionMode;
  readonly solutions: readonly string[];
  readonly phase: Phase;
  readonly coordination: Coordination | null;
  /** Required when `workType` is `qa`. */
  readonly qa?: { readonly stack: QaStack; readonly confluenceUrl: string; readonly figmaUrls: readonly string[] } | null;
  readonly worktrees: boolean;
  readonly ultracode: boolean;
}

/**
 * Additive (M3.3): values the New-session modal opens with instead of its defaults,
 * e.g. from an Inbox item's "Open fix session" action. Any field may be missing.
 */
export type NewSessionPrefill = { readonly [K in keyof NewSession]?: NewSession[K] };

/** An agent of a session (data model; gap #8). Provisional: M2.1 / M4.3. */
export interface Agent {
  readonly id: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly description: string | null;
  readonly solutionPath: string | null;
  readonly branch: string | null;
  readonly status: SessionStatus;
  /** Short status copy ("asked 1", "Tier A green"). */
  readonly statusText: string | null;
}

/** `GET /api/sessions` item: a session with its agents and open question count. Provisional: M4.1. */
export interface Session {
  readonly id: string;
  readonly name: string;
  readonly claudeSessionId: string;
  readonly status: SessionStatus;
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly coordination: Coordination | null;
  readonly qaStack: QaStack | null;
  readonly ultracode: boolean;
  readonly worktrees: boolean;
  readonly solutions: readonly string[];
  readonly attached: boolean;
  readonly createdAt: string;
  /** Last activity (drives the sidebar age); `null` before the first event. */
  readonly lastActivityAt: string | null;
  readonly agents: readonly Agent[];
  readonly openQuestionCount: number;
  /** Additive (M4.1): the folder the session's process runs in (the workspace root), `null` before its first spawn. */
  readonly cwd: string | null;
  /** Additive (M4.1): the session has a live supervised `claude` process (Pause applies; else Resume). */
  readonly live: boolean;
  /** Additive (M4.1): `claude --resume <claudeSessionId>`, the handoff card's command (prototype copy, M0.4). */
  readonly resumeCommand: string;
  /** Additive (M4.1): the header chips (`src/core/derive/chips.ts`). */
  readonly chips: readonly SessionChip[];
}

/** A session event (data model). Drives the chat, the timeline and the terminal tail. Provisional: M2.1. */
export interface SessionEvent {
  readonly id: number;
  readonly sessionId: string;
  /** The agent's id, `null` for session-level events. */
  readonly agentId: string | null;
  readonly ts: string;
  readonly endTs: string | null;
  readonly kind: EventKind;
  readonly label: string;
  /** One of the `EventPayload` shapes in `event-payload.ts` (`payload.type`; `docs/derivations.md`). */
  readonly payload: unknown;
}

/** One changed file (gap #10). Provisional: M4.5. */
export interface FileDiff {
  /** Solution name (e.g. `billing-front`), or `root` for workspace-root files. */
  readonly solution: string;
  /** Path inside the solution. */
  readonly path: string;
  readonly branch: string | null;
  readonly added: number;
  readonly removed: number;
  /** Unified diff body lines, each starting with `+`, `-` or a space. */
  readonly lines: readonly string[];
}

/** A stored artifact (data model; gap #9). Provisional: M4.6 / M7.3. */
export interface Artifact {
  readonly id: string;
  readonly type: ArtifactType;
  readonly name: string;
  readonly solution: string | null;
  readonly branch: string | null;
  readonly sessionId: string | null;
  readonly meta: string | null;
  readonly createdAt: string;
}

/** `GET /api/sessions/{id}`. Provisional: M4.1. */
export interface SessionDetail extends Session {
  readonly task: string;
  readonly events: readonly SessionEvent[];
  readonly files: readonly FileDiff[];
  readonly artifacts: readonly Artifact[];
  /**
   * Additive (M4.2): the questions of every batch the session asked, batches oldest
   * first and each batch's questions in order. The chat shows a batch that still
   * waits (open, or stale and unanswered) as the inline question card and an
   * answered one as the answers bubble (`docs/chat.md`).
   */
  readonly questions: readonly Question[];
}

/** `{ resumeCommand }` of `/detach` and `/attach` (contract). */
export interface ResumeCommand {
  readonly resumeCommand: string;
}

/** Additive (M4.1): optional body of `POST /api/sessions/{id}/attach`. */
export interface AttachRequest {
  /** Attach even though the warning below applies (the developer confirmed it). */
  readonly confirm?: boolean;
}

/**
 * Why "Attach here" asks first (M4.1, gap #5, M0.4): attaching while a terminal
 * still holds the session forks the conversation.
 */
export type AttachWarningReason =
  /** The transcript changed less than 2 minutes ago. */
  | { readonly kind: 'transcript-recent'; readonly modifiedAt: string }
  /** `claude agents --json` lists the session id as live. */
  | { readonly kind: 'terminal-live'; readonly pid: number }
  /** `claude agents --json` could not be read, so liveness is unknown. */
  | { readonly kind: 'liveness-unknown' };

/** Additive (M4.1): the `409` body of `POST /attach` without `confirm` while a warning applies. Nothing was spawned. */
export interface AttachWarning {
  readonly error: 'attach-warning';
  readonly message: string;
  readonly reasons: readonly AttachWarningReason[];
}

/** An answer option, verbatim from `AskUserQuestion`. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** One question of a batch (data model + M0 stored fields). Provisional: M3.1. */
export interface Question {
  readonly id: string;
  readonly batchId: string;
  readonly sessionId: string;
  readonly source: string;
  readonly text: string;
  readonly header: string | null;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly state: QuestionState;
  readonly answerIndex: number | null;
  readonly answeredAt: string | null;
}

/** A solution + branch pair (branch chips). */
export interface BranchRef {
  readonly solution: string;
  readonly branch: string;
}

/** An Inbox action button (the first one is primary). */
export interface InboxAction {
  readonly id: string;
  readonly label: string;
}

/** `GET /api/inbox` item. Provisional: M3.1 / M3.2 / M3.3. */
export interface InboxItem {
  readonly id: string;
  /** A question batch, a permission request (D6) or a system item (M3.3). */
  readonly kind: 'questions' | 'permission' | 'system';
  readonly sessionId: string | null;
  /** Session name, schedule name or `worktrees`. */
  readonly source: string;
  readonly status: SessionStatus;
  readonly title: string;
  /** Kind label ("3 questions", "Scheduled run failed"). */
  readonly label: string;
  readonly detail: string;
  readonly createdAt: string;
  readonly branches: readonly BranchRef[];
  readonly questions?: readonly Question[];
  readonly actions?: readonly InboxAction[];
  /** Additive (M3.1): a permission item's request, verbatim (D6). */
  readonly permission?: PermissionRequest;
  /** Additive (M3.3): what "Open fix session" (action `open-fix-session`) opens the New-session modal with. */
  readonly prefill?: NewSessionPrefill;
}

/** A permission request as the Inbox shows it (D6: tool + input verbatim). Provisional: M3.1 / M3.2. */
export interface PermissionRequest {
  /** The CLI's control `request_id`. */
  readonly requestId: string;
  readonly toolName: string;
  /** The tool input, verbatim. */
  readonly input: unknown;
  /** The model's own description of the call. */
  readonly description: string | null;
  /** The CLI's reason ("This command requires approval"). */
  readonly decisionReason: string | null;
  /** The subagent's task id when a subagent asks. */
  readonly agentId: string | null;
  /** The asking agent's name (the subagent through `task_started`, else the main agent). */
  readonly agent: string | null;
}

/** `POST /api/questions/batch/{batchId}/answers` body (contract). */
export interface AnswerBatch {
  readonly answers: ReadonlyArray<{ readonly questionId: string; readonly answerIndex: number }>;
}

/** A git worktree (data model). Provisional: M2.2. */
export interface Worktree {
  readonly id: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly sessionId: string | null;
  readonly prNumber: number | null;
  readonly prState: string | null;
  readonly removable: boolean;
}

/** How the router AGENTS.md lets sessions use a folder (M6.1). */
export type FolderRule = 'editable' | 'on-request' | 'read-only';

/** One branch of a solution (branch chips, branch cards). Provisional: M6.2. */
export interface SolutionBranch {
  readonly branch: string;
  /** Worktree path, `null` when the session works in place. */
  readonly worktree: string | null;
  readonly sessionId: string | null;
  /** Session name, or a note such as "idle". */
  readonly owner: string;
  readonly status: SessionStatus;
}

/** One interface of a solution's `phase-ledger.md` (gap #12; the detail panel's phase ledger). */
export interface PhaseLedgerEntry {
  readonly interface: string;
  /** `UI-first` or `integration`. */
  readonly phase: string;
  /** Where the seam is (`seam TODO · FreeTalkViewModel.cs:41`); empty when the ledger names none. */
  readonly seam: string;
}

/** An artifact or follow-up of a solution (the detail panel's "Artifacts & follow-ups"). */
export interface SolutionArtifact {
  /** Artifact type tag (`CONTRACT`, `QA`, `FOLLOWUP`, …). */
  readonly type: string;
  /** Path inside the solution (`contracts/free-talk.md`) or the artifact's name. */
  readonly name: string;
  /** Short state (`locked`, `2 pending`); empty when none. */
  readonly meta: string;
  /** The session that produced it, `null` for a file found in the solution. */
  readonly sessionId: string | null;
}

/**
 * A session in a solution's conflict (M6.3, `docs/solutions.md` → *Conflicts*):
 * one of the open sessions writing the repo while at least one of them has no
 * worktree of its own.
 */
export interface ConflictSession {
  readonly sessionId: string;
  readonly name: string;
  /** `true` when it writes in its own worktree; `false` = in the main checkout (the card offers "Move … to worktree"). */
  readonly isolated: boolean;
  /** The `{repo}` of `POST /api/solutions/{repo}/isolate`: the solution as the session lists it (or its worktree's repo). */
  readonly repo: string;
  /** `false` while it continues in a terminal: isolating it is refused (409 `detached`) until it is attached again. */
  readonly attached: boolean;
}

/** codebase-memory freshness of a solution (`.claude/.codebase-memory-dirty`, M6.2 / M6.4). */
export type CodebaseMemoryFreshness = 'fresh' | 'dirty' | 'unknown';

/** A solution row. Provisional: M6.2. */
export interface Solution {
  readonly name: string;
  readonly path: string;
  /** Path from the workspace root, `/`-separated (`microfrontends/acme-app-front`, `mobile`). M6.2. */
  readonly relativePath: string;
  /** Filter pill: Web, Mobile, NuGet, Backend, Read-only (or Other for `other/`). */
  readonly type: string;
  readonly status: SessionStatus;
  readonly rule: FolderRule;
  readonly phase: string;
  readonly changes: string;
  /** Second-line flag ("⚠ shared working tree", "contract source"); empty when none. */
  readonly flag: string;
  /** Two or more open sessions write the repo and at least one has no worktree of its own (M6.3). */
  readonly conflict: boolean;
  /** The sessions in the conflict, oldest first; empty without one (M6.3). */
  readonly conflictSessions: readonly ConflictSession[];
  readonly branches: readonly SolutionBranch[];
  /** The solution's `phase-ledger.md` entries (gap #12); `null` when it has no such file. M6.2. */
  readonly ledger: readonly PhaseLedgerEntry[] | null;
  /** Artifacts of its sessions + its `mobile-followups/*.md` files, newest first. M6.2. */
  readonly artifacts: readonly SolutionArtifact[];
  /** Whether agents edited it since codebase-memory last indexed it. M6.2 (M6.4 refines). */
  readonly codebaseMemory: CodebaseMemoryFreshness;
}

/** `GET /api/solutions` item: one folder group. Provisional: M6.2. */
export interface SolutionGroup {
  readonly folder: string;
  readonly note: string;
  readonly rule: FolderRule;
  readonly solutions: readonly Solution[];
}

/** One run of a schedule (the 14-run strip). */
export interface ScheduleRun {
  readonly ts: string;
  readonly result: ScheduleRunResult;
  readonly summary: string | null;
}

/** `GET /api/schedules` item (data model; D8). Provisional: M7.1. */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cron: string;
  readonly paused: boolean;
  /** Session config (NewSession) + prompt (D8). */
  readonly template: unknown;
  /** Oldest first, at most 14. */
  readonly runs: readonly ScheduleRun[];
  readonly nextRunAt: string | null;
}

/** `GET /api/history` item (M7.4, docs/spike-m0.md → What History needs). Provisional: M7.4. */
export interface HistoryItem {
  readonly claudeSessionId: string;
  /** Switchboard's id when the session is in the DB. */
  readonly sessionId: string | null;
  readonly startedAt: string;
  readonly name: string;
  readonly mode: string;
  readonly summary: string;
  readonly branches: readonly BranchRef[];
  readonly outcome: string;
  readonly status: SessionStatus;
}

/** `GET/PUT /api/settings`: key → JSON value. Provisional: M8.2. */
export type Settings = Readonly<Record<string, unknown>>;

/** `GET/PUT /api/tools` item (data model; gaps #13, #14). Provisional: M8.1. */
export interface Tool {
  readonly id: string;
  readonly name: string;
  /** `null` = not configured. */
  readonly url: string | null;
  readonly description: string | null;
  readonly showInSidebar: boolean;
}

/** `POST /api/tools/{id}/probe` (contract). */
export interface ToolProbe {
  readonly state: 'up' | 'down';
}

/**
 * `GET /api/system` (contract fields) and the `system` hub event. Units, which the
 * contract leaves open: `cpu` and `usagePct` are percentages 0–100, `ramUsed` and
 * `ramTotal` are bytes, `processes` = live supervised `claude` processes (gap #11).
 * Provisional: M5.3 (CLI/gh fields, metrics) and M9.2 (usage).
 */
export interface SystemInfo {
  /** CLI path or command when found, `null` when not found. */
  readonly cli: string | null;
  readonly cliVersion: string | null;
  readonly signedIn: boolean;
  readonly ghSignedIn: boolean;
  readonly cpu: number;
  readonly ramUsed: number;
  readonly ramTotal: number;
  readonly processes: number;
  /** Omitted when unknown (never invented, ARCHITECTURE → Usage meter). */
  readonly usagePct?: number;
  /** Additive: when the window behind `usagePct` resets (the footer's "40% · 2h05"). */
  readonly usageResetsAt?: string;
}

/** `/hub` event names and payloads (contract, locked). */
export interface HubEvents {
  readonly sessionUpdated: Session;
  readonly event: { readonly sessionId: string; readonly event: SessionEvent };
  readonly questionBatch: { readonly sessionId: string; readonly batchId: string; readonly questions: readonly Question[] };
  readonly inboxChanged: { readonly count: number };
  readonly worktreeRemovable: Worktree;
  readonly scheduleRun: { readonly scheduleId: string; readonly result: ScheduleRunResult };
  readonly system: SystemInfo;
}

/** A `/hub` event name. */
export type HubEventName = keyof HubEvents;

/** Every `/hub` event name (contract). */
export const HUB_EVENT_NAMES: readonly HubEventName[] = [
  'sessionUpdated',
  'event',
  'questionBatch',
  'inboxChanged',
  'worktreeRemovable',
  'scheduleRun',
  'system',
];

/** Body of a route that exists but whose backlog item has not landed yet (HTTP 501). */
export interface NotImplementedBody {
  readonly error: 'not-implemented';
  /** The backlog item that implements the route (`docs/lanes.md`). */
  readonly item: string;
}
