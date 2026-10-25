/**
 * D131 · lane R · the + New sheet's pure part (unit-tested in
 * `tests/web/v2-new.test.ts`; no DOM, no JSX): the kinds, each kind's form and its
 * checks, the bodies the existing APIs take, the routine presets and the
 * `new-session` machine draft (D88) the sheet saves and restores.
 *
 * The Agent kind posts the classic New-session bodies: a **Simple** start
 * (`toSimpleBody`, no workspace questions) unless Advanced › "Answer the
 * workspace questions now" is on, then the **Full** one (`toStartBody`).
 */
import type { NewRepoSession, NewSession, NewSimpleSession, OwnedLoopInput, TodoFieldsInput } from '../../../core/api.ts';
import type { TodoPriority } from '../../../core/api.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { TITLE_MAX } from '../../../core/session-title.ts';
import { TODO_NO_PLAN, TODO_TITLE_MAX } from '../../../core/todos.ts';
import { type FormFolder, DEFAULT_FORM, type NewSessionForm, canStart, formFromDraft, isPlainFolder, toStartBody } from '../../modals/new-session.ts';
import { simpleBlockers, toSimpleBody } from '../../modals/simple-session.ts';
import { NEW_WORDS } from '../glossary.ts';
import { type Speed, speedModel as sharedSpeedModel } from '../shared/speed.ts';

/** What the + New sheet can make (the prototype's types, in its order). */
export const NEW_KINDS = ['agent', 'conversation', 'task', 'project', 'routine', 'teammate', 'crew'] as const;
/** One of {@link NEW_KINDS}. */
export type NewKindId = (typeof NEW_KINDS)[number];

/** `true` for a known kind. */
export function isNewKind(value: unknown): value is NewKindId {
  return typeof value === 'string' && (NEW_KINDS as readonly string[]).includes(value);
}

// ── Agent / conversation ─────────────────────────────────────────────────

/** Smart / Fast (the prototype's Speed). */
export type { Speed } from '../shared/speed.ts';
/** Normal / Deep (the prototype's Thinking depth). */
export type Depth = 'normal' | 'deep';

/** The Agent and Conversation forms (the classic form underneath, plus the v2 choices). */
export interface AgentForm {
  /** The classic form (folder, title, message, router answers, branch, CLI, account, Ultracode). */
  readonly form: NewSessionForm;
  readonly speed: Speed;
  readonly depth: Depth;
  /** The exact model from Advanced (`''` = by speed). */
  readonly exactModel: string;
  /** Advanced › "Answer the workspace questions now" (the Full start). */
  readonly askQuestions: boolean;
  /** The sidebar folder it goes into (`''` = none). */
  readonly sidebarFolder: string;
  /** The computer (`null` = this one). */
  readonly machine: string | null;
}

/** The Agent form as the sheet opens it. */
export const DEFAULT_AGENT_FORM: AgentForm = {
  form: DEFAULT_FORM,
  speed: 'smart',
  depth: 'normal',
  exactModel: '',
  askQuestions: false,
  sidebarFolder: '',
  machine: null,
};

/**
 * The `--model` / `--effort` the speed and depth mean (`null` = the CLI's default):
 * Smart / Fast through the shared mapping (`shared/speed.ts`: Opus / Sonnet),
 * Deep = `high`, Normal = the default. An exact model wins.
 */
export function speedModel(speed: Speed, depth: Depth, provider: CliProviderId | null, offered: readonly { readonly value: string; readonly label?: string }[] | null, exact = ''): { readonly model: string | null; readonly effort: string | null } {
  const effort = depth === 'deep' ? 'high' : null;
  if (exact.trim() !== '') return { model: exact.trim(), effort };
  return { model: sharedSpeedModel(speed, offered, provider), effort };
}

/** Why the agent cannot start yet (empty = it can), in the order shown. */
export function agentProblems(agent: AgentForm, folder: FormFolder | null, takenNames: readonly string[], machineOffline: boolean): string[] {
  const out: string[] = [];
  if (folder === null) out.push(NEW_WORDS.errors.folder);
  if (agent.form.task.trim() === '') out.push(NEW_WORDS.errors.message);
  if (agent.form.name.trim().length > TITLE_MAX) out.push(NEW_WORDS.errors.titleLong(TITLE_MAX));
  if (machineOffline) out.push(NEW_WORDS.errors.computerOffline);
  if (out.length > 0) return out;
  if (agent.askQuestions) {
    if (!canStart(agent.form, takenNames, folder)) out.push(NEW_WORDS.errors.branch);
  } else {
    const blockers = simpleBlockers({ form: agent.form, folder, branch: agent.form.branch, takenNames });
    if (blockers.length > 0) out.push(NEW_WORDS.errors.branch);
  }
  return out;
}

