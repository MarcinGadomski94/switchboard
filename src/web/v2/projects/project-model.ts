import { type Plan, type PlanItem, type PlanMergeMode, PLAN_PICK_REPOS_REASON, PLAN_REOPENED_PREFIX, PLAN_STOPPED_NO_MESSAGE } from '../../../core/plans.ts';
import { durationShort, earlyStartWarning, isProtectedTargetName, shortLabel, timeline } from '../../plans/model.ts';
import { MODE_LABELS, PROJECT_WORDS, STEP_LABELS, type V2Status } from '../glossary.ts';

/**
 * D131 · lane P · the Projects pages' pure rules (a v2 "project" is a plan, D99; a "step" is a
 * plan item). DOM-free, unit-tested in `tests/web/v2-projects.test.ts`. The classic Plans
 * model (`src/web/plans/model.ts`) keeps the layout, timeline and label rules; this adds the v2
 * reading of them: the step states in plain words (D115 / D120 / D121 / D124 included), the
 * approval modes, the board columns, the step menu and its reasons, the list's counts.
 */

// ── step states ─────────────────────────────────────────────────────────

/** The v2 kinds of a step (the server's `PlanItemState`, with D115's "pick" split out). */
export type StepKind = 'waiting' | 'pick' | 'ready' | 'running' | 'question' | 'needs' | 'stopped' | 'approval' | 'confirm' | 'done' | 'blocked';

/** How a step shows: its v2 status (icon + word + colour), the word, and the line under its title. */
export interface StepLook {
  readonly kind: StepKind;
  readonly status: V2Status;
  readonly label: string;
  /**
   * The line under the title: the ask (D124), the agent's last message (D120), why it is blocked
   * or what it waits on; `null` = none (the caller shows the agent's activity).
   */
  readonly detail: string | null;
}

/** The step's v2 kind. */
export function stepKind(item: Pick<PlanItem, 'state' | 'reason'>): StepKind {
  switch (item.state) {
    case 'waiting':
      return item.reason === PLAN_PICK_REPOS_REASON ? 'pick' : 'waiting';
    case 'ready':
      return 'ready';
    case 'running':
      return 'running';
    case 'question':
      return 'question';
    case 'needs-you':
      return 'needs';
    case 'stopped':
      return 'stopped';
    case 'ready-to-merge':
      return 'approval';
    case 'to-confirm':
      return 'confirm';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
  }
}

/** The v2 status of each kind (amber = it needs you, red = stopped or blocked, violet = ready for approval). */
export const STEP_STATUS: Readonly<Record<StepKind, V2Status>> = {
  waiting: 'queued',
  pick: 'queued',
  ready: 'queued',
  running: 'working',
  question: 'needs',
  needs: 'needs',
  stopped: 'stopped',
  approval: 'ready',
  confirm: 'ready',
  done: 'done',
  blocked: 'stopped',
};

/** What a waiting step waits on: "Waiting on 101 API, 102 UI" (the open dependencies), `null` when none is open. */
export function waitingOn(item: Pick<PlanItem, 'dependsOn'>, items: readonly PlanItem[]): string | null {
  const open = item.dependsOn.map((id) => items.find((other) => other.id === id)).filter((dep): dep is PlanItem => dep !== undefined && dep.state !== 'done');
  if (open.length === 0) return null;
  return `Waiting on ${open.map((dep) => (dep.key ? `${shortLabel(dep, items)}` : dep.title)).join(', ')}`;
}

