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
import type { StatusTableFormat } from './derive/status-table.ts';
import type { UpdateStatus } from './updates.ts';
import type { AnsweredOn } from './remote-control.ts';
import type { ResolvedContext } from './context-meter.ts';
import type { QueuedReason } from './event-payload.ts';
import type { SessionMachine } from './peers.ts';
import type { SidebarLayout } from './sidebar-layout.ts';
import type {
  AgentKind,
  ArtifactType,
  Coordination,
  EventKind,
  FolderKind,
  Phase,
  QaStack,
  QuestionState,
  ScheduleRunResult,
  ScheduleRunTrigger,
  SessionMode,
  SessionOrigin,
  SessionStatus,
  WorkType,
} from './model.ts';

export type { SessionChip } from './derive/chips.ts';
export type { StatusTableFormat } from './derive/status-table.ts';
export type { SidebarFolder, SidebarFolderCreate, SidebarFolderMove, SidebarFolderPatch, SidebarLayout, SidebarPlace, SidebarPlaceInput } from './sidebar-layout.ts';

/**
 * `POST /api/sessions` body (contract, locked; `folder` additive, D14).
 * `coordination` is `null` when not applicable.
 *
 * **Repo folder (D14):** the router-only fields (`workType`, `mode`, `phase`,
 * `coordination`, `qa`) do not apply: the server ignores them (they may be
 * omitted) and stores `null`. `solutions` may be empty or omitted; the repo is
 * the one solution (`[<repo name>]`), and any other name is refused (422).
 */
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
  /**
   * Additive (D14): the id of the saved folder ({@link Folder}) the session starts
   * in. Omitted or `null` = the default folder (409 `no-folder` when none is
   * saved); an unknown id is refused (422, field `folder`).
   */
  readonly folder?: string | null;
  /**
   * Additive (D22): the session's free-text title, shown wherever the session is
   * named (`name` stays the kebab-case short name its worktree and branch use).
   * Trimmed, 1–80 characters, else 422 on field `title`; omitted or `null` = no
   * title (the name is shown).
   */
  readonly title?: string | null;
  /**
   * Additive (D32): the branch of the session's worktree(s), named after its
   * ticket (`PROJ-0001-short-description`, `TICKET_BRANCH` in
   * `src/core/ticket-branch.ts`). **Required** with `worktrees: true` (422 on
   * field `branch` when it is missing or not a ticket branch); a workspace
   * session uses it in every solution's repo; 409 `branch-exists` when a repo has
   * it already. Not read without a worktree. Scheduled runs keep
   * `session/{name}`.
   */
  readonly branch?: string | null;
  /**
   * Additive (D42): the model the session starts with, passed as `--model` on
   * its first spawn (and every later one, D31). Omitted, `null`, blank or
   * `"default"` = the CLI's default (no `--model`). Checked like D31's
   * `PUT /api/sessions/{id}/model`: against the latest model list any claude
   * process reported (`GET /api/models`) when there is one, else any model name
   * (422 on field `model`). A start that names `model` or `effort` becomes the
   * service's last choice ({@link ModelSettings.last}).
   */
  readonly model?: string | null;
  /**
   * Additive (D42): the effort level the session starts with (`--effort`);
   * omitted, `null` or blank = the CLI's default. One of the chosen model's levels
   * while the list is known (a model without levels takes none), else one of
   * `low, medium, high, xhigh, max` (422 on field `effort`).
   */
  readonly effort?: string | null;
  /**
   * Additive (D40): the epic/task branching of the worktrees, read only with
   * `worktrees: true` (never for a schedule's runs). Omitted or `null` = a task
   * without an epic and no per-repo choices ({@link NewSessionBranching}).
   */
  readonly branching?: NewSessionBranching | null;
}

/**
 * Additive (D40, `docs/new-session.md` → *Branching (D40)*): how the session's
 * task worktrees are branched (lazy: Switchboard never creates the epic branch
 * and never pushes). Each worktree is cut, after a `git fetch origin`, from
 * `origin/<epic>` when the epic is on origin, else from `origin/<base>` (the
 * repo's override when set); without an epic from the repo's origin default
 * branch (`origin/HEAD`). An existing task branch is reused (tracking
 * `origin/<task>` when it is there, else the local branch).
 */
export interface NewSessionBranching {
  /**
   * The epic: its ticket key (`PROJ-3010`), summary (free text, may be empty) and
   * branch (`feature/<KEY>-<Summary>`, `epicBranchName`; a valid git branch
   * name; omitted or blank = derived from the key and summary). Omitted or `null`
   * = a task without an epic.
   */
  readonly epic?: { readonly key: string; readonly summary?: string; readonly branch?: string | null } | null;
  /** The epic's base branch on origin; omitted or blank = `dev`. Not read without an epic. */
  readonly base?: string | null;
  /** Per solution (as in `solutions`): the base branch used instead in that repo (the preflight's "Use other base"). */
  readonly bases?: Readonly<Record<string, string>> | null;
  /** Solutions dropped from the task (the preflight's "Drop from task"): no worktree, and they leave the session's solutions. */
  readonly dropped?: readonly string[] | null;
  /**
   * Additive (D47): the parent the task is **stacked** on, typed by the developer:
   * a task key (`PROJ-3013`: per repo the one origin branch whose name starts with
   * `PROJ-3013-`) or a full branch name (a valid git branch name; a leading
   * `origin/` is dropped). Omitted, `null` or blank = the epic branch (not
   * stacked). Per repo the worktree is cut from `origin/<parent>` when the parent
   * is on origin there (its PR targets the parent), else by the D40 rule (PR into
   * the epic, or without an epic into the origin default branch). Also read
   * without an epic. 422 on field `branching.parent`.
   */
  readonly parent?: string | null;
}

/** Additive (D40): `POST /api/branching/preflight` body. */
export interface BranchingPreflightRequest {
  /** A saved folder's id; omitted or `null` = the default folder. */
  readonly folder?: string | null;
  /** The solutions to check (a repo folder checks its repo whatever is sent). Empty = no rows. */
  readonly solutions: readonly string[];
  /** The epic branch; omitted, `null` or blank = a task without an epic (the rows check the origin default branch). */
  readonly epicBranch?: string | null;
  /** The epic's base; omitted or blank = `dev`. */
  readonly base?: string | null;
  /** The task branch to look for on origin; omitted, blank or not a valid branch name = not checked. */
  readonly taskBranch?: string | null;
  /** Per-solution base overrides (as in {@link NewSessionBranching.bases}). */
  readonly bases?: Readonly<Record<string, string>> | null;
  /** Additive (D47): the typed parent (as in {@link NewSessionBranching.parent}); omitted, `null` or blank = not stacked. */
  readonly parent?: string | null;
}

/** Additive (D47): the parent's pull request in one repo (`gh pr view <parent> --json number,state,url,baseRefName`). */
export interface BranchingParentPullRequest {
  readonly number: number;
  /** Verbatim: `OPEN`, `CLOSED`, `MERGED`. */
  readonly state: string;
  readonly url: string | null;
  /** The branch the parent's PR goes into. */
  readonly baseRefName: string | null;
}

/** Additive (D47): the typed parent in one repo of a preflight. */
export interface BranchingPreflightParent {
  /** As typed, normalized (a key upper-cased, `origin/` dropped). */
  readonly typed: string;
  /** The origin branch it resolves to in this repo; `null` when it is not there (or several match). */
  readonly branch: string | null;
  /** The origin branches it names here (a key can name several). */
  readonly matches: readonly string[];
  /** Why it cannot be used here (several branches match a key); `null` otherwise. */
  readonly error: string | null;
  /** The parent's PR here; `null` when there is none, the parent is not here, or gh failed ({@link prError}). */
  readonly pr: BranchingParentPullRequest | null;
  /** `true` when gh answered "no pull requests found". */
  readonly noPr: boolean;
  /** Why gh could not tell; `null` otherwise. */
  readonly prError: string | null;
}