/** The classic form with the model choice and the worktree rule applied. */
function launchForm(agent: AgentForm, offered: readonly { readonly value: string }[] | null): NewSessionForm {
  const choice = speedModel(agent.speed, agent.depth, agent.form.provider, offered, agent.exactModel);
  const changed = choice.model !== null || choice.effort !== null;
  return { ...agent.form, model: changed ? choice : agent.form.model };
}

/**
 * The `POST /api/sessions` body: Simple (the message alone, no router answers)
 * unless the workspace questions are answered here, then the Full body (D22/D32).
 */
export function agentBody(agent: AgentForm, folder: FormFolder | null, takenNames: readonly string[], offered: readonly { readonly value: string }[] | null): NewSimpleSession | NewSession | NewRepoSession {
  const form = launchForm(agent, offered);
  if (agent.askQuestions && folder !== null && !isPlainFolder(folder)) return toStartBody(form, folder, takenNames);
  return toSimpleBody({ form: { ...form, worktrees: form.worktrees && !isPlainFolder(folder) }, folder, branch: form.branch, takenNames });
}

/** The `POST /api/chats` body (D106): the message, the CLI, account and model. */
export function chatBody(agent: AgentForm, offered: readonly { readonly value: string }[] | null, attachments: readonly string[]): { readonly message: string; readonly attachments?: readonly string[]; readonly provider?: CliProviderId; readonly profileId?: string; readonly model?: string | null; readonly effort?: string | null } {
  const choice = speedModel(agent.speed, agent.depth, agent.form.provider, offered, agent.exactModel);
  return {
    message: agent.form.task.trim(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(agent.form.provider ? { provider: agent.form.provider } : {}),
    ...(agent.form.provider && agent.form.profileId ? { profileId: agent.form.profileId } : {}),
    ...(choice.model !== null || choice.effort !== null ? { model: choice.model, effort: choice.effort } : {}),
  };
}

/** Why the conversation cannot start (empty = it can). */
export function conversationProblems(agent: AgentForm): string[] {
  return agent.form.task.trim() === '' ? [NEW_WORDS.errors.message] : [];
}

// ── Task ─────────────────────────────────────────────────────────────────

/** The estimates offered (minutes; `null` = not estimated). */
export const ESTIMATES: readonly (number | null)[] = [null, 15, 30, 60, 120, 240];

/** `15 min`, `1 hour`, `4 hours`. */
export function estimateLabel(minutes: number | null): string {
  if (minutes === null) return NEW_WORDS.estimateNone;
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** The Task form. */
export interface TaskForm {
  readonly title: string;
  readonly description: string;
  readonly plan: string;
  readonly priority: TodoPriority;
  readonly estimate: number | null;
  /** The agent whose list it goes into. */
  readonly agent: string;
}

/** The Task form as it opens. */
export const DEFAULT_TASK_FORM: TaskForm = { title: '', description: '', plan: '', priority: 'medium', estimate: 30, agent: '' };

/** Why the task cannot be added (field → message). */
export function taskProblems(task: TaskForm): Partial<Record<'title' | 'agent', string>> {
  const out: Partial<Record<'title' | 'agent', string>> = {};
  const title = task.title.trim();
  if (title === '') out.title = NEW_WORDS.errors.title;
  else if (title.length > TODO_TITLE_MAX) out.title = NEW_WORDS.errors.titleLong(TODO_TITLE_MAX);
  if (task.agent === '') out.agent = NEW_WORDS.errors.agent;
  return out;
}

/** The `POST /api/sessions/{id}/todos` fields (an empty plan is `No plan`). */
export function taskBody(task: TaskForm): TodoFieldsInput {
  const description = task.description.trim();
  const plan = task.plan.trim();
  return { title: task.title.trim().replace(/\s+/g, ' '), description: description === '' ? null : description, plan: plan === '' ? TODO_NO_PLAN : plan, priority: task.priority, estimateMinutes: task.estimate };
}

// ── Routine ──────────────────────────────────────────────────────────────

/** A plain-words schedule and what the loop API takes for it. */
export interface RoutinePreset {
  readonly id: string;
  readonly label: string;
  readonly schedule: { readonly cron: string } | { readonly everyMinutes: number } | null;
}

/** The schedules in plain words (`custom` = a cron the developer types). */
export const ROUTINE_PRESETS: readonly RoutinePreset[] = [
  { id: 'every-30', label: 'Every 30 minutes', schedule: { everyMinutes: 30 } },
  { id: 'hourly', label: 'Every hour', schedule: { everyMinutes: 60 } },
  { id: 'morning', label: 'Every morning at 08:00', schedule: { cron: '0 8 * * *' } },
  { id: 'weekdays', label: 'Weekdays at 08:00', schedule: { cron: '0 8 * * 1-5' } },
  { id: 'friday', label: 'Every Friday at 15:00', schedule: { cron: '0 15 * * 5' } },
  { id: 'custom', label: 'Custom…', schedule: null },
];

/** The Routine form. */
export interface RoutineForm {
  readonly prompt: string;
  readonly agent: string;
  readonly preset: string;
  /** The cron of `custom`. */
  readonly cron: string;
}

/** The Routine form as it opens (the prototype's "Every morning at 08:00"). */
export const DEFAULT_ROUTINE_FORM: RoutineForm = { prompt: '', agent: '', preset: 'morning', cron: '' };

/** A five-field cron (the server checks it for real). */
const CRON_SHAPE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;

/** Why the routine cannot be made (field → message). */
export function routineProblems(routine: RoutineForm): Partial<Record<'prompt' | 'agent' | 'cron', string>> {
  const out: Partial<Record<'prompt' | 'agent' | 'cron', string>> = {};
  if (routine.prompt.trim() === '') out.prompt = NEW_WORDS.errors.message;
  if (routine.agent === '') out.agent = NEW_WORDS.errors.agent;
  if (routine.preset === 'custom' && !CRON_SHAPE.test(routine.cron)) out.cron = NEW_WORDS.errors.cron;
  return out;
}

/** The `POST /api/sessions/{id}/loops` body (D94): the prompt, the schedule and a label (the preset's words). */
export function routineBody(routine: RoutineForm): OwnedLoopInput {
  const preset = ROUTINE_PRESETS.find((entry) => entry.id === routine.preset) ?? ROUTINE_PRESETS[2];
  const schedule = preset?.schedule ?? { cron: routine.cron.trim().replace(/\s+/g, ' ') };
  const prompt = routine.prompt.trim();
  const label = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;
  return { prompt, label, ...schedule };
}

// ── Project ──────────────────────────────────────────────────────────────

/** One step of a project, as written (one per line). */
export interface StepLine {
  readonly title: string;
  /** The earlier step it waits on (its title), from "(after …)". */
  readonly after: string | null;
}

/** The steps written one per line; "(after <step>)" at the end makes it wait on that earlier step. */
export function parseSteps(text: string): StepLine[] {
  const out: StepLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*•\d.)\s]+(?=\S)/, '').trim();
    if (line === '') continue;
    const match = /^(.*?)\s*\((?:after|waits on)\s+([^)]+)\)\s*$/i.exec(line);
    const title = (match ? (match[1] ?? '') : line).trim();
    if (title === '') continue;
    out.push({ title: title.slice(0, TODO_TITLE_MAX), after: match ? (match[2] ?? '').trim() : null });
  }
  return out;
}