/** The look of a step (the list row, the board card, the graph node, the timeline bar). */
export function stepLook(item: PlanItem, items: readonly PlanItem[]): StepLook {
  const kind = stepKind(item);
  const status = STEP_STATUS[kind];
  switch (kind) {
    case 'waiting':
      return { kind, status, label: STEP_LABELS.waiting, detail: waitingOn(item, items) ?? 'Starts when a slot is free' };
    case 'pick':
      return { kind, status, label: STEP_LABELS.pick, detail: null };
    case 'ready':
      return { kind, status, label: STEP_LABELS.ready, detail: null };
    case 'running':
      return { kind, status, label: item.waitingOn === 'checks' ? STEP_LABELS.runningTests : STEP_LABELS.running, detail: null };
    case 'question':
      return { kind, status, label: STEP_LABELS.question, detail: null };
    case 'needs':
      return { kind, status, label: STEP_LABELS.needs, detail: item.reason };
    case 'stopped':
      return { kind, status, label: STEP_LABELS.stopped, detail: item.reason ?? PLAN_STOPPED_NO_MESSAGE };
    case 'approval':
      return { kind, status, label: STEP_LABELS.approval, detail: 'Its agent is done. Combine it, or send it back.' };
    case 'confirm':
      return { kind, status, label: STEP_LABELS.confirm, detail: 'Its agent marked it done. Confirm it, or send it back.' };
    case 'done':
      return { kind, status, label: STEP_LABELS.done, detail: null };
    case 'blocked':
      return { kind, status, label: STEP_LABELS.blocked, detail: item.reason };
  }
}

/** D121: the reopened notice of a step ("Reopened: it was marked merged but …"), `null` = none. */
export function reopenedNotice(item: Pick<PlanItem, 'note'>): string | null {
  const note = item.note ?? '';
  if (!note.startsWith(PLAN_REOPENED_PREFIX)) return null;
  const end = note.indexOf('; started before');
  return end < 0 ? note : note.slice(0, end);
}

/** D121: the early-start warning of a step (its dependency was falsely done when it started), `null` = none. */
export function earlyStart(item: Pick<PlanItem, 'note'>): string | null {
  return earlyStartWarning(item);
}