/** Additive (D40): one repo of a preflight. `null` values are unknown (the repo could not be read or fetched). */
export interface BranchingPreflightRow {
  /** The solution as sent (a repo folder: the repo's name). */
  readonly solution: string;
  /** Its main checkout; `null` when it does not resolve to a git repository. */
  readonly repoPath: string | null;
  /**
   * Why the refs could not be checked, e.g. `no origin remote: the worktree starts
   * from the repo's current HEAD`, `git fetch origin failed: …`; `null` when they were.
   */
  readonly error: string | null;
  /** The base checked (without `origin/`): the override, the epic's base, or the origin default branch; `null` when unknown. */
  readonly base: string | null;
  /** Where {@link base} comes from. */
  readonly baseSource: 'epic' | 'override' | 'default';
  /** `origin/<base>` exists after the fetch. */
  readonly baseExists: boolean | null;
  /** The epic on origin (`null` without an epic). `behind` = commits of `origin/<base>` it lacks (`null` when either is missing). */
  readonly epic: { readonly branch: string; readonly exists: boolean | null; readonly behind: number | null } | null;
  /** The task branch on origin and locally (`null` when no valid task branch was sent). */
  readonly task: { readonly branch: string; readonly exists: boolean | null; readonly local: boolean | null } | null;
  /**
   * The branch the task worktree would be cut from (`origin/<x>`), `null` when
   * there is none yet. D47: `origin/<parent>` when the typed parent is on origin
   * in this repo.
   */
  readonly cutFrom: string | null;
  /** Additive (D47): the typed parent in this repo; `null` when not stacked (or the row has an `error`). */
  readonly parent?: BranchingPreflightParent | null;
  /**
   * Additive (D47): where this repo's PR would go: the parent (on origin here),
   * else the epic branch (even while it is not on origin), else the branch cut
   * from; `null` when unknown or the row has an `error`.
   */
  readonly prTarget?: string | null;
}

/** Additive (D40): `POST /api/branching/preflight` answer. */
export interface BranchingPreflight {
  readonly rows: readonly BranchingPreflightRow[];
}

/**
 * Additive (D14): the `POST /api/sessions` body for a **repo** folder: only the
 * fields that apply there (the repo is the one solution; the router-only fields
 * are left out). The server also accepts a full {@link NewSession} for a repo
 * folder and ignores its router fields.
 */
export interface NewRepoSession {
  readonly name: string;
  readonly task: string;
  /** The saved repo folder's id (`Folder.kind` = `repo`). */
  readonly folder: string;
  /** Empty, omitted, or `[<repo name>]` (`Folder.name`); anything else is 422. */
  readonly solutions?: readonly string[];
  readonly worktrees: boolean;
  readonly ultracode: boolean;
  /** Additive (D22): as {@link NewSession.title}. */
  readonly title?: string | null;
  /** Additive (D32): as {@link NewSession.branch} (required with `worktrees: true`). */
  readonly branch?: string | null;
  /** Additive (D40): as {@link NewSession.branching} (a repo folder's one repo cannot be dropped). */
  readonly branching?: NewSessionBranching | null;
  /** Additive (D42): as {@link NewSession.model}. */
  readonly model?: string | null;
  /** Additive (D42): as {@link NewSession.effort}. */
  readonly effort?: string | null;
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
  /**
   * Additive (D36): the id of the Agent / Task `tool_use` that started this
   * subagent (the main agent's call event has it as `payload.toolUseId`; the
   * subagent's own lines carry it as `parent_tool_use_id`), so the chat can open
   * the subagent's own conversation from that call. `null` for the main agent and
   * for agents no call was seen for (the demo's). Optional so older fixtures
   * type-check; the server always sends it.
   */
  readonly toolUseId?: string | null;
  /**
   * Additive (D51): what a Workflow's agent is (`kind: 'workflow'`), `null` / absent
   * for every other agent. `docs/derivations.md` → *Workflow agents*.
   */
  readonly workflow?: AgentWorkflow | null;
}

/**
 * Additive (D51): a Workflow agent's own facts, from the CLI's live `task_progress`
 * snapshot and its files (`workflows/<runId>.json`, `subagents/workflows/<runId>/`).
 */
export interface AgentWorkflow {
  /** The run it belongs to (`WorkflowRun.runId`, `wf_…`). */
  readonly runId: string;
  /** The script's agent number (1-based, `workflow_agent.index`); `null` when only the files know the agent. */
  readonly index: number | null;
  /** The CLI's agent id (`agent-<id>.jsonl`); `null` while it is queued (no transcript yet). */
  readonly agentId: string | null;
  /** The phase it runs in (`phaseTitle`, the meta's `workflowPhase`); `null` without one. */
  readonly phase: string | null;
  readonly model: string | null;
  /** When it started / ended (ISO); `null` when unknown or not yet. */
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Its current action while it runs (the last tool it called); `null` otherwise. */
  readonly action: WorkflowAgentAction | null;
  /** The working folder its transcript names (`cwd`); `null` when unknown. */
  readonly cwd: string | null;
  /** Grows while its transcript grows (bytes read): its open chat reloads when it changes. */
  readonly version: number;
}

/** Additive (D51): what a running Workflow agent does now. */
export interface WorkflowAgentAction {
  /** The tool it called last (`lastToolName`, the transcript's last `tool_use`). */
  readonly tool: string;
  /** Short literal summary (D19's rules), `null` when none. */
  readonly summary: string | null;
  /** Since when (ISO): that call's time, else the agent's start. */
  readonly since: string;
}

/**
 * Additive (D51): one Workflow run of a session, the group its agents belong to
 * (`Session.workflows`, oldest first).
 */
export interface WorkflowRun {
  /** `wf_…`: the run folder's name. */
  readonly runId: string;
  /** The CLI's task id (`w…`, the background task); `null` when unknown (after a restart, before the run file). */
  readonly taskId: string | null;
  /** The script's `meta.name`, else the run id. */
  readonly name: string;
  /** The script's `meta.description`; `null` when unknown. */
  readonly summary: string | null;
  /** `run` while it runs, then `done` / `fail`; `idle` when it stopped (killed, or its process ended first). */
  readonly status: SessionStatus;
  /** The phase it is in (the newest phase an agent started in; the last one once it ended); `null` without phases. */
  readonly phase: string | null;
  /** Every phase title of the script, in order (as far as known). */
  readonly phases: readonly string[];
  /** Its agents (queued ones included) and how many are done / failed. */
  readonly agentCount: number;
  readonly doneCount: number;
  readonly failedCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /**
   * Additive (D51 ruling D51-resume): what "Resume run" asks the session's agent to
   * call (`Workflow({ scriptPath, resumeFromRunId: runId, args })`); set only for a
   * run that stopped or failed and whose script Switchboard found, else `null`.
   * Optional so older payloads type-check.
   */
  readonly resume?: WorkflowResume | null;
}

/** Additive (D51 ruling D51-resume): the `Workflow` call that resumes a run. */
export interface WorkflowResume {
  /** The run's script file (under the CLI's projects folder, `<name>-<runId>.js`). */
  readonly scriptPath: string;
  /** The run's `args` from its run file, when it had any; else `null`. */
  readonly args: unknown;
}

/** Additive (D51): `GET /api/sessions/{id}/workflow-agents/{agentId}/chat`: a Workflow agent's conversation from its transcript. */
export interface WorkflowAgentChat {
  /** Its conversation in the event shapes the stream produces (`agentId` = the agent's id; ids are local to this answer). */
  readonly events: readonly SessionEvent[];
  /** Its return value (the journal's `result`, as JSON) or its error; `null` while it runs. */
  readonly result: { readonly text: string; readonly isError: boolean } | null;
  /** `AgentWorkflow.version` at read time. */
  readonly version: number;
}

/**
 * Additive (D19): what a session's running turn (or one of its agents) is doing
 * now: `thinking` (the model is working, `system/thinking_tokens` ticks), `tool` (a
 * `tool_use` waits for its `tool_result`), `writing` (after a text block), `waiting`
 * (a question or permission request is open). Additive (D30): `background` (no turn
 * runs, but the main agent waits for background work it started,
 * {@link SessionActivity.background}). `docs/derivations.md` → *Live activity*.
 */
export type ActivityState = 'thinking' | 'tool' | 'writing' | 'waiting' | 'background';

/**
 * Additive (D30): what a pending background task is: a `Bash` run in the background,
 * an async `Agent` / `Task`, a `Monitor`, or a `ScheduleWakeup`. Additive (D43): a
 * `Workflow` run in the background (`workflow`), and `task` for any other task the
 * CLI reports (a `system/task_started` of a type Switchboard does not know).
 */