/** The index of the earlier step an "after" names (case-insensitive; a prefix is enough), `-1` when none. */
export function stepIndex(steps: readonly StepLine[], before: number, name: string): number {
  const wanted = name.trim().toLowerCase();
  for (let i = 0; i < before; i += 1) if ((steps[i]?.title.toLowerCase() ?? '') === wanted) return i;
  for (let i = 0; i < before; i += 1) if ((steps[i]?.title.toLowerCase() ?? '').startsWith(wanted)) return i;
  return -1;
}

/** The Project form. */
export interface ProjectForm {
  readonly title: string;
  /** The agent whose task list the project runs (its folder is where steps work). */
  readonly owner: string;
  readonly steps: string;
}

/** The Project form as it opens. */
export const DEFAULT_PROJECT_FORM: ProjectForm = { title: '', owner: '', steps: '' };

/** Why the project cannot be made (field → message). */
export function projectProblems(project: ProjectForm): Partial<Record<'title' | 'owner' | 'steps', string>> {
  const out: Partial<Record<'title' | 'owner' | 'steps', string>> = {};
  if (project.title.trim() === '') out.title = NEW_WORDS.errors.title;
  if (project.owner === '') out.owner = NEW_WORDS.errors.agent;
  if (parseSteps(project.steps).length === 0) out.steps = NEW_WORDS.errors.steps;
  return out;
}

// ── Teammate / crew ──────────────────────────────────────────────────────

/** The kinds the Crews dialogs make (lane P's New teammate / New crew; the sheet opens them, it has no form of its own). */
export const DIALOG_KINDS = ['teammate', 'crew'] as const;
/** One of {@link DIALOG_KINDS}. */
export type DialogKindId = (typeof DIALOG_KINDS)[number];

