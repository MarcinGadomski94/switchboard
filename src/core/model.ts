/**
 * Enumerations of the data model (`docs/handoff/ARCHITECTURE.md` → *Data model*,
 * `docs/handoff/contracts/local-api.md` → *NewSession*). Shared by the store, the
 * server and later the UI. Each union has a matching `readonly` list so values that
 * come from outside (HTTP bodies, the database) can be checked at runtime.
 *
 * The lists marked "locked" come from the contract or the architecture data model;
 * the database enforces them with CHECK constraints (`docs/database.md`).
 */

/** Session status (locked): the status dot colors. */
export const SESSION_STATUSES = ['need', 'run', 'done', 'fail', 'idle', 'paused'] as const;
/** Session status. */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** NewSession `workType` (locked). */
export const WORK_TYPES = ['feature', 'qa'] as const;
/** Work type of a session. */
export type WorkType = (typeof WORK_TYPES)[number];

/** NewSession `mode` (locked). */
export const SESSION_MODES = ['single', 'orchestrator'] as const;
/** Session mode. */
export type SessionMode = (typeof SESSION_MODES)[number];

/** NewSession `phase` (locked). */
export const PHASES = ['ui-first', 'integration'] as const;
/** Phase of a session. */
export type Phase = (typeof PHASES)[number];

/** NewSession `coordination` (locked; `null` = not applicable). */
export const COORDINATIONS = ['sequential', 'parallel-twin', 'none'] as const;
/** Mobile coordination of a single-solution feature session. */
export type Coordination = (typeof COORDINATIONS)[number];

/** NewSession `qa.stack` (locked). */
export const QA_STACKS = ['web', 'mobile', 'both'] as const;
/** QA stack under test. */
export type QaStack = (typeof QA_STACKS)[number];

/**
 * Folder kind (D14, locked by the decision): a `workspace` is a folder with a
 * router `AGENTS.md` that is not itself a git main checkout (many solutions,
 * router rules); a `repo` is a git main checkout (one solution). D59 adds
 * `plain`: any other folder (no `AGENTS.md`, not a git repository), for Simple
 * sessions only: no solutions, no worktrees, no router answers.
 */
export const FOLDER_KINDS = ['workspace', 'repo', 'plain'] as const;
/** Kind of a saved folder / of a session's folder. */
export type FolderKind = (typeof FOLDER_KINDS)[number];

/** Where a session came from (D16, migration 0004): started in Switchboard, or moved in from a terminal. */
export const SESSION_ORIGINS = ['switchboard', 'terminal'] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/** Event kind (locked). Drives the chat, the timeline and the terminal tail. */
export const EVENT_KINDS = ['plan', 'impl', 'loop', 'ask', 'ok', 'tool', 'text', 'error'] as const;
/** Event kind. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** Artifact type (locked). */
export const ARTIFACT_TYPES = ['PR', 'BRANCH', 'DIFF', 'DOC', 'CONTRACT', 'QA', 'FOLLOWUP', 'TICKET'] as const;
/** Artifact type. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Question batch state (locked by ARCHITECTURE → *Stored state*). A question has its batch's state. */
export const QUESTION_STATES = ['open', 'answered', 'stale'] as const;
/** Question batch state. */
export type QuestionState = (typeof QUESTION_STATES)[number];

/** Agent kind (gap #8): the session's main agent, one per Agent/Task tool call, workflow agents. */
export type AgentKind = 'main' | 'subagent' | 'workflow';

/** Permission request state. `stale` closes the item without a decision. */
export type PermissionState = 'open' | 'decided' | 'stale';

/** Permission decision (D6: Allow once / Deny). */
/** D6: Allow once / Deny; D48 P4: `always-allow` for a hooked terminal session's request (its `updatedPermissions`). */
export type PermissionDecision = 'allow-once' | 'always-allow' | 'deny';

/** System Inbox item state. */
export type SystemItemState = 'open' | 'closed';

/** How a question batch's answers reached the CLI. */
export type AnswerDelivery = 'control_response' | 'user_message';

/** Result of one scheduled run (the 14-run strip). */
export type ScheduleRunResult = 'running' | 'ok' | 'fail' | 'need' | 'skipped';

/** What started a scheduled run. */
export type ScheduleRunTrigger = 'cron' | 'manual';

/** Source of a usage reading (ARCHITECTURE → *Usage meter*). */
export type UsageSource = 'get_usage' | 'rate_limit_event';

/** `true` if `value` is one of `list`. */
export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