export type BackgroundTaskKind = 'bash' | 'agent' | 'monitor' | 'wakeup' | 'workflow' | 'task';

/**
 * Additive (D30): background work the main agent started and whose end the CLI has
 * not reported yet (`docs/derivations.md` → *Background work*). Derived in memory
 * from the stream-json, never stored. D43: also every other background task the CLI
 * reports (`system/task_started`).
 */
export interface BackgroundTask {
  /** The CLI's task id (the background command's, the async agent's, the monitor's, the workflow's); the `tool_use` id when the CLI gave none (a wake-up). */
  readonly id: string;
  /** The `tool_use` that started it; D43: the task id for a task the CLI reported without one (a `system/task_started` with no `tool_use_id`). */
  readonly toolUseId: string;
  readonly kind: BackgroundTaskKind;
  /**
   * Short literal text (D19's summaries; for a GitHub wait the `gh …` command, for a
   * wake-up its reason; D43: a workflow's `Summary:`, any other CLI-reported task's
   * description); at most 80 characters.
   */
  readonly summary: string;
  /** When it started (ISO): its tool call; D43: for a task known only from its `system/task_started`, that line's arrival. */
  readonly startedAt: string;
  /** `wakeup` only: when the CLI wakes the session (ISO): the call's time + `delaySeconds`. */
  readonly wakeAt?: string;
  /** The command runs `gh run`, `gh pr checks` or `gh workflow`: a wait for GitHub Actions. */
  readonly github: boolean;
  /**
   * Additive (D51): a `workflow` task's run, when Switchboard knows it: its agents
   * done out of all and its phase ("3/7 agents done · phase Review"). Absent / `null`
   * otherwise.
   */
  readonly workflow?: { readonly runId: string; readonly doneCount: number; readonly agentCount: number; readonly phase: string | null } | null;
}

/** Additive (D19): one agent's current action while the session's turn runs. */
export interface AgentActivity {
  readonly state: ActivityState;
  /** When this state began (ISO); for `tool`, when that tool call started. */
  readonly since: string;
  /** When the agent became active in this turn (ISO): the turn's start for the main agent, the subagent's own start otherwise. */
  readonly startedAt: string;
  /** `tool`: the tool's name; otherwise `null`. */
  readonly tool: string | null;
  /** `tool`: the short literal summary (D19: Bash → the command's first line, Read / Edit / Write → the file name, …); otherwise `null`. */
  readonly summary: string | null;
}

/**
 * Additive (D19): the live activity of a session while a turn runs, derived in
 * memory from the process's stream-json (never stored, never guessed). The
 * top-level state is `waiting` while any request is open, else the main agent's.
 * D30: also while no turn runs but background tasks are pending (state
 * `background`); `null` only when neither.
 */
export interface SessionActivity {
  /**
   * When the running turn started (ISO): the user message was taken up, or the CLI
   * started a turn by itself. D30, state `background` (no turn runs): the oldest
   * pending task's start, like `since`.
   */
  readonly turnStartedAt: string;
  readonly state: ActivityState;
  /** When the top-level state began (ISO); for `tool`, when that tool call started; for `background`, when the oldest pending task started. */
  readonly since: string;
  /** `tool`: the main agent's running tool; `background`: the tool that started the oldest pending task (D43: `null` for a `task`, which no known tool started); otherwise `null`. */
  readonly tool: string | null;
  /** `tool` / `background`: that call's short summary; otherwise `null`. */
  readonly summary: string | null;
  /** Estimated thinking tokens so far this turn (the sum of the `system/thinking_tokens` deltas); `null` before the first tick (and in `background`). */
  readonly thinkingTokens: number | null;
  /** Each active agent's own action, keyed by agent id (`Agent.id`): the main agent and the subagents working now (in `background`: the main agent, state `background`). */
  readonly agents: Readonly<Record<string, AgentActivity>>;
  /** Additive (D30): the main agent's pending background tasks, oldest first; empty when none (also while a turn runs). */
  readonly background: readonly BackgroundTask[];
  /**
   * Additive (D53): a hooked session's newest sign of life (a transcript change or
   * a hook call, ISO): a running turn quiet for 3 minutes reads "· no activity for
   * 3m". Absent for a supervised session (its stream-json is live).
   */
  readonly quietSince?: string | null;
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
  /**
   * Additive (D51): the session's Workflow runs, oldest first; their agents are in
   * {@link agents} (`kind: 'workflow'`, `Agent.workflow.runId`). Empty when none.
   */
  readonly workflows?: readonly WorkflowRun[];
  readonly openQuestionCount: number;
  /**
   * Additive (M4.1; D14): the folder the session's process runs in: the workspace
   * root (workspace folder), the repo or its worktree (repo folder). `null` only
   * for a session that never started.
   */
  readonly cwd: string | null;
  /** Additive (D14): the id of the saved folder the session started in; `null` once that folder was removed from the list. */
  readonly folder: string | null;
  /** Additive (D14): the session's folder (canonical path), kept when the folder leaves the saved list; tags the session in lists. */
  readonly folderPath: string | null;
  /** Additive (D14): what {@link folderPath} is. */
  readonly folderKind: FolderKind | null;
  /** Additive (D16, migration 0004): `terminal` when the session was moved in from a terminal ("Continue in Switchboard"), else `switchboard`. */
  readonly origin: SessionOrigin;
  /** Additive (M4.1): the session has a live supervised `claude` process (Pause applies; else Resume). */
  readonly live: boolean;
  /** Additive (D19): what the running turn is doing now; `null` when no turn runs (always for a session without a live process). D30: also set (state `background`) while no turn runs but background tasks are pending. */
  readonly activity: SessionActivity | null;
  /** Additive (M4.1): `claude --resume <claudeSessionId>`, the handoff card's command (prototype copy, M0.4). */
  readonly resumeCommand: string;
  /** Additive (M4.1): the header chips (`src/core/derive/chips.ts`). */
  readonly chips: readonly SessionChip[];
  /** Additive (M7.2, D9): the loops observed in the session, oldest first (the Schedules & loops cards). */
  readonly loops: readonly Loop[];
  /**
   * Additive (D22, migration 0006): the session's free-text title (trimmed, 1–80
   * characters); `null` when it has none. The server always sends it; optional
   * here so older payloads and fixtures still type-check.
   */
  readonly title?: string | null;
  /** Additive (D22): what the UI shows for the session: {@link title}, else {@link name}. Always sent by the server. */
  readonly displayTitle?: string;
  /**
   * Additive (D24, migration 0007): Remote Control on the session's process
   * (`docs/remote-control.md`); `null` for a session Switchboard never ran a
   * process for (the demo's seeded sessions: the header shows no Remote toggle).
   * The server always sends it; optional here so older payloads and fixtures
   * still type-check.
   */
  readonly remote?: SessionRemote | null;
  /**
   * Additive (D25, migration 0008): the remote session this one is a local copy of
   * (`session_<X>`, "From a remote session" / `POST /api/sessions/teleport`);
   * `null` for every other session. The server always sends it; optional here so
   * older payloads and fixtures still type-check.
   */
  readonly remoteSource?: string | null;
  /**
   * Additive (D31, migration 0009): the session's model and effort choice and the
   * models its claude process offers (`docs/model-effort.md`); `null` for a session
   * with no model information at all (Switchboard never ran a process for it and
   * nothing is stored: the demo's seeded sessions show no pickers). The server
   * always sends it; optional here so older payloads and fixtures still type-check.
   */
  readonly model?: SessionModel | null;
  /**
   * Additive (D33, migration 0010): when the developer closed the session (ISO);
   * `null` while it is open. `GET /api/sessions` leaves closed sessions out unless
   * `?closed=include`; History lists them with a "Closed" tag and Reopen. The
   * server always sends it; optional here so older payloads and fixtures still
   * type-check.
   */
  readonly closedAt?: string | null;
  /**
   * Additive (D49, migration 0015): how full the main agent's context window is
   * and when the CLI last compacted it (`docs/chat.md` → *Context bar*). `null`
   * for a session Switchboard never ran a process for and has no reading of (the
   * demo seed: no bar). A session with a process but no reading yet has
   * `tokens: null` ("Context —"). The window follows the session's model choice.
   * The server always sends it; optional here so older payloads and fixtures
   * still type-check.
   */
  readonly context?: SessionContext | null;
  /**
   * Additive (D48, `docs/peers.md`): the paired machine the session runs on, only
   * on a peer's session (its `id` is then a remote id, `r~<machine>~<id>`); absent
   * for this machine's own sessions. `state` other than `online` = unreachable now
   * (the session is shown, not deleted; the peer keeps running it).
   */
  readonly machine?: SessionMachine | null;
  /**
   * Additive (D48 P4, migration 0017, `docs/peers.md` → *Hooked terminal
   * sessions*): a hand-started terminal session Switchboard hooked into. Its chat
   * comes from the transcript; messages wake it through its hooks (held until its
   * turn ends); interrupt, slash commands, model changes, pause / resume and the
   * terminal handoff stay in the terminal. `false` for every other session. The
   * server always sends it; optional so older payloads and fixtures type-check.
   */
  readonly hooked?: boolean;
  /**
   * Additive (D53): a hooked session's delivery state (`docs/chat.md` → *Queued
   * messages* → *Hooked sessions*): whether a wake-up waiter is armed and what an
   * undelivered message waits on. Absent / `null` for every other session.
   */
  readonly hookStatus?: HookStatus | null;
}