/** "est 30m · took 45m" (estimate vs actual); `null` when neither is known. */
export function estimateLine(item: Pick<PlanItem, 'estimateMinutes' | 'actualMinutes' | 'state'>): string | null {
  const parts: string[] = [];
  if (item.estimateMinutes !== null) parts.push(`est ${durationShort(item.estimateMinutes)}`);
  if (item.actualMinutes !== null && (item.state === 'done' || item.actualMinutes >= 1)) parts.push(`${item.state === 'done' ? 'took' : 'so far'} ${durationShort(item.actualMinutes)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Whether a step waits for the developer (the amber / red / violet ones). */
export function stepNeedsYou(item: Pick<PlanItem, 'state' | 'reason'>): boolean {
  const kind = stepKind(item);
  return kind === 'question' || kind === 'needs' || kind === 'stopped' || kind === 'approval' || kind === 'confirm';
}

// ── the approval mode ───────────────────────────────────────────────────

/** The four modes in the order the select lists them. */
export const MODE_ORDER: readonly PlanMergeMode[] = ['agents', 'agents-with-holds', 'developer', 'none'];

/** A mode in plain words ("Not chosen yet" for a draft). */
export function modeLabel(mode: PlanMergeMode | null): string {
  return mode === null ? MODE_LABELS.unset : MODE_LABELS[mode];
}

/** The modes a project offers: without a target branch only "No combining". */
export function modeOptions(plan: Pick<Plan, 'targetBranch'>): readonly PlanMergeMode[] {
  return plan.targetBranch === null ? ['none'] : MODE_ORDER;
}

/** Whether agents combine on their own in this mode. */
export function agentsCombine(mode: PlanMergeMode | null): boolean {
  return mode === 'agents' || mode === 'agents-with-holds';
}

/**
 * Whether `mode` needs the protected-destination acknowledgement on this project: an agent mode
 * whose target is `dev`, `develop`, `main` or `master` (the server also knows the repo's default
 * and protected branches, and refuses with `target-forbidden`; the page then asks too).
 */
export function needsProtectedAck(plan: Pick<Plan, 'targetBranch'>, mode: PlanMergeMode | null, refusedProtected = false): boolean {
  return agentsCombine(mode) && (refusedProtected || isProtectedTargetName(plan.targetBranch));
}

/** The acknowledgement's words: "Agents will combine straight into dev". */
export function protectedAckText(plan: Pick<Plan, 'targetBranch'>): string {
  return PROJECT_WORDS.protectedAck(plan.targetBranch ?? 'the target branch');
}

// ── the list ────────────────────────────────────────────────────────────

/** A project card's numbers. */
export interface ProjectCounts {
  readonly done: number;
  readonly total: number;
  readonly running: number;
  readonly approval: number;
  readonly needsYou: number;
  readonly stopped: number;
}

/** The counts on a project card (the list) and in its header. */
export function projectCounts(plan: Pick<Plan, 'items' | 'progress'>): ProjectCounts {
  const kinds = plan.items.map(stepKind);
  return {
    done: plan.progress.done,
    total: plan.progress.total,
    running: kinds.filter((kind) => kind === 'running').length,
    approval: kinds.filter((kind) => kind === 'approval' || kind === 'confirm').length,
    needsYou: plan.items.filter(stepNeedsYou).length,
    stopped: kinds.filter((kind) => kind === 'stopped' || kind === 'blocked').length,
  };
}

/** "about 3h left", `null` without an estimate. */
export function timeLeft(plan: Pick<Plan, 'estimatedMinutesLeft' | 'state'>): string | null {
  if (plan.state === 'done' || plan.state === 'cancelled' || plan.estimatedMinutesLeft === null) return null;
  return PROJECT_WORDS.timeLeft(durationShort(plan.estimatedMinutesLeft));
}

/** The project's own state as a v2 status (its card chip when nothing needs you). */
export function projectStatus(plan: Pick<Plan, 'state' | 'items'>): { readonly status: V2Status; readonly label: string } {
  switch (plan.state) {
    case 'draft':
      return { status: 'idle', label: 'Not started' };
    case 'paused':
      return { status: 'paused', label: 'On hold' };
    case 'done':
      return { status: 'done', label: 'Done' };
    case 'cancelled':
      return { status: 'userstop', label: 'Cancelled' };
    case 'running':
      return plan.items.some((item) => item.state === 'running') ? { status: 'working', label: 'Working' } : { status: 'queued', label: 'Waiting' };
  }
}

/** The Jira tag of a project ("PROJ-10"), `null` when it is not from Jira. */
export function jiraTag(plan: Pick<Plan, 'external'>): string | null {
  return plan.external?.system === 'jira' ? plan.external.key : null;
}

/** The list's order: projects that need you first, then running, then drafts and paused ones, finished last; newest first within. */
export function sortProjects<T extends Pick<Plan, 'state' | 'items' | 'createdAt'>>(plans: readonly T[]): T[] {
  const rank = (plan: T): number => {
    if (plan.items.some(stepNeedsYou) && (plan.state === 'running' || plan.state === 'paused')) return 0;
    if (plan.state === 'running') return 1;
    if (plan.state === 'paused' || plan.state === 'draft') return 2;
    return 3;
  };
  return [...plans].sort((a, b) => rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
}

// ── the views ───────────────────────────────────────────────────────────

/** The project page's views. */
export const PROJECT_VIEWS = ['steps', 'board', 'graph', 'timeline'] as const;
/** One of {@link PROJECT_VIEWS}. */
export type ProjectView = (typeof PROJECT_VIEWS)[number];

/** The remembered view, checked (an unknown value = Steps). */
export function readProjectView(stored: string | null): ProjectView {
  return (PROJECT_VIEWS as readonly string[]).includes(stored ?? '') ? (stored as ProjectView) : 'steps';
}

/** The board's columns (Lane A's board: Needs you · Working · Ready for approval · Done). */
export const BOARD_COLUMNS = ['needs', 'working', 'ready', 'done'] as const;
/** One of {@link BOARD_COLUMNS}. */
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** The column titles. */
export const BOARD_COLUMN_LABELS: Readonly<Record<BoardColumn, string>> = { needs: 'Needs you', working: 'Working', ready: 'Ready for approval', done: 'Done' };

/** The column a step sits in (waiting steps sit with the working ones, as in the prototype). */
export function boardColumn(item: Pick<PlanItem, 'state' | 'reason'>): BoardColumn {
  switch (stepKind(item)) {
    case 'question':
    case 'needs':
    case 'stopped':
    case 'blocked':
      return 'needs';
    case 'approval':
    case 'confirm':
      return 'ready';
    case 'done':
      return 'done';
    default:
      return 'working';
  }
}

/** The board: each column's steps in the plan's order. */
export function boardColumns<T extends Pick<PlanItem, 'state' | 'reason' | 'position'>>(items: readonly T[]): Readonly<Record<BoardColumn, T[]>> {
  const out: Record<BoardColumn, T[]> = { needs: [], working: [], ready: [], done: [] };
  for (const item of [...items].sort((a, b) => a.position - b.position)) out[boardColumn(item)].push(item);
  return out;
}

/** One project's bars on the list's Timeline. */
export interface ProjectBar {
  readonly planId: string;
  readonly title: string;
  readonly from: number;
  readonly to: number;
  /** The end is projected (dashed). */
  readonly projected: boolean;
  readonly status: V2Status;
}

/**
 * The Projects list's Timeline: one bar per started project from its start to its end (done), or
 * to its projected finish (the classic timeline's projection), on one shared axis. Drafts have no bar.
 */
export function projectsTimeline(plans: readonly Plan[], now: number): { readonly bars: readonly ProjectBar[]; readonly start: number; readonly end: number } {
  const bars: ProjectBar[] = [];
  for (const plan of plans) {
    if (plan.state === 'draft') continue;
    const from = Date.parse(plan.startedAt ?? plan.createdAt);
    if (Number.isNaN(from)) continue;
    const finished = plan.finishedAt ? Date.parse(plan.finishedAt) : null;
    const view = finished === null ? timeline(plan, now) : null;
    const projectedEnd = view?.projectedFinish ?? null;
    const to = finished ?? Math.max(now, projectedEnd ?? now);
    bars.push({ planId: plan.id, title: plan.title, from, to: Math.max(to, from + 60_000), projected: finished === null, status: projectStatus(plan).status });
  }
  const start = bars.length > 0 ? Math.min(...bars.map((bar) => bar.from)) : now;
  const end = bars.length > 0 ? Math.max(now, ...bars.map((bar) => bar.to)) : now + 3_600_000;
  return { bars, start, end: end === start ? start + 3_600_000 : end };
}

/** A time's place on an axis as a percentage (clamped to 0–100). */
export function axisPercent(at: number, start: number, end: number): number {
  if (end <= start) return 0;
  return Math.min(100, Math.max(0, ((at - start) / (end - start)) * 100));
}

// ── step actions ────────────────────────────────────────────────────────

/** A step's ⋯ action. */
export type StepActionId = 'hold' | 'release' | 'reopen' | 'retry' | 'done' | 'change' | 'edit' | 'remove';

/** One entry of the step's ⋯ menu: enabled, or disabled with the reason. */
export interface StepAction {
  readonly id: StepActionId;
  readonly label: string;
  readonly disabledReason?: string;
}

function finished(plan: Pick<Plan, 'state'>): boolean {
  return plan.state === 'done' || plan.state === 'cancelled';
}

/** Why nothing can be done on a paired computer's project right now, `null` = it can. */
export function remoteBlock(plan: Pick<Plan, 'machine'>): string | null {
  if (!plan.machine) return null;
  return plan.machine.state === 'online' ? null : `${plan.machine.name} is offline; it can change once it reconnects.`;
}

/**
 * The step ⋯ menu (Hold / Release hold, Reopen (D121), Try again, Mark done, Open change request,
 * Edit (D129), Remove), each with the reason when it cannot be used (the menu shows why, never
 * hides an action).
 */
export function stepActions(plan: Pick<Plan, 'state' | 'machine' | 'targetBranch' | 'mergeMode'>, item: Pick<PlanItem, 'state' | 'storedState' | 'hold' | 'prUrl'>): StepAction[] {
  const blocked = remoteBlock(plan) ?? (finished(plan) ? `The project is ${plan.state}.` : null);
  const why = (reason: string | null): { disabledReason?: string } => (blocked ? { disabledReason: blocked } : reason ? { disabledReason: reason } : {});
  const actions: StepAction[] = [];
  if (item.hold) actions.push({ id: 'release', label: PROJECT_WORDS.release, ...why(null) });
  else actions.push({ id: 'hold', label: PROJECT_WORDS.hold, ...why(item.state === 'done' ? 'Done steps can’t be held; reopen it instead.' : null) });
  const reopenWhy = item.state !== 'done' ? 'Only done steps can be reopened.' : plan.state !== 'running' && plan.state !== 'paused' ? 'Start the project first.' : null;
  actions.push({ id: 'reopen', label: PROJECT_WORDS.reopen, ...why(reopenWhy) });
  actions.push({ id: 'retry', label: PROJECT_WORDS.retry, ...why(item.storedState !== 'failed' ? 'Only a failed step can be tried again.' : null) });
  actions.push({ id: 'done', label: PROJECT_WORDS.markDone, ...why(item.state === 'done' ? 'It’s done already.' : plan.state === 'draft' ? 'Start the project first.' : null) });
  const changeWhy = item.prUrl ? null : item.state === 'ready-to-merge' ?(plan.targetBranch === null || plan.mergeMode === 'none' ? 'This project has no combine step.' : null) : 'No change request yet.';
  actions.push({ id: 'change', label: PROJECT_WORDS.openChange, ...(item.prUrl ? {} : why(changeWhy)) });
  actions.push({ id: 'edit', label: PROJECT_WORDS.edit, ...why(item.storedState !== 'pending' ? 'Only a step that hasn’t started can be edited.' : null) });
  actions.push({ id: 'remove', label: PROJECT_WORDS.remove, ...why(item.storedState === 'running' || item.storedState === 'done' ? 'A running or done step can’t be removed.' : null) });
  return actions;
}

/** What a step's primary click does: open its agent (it has a run session), else show its detail. */
export function stepOpens(item: Pick<PlanItem, 'runSessionId'>): { readonly agent: string } | { readonly detail: true } {
  return item.runSessionId ? { agent: item.runSessionId } : { detail: true };
}

/** D129: checks a pending step's edit; `null` = fine, else the field's problem. */
export function checkStepEdit(title: string, estimate: string): { readonly field: 'title' | 'estimate'; readonly message: string } | null {
  if (title.trim() === '') return { field: 'title', message: 'Give the step a title.' };
  if (estimate.trim() !== '') {
    const minutes = Number(estimate);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 100_000) return { field: 'estimate', message: 'Minutes, a whole number from 1.' };
  }
  return null;
}

/** The step's label for menus and toasts: "PROJ-101 API" (key and title), else the title. */
export function stepName(item: Pick<PlanItem, 'key' | 'title'>): string {
  if (!item.key) return item.title;
  return item.title.startsWith(item.key) ? item.title : `${item.key} ${item.title}`;
}

// ── Start ───────────────────────────────────────────────────────────────

/** Whether Start can be pressed: a mode chosen, and the acknowledgement when it is needed. */
export function canStart(plan: Pick<Plan, 'targetBranch' | 'items'>, mode: PlanMergeMode | null, acknowledged: boolean, refusedProtected = false): { readonly ok: boolean; readonly why: string | null } {
  if (plan.items.length === 0) return { ok: false, why: 'Add a step first.' };
  if (mode === null) return { ok: false, why: 'Choose who approves combining.' };
  if (needsProtectedAck(plan, mode, refusedProtected) && !acknowledged) return { ok: false, why: `Tick “${protectedAckText(plan)}” to start.` };
  return { ok: true, why: null };
}

/** The subfolder field's check (D130: at most 60 characters). */
export function checkSubfolder(name: string): string | null {
  return name.trim().length > 60 ? 'At most 60 characters.' : null;
}