/**
 * D131 · lane X · `true` for a kind the + New sheet hands to the Crews dialogs (role templates,
 * suggestions, adopting an agent, budget, hand-offs: `crews/dialogs.tsx`) instead of a form here.
 */
export function opensDialog(kind: NewKindId): kind is DialogKindId {
  return (DIALOG_KINDS as readonly string[]).includes(kind);
}

/** The kinds the sheet's own forms make. */
export type SheetKindId = Exclude<NewKindId, DialogKindId>;

// ── The draft (D88's `new-session` machine draft) ────────────────────────

/** Everything the sheet holds. */
export interface SheetState {
  readonly kind: SheetKindId;
  readonly agent: AgentForm;
  readonly task: TaskForm;
  readonly routine: RoutineForm;
  readonly project: ProjectForm;
}

/** The sheet as it opens for `kind`. */
export function emptySheet(kind: SheetKindId): SheetState {
  return { kind, agent: DEFAULT_AGENT_FORM, task: DEFAULT_TASK_FORM, routine: DEFAULT_ROUTINE_FORM, project: DEFAULT_PROJECT_FORM };
}

/**
 * The `new-session` draft's value for the sheet (`{ form, simpleBranch }`, D88):
 * the agent's classic form, with the kind (`newKind`) and, for the other kinds,
 * their title in `name` and their text in `task` (the only text the draft keeps).
 */
export function sheetDraft(sheet: SheetState): { readonly form: Readonly<Record<string, unknown>>; readonly simpleBranch: string | null } {
  const base: Record<string, unknown> = { ...sheet.agent.form, newKind: sheet.kind };
  switch (sheet.kind) {
    case 'task':
      base['name'] = sheet.task.title;
      base['task'] = sheet.task.description;
      break;
    case 'routine':
      base['name'] = '';
      base['task'] = sheet.routine.prompt;
      break;
    case 'project':
      base['name'] = sheet.project.title;
      base['task'] = sheet.project.steps;
      break;
    default:
      break;
  }
  return { form: base, simpleBranch: null };
}

/** `true` when the sheet holds typed text worth a draft. */
export function sheetHasText(sheet: SheetState): boolean {
  const value = sheetDraft(sheet).form;
  return ['name', 'task'].some((key) => typeof value[key] === 'string' && (value[key] as string).trim() !== '');
}

/**
 * The sheet a saved `new-session` draft opens (an unknown kind is an agent, the classic form's
 * draft; a teammate or crew draft saved before lane X moved them to the Crews dialogs opens as an
 * agent too).
 */
export function sheetFromDraft(saved: Readonly<Record<string, unknown>>): SheetState {
  const kind: SheetKindId = isNewKind(saved['newKind']) && !opensDialog(saved['newKind']) ? saved['newKind'] : 'agent';
  const empty = emptySheet(kind);
  const form = formFromDraft(saved);
  const name = typeof saved['name'] === 'string' ? saved['name'] : '';
  const task = typeof saved['task'] === 'string' ? saved['task'] : '';
  switch (kind) {
    case 'task':
      return { ...empty, task: { ...empty.task, title: name, description: task } };
    case 'routine':
      return { ...empty, routine: { ...empty.routine, prompt: task } };
    case 'project':
      return { ...empty, project: { ...empty.project, title: name, steps: task } };
    default:
      return { ...empty, agent: { ...empty.agent, form } };
  }
}

/** Opens the sheet from a request: the kind, the message text, a prefill's form and the computer. */
export function sheetFromRequest(kind: SheetKindId, text: string | undefined, prefilled: NewSessionForm | null, machine: string | null | undefined): SheetState {
  const sheet = emptySheet(kind);
  const form = prefilled ?? DEFAULT_FORM;
  const withText = text !== undefined && text !== '' ? { ...form, task: text } : form;
  const agent: AgentForm = { ...sheet.agent, form: withText, machine: machine ?? null };
  switch (kind) {
    case 'task':
      return { ...sheet, agent, task: { ...sheet.task, title: text ?? '' } };
    case 'routine':
      return { ...sheet, agent, routine: { ...sheet.routine, prompt: text ?? '' } };
    case 'project':
      return { ...sheet, agent, project: { ...sheet.project, title: text ?? '' } };
    default:
      return { ...sheet, agent };
  }
}

/** The most recently used folders first (never used last, then by name). */
export function foldersByRecent<T extends { readonly lastUsedAt: string | null; readonly displayName: string }>(folders: readonly T[]): T[] {
  return [...folders].sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}