/** Additive (D53): what a message to a hooked terminal session waits on (`src/core/derive/hooked-activity.ts`). */
export interface HookStatus {
  /** A wake-up waiter (the SessionStart / Stop `asyncRewake` hook) is held for the session now. */
  readonly waiter: boolean;
  /** Switchboard's hooks reported from the session since Switchboard started. */
  readonly hookSeen: boolean;
  /**
   * What an undelivered message waits on (`HOOK_DELIVERY_TEXT` has the words):
   * `handed` (released to the waiter, not taken up yet), `turn` (the next turn
   * boundary), `no-waiter` (no hook listening yet), `ended` (the terminal session
   * is gone); `null` when nothing waits and a waiter is armed.
   */
  readonly delivery: 'handed' | 'turn' | 'no-waiter' | 'ended' | null;
}

/**
 * Additive (D49): `Session.context` (`resolveContext` in `src/core/context-meter.ts`):
 * `tokens` (`null` = unknown), `window`, `windowSource` (`reported` by the CLI's
 * `modelUsage` or derived from the `model` name), `model`, `percent`, `band`
 * (`ok` < 60 % ≤ `warn` < 80 % ≤ `high`, `unknown`), `updatedAt`, `compaction`
 * (`{at, trigger, preTokens, postTokens}` of the last one, or `null`) and
 * `compactedRecently` (from a compaction until the next turn starts).
 */
export type SessionContext = ResolvedContext;

/**
 * Additive (D31): a session's model and effort (`Session.model`).
 * - `current`: the stored model, passed as `--model` on every spawn; `null` = the
 *   CLI's default (no `--model`);
 * - `effort`: the stored effort level, passed as `--effort`; `null` = the CLI's default;
 * - `available`: the models the session's last claude process reported in its
 *   `initialize` reply (kept after it ends); `null` until a process reported them
 *   (the pickers are disabled then).
 */
export interface SessionModel {
  readonly current: string | null;
  readonly effort: string | null;
  readonly available: readonly SessionModelOption[] | null;
}

/** Additive (D31): one model the CLI offers (an `initialize` reply's `models[]` entry, read). */
export interface SessionModelOption {
  /** What `set_model` / `--model` take (`default`, `opus`, `claude-opus-4-7`, …). `default` is the CLI's default model. */
  readonly value: string;
  /** The CLI's `displayName` (`Opus 5.5`, `Default (recommended)`), else the value. */
  readonly label: string;
  /** The CLI's `description`, when it gave one. */
  readonly description?: string;
  /** The effort levels the model supports (`supportedEffortLevels`, in the CLI's order); absent when it has none. */
  readonly efforts?: readonly string[];
}

/**
 * Additive (D31): body of `PUT /api/sessions/{id}/model`. A field left out keeps
 * its stored value; `null` (or `default` for the model) goes back to the CLI's default.
 */
export interface SessionModelInput {
  readonly model?: string | null;
  readonly effort?: string | null;
}

/** Additive (D42): a model and effort as stored (`null` = the CLI's default: no `--model` / `--effort`). */
export interface SessionModelChoice {
  readonly model: string | null;
  readonly effort: string | null;
}

/**
 * Additive (D42): `GET /api/models`, what the New-session form's Model row
 * offers and starts on (`docs/model-effort.md` → *At session start (D42)*).
 * - `options`: the latest model list any claude process reported in its
 *   `initialize` reply (the service's `models.options`); `null` until one did
 *   (the form offers the CLI's aliases then);
 * - `last`: the last model and effort the developer chose, at a start
 *   (`POST /api/sessions` with `model` / `effort`) or in a session header's
 *   picker (`PUT /api/sessions/{id}/model`); `null` until one was chosen (the
 *   form starts on the CLI's default then).
 */
export interface ModelSettings {
  readonly options: readonly SessionModelOption[] | null;
  readonly last: SessionModelChoice | null;
}


/**
 * Additive (D33): body of `POST /api/sessions/{id}/close`. `confirm: true` is
 * needed when the session's process is live or the session runs or waits
 * (`run` / `need`): the close stops it the way Pause does.
 */
export interface SessionCloseInput {
  readonly confirm?: boolean;
}

/**
 * Additive (D24): a session's Remote Control state (`Session.remote`).
 * - `available`: the session has a live process whose `initialize` reported
 *   `remote_control_available: true` (the toggle is enabled only then);
 * - `enabled`: Remote is on for the session: its live process has (or is
 *   reconnecting) the bridge, and a paused session reconnects on resume (D7);
 * - `url`: the claude.ai link (`https://claude.ai/code/session_…`) of the last
 *   bridge, kept after Remote is turned off (for a later reattach); `null` before
 *   the first one.
 */
export interface SessionRemote {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly url: string | null;
}

/** Additive (D24): body of `PUT /api/sessions/{id}/remote`. */
export interface SessionRemoteInput {
  readonly enabled: boolean;
}

/** Additive (D22): body of `PUT /api/sessions/{id}/title`; `null` or an empty title clears it (the name is shown again). */
export interface SessionTitleInput {
  readonly title: string | null;
}

/** Result of one loop iteration (a strip cell): `none` = not finished / not run. M7.2. */
export type LoopIterationResult = 'ok' | 'fail' | 'run' | 'need' | 'none';

/** One iteration of a loop, oldest first. M7.2. */
export interface LoopIteration {
  readonly result: LoopIterationResult;
  readonly ts: string | null;
  /** The label of the result that ended it, `null` while open or unknown. */
  readonly label: string | null;
}

/**
 * A loop of a session (data model *Loop*; D9, M7.2, `docs/derivations.md` →
 * *Loop cards*). Iteration, next firing and expiry come from observed `/loop`,
 * ScheduleWakeup, CronCreate and Workflow events; cap and breaker from a
 * `.loop/progress.md` in the session's working folders. Unknown values are `null`.
 */
export interface Loop {
  readonly id: string;
  readonly sessionId: string;
  /** Observed source: `/loop`, `CronCreate`, `ScheduleWakeup` or `Workflow`. */
  readonly kind: string;
  /** Card subtitle (`/loop 1h`); `null` = show the kind. */
  readonly label: string | null;
  readonly iteration: number | null;
  readonly cap: number | null;
  readonly breakerCount: number | null;
  /** `tripped` / `reset` when known; `null` otherwise. */
  readonly breakerState: string | null;
  readonly nextFireAt: string | null;
  readonly expiresAt: string | null;
  readonly iterations: readonly LoopIteration[];
  /** The `.loop/progress.md` cap and breaker were read from (as shown: relative to the session's folder when inside it, D14). */
  readonly progressPath: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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

/** One changed file (gap #10; M4.5, `docs/worktrees.md` → *Diff*). */
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
  /**
   * `true` while the working tree holds changes to this file that are not
   * committed (staged, unstaged or untracked); `false` once all of the file's
   * changes are in commits of the session's branch. The Diff tab shows "Not
   * committed. Commit only when you approve." while it is `true`.
   */
  readonly uncommitted: boolean;
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

/**
 * A row of `GET /api/artifacts` (M7.3, global Artifacts view): an {@link Artifact}
 * plus the source session's name (`null` without a session) and the last update,
 * which the view's Age column reads (a DIFF grows with every write).
 */
export interface ArtifactListItem extends Artifact {
  readonly sessionName: string | null;
  /** Additive (D22): the source session's display title (its title, else its name); `null` without a session. */
  readonly sessionTitle?: string | null;
  readonly updatedAt: string;
  /** Additive (D14): the source session's saved folder (`null` without a session, or once the folder left the list). */
  readonly folder: string | null;
  /** Additive (D14): the source session's folder path (`null` without a session); tags the row with its folder. */
  readonly folderPath: string | null;
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
  /**
   * Additive (D21): the newest status table the agent printed in the chat (the main
   * conversation's agent messages), which the right panel's agent overview repeats
   * under its derived table; `null` when it printed none. Found anywhere in the
   * session's messages, not only in the recent {@link events}.
   */
  readonly reportedTable: ReportedTable | null;
}

/**
 * Additive (D21): a status table the agent printed, as printed (`docs/derivations.md`
 * → *Agent overview*): a box-drawing or GitHub-flavored pipe table whose header has
 * an Agent and a Status column.
 */
export interface ReportedTable {
  /** The table's lines as printed (common indentation removed; a fenced box table without its fence lines). */
  readonly text: string;
  /** `box`: shown in monospace like a chat code block; `gfm`: shown through the chat's Markdown renderer. */
  readonly format: StatusTableFormat;
  /** When the message that holds it arrived (ISO, the message event's `ts`). */
  readonly at: string;
}

/** `{ resumeCommand }` of `/detach` and `/attach` (contract). */
export interface ResumeCommand {
  readonly resumeCommand: string;
}

/**
 * D50: how a Stop (`POST /api/sessions/{id}/interrupt`) ended:
 * - `stopped`: the CLI acknowledged the interrupt and the running turn ended (or had just ended);
 * - `idle`: no turn ran (nothing to stop; nothing was sent);
 * - `timeout`: the CLI did not acknowledge in time (or the interrupted turn did not end):
 *   an error line is recorded and nothing is killed; Pause ends the process.
 */
export type InterruptOutcome = 'stopped' | 'idle' | 'timeout';

/** Additive (D50): the reply of `POST /api/sessions/{id}/interrupt`. */
export interface InterruptResult {
  /** The session after the Stop (status `idle` once the turn stopped, unless background work keeps it working). */
  readonly session: Session;
  readonly outcome: InterruptOutcome;
  /**
   * The texts of the messages the Stop took back (queued while the turn ran and not
   * taken up by the agent), oldest first: the composer puts them back for editing.
   * Empty for a second Stop while the first one is still waiting.
   */
  readonly withdrawn: readonly string[];
}

/** Additive (D50 background): optional body of `POST /api/sessions/{id}/background/stop`. */
export interface StopBackgroundRequest {
  /** The background tasks to stop (`BackgroundTask.id`); absent = every stoppable one. */
  readonly taskIds?: readonly string[];
}

/** Additive (D50 background): the reply of `POST /api/sessions/{id}/background/stop`. */
export interface StopBackgroundResult {
  readonly session: Session;
  /** The tasks the CLI stopped. */
  readonly stopped: readonly string[];
  /** The tasks it refused or did not answer for, with the CLI's text (or `no reply`). */
  readonly failed: ReadonlyArray<{ readonly id: string; readonly error: string }>;
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
  /** The picked option's index; `null` until answered, and for an own answer (D39). */
  readonly answerIndex: number | null;
  readonly answeredAt: string | null;
  /**
   * Additive (D39): the developer's own answer ("Other…"), verbatim as it went to
   * the CLI (trimmed); `answerIndex` is then `null`. `null` for an option answer
   * and while unanswered. Optional here so older payloads and fixtures still
   * type-check; the server always sends it.
   */
  readonly answerText?: string | null;
  /**
   * Additive (D24): where the batch was answered when that was not Switchboard:
   * `claude.ai` when the phone (Remote Control) answered first and the CLI withdrew
   * the request (`control_cancel_request`); the batch is then closed (`answered`,
   * no `answerIndex`). `null` / absent otherwise.
   */
  readonly answeredOn?: AnsweredOn | null;
  /**
   * Additive (D33): why the batch was closed without answers while it still
   * waited (`session closed`: its session was closed); it then waits no more and
   * answering it is 409 `not-open`. `null` otherwise; optional here so older
   * payloads and fixtures still type-check.
   */
  readonly closedReason?: string | null;
  /**
   * Additive (D44): `resume` while the batch's answers wait in the session's
   * outbox (a stale batch answered while the session had no live process; they go
   * out with the session's next message, e.g. "Continue." on Resume); `null` once
   * they were written and for every other batch. Optional here so older payloads
   * and fixtures still type-check; the server always sends it.
   */
  readonly queued?: QueuedReason | null;
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
  /**
   * Additive (D22): how the UI shows {@link source}: a session's display title
   * (its title, else its name) for a question or permission item; absent for a
   * system item (its `source` is shown as it is).
   */
  readonly sourceTitle?: string;
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
  /** Additive (D48): the paired machine the item comes from (a peer's item; its ids are remote ids); absent for this machine's own. */
  readonly machine?: SessionMachine | null;
}

/**
 * Additive (D48 P4): a terminal `claude` session running on this machine
 * (`GET /api/terminal-sessions`): `claude agents --json` plus what the hooks
 * reported. Sessions Switchboard itself runs are not listed.
 */
export interface TerminalSession {
  /** The claude session id. */
  readonly id: string;
  readonly pid: number | null;
  readonly cwd: string | null;
  /** The CLI's session name. */
  readonly name: string | null;
  /** The CLI's words: `idle`, `busy`, `waiting`. */
  readonly status: string | null;
  /** E.g. `permission prompt`. */
  readonly waitingFor: string | null;
  readonly startedAt: string | null;
  /** Switchboard follows it (an open hooked session). */
  readonly hooked: boolean;
  /** That Switchboard session's id, `null` while not hooked. */
  readonly sessionId: string | null;
  /** Switchboard's hooks have reported from it (so messages can wake it after its next turn end, or now when a waiter is armed). */
  readonly hookSeen: boolean;
  /** A wake-up waiter is armed (a message would go out now, once the session is idle). */
  readonly waiter: boolean;
}

/** Additive (D48 P4): Switchboard's hooks in this machine's user Claude settings (`GET /api/hooks`). */
export interface HooksStatus {
  /** `installed`: exactly the current entries; `outdated`: Switchboard's entries, but not the current ones (install again); `unreadable`: the file is not valid JSON (nothing is changed). */
  readonly state: 'installed' | 'outdated' | 'none' | 'unreadable';
  readonly settingsPath: string;
  /** `claude --version`, `null` when it could not be read. */
  readonly cliVersion: string | null;
  /** `internal`: the tested `rewakeMessage` / `rewakeSummary` fields are used; `fallback`: the documented `asyncRewake` only. */
  readonly rewake: 'internal' | 'fallback';
  /** The backup the last Install / Remove made (absolute path), `null` when none. */
  readonly lastBackup: string | null;
  readonly error: string | null;
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
  /**
   * Additive (D48 P4): a hooked terminal session's request: Deny takes an
   * optional message (`POST /api/inbox/{id}/actions/deny` with `{ message }`), and
   * "Always allow" (`always-allow`) is offered when the CLI suggested rules.
   * Absent for a supervised process's request (D6).
   */
  readonly hook?: { readonly denyMessage: true; readonly alwaysAllow: boolean } | null;
}

/**
 * One answer of {@link AnswerBatch}: exactly one of `answerIndex` (a picked option)
 * and, additive (D39), `text` (the developer's own words, 1–2000 characters once
 * trimmed; `src/core/own-answer.ts`).
 */
export interface BatchAnswer {
  readonly questionId: string;
  readonly answerIndex?: number;
  readonly text?: string;
}

/** `POST /api/questions/batch/{batchId}/answers` body (contract; D39 adds `text`). */
export interface AnswerBatch {
  readonly answers: readonly BatchAnswer[];
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
  /**
   * Additive (D22, developer ruling 2026-09-28): the owner session's display title
   * (its title, else its name), `null` when no session owns the branch ({@link owner}
   * is then a note such as `idle`). The branch chips and cards name the owner by
   * this, else by {@link owner}, with the short name ({@link owner}) as the tooltip;
   * the branch and worktree names are still the short name's. Always sent by the
   * server; optional here like `ConflictSession.title`.
   */
  readonly ownerTitle?: string | null;
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
  /**
   * Additive (D22, developer ruling 2026-09-28): the session's title, `null` when it
   * has none. The card and its "Move … to worktree" button name the session by its
   * display title (this, else {@link name}); the worktree and branch it gets are
   * still built from {@link name}. Always sent by the server; optional here like
   * `Session.title`.
   */
  readonly title?: string | null;
  /** `true` when it writes in its own worktree; `false` = in the main checkout (the card offers "Move … to worktree"). */
  readonly isolated: boolean;
  /** The `{repo}` of `POST /api/solutions/{repo}/isolate`: the solution as the session lists it (or its worktree's repo). */
  readonly repo: string;
  /** `false` while it continues in a terminal: isolating it is refused (409 `detached`) until it is attached again. */
  readonly attached: boolean;
}

/**
 * `POST /api/solutions/{repo}/isolate` body ("Move … to worktree", gap #2 / M6.3):
 * the contract's `{ sessionId }`, plus D32's `branch`.
 */
export interface IsolateRequest {
  readonly sessionId: string;
  /**
   * Additive, required (D32): the new worktree's branch, named after the ticket
   * (`PROJ-0001-short-description`); missing or not a ticket branch is 422 on
   * field `branch`, a branch the repo has already is 409 `branch-exists`.
   */
  readonly branch: string;
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
  /** Additive (M7.1): when it got its final result (`ok` / `fail` / `skipped`); `null` while `running` or `need`. */
  readonly finishedAt?: string | null;
  /** Additive (M7.1): the session the run started; `null` when none started (refused, skipped) or it was deleted. */
  readonly sessionId?: string | null;
  /** Additive (M7.1): `cron` (the schedule fired) or `manual` (Run now, Retry run). */
  readonly triggeredBy?: ScheduleRunTrigger;
}

/** `GET /api/schedules` item (data model; D8). Provisional: M7.1. */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cron: string;
  readonly paused: boolean;
  /** Session config (NewSession) + prompt (D8): the `task` is the prompt each run starts with. */
  readonly template: unknown;
  /** Oldest first, at most 14. */
  readonly runs: readonly ScheduleRun[];
  /** The next time the cron fires; `null` while paused or when the expression never fires again. */
  readonly nextRunAt: string | null;
  /** Additive (M7.1): a run is in progress (its session runs or waits for the developer); Run now is refused (409) and a cron firing is `skipped`. */
  readonly running?: boolean;
  /**
   * Additive (D14): the saved folder the runs start in (also `template.folder`);
   * `null` = the default folder at run time (a schedule saved before any folder
   * existed) or the folder was removed.
   */
  readonly folder?: string | null;
  /**
   * Additive (D52, `docs/peers.md` → *A peer's schedules and loops*): the paired
   * machine the schedule lives and runs on, only on a peer's schedule (its `id`
   * and its runs' `sessionId` are then remote ids); absent for this machine's own.
   * `state` other than `online` = its last known state (actions are refused).
   */
  readonly machine?: SessionMachine | null;
}

/**
 * Additive (D52): a loop observed in a terminal `claude` session Switchboard does
 * not follow (neither its own nor hooked), derived read-only from that session's
 * transcript on its machine (`GET /api/terminal-loops`). It cannot be opened
 * until the session is hooked (D48 P4: "Hook into…").
 */
export interface TerminalLoop {
  /**
   * The loop as a session's loop reads (`Session.loops`): `id` = `term:<claude
   * session id>:<key>` (a remote id on a peer's), `sessionId` = the terminal's
   * claude session id (not a Switchboard session), cap + breaker from a
   * `.loop/progress.md` in its cwd.
   */
  readonly loop: Loop;
  /** The terminal session (its claude session id, name, cwd, the CLI's status words, pid, start). */
  readonly terminal: {
    readonly id: string;
    readonly name: string | null;
    readonly cwd: string | null;
    readonly status: string | null;
    readonly pid: number | null;
    readonly startedAt: string | null;
  };
  /** The paired machine it runs on (a peer's); absent for this machine's own. */
  readonly machine?: SessionMachine | null;
}

/**
 * Additive (M7.1, D8): the `POST /api/schedules` body the New-session modal's
 * "Save schedule" sends. Without `id` it creates a schedule; with the `id` of an
 * existing one it replaces its cron and template (Edit). The schedule's name is
 * `template.name`, its description the first line of `template.task` (the prompt).
 * D14: `template.folder` picks the folder (default folder when omitted); the
 * stored template always carries the folder's id.
 */
export interface ScheduleInput {
  readonly id?: string;
  readonly cron: string;
  /** The NewSession each run starts (D14: a {@link NewRepoSession} for a repo folder). */
  readonly template: NewSession | NewRepoSession;
}

/**
 * `GET /api/history` item (M7.4, docs/spike-m0.md → What History needs;
 * `docs/derivations.md` → *History*, rules in `src/core/history.ts`).
 */
export interface HistoryItem {
  readonly claudeSessionId: string;
  /** Switchboard's id when the session is in the DB; `null` for a terminal-started session. */
  readonly sessionId: string | null;
  /** DB `createdAt`, else the transcript's first timestamp. */
  readonly startedAt: string;
  readonly name: string;
  /**
   * Additive (D22): what a stored session's row shows: its title, else its name
   * ({@link name}). Absent on a terminal conversation's row, which shows {@link name}.
   */
  readonly displayTitle?: string;
  /** `orch · feature · UI-first` for a stored session; `terminal` (+ ` · /loop 1h` when it started with a command) otherwise. */
  readonly mode: string;
  /** The last main-chain assistant text (collapsed, at most 240 characters). */
  readonly summary: string;
  readonly branches: readonly BranchRef[];
  /** Additive (M7.4): solutions in the session without a branch in {@link branches} (in-place sessions, terminal folders). */
  readonly solutions: readonly string[];
  /** `PR #n merged`, a status word (`running`, `done`, …), or `active` / `ended` for a terminal session. */
  readonly outcome: string;
  /** The outcome's color (terminal sessions: `run` while active, else `idle`). */
  readonly status: SessionStatus;
  /** Additive (D14): the saved folder the session belongs to (a stored session's folder, else the saved folder its transcript started in); `null` when none. */
  readonly folder: string | null;
  /** Additive (D14): that folder's path (a stored session's root, else the folder the transcript started in); `null` when unknown. */
  readonly folderPath: string | null;
  /**
   * Additive (D16): `true` for a conversation started in a terminal that is not in
   * Switchboard yet: it can continue there as the same conversation
   * (`POST /api/history/{claudeSessionId}/continue`). Absent otherwise.
   */
  readonly terminal?: boolean;
  /** Additive (D16): a terminal conversation's first prompt (else its first command), collapsed and cut at 240 characters. */
  readonly firstPrompt?: string | null;
  /** Additive (D16): the folder a terminal conversation started in (where it continues). */
  readonly cwd?: string | null;
  /**
   * Additive (D24): `true` on a terminal conversation whose transcript has a
   * `bridge-session` line (it had Remote Control on): the row's "Remote Control"
   * badge. Absent otherwise.
   */
  readonly remoteControl?: boolean;
  /**
   * Additive (D33): on a stored session's row, when the session was closed (the
   * row's "Closed" tag and Reopen, `POST /api/sessions/{id}/reopen`); `null` while
   * it is open. Absent on a terminal conversation's row.
   */
  readonly closedAt?: string | null;
}

/**
 * Additive (D16): body of `POST /api/history/{claudeSessionId}/continue`, which
 * moves a terminal conversation into Switchboard as the same conversation
 * (`docs/derivations.md` → *History*, `docs/supervisor.md` → *Continue in Switchboard*).
 * Every field is optional; the answer is `201 Session`.
 */
export interface ContinueConversation {
  /**
   * The session's name (kebab-case, unique); omitted = derived from {@link title}
   * when one is given (D22), else from the conversation's title, else its first prompt.
   */
  readonly name?: string;
  /**
   * Additive (D22, developer ruling 2026-09-28): the moved session's title (trimmed,
   * 1–80 characters, else 422 on field `title`); omitted or `null` = the
   * conversation's own title (custom, else AI), none without one.
   */
  readonly title?: string | null;
  /** Add the workspace or repo the conversation sits in to the saved folders (after `409 folder-not-saved`). */
  readonly addFolder?: boolean;
  /** Move it although a terminal may still have it open (after `409 terminal-open`). */
  readonly confirm?: boolean;
}

/**
 * Additive (D25): body of `POST /api/sessions/teleport`, which continues a remote
 * session (claude.ai/code, or Remote Control on another machine) locally: a new
 * worktree of a **repo** folder, `claude -p --teleport <session_X>` there, then a
 * normal supervised session (`docs/supervisor.md` → *Teleport*). The answer is
 * `201 Session` with {@link Session.remoteSource} set.
 */
export interface TeleportSession {
  /** A claude.ai/code session URL (query string ignored), `session_<X>` or `cse_<X>`; else 422 on field `remote`. */
  readonly remote: string;
  /** The saved **repo** folder's id; a workspace folder or an unknown id is 422 on field `folder`. */
  readonly folder: string;
  /**
   * The session's title (D22: trimmed, 1–80 characters, else 422 on field `title`);
   * its short name is derived from it (`-2`, `-3`, … when taken). Omitted, `null`
   * or blank = title `Remote <first 8 characters of X>`, name `remote-<the same, lower-cased>`.
   */
  readonly title?: string | null;
  /**
   * Optional first message, written to the local copy right after the spawn (the
   * CLI may report its session only once it takes a message, `docs/supervisor.md`
   * → *Teleport*). Omitted or blank = none: the local copy stays idle.
   */
  readonly task?: string;
}

/**
 * Additive (D25): a teleport the CLI refused or never finished. Nothing is left
 * behind: the worktree and branch Switchboard created are removed and no session
 * is stored. `message` is the CLI's own text, verbatim (its stderr, else what it
 * printed on stdout) when it has one.
 * - 502 `teleport-failed`: `claude` exited before it reported the local session (`system/init`);
 * - 504 `teleport-timeout`: it did not report the local session in time and was stopped.
 */
export interface TeleportRefusal {
  readonly error: 'teleport-failed' | 'teleport-timeout';
  readonly message: string;
}

/**
 * Additive (D16): the refusals of `POST /api/history/{claudeSessionId}/continue`
 * that the UI acts on. Others are `{ error, message }` (404 `not-found`, 409
 * `folder-missing`, 422 `not-a-terminal-conversation`, 422 `invalid` with `errors`).
 */
export type ContinueRefusal =
  /** 409: a Switchboard session already has this conversation. */
  | { readonly error: 'already-in-switchboard'; readonly message: string; readonly sessionId: string }
  /** 409: no saved folder holds the conversation; `check` is the workspace or repo it sits in (send `addFolder: true`). */
  | { readonly error: 'folder-not-saved'; readonly message: string; readonly check: FolderCheck }
  /** 409: a terminal may still have it open (the Attach-here reasons; send `confirm: true`). */
  | { readonly error: 'terminal-open'; readonly message: string; readonly reasons: readonly AttachWarningReason[] }
  /** 422: it started outside every workspace and git repository. */
  | { readonly error: 'not-in-a-folder'; readonly message: string; readonly cwd: string };

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
  /**
   * Additive (D15): the tool's loopback framing proxy, which the Tool view's iframe
   * loads (`docs/tools.md` → *Framing proxy*); `null` when the tool has no URL or no
   * proxy runs for it (demo mode). Ignored in a `PUT /api/tools` body.
   */
  readonly frameUrl: string | null;
}

/** `POST /api/tools/{id}/probe` (contract). */
export interface ToolProbe {
  readonly state: 'up' | 'down';
  /**
   * Additive (D15): present only when the tool is up, refuses to be framed by this
   * page (`X-Frame-Options` / CSP `frame-ancestors`) and no framing proxy runs for
   * it, so the Tool view offers New tab instead of a blank frame.
   */
  readonly framing?: 'refused';
}

/**
 * Additive (D35, `docs/frame-helper.md` → *Guided setup*): `GET /api/frame-helper`,
 * the frame helper's folder and version in the checkout the service runs from.
 */
export interface FrameHelperInfo {
  /** Absolute path of `tools/frame-helper` (the folder Chrome's "Load unpacked" takes), in the service's OS form. */
  readonly path: string;
  /** The `version` of its `manifest.json`. */
  readonly version: string;
}

/** Additive (D35): the 502 of `POST /api/frame-helper/reveal` and `/open-extensions` when the OS opener failed. */
export interface FrameHelperOpenError {
  readonly error: 'open-failed';
  /** The opener's own error (its stderr, or how it ended), e.g. `open -a Google Chrome chrome://extensions: Unable to find application named 'Google Chrome'`. */
  readonly message: string;
}

/**
 * One project listed in the workspace's `.claude/.codebase-memory-dirty` (M8.1
 * strip, gap #4; the file M6.4 reads for freshness). Additive, not in the contract.
 */
export interface CodebaseMemoryProject {
  /** The line of the file verbatim: codebase-memory's project id. */
  readonly id: string;
  /** The repo folder name (`acme-app-front`, `mobile`), else the id. */
  readonly name: string;
  /** Absolute repo path when the id belongs to the workspace root, else `null`. */
  readonly path: string | null;
  /** When the project was marked dirty; `null` when unknown (the file keeps no times). */
  readonly markedAt: string | null;
}

/** `GET /api/codebase-memory` (additive, M8.1): the Codebase Memory tool's strip. */
export interface CodebaseMemoryStatus {
  readonly projects: readonly CodebaseMemoryProject[];
  /** Indexed-project count and index mode; `null` when unknown (never invented). */
  readonly indexed: { readonly projects: number; readonly mode: string } | null;
}

/**
 * `GET /api/system` (contract fields) and the `system` hub event. Units, which the
 * contract leaves open: `cpu` and `usagePct` are percentages 0–100, `ramUsed` and
 * `ramTotal` are bytes, `processes` = live supervised `claude` processes (gap #11).
 * CLI/gh fields and metrics since M5.3 (`docs/setup.md` → *System*); usage: M9.2.
 */
export interface SystemInfo {
  /** CLI path or command when found (`<cli> --version` exits 0), `null` when not found. */
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
  /** Additive (M9.2, `docs/usage.md`): the usage warnings in force (fired, window not reset yet); omitted when none. */
  readonly usageWarnings?: readonly UsageWarning[];
  /**
   * Additive (D17, `docs/usage.md`): each usage window known now, for the footer's
   * rows: `session` (5-hour), `week` (weekly, all models), then a `model` window per
   * model-scoped weekly limit while it is in use. A window that is unknown is left
   * out (never guessed); the field is omitted when none is known.
   */
  readonly usageWindows?: readonly UsageWindow[];
}

/** A Max usage window (M9.2): `get_usage` `rate_limits.five_hour` / `seven_day`. */
export type UsageWindowName = 'five_hour' | 'seven_day';

/** Additive (D17): what a {@link UsageWindow} is: the 5-hour session, the weekly limit (all models), or one model's weekly limit. */
export type UsageWindowKey = 'session' | 'week' | 'model';

/** Additive (D17, `docs/usage.md`): one usage window known now (`SystemInfo.usageWindows`). */
export interface UsageWindow {
  readonly key: UsageWindowKey;
  /** The footer row's label: `Session`, `Week`, or the model's name (`Fable`). */
  readonly label: string;
  /** Utilization 0–100. */
  readonly pct: number;
  /** When the window resets (ISO 8601 UTC). */
  readonly resetsAt: string;
  /** `key: 'model'` only: the model's display name as the CLI sends it. */
  readonly model?: string;
  /**
   * `key: 'model'` only, additive: when the value comes from a `get_usage` reading
   * older than `MODEL_WINDOW_MAX_AGE_MS`, that reading's time (ISO 8601); the footer
   * shows `as of <age>` instead of the reset (developer ruling 2026-09-28: keep the
   * last value, marked old). Absent while the reading is fresh.
   */
  readonly asOf?: string;
}

/** Additive (D17): the window a {@link UsageWarning} is about; `model` = a model-scoped weekly limit named by `UsageWarning.model`. */
export type UsageWarningWindow = UsageWindowName | 'model';

/**
 * Additive (M9.2): a usage warning. It fires once when a window reaches the
 * Settings threshold and stays in force until that window resets ("just warn":
 * nothing is paused). The UI shows it as a toast once per window and reset.
 */
export interface UsageWarning {
  readonly window: UsageWarningWindow;
  /** Additive (D17): `window: 'model'` only, the model's display name (`Fable`). */
  readonly model?: string;
  /** The window's utilization when the warning fired (0–100). */
  readonly pct: number;
  /** The threshold it reached (Settings `usage.warnAtPct`, default 90). */
  readonly threshold: number;
  /** When the window resets (ISO); the warning is in force until then. */
  readonly resetsAt: string;
  readonly firedAt: string;
}

/**
 * Additive (D14): why a path cannot be a saved folder (`docs/folders.md` → *Kinds*).
 * - `not-absolute`: the path is not absolute (`~` counts as the home folder);
 * - `missing`: nothing is there;
 * - `not-a-folder`: a file;
 * - `git-worktree`: `.git` is a file (a linked worktree or a submodule): add its main checkout instead;
 * - `unsupported`: neither a git main checkout nor a folder with an `AGENTS.md`.
 */
export type FolderProblem = 'not-absolute' | 'missing' | 'not-a-folder' | 'git-worktree' | 'unsupported';

/**
 * Additive (D14): what a folder is, checked live on disk (`GET /api/folders/check`,
 * and each saved {@link Folder}'s `check`). The UI builds the check line from it:
 * `✓ AGENTS.md (Workspace Router) · 38 solutions`, `✓ git repo · single solution`,
 * or the problem.
 */
export interface FolderCheck {
  /** The path checked: absolute with `~` expanded (as typed when it is not absolute). */
  readonly path: string;
  /** The folder resolved on disk (realpath); `null` when there is nothing there. */
  readonly canonicalPath: string | null;
  /** A folder exists at {@link path}. */
  readonly exists: boolean;
  /** `repo` = a git main checkout; `workspace` = a folder with a router `AGENTS.md` that is not a main checkout; `null` = refused ({@link problem}). */
  readonly kind: FolderKind | null;
  /** Workspace: `<path>/AGENTS.md`'s first `# ` heading and its line count; `null` otherwise. */
  readonly router: { readonly title: string | null; readonly lines: number } | null;
  /** Workspace: how many solutions its scan lists (every group of `GET /api/solutions`); repo: 1; `null` when refused or the scan failed. */
  readonly solutionCount: number | null;
  /** Repo: its name (the folder name), which is its one solution; `null` otherwise. */
  readonly repoName: string | null;
  /** Why it cannot be a folder; `null` for a workspace or a repo. */
  readonly problem: FolderProblem | null;
  /** The problem in words (`no AGENTS.md here and not a git repository`); empty when there is none. */
  readonly message: string;
}

/**
 * Additive (D14): a saved folder (`GET /api/folders`, Settings → Folders, the
 * New-session form's Folder row): a workspace or a git repo sessions start in.
 */
export interface Folder {
  readonly id: string;
  /** Absolute path as it was added (`~` expanded). */
  readonly path: string;
  /** The folder resolved on disk when it was added or last used (realpath); unique among saved folders. */
  readonly canonicalPath: string;
  /**
   * Its last path segment (for a repo: the repo's name, its one solution). D18: the
   * folder's own name, unchanged by a custom name; worktrees are named after it
   * (`<repo>-wt-<session>`).
   */
  readonly name: string;
  /**
   * Additive (D18): the folder's custom name (trimmed, at most 40 characters,
   * unique among saved folders ignoring case); `null` when it has none.
   */
  readonly label: string | null;
  /** Additive (D18): what the UI shows for the folder: {@link label}, else {@link name}. */
  readonly displayName: string;
  /** What it was when added (sessions use this); {@link check} says what it is now. */
  readonly kind: FolderKind;
  /** Sessions, scans and schedules use it when no folder is named. Exactly one saved folder is the default. */
  readonly isDefault: boolean;
  readonly addedAt: string;
  /** When a session last started in it; `null` before the first. */
  readonly lastUsedAt: string | null;
  /** The live check of {@link path}. */
  readonly check: FolderCheck;
}

/** Additive (D14): `POST /api/folders` body. `path` is absolute, or `~/…`. */
export interface AddFolderRequest {
  readonly path: string;
  /**
   * Additive (D18): an optional custom name (trimmed; empty or omitted = none).
   * For a folder saved already, a non-empty name renames it.
   */
  readonly label?: string | null;
}

/**
 * Additive (D18): `PUT /api/folders/{id}/label` body (Rename in Settings →
 * Folders). `null` or an empty string removes the custom name.
 */
export interface RenameFolderRequest {
  readonly label: string | null;
}

/** Additive (D14): the `409` body of `DELETE /api/folders/{id}` while schedules still start their runs in the folder. */
export interface FolderInUse {
  readonly error: 'folder-in-use';
  readonly message: string;
  /** The schedules' names. */
  readonly schedules: readonly string[];
}

/** Additive (M5.3; D14): `GET /api/setup`, the first-run wizard's state (`docs/setup.md`). */
export interface SetupState {
  /** When the wizard was finished; `null` = setup not done. */
  readonly completedAt: string | null;
  /** Open the wizard when the UI loads: setup not done and `SWITCHBOARD_SETUP_WIZARD` is not `off`. */
  readonly autoOpen: boolean;
  /**
   * D14: the saved folders (as `GET /api/folders`, the default first). Empty = the
   * wizard's "Add your first folder" step has nothing yet; the step is skippable.
   */
  readonly folders: readonly Folder[];
  /** The usage warning threshold (M8.2's `usage.warnAtPct`, default 90). */
  readonly warnAtPct: number;
}

/** Additive (M5.3): `GET /api/setup/folders`, one folder's subfolders for Browse… (the wizard, Settings → Folders → Add…, the New-session form). */
export interface FolderListing {
  readonly path: string;
  /** `null` at the top of the file system. */
  readonly parent: string | null;
  readonly folders: ReadonlyArray<{ readonly name: string; readonly path: string }>;
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
  /** Additive (D19): a session's live activity changed (at most one per second per session; `null` = the turn ended; D30: and no background task is pending). */
  readonly activity: { readonly sessionId: string; readonly activity: SessionActivity | null };
  /**
   * Additive (D52 ruling D52-peer-edits-live): a schedule changed: saved (created or
   * edited), paused, resumed, deleted, or its run state changed (with every
   * `scheduleRun`). Forwarded between peers (a peer's with its remote id), so a
   * schedule edited on one machine shows on the other at once.
   */
  readonly schedulesChanged: { readonly scheduleId: string; readonly change: ScheduleChange };
  /**
   * Additive (D54): the sidebar's pins and folders changed (any `/api/sidebar*`
   * write, in any tab); the payload is the whole new layout. This machine's
   * only: never forwarded between peers.
   */
  readonly sidebarLayoutChanged: SidebarLayout;
  /**
   * Additive (D55): the updater's state changed (a check started or ended, an
   * update's progress, a dismissed banner); the payload is the whole
   * `GET /api/updates` answer. This machine's only: never forwarded between peers.
   */
  readonly updateChanged: UpdateStatus;
}

/** D52: what happened to a schedule (`schedulesChanged`). */
export type ScheduleChange = 'saved' | 'paused' | 'resumed' | 'deleted' | 'run';

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
  'activity',
  'schedulesChanged',
  'sidebarLayoutChanged',
  'updateChanged',
];

/** Body of a route that exists but whose backlog item has not landed yet (HTTP 501). */
export interface NotImplementedBody {
  readonly error: 'not-implemented';
  /** The backlog item that implements the route (`docs/lanes.md`). */
  readonly item: string;
}
