import type { Folder, ModelSettings, NewRepoSession, NewSession, NewSessionPrefill, SessionModelOption, SolutionGroup } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId, isCliProviderId } from '../../core/cli-providers.ts';
import { CLI_MODEL_ALIASES, DEFAULT_MODEL_CHOICE, type ModelChoice, fitModelChoice, normalizeEffort, normalizeModel, readModelChoice, readModelOptions } from '../../core/model-choice.ts';
import {
  COORDINATIONS,
  type Coordination,
  type FolderKind,
  PHASES,
  type Phase,
  QA_STACKS,
  type QaStack,
  SESSION_MODES,
  type SessionMode,
  WORK_TYPES,
  type WorkType,
  isOneOf,
} from '../../core/model.ts';
import { TITLE_MAX, shortNameFromTitle } from '../../core/session-title.ts';
import { type TicketBranchCheck, branchFromTitle, checkTicketBranch } from '../../core/ticket-branch.ts';
import { FOLDER_KIND_LABEL, distinctFolderNames, sessionCwd } from '../folders/folders.ts';
import { type ModelPicker, modelChoicePicker, modelPickBody } from '../views/session/session-header.ts';
import { baseName, workspaceRootOf } from '../views/solutions-format.ts';

/**
 * Pure logic of the New-session modal (M5.1, SPEC → Modals → New session). The
 * copy, options and summary lines are the prototype's (`docs/handoff/prototype/
 * Switchboard App.dc.html`: the `ns` state, `pills`, `nsGroups`, `nsSummary`,
 * `canLaunch`); the values map onto the contract's `NewSession`
 * (`docs/handoff/contracts/local-api.md`). Rules that are not in the prototype are
 * listed in `docs/new-session.md`. D14 adds the Folder row: the form targets a
 * saved folder, and a **repo** folder keeps only Task, Worktree and Ultracode
 * (`docs/folders.md` → *UI*). D22: the name field takes free text as the
 * session's title; Start posts the short name derived from it ({@link startNames}).
 * D32: with a worktree, the **Branch** field names its branch after the ticket
 * ({@link formBranch}); Start waits for a valid one. D38: picking solutions is
 * optional for a workspace folder; with none picked the agent determines them
 * ({@link SOLUTIONS_BY_AGENT}). D42: the Launch area's **Model** row picks the
 * model and effort the session starts with, starting on the last choice
 * ({@link formModel}).
 */

/** The form's state. `figmaUrls` is the raw text of its field (URLs separated by spaces, commas or new lines). */
export interface NewSessionForm {
  readonly name: string;
  readonly task: string;
  readonly workType: WorkType;
  readonly mode: SessionMode;
  readonly solutions: readonly string[];
  readonly phase: Phase;
  /** Kept while the section is hidden; sent only when it applies ({@link showsCoordination}). */
  readonly coordination: Coordination;
  /** QA stack under test; `null` until the developer picks one (the router gives no recommended stack). */
  readonly stack: QaStack | null;
  readonly confluenceUrl: string;
  readonly figmaUrls: string;
  readonly worktrees: boolean;
  readonly ultracode: boolean;
  /**
   * D14: the saved folder's id the session starts in; `null` = the default folder
   * (the saved folders have not loaded yet, or none is saved).
   */
  readonly folder: string | null;
  /**
   * D32: the Branch field as typed; `null` while the developer has not typed in
   * it, so it follows the title ({@link formBranch}: `branchFromTitle`).
   */
  readonly branch: string | null;
  /**
   * D42: the Model row's choice (`null` = the CLI's default for either part);
   * `null` while the developer has not picked one (nor a prefill named one), so
   * the service's last choice applies ({@link formModel}). The body and the
   * summary carry it only when it is set: the modal fills it in first
   * ({@link withFormModel}).
   */
  readonly model: ModelChoice | null;
  /**
   * D62: the CLI the session runs on; `null` while the developer has not picked
   * one, so the default CLI applies (`GET /api/clis` → `default`). Picking
   * another CLI clears {@link model} (each CLI names its models differently).
   */
  readonly provider: CliProviderId | null;
  /**
   * D63: the account profile the session starts on; `null` = automatic (Settings →
   * Accounts' rule: the first account with allowance). Picking another CLI clears it.
   */
  readonly profileId: string | null;
}

/**
 * The folder the form targets (D14): a saved {@link Folder}'s id, path, name and
 * kind. A repo folder hides the router sections and is its own one solution.
 * D18: `displayName` (its custom name, else its own name) is what the summary
 * shows; `name` stays the one the repo's solution and worktree are named after.
 */
export type FormFolder = Pick<Folder, 'id' | 'path' | 'name' | 'displayName' | 'kind'>;

/** `true` for a repo folder (D14): only Task, Worktree and Ultracode apply. */
export function isRepoFolder(folder: Pick<FormFolder, 'kind'> | null | undefined): boolean {
  return folder?.kind === 'repo';
}

/** D59: `true` for a plain folder (no AGENTS.md, not a git repository): Simple sessions only. */
export function isPlainFolder(folder: Pick<FormFolder, 'kind'> | null | undefined): boolean {
  return folder?.kind === 'plain';
}

/**
 * D59: the Full form's note for a plain folder (the router, solutions and
 * branching need a workspace or a git repository); the dialog offers the switch.
 */
export const PLAIN_FOLDER_FULL_NOTE = "This folder has no AGENTS.md and isn't a git repository: the Full form needs a workspace or a git repo. Use Simple to start a session here.";

/** D59: the same note in schedule mode (schedules are Full only, so no switch is offered). */
export const PLAIN_FOLDER_SCHEDULE_NOTE = "This folder has no AGENTS.md and isn't a git repository: a schedule needs a workspace or a git repo folder.";

/**
 * The router's recommended session-start answers (router AGENTS.md → *Session
 * start*: feature-building, single-solution, UI-first, sequential), which
 * "Accept recommended" sets (prototype `nsRecommended`).
 */
export const RECOMMENDED = { workType: 'feature', mode: 'single', phase: 'ui-first', coordination: 'sequential' } as const satisfies Partial<NewSessionForm>;

/**
 * What the modal opens with: an empty name and task, the recommended answers, no
 * solutions, a worktree per solution on and ultracode off (the prototype's
 * Settings → Sessions & worktrees defaults: "Worktree per session: on",
 * "Ultracode by default: off").
 */
export const DEFAULT_FORM: NewSessionForm = {
  name: '',
  task: '',
  ...RECOMMENDED,
  solutions: [],
  stack: null,
  confluenceUrl: '',
  figmaUrls: '',
  worktrees: true,
  ultracode: false,
  folder: null,
  branch: null,
  model: null,
  provider: null,
  profileId: null,
};

/** A pill option: value + the prototype's label. */
export type PillOption<T extends string> = readonly [value: T, label: string];

/** Section 2 · Work type. */
export const WORK_TYPE_OPTIONS: ReadonlyArray<PillOption<WorkType>> = [
  ['feature', 'Feature-building'],
  ['qa', 'Test-authoring (QA)'],
];
/** Section 3 · Mode. */
export const MODE_OPTIONS: ReadonlyArray<PillOption<SessionMode>> = [
  ['single', 'Single-solution'],
  ['orchestrator', 'Workspace orchestrator'],
];
/** Section 5 · Phase. */
export const PHASE_OPTIONS: ReadonlyArray<PillOption<Phase>> = [
  ['ui-first', 'UI-first'],
  ['integration', 'Integration'],
];
/** Section 6 · Mobile coordination. */
export const COORDINATION_OPTIONS: ReadonlyArray<PillOption<Coordination>> = [
  ['sequential', 'Sequential follow-up'],
  ['parallel-twin', 'Parallel-twin'],
  ['none', 'No mobile counterpart'],
];
/** Section 6 · QA contract: the stack under test. */
export const STACK_OPTIONS: ReadonlyArray<PillOption<QaStack>> = [
  ['web', 'Web · Playwright'],
  ['mobile', 'Mobile · Appium'],
  ['both', 'Both'],
];

/**
 * The name field as typed where a kebab-case name is expected (a schedule's name,
 * the name of a moved conversation): whitespace becomes `-`, letters lower case
 * (prototype `onNsName`). A new session's field takes free text instead (D22).
 */
export function sanitizeName(value: string): string {
  return value.replace(/\s+/g, '-').toLowerCase();
}

/** The name field as it is, or `session` while it is empty (prototype `sname`): a schedule's name. */
export function sessionName(form: Pick<NewSessionForm, 'name'>): string {
  return (form.name || 'session').trim();
}

/** What "Start session" names the session (D22). */
export interface StartNames {
  /** The short name: kebab-case, unique among `takenNames`; its worktree and branch are built from it. */
  readonly name: string;
  /** The title: the field trimmed; `null` only for an empty field. */
  readonly title: string | null;
}

/**
 * D22 (`docs/derivations.md` → *Session titles*): the field's free text is the
 * title and the short name is derived from it (`shortNameFromTitle`: `JIRA
 * Ticket handling` → `jira-ticket-handling`, `-2`, `-3`, … when taken; `session`
 * for an empty field). Developer ruling 2026-09-28: text that already is its own
 * short name (`free-talk-640`) is a title too, so every session started from the
 * form has one; only an empty field has none.
 */
export function startNames(form: Pick<NewSessionForm, 'name'>, takenNames: readonly string[]): StartNames {
  const text = form.name.trim();
  return { name: shortNameFromTitle(text, takenNames), title: text !== '' ? text : null };
}

/** D22: the field's title is longer than a title may be (80 characters once trimmed). */
export function titleTooLong(form: Pick<NewSessionForm, 'name'>): boolean {
  const { title } = startNames(form, []);
  return title !== null && title.length > TITLE_MAX;
}

/**
 * D32: the Branch field shows (and is required) whenever Start creates a worktree:
 * Worktree on, for a workspace (one branch in every solution's repo) or a repo
 * folder. The modal hides it where no worktree is made by the developer's name
 * (a schedule, a moved conversation, a teleport).
 */
export function showsBranch(form: Pick<NewSessionForm, 'worktrees'>): boolean {
  return form.worktrees;
}

/**
 * D32: the branch Start posts: the field as typed, else what the title suggests
 * while the developer has not typed in it (`branchFromTitle`: "PROJ-1984 Purchase
 * complete" → `PROJ-1984-purchase-complete`), else empty.
 */
export function formBranch(form: Pick<NewSessionForm, 'branch' | 'name'>): string {
  return form.branch ?? branchFromTitle(form.name) ?? '';
}

/** D32: the Branch field's check (`checkTicketBranch` of {@link formBranch}): its message is shown under the field. */
export function branchCheck(form: Pick<NewSessionForm, 'branch' | 'name'>): TicketBranchCheck {
  return checkTicketBranch(formBranch(form));
}

/** D32: the Branch field keeps Start disabled (it shows and is not a ticket branch). */
export function branchBlocks(form: Pick<NewSessionForm, 'branch' | 'name' | 'worktrees'>): boolean {
  return showsBranch(form) && !branchCheck(form).ok;
}

/** `true` for a `*-front` solution (a microfrontend: the web half with a mobile counterpart). */
export function isFront(solution: string): boolean {
  return baseName(solution).endsWith('-front');
}

/** Section 6 · Mobile coordination applies: feature-building, single-solution, a `*-front` in scope. */
export function showsCoordination(form: Pick<NewSessionForm, 'workType' | 'mode' | 'solutions'>): boolean {
  return form.workType === 'feature' && form.mode === 'single' && form.solutions.some(isFront);
}

/** Section 6 · QA contract applies: test-authoring. */
export function showsQa(form: Pick<NewSessionForm, 'workType'>): boolean {
  return form.workType === 'qa';
}

/** The Figma field's URLs (split on spaces, commas and new lines; blanks dropped). */
export function figmaUrlList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

/** What a QA session still lacks before it can start (the QA contract, router → *Contract-lock for QA*). */
export function missingQa(form: Pick<NewSessionForm, 'workType' | 'stack' | 'confluenceUrl' | 'figmaUrls'>): Array<'stack' | 'confluence' | 'figma'> {
  if (!showsQa(form)) return [];
  const missing: Array<'stack' | 'confluence' | 'figma'> = [];
  if (form.stack === null) missing.push('stack');
  if (form.confluenceUrl.trim() === '') missing.push('confluence');
  if (figmaUrlList(form.figmaUrls).length === 0) missing.push('figma');
  return missing;
}

/** `true` when the form's name, as typed, is already taken (a schedule's name among the schedules). */
export function nameTaken(form: Pick<NewSessionForm, 'name'>, takenNames: readonly string[]): boolean {
  return takenNames.includes(sessionName(form));
}

/**
 * Everything but the name is ready: for QA, the stack + both sources the fields
 * mark "(required)". D38: solutions are optional (none picked = the agent
 * determines them). A repo folder (D14) has nothing else to pick: the repo is the
 * one solution and the router sections do not apply.
 */
export function formComplete(form: NewSessionForm, folder: Pick<FormFolder, 'kind'> | null = null): boolean {
  // D59: the Full form (and a schedule) cannot start in a plain folder: Simple does.
  if (isPlainFolder(folder)) return false;
  if (isRepoFolder(folder)) return true;
  return missingQa(form).length === 0;
}

/** D38: the summary line of a workspace session started without picked solutions (in place of the old warning). */
export const SOLUTIONS_BY_AGENT = 'solutions  chosen by the agent';

/** D38: section 4's hint while no solution is picked (the muted hint on the label line). */
export const SOLUTIONS_HINT_NONE = '0 selected · leave empty to let the agent choose · read-only folders locked';

/**
 * Section 4's hint (prototype `nsSolHint`): `<n> selected · read-only folders
 * locked`; D38: {@link SOLUTIONS_HINT_NONE} while none is picked; a repo folder's
 * `1 selected · a git repo is one solution` (D14).
 */
export function solutionsHint(form: Pick<NewSessionForm, 'solutions'>, folder: Pick<FormFolder, 'kind'> | null = null): string {
  if (isRepoFolder(folder)) return '1 selected · a git repo is one solution';
  return form.solutions.length === 0 ? SOLUTIONS_HINT_NONE : `${form.solutions.length} selected · read-only folders locked`;
}

/**
 * "Start session" is enabled: {@link formComplete}, a title of at most 80
 * characters and, D32, a ticket branch when a worktree is made
 * ({@link branchBlocks}). D22: a taken name no longer blocks it, the short name
 * gets `-2`, `-3`, … instead ({@link startNames}).
 */
export function canStart(form: NewSessionForm, _takenNames: readonly string[] = [], folder: Pick<FormFolder, 'kind'> | null = null): boolean {
  return formComplete(form, folder) && !titleTooLong(form) && !branchBlocks(form);
}

/** Toggles `solution` in the selection (order of picking kept). */
export function toggleSolution(solutions: readonly string[], solution: string): string[] {
  return solutions.includes(solution) ? solutions.filter((s) => s !== solution) : [...solutions, solution];
}

/** The `POST /api/sessions` body (contract → NewSession; D14: `folder` when the form names one). */
export function toNewSession(form: NewSessionForm): NewSession {
  const qa = showsQa(form) && form.stack !== null ? { stack: form.stack, confluenceUrl: form.confluenceUrl.trim(), figmaUrls: figmaUrlList(form.figmaUrls) } : null;
  return {
    name: sessionName(form),
    task: form.task.trim(),
    workType: form.workType,
    mode: form.mode,
    solutions: [...form.solutions],
    phase: form.phase,
    coordination: showsCoordination(form) ? form.coordination : null,
    qa,
    worktrees: form.worktrees,
    ultracode: form.ultracode,
    ...(form.folder ? { folder: form.folder } : {}),
    ...modelFields(form),
    ...providerFields(form),
  };
}

/** D62: the body's `provider` once the form has one (the modal fills in the default CLI first). */
export function providerFields(form: Pick<NewSessionForm, 'provider'> & { readonly profileId?: string | null }): { readonly provider?: CliProviderId; readonly profileId?: string } {
  return { ...(form.provider ? { provider: form.provider } : {}), ...(form.provider && form.profileId ? { profileId: form.profileId } : {}) };
}

/** D42: the body's `model` / `effort` (`null` = the CLI's default), once the form has a choice. */
function modelFields(form: Pick<NewSessionForm, 'model'>): { readonly model?: string | null; readonly effort?: string | null } {
  return form.model ? { model: form.model.model, effort: form.model.effort } : {};
}

/** The `POST /api/sessions` body for a repo folder (D14, `NewRepoSession`): the repo is the one solution, no router fields. */
export function toNewRepoSession(form: NewSessionForm, folder: Pick<FormFolder, 'id' | 'name'>): NewRepoSession {
  return {
    name: sessionName(form),
    task: form.task.trim(),
    folder: folder.id,
    solutions: [folder.name],
    worktrees: form.worktrees,
    ultracode: form.ultracode,
    ...modelFields(form),
    ...providerFields(form),
  };
}

/** The body with the name field as typed: a {@link NewRepoSession} for a repo folder, else a {@link NewSession} (a schedule's template). */
export function toSessionBody(form: NewSessionForm, folder: FormFolder | null): NewSession | NewRepoSession {
  return folder && isRepoFolder(folder) ? toNewRepoSession(form, folder) : toNewSession(form);
}

/**
 * What "Start session" posts (D22): {@link toSessionBody} with the short name
 * derived from the field and the field as `title` (none for an empty field);
 * D32: with a worktree, the `branch` ({@link formBranch}, trimmed). A schedule's
 * template never carries one (its runs keep `session/{name}`).
 */
export function toStartBody(form: NewSessionForm, folder: FormFolder | null, takenNames: readonly string[]): NewSession | NewRepoSession {
  const { name, title } = startNames(form, takenNames);
  const branch = showsBranch(form) ? { branch: formBranch(form).trim() } : {};
  return { ...toSessionBody(form, folder), name, ...(title !== null ? { title } : {}), ...branch };
}

/**
 * The form a prefill opens (M3.3 "Open fix session"): the defaults with every
 * valid prefill field on top. Invalid values are ignored; `coordination: null`
 * keeps the default.
 */
export function formFromPrefill(prefill: NewSessionPrefill | null | undefined): NewSessionForm {
  if (!prefill) return DEFAULT_FORM;
  const form: { -readonly [K in keyof NewSessionForm]: NewSessionForm[K] } = { ...DEFAULT_FORM };
  if (typeof prefill.name === 'string') form.name = sanitizeName(prefill.name);
  if (typeof prefill.task === 'string') form.task = prefill.task;
  if (isOneOf(WORK_TYPES, prefill.workType)) form.workType = prefill.workType;
  if (isOneOf(SESSION_MODES, prefill.mode)) form.mode = prefill.mode;
  if (isOneOf(PHASES, prefill.phase)) form.phase = prefill.phase;
  if (isOneOf(COORDINATIONS, prefill.coordination)) form.coordination = prefill.coordination;
  if (Array.isArray(prefill.solutions)) {
    form.solutions = [...new Set(prefill.solutions.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))];
  }
  const qa = prefill.qa;
  if (qa && typeof qa === 'object') {
    if (isOneOf(QA_STACKS, qa.stack)) form.stack = qa.stack;
    if (typeof qa.confluenceUrl === 'string') form.confluenceUrl = qa.confluenceUrl;
    if (Array.isArray(qa.figmaUrls)) form.figmaUrls = qa.figmaUrls.filter((u) => typeof u === 'string').join(' ');
  }
  if (typeof prefill.worktrees === 'boolean') form.worktrees = prefill.worktrees;
  if (typeof prefill.ultracode === 'boolean') form.ultracode = prefill.ultracode;
  if (typeof prefill.folder === 'string' && prefill.folder.trim() !== '') form.folder = prefill.folder.trim();
  // D32: a prefilled branch counts as typed (the title no longer replaces it).
  if (typeof prefill.branch === 'string' && prefill.branch.trim() !== '') form.branch = prefill.branch.trim();
  // D62: a prefill's CLI (a schedule's template) counts as picked.
  if (isCliProviderId(prefill.provider)) form.provider = prefill.provider;
  // D42: a prefill's model / effort (a schedule's template) count as picked (the last choice no longer applies).
  if (prefill.model !== undefined || prefill.effort !== undefined) {
    const choice = readModelChoice({ model: prefill.model ?? null, effort: prefill.effort ?? null });
    if (choice) form.model = choice;
  }
  return form;
}

/**
 * D88 ruling (2026-10-09): the form a New-session draft restores (`new-session`,
 * this machine's draft; `src/core/drafts.ts` → `NewSessionDraft.form`): the
 * defaults with every field the draft holds on top, each checked again (a value
 * this version does not know keeps the default). The folder resolves like any
 * form's once the saved folders are known ({@link resolveFormFolder}).
 */
export function formFromDraft(saved: Readonly<Record<string, unknown>>): NewSessionForm {
  const form: { -readonly [K in keyof NewSessionForm]: NewSessionForm[K] } = { ...DEFAULT_FORM };
  const text = (key: string): string | null => (typeof saved[key] === 'string' ? (saved[key] as string) : null);
  form.name = text('name') ?? form.name;
  form.task = text('task') ?? form.task;
  form.confluenceUrl = text('confluenceUrl') ?? form.confluenceUrl;
  form.figmaUrls = text('figmaUrls') ?? form.figmaUrls;
  if (isOneOf(WORK_TYPES, saved['workType'])) form.workType = saved['workType'];
  if (isOneOf(SESSION_MODES, saved['mode'])) form.mode = saved['mode'];
  if (isOneOf(PHASES, saved['phase'])) form.phase = saved['phase'];
  if (isOneOf(COORDINATIONS, saved['coordination'])) form.coordination = saved['coordination'];
  if (isOneOf(QA_STACKS, saved['stack'])) form.stack = saved['stack'];
  if (Array.isArray(saved['solutions'])) form.solutions = [...new Set((saved['solutions'] as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim() !== ''))];
  if (typeof saved['worktrees'] === 'boolean') form.worktrees = saved['worktrees'];
  if (typeof saved['ultracode'] === 'boolean') form.ultracode = saved['ultracode'];
  if (typeof saved['folder'] === 'string' && saved['folder'] !== '') form.folder = saved['folder'];
  if (typeof saved['branch'] === 'string') form.branch = saved['branch'];
  if (isCliProviderId(saved['provider'])) form.provider = saved['provider'];
  if (typeof saved['profileId'] === 'string' && saved['profileId'] !== '') form.profileId = saved['profileId'];
  const model = saved['model'];
  if (model !== null && typeof model === 'object') {
    const choice = readModelChoice(model);
    if (choice) form.model = choice;
  }
  return form;
}

/**
 * The folder a form opens with once the saved folders are known (D14): its own
 * (a prefill's, e.g. a schedule's Edit or "Open fix session") while it is saved,
 * else the default folder, else none.
 */
export function resolveFormFolder(current: string | null, folders: readonly Folder[]): string | null {
  if (current && folders.some((folder) => folder.id === current)) return current;
  return (folders.find((folder) => folder.isDefault) ?? folders[0])?.id ?? null;
}

/** One entry of the Folder dropdown: the saved folder's id and its text. */
export interface FolderChoice {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly kind: FolderKind;
}

/**
 * The Folder dropdown (D14): the saved folders in the API's order (the default
 * first, then most recently used, then the order added), each by its display name
 * (D18: its custom name, else its own name), `(default)` after the default one; a
 * name two folders share (ignoring case) gets its path. The path is each option's
 * tooltip.
 */
export function folderChoices(folders: readonly Folder[]): FolderChoice[] {
  const names = distinctFolderNames(folders.map((folder) => ({ name: folder.displayName, path: folder.path })));
  return folders.map((folder, index) => {
    const name = names[index] ?? folder.displayName;
    return { id: folder.id, label: folder.isDefault ? `${name} (default)` : name, path: folder.path, kind: folder.kind };
  });
}

/** One solution chip of section 4. */
export interface SolutionChip {
  /** What the chip adds to `solutions` (the row's name; its relative path when two writable rows share the name). */
  readonly value: string;
  /** `✓ name` when selected (prototype). */
  readonly label: string;
  readonly selected: boolean;
  /** Read-only: 40% opacity, not-allowed cursor, never selectable. */
  readonly locked: boolean;
}

/** One row of section 4: the folder label and its chips. */
export interface ChipGroup {
  readonly folder: string;
  readonly chips: readonly SolutionChip[];
}

/** Folder label of the row that shows selected solutions the scan does not list (e.g. from a prefill). */
export const UNKNOWN_FOLDER = 'not found';

/** The read-only group's chip for a read-only row: its top folder, `folder/*` when the row sits below it (prototype `deprecated/*`). */
export function readOnlyChipLabel(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  const first = parts[0] ?? relativePath;
  return parts.length > 1 ? `${first}/*` : first;
}

/**
 * Section 4's rows from `GET /api/solutions` (the workspace scan, M6.1): one per
 * writable folder group with a chip per solution, then the read-only group with
 * one locked chip per read-only top folder (sorted), then — when the scan has
 * loaded — a row for selected solutions it does not list, so they can still be
 * removed. `null` (still loading) gives no rows.
 */
export function chipGroups(groups: readonly SolutionGroup[] | null, selected: readonly string[]): ChipGroup[] {
  if (groups === null) return [];
  const writable = groups.flatMap((group) => group.solutions.filter((s) => s.rule !== 'read-only'));
  const nameCount = new Map<string, number>();
  for (const solution of writable) nameCount.set(solution.name, (nameCount.get(solution.name) ?? 0) + 1);
  const valueOf = (solution: { readonly name: string; readonly relativePath: string }): string =>
    (nameCount.get(solution.name) ?? 0) > 1 ? solution.relativePath : solution.name;
  const chip = (value: string, locked: boolean): SolutionChip => {
    const on = !locked && selected.includes(value);
    return { value, label: on ? `✓ ${value}` : value, selected: on, locked };
  };

  const rows: ChipGroup[] = [];
  const known = new Set<string>();
  const readOnly = new Set<string>();
  for (const group of groups) {
    const chips: SolutionChip[] = [];
    for (const solution of group.solutions) {
      if (solution.rule === 'read-only') {
        readOnly.add(readOnlyChipLabel(solution.relativePath));
        continue;
      }
      const value = valueOf(solution);
      known.add(value);
      chips.push(chip(value, false));
    }
    if (chips.length > 0) rows.push({ folder: group.folder, chips });
  }
  if (readOnly.size > 0) rows.push({ folder: 'read-only', chips: [...readOnly].sort().map((label) => chip(label, true)) });
  const unknown = selected.filter((s) => !known.has(s));
  if (unknown.length > 0) rows.push({ folder: UNKNOWN_FOLDER, chips: unknown.map((s) => chip(s, false)) });
  return rows;
}

/** The workspace root derived from the first scanned solution (the summary's `cwd` before the folder is known); `null` before the scan. */
export function workspaceRoot(groups: readonly SolutionGroup[] | null): string | null {
  const first = groups?.flatMap((group) => [...group.solutions])[0];
  return first ? workspaceRootOf(first) : null;
}

/** Gap #1: the worktree folder a solution gets, `../{repo}-wt-{name}` next to the repo. */
export function worktreeFolder(solution: string, name: string): string {
  return `../${baseName(solution)}-wt-${name}`;
}

/** Color role of a summary line: `#` comments, values, worktree paths (blue), warnings (amber), the closing ✓ (green). */
export type SummaryTone = 'comment' | 'value' | 'path' | 'warn' | 'ok';

/** One line of the live mono summary. */
export interface SummaryLine {
  readonly text: string;
  readonly tone: SummaryTone;
}

const COORDINATION_SUMMARY: Readonly<Record<Coordination, string>> = {
  sequential: 'sequential',
  'parallel-twin': 'parallel-twin',
  none: 'no counterpart',
};

/**
 * How the summary reads the name field: `start` (a new session, D22: the short
 * name derived from the field, {@link startNames}) or `as-typed` (a scheduled
 * run's session name, which the Schedule section builds from the schedule's name).
 */
export type SummaryNaming = 'start' | 'as-typed';

/** The warning when the field's title is too long (D22). */
export const TITLE_TOO_LONG = `⚠ the title must be at most ${TITLE_MAX} characters`;

/** The warning while the Branch field is not a ticket branch (D32; the field itself shows the full message). */
export const BRANCH_MISSING = '⚠ name the branch after its ticket';

/**
 * The session name the summary shows, and the line under the worktree comment
 * (D22 / D32): with a worktree made by the developer's name, `branch    <branch>`
 * (`—` while the field is not a ticket branch); else, when the short name is not
 * the field as typed, `name      <name>`. A schedule's run (`as-typed`) keeps its
 * `session/{name}` and shows no such line.
 */
function summaryName(form: NewSessionForm, takenNames: readonly string[], naming: SummaryNaming): { readonly name: string; readonly line: SummaryLine | null } {
  if (naming === 'as-typed') return { name: sessionName(form), line: null };
  const { name } = startNames(form, takenNames);
  if (showsBranch(form)) {
    const check = branchCheck(form);
    return { name, line: { text: `branch    ${check.ok ? check.name : '—'}`, tone: 'value' } };
  }
  if (name === (form.name.trim() || 'session')) return { name, line: null };
  // The field is a title (or its name is taken): say which short name the session gets.
  return { name, line: { text: `name      ${name}`, tone: 'value' } };
}

/**
 * The name warnings: a taken name as typed (a schedule's) or a title that is too
 * long (a new session's, D22); D32: a new session's branch that is not a ticket
 * branch yet.
 */
function nameWarnings(form: NewSessionForm, takenNames: readonly string[], naming: SummaryNaming): SummaryLine[] {
  if (naming === 'as-typed') return nameTaken(form, takenNames) ? [{ text: '⚠ a session with this name exists', tone: 'warn' }] : [];
  const lines: SummaryLine[] = [];
  if (branchBlocks(form)) lines.push({ text: BRANCH_MISSING, tone: 'warn' });
  if (titleTooLong(form)) lines.push({ text: TITLE_TOO_LONG, tone: 'warn' });
  return lines;
}

/**
 * The live summary (prototype `nsSummary`): what the session will start with,
 * in the router's terms, the worktree folders, and why Start is disabled. D14:
 * a `folder` line (its display name, D18, and kind) before `cwd` once the folder is known,
 * and `cwd` is the folder's; a repo folder has only the folder, the cwd (the repo,
 * or its worktree with Worktree on) and ultracode ({@link repoSummaryLines}). D22:
 * the worktree folders use the short name derived from the field; when it is not
 * the field as typed and Worktree is off, a `name      <name>` line says so under
 * the worktree comment. D32: with Worktree on, a `branch    <branch>` line there
 * names the ticket branch (`—` until the field is valid, with a `⚠` line). D38:
 * with no solution picked, {@link SOLUTIONS_BY_AGENT} stands where the worktree
 * folders go (it replaces the prototype's `⚠ pick at least one solution`). D42:
 * once the form has a model choice, a `model     <model> · <effort>` line
 * ({@link modelSummaryLine}, labels from `modelOptions`) follows `ultracode`.
 */
export function summaryLines(
  form: NewSessionForm,
  root: string | null,
  takenNames: readonly string[],
  folder: FormFolder | null = null,
  naming: SummaryNaming = 'start',
  modelOptions: readonly SessionModelOption[] = CLI_MODEL_ALIASES,
): SummaryLine[] {
  if (folder && isRepoFolder(folder)) return repoSummaryLines(form, folder, takenNames, naming, modelOptions);
  const { name, line } = summaryName(form, takenNames, naming);
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const lines: SummaryLine[] = [{ text: '# claude code · background · Max', tone: 'comment' }];
  if (folder) lines.push(value(`folder    ${folder.displayName} · ${FOLDER_KIND_LABEL[folder.kind]}`));
  lines.push(
    value(`cwd       ${folder?.path ?? root ?? '—'}`),
    value(`work      ${form.workType === 'qa' ? 'test-authoring (QA)' : 'feature-building'}`),
    value(`mode      ${form.mode === 'orchestrator' ? 'workspace orchestrator' : 'single-solution'}`),
    value(`phase     ${form.phase === 'ui-first' ? 'UI-first' : 'integration'}`),
  );
  if (showsQa(form)) lines.push(value(`stack     ${form.stack ?? '—'}`));
  else if (showsCoordination(form)) lines.push(value(`mobile    ${COORDINATION_SUMMARY[form.coordination]}`));
  lines.push(value(`ultracode ${form.ultracode ? 'on' : 'off'}`));
  if (form.model) lines.push(modelSummaryLine(form.model, modelOptions, form.provider));
  lines.push(value(' '));
  lines.push({ text: form.worktrees ? '# worktrees' : '# no worktrees · edits in place', tone: 'comment' });
  if (line) lines.push(line);
  if (form.worktrees) for (const solution of form.solutions) lines.push({ text: worktreeFolder(solution, name), tone: 'path' });
  // D38: none picked is no longer a reason to wait: the agent determines them.
  if (form.solutions.length === 0) lines.push(value(SOLUTIONS_BY_AGENT));
  lines.push(...nameWarnings(form, takenNames, naming));
  const missing = missingQa(form);
  if (missing.includes('stack')) lines.push({ text: '⚠ pick the stack under test', tone: 'warn' });
  if (missing.includes('confluence')) lines.push({ text: '⚠ add the Confluence page URL', tone: 'warn' });
  if (missing.includes('figma')) lines.push({ text: '⚠ add the Figma frame URLs', tone: 'warn' });
  lines.push(value(' '), { text: '✓ answers pre-filled → agent confirms, no re-ask', tone: 'ok' });
  return lines;
}

/**
 * The summary for a repo folder (D14): the folder, the cwd the session gets (the
 * repo, or `<parent>/<repo>-wt-<name>` with Worktree on), ultracode, the worktree,
 * and the first message: the task alone, plus the worktree note with a worktree
 * (no router answers: a single repo has no router). D22: the short name as in
 * {@link summaryLines}; D42: the `model` line after `ultracode` likewise.
 */
export function repoSummaryLines(
  form: NewSessionForm,
  folder: FormFolder,
  takenNames: readonly string[],
  naming: SummaryNaming = 'start',
  modelOptions: readonly SessionModelOption[] = CLI_MODEL_ALIASES,
): SummaryLine[] {
  const { name, line } = summaryName(form, takenNames, naming);
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const lines: SummaryLine[] = [
    { text: '# claude code · background · Max', tone: 'comment' },
    value(`folder    ${folder.displayName} · ${FOLDER_KIND_LABEL[folder.kind]}`),
    value(`cwd       ${sessionCwd(folder, form.worktrees, name)}`),
    value(`ultracode ${form.ultracode ? 'on' : 'off'}`),
    ...(form.model ? [modelSummaryLine(form.model, modelOptions, form.provider)] : []),
    value(' '),
    { text: form.worktrees ? '# worktree' : '# no worktree · edits in place', tone: 'comment' },
  ];
  if (line) lines.push(line);
  if (form.worktrees) lines.push({ text: worktreeFolder(folder.name, name), tone: 'path' });
  lines.push(...nameWarnings(form, takenNames, naming));
  lines.push(value(' '), { text: form.worktrees ? '✓ task + worktree note · no router answers' : '✓ task only · no router answers', tone: 'ok' });
  return lines;
}

/**
 * The line shown when `POST /api/sessions` refuses: the validation messages
 * (422), the server's `message` (409 worktree / workspace refusals), else the
 * HTTP status or "not reachable".
 */
export function startErrorText(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as { errors?: unknown; message?: unknown };
    if (Array.isArray(record.errors)) {
      const messages = record.errors
        .map((e) => (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : null))
        .filter((m): m is string => m !== null);
      if (messages.length > 0) return `Not started: ${messages.join('; ')}`;
    }
    if (typeof record.message === 'string' && record.message !== '') return `Not started: ${record.message}`;
  }
  return status === 0 ? 'Not started: Switchboard is not reachable.' : `Not started: HTTP ${status}`;
}

// ── D42: the Model row (`docs/new-session.md` → *Model (D42)*) ──────────

/** D42: the Model row's title and description (a Launch row like the two toggles). */
export const MODEL_ROW_TITLE = 'Model';
export const MODEL_ROW_DESCRIPTION = 'Starts on your last choice';

/** D42: the popover's note (where D31's says when a change applies). */
export const MODEL_APPLIES_AT_START = 'The session starts with this choice (--model / --effort). New sessions start on your last choice.';

/** D42: the trigger's tooltip while `GET /api/models` has not answered yet. */
export const MODELS_LOADING = 'Loading the models…';

/** D42: what the form uses when `GET /api/models` failed: no reported list, no last choice. */
export const NO_MODEL_SETTINGS: ModelSettings = { options: null, last: null };

/** D42: the key of the summary's model line (the value lines' 10-column key). */
export const MODEL_LINE_KEY = 'model     ';

/**
 * D42: what the Model row offers: the latest model list any claude process
 * reported (`GET /api/models` → `options`), else the CLI's aliases (`default`,
 * `opus`, `sonnet`, `haiku`, no effort levels).
 */
export function formModelOptions(models: ModelSettings | null, provider: CliProviderId = 'claude'): readonly SessionModelOption[] {
  return readModelOptions(models?.options ?? null) ?? cliFallbackModels(provider);
}

/**
 * D62: what a CLI offers while none of its sessions reported a list yet: Claude
 * Code's aliases (D42), else only that CLI's default model.
 */
export function cliFallbackModels(provider: CliProviderId): readonly SessionModelOption[] {
  return provider === 'claude' ? CLI_MODEL_ALIASES : [{ value: 'default', label: 'Default', description: `${CLI_LABELS[provider]}'s default model` }];
}

/**
 * D42: the model and effort the session starts with: the developer's pick (or
 * a prefill's), else the service's last choice (`GET /api/models` → `last`),
 * else the CLI's default; always fitted to what the row offers
 * (`fitModelChoice`: a model it does not list falls back to the default, an
 * effort the model lacks to Default). `null` while nothing is picked and
 * `models` has not loaded yet (`null`).
 */
export function formModel(form: Pick<NewSessionForm, 'model'>, models: ModelSettings | null, provider: CliProviderId = 'claude'): ModelChoice | null {
  const options = formModelOptions(models, provider);
  if (form.model) return fitModelChoice(form.model, options);
  if (models === null) return null;
  return fitModelChoice(readModelChoice(models.last) ?? DEFAULT_MODEL_CHOICE, options);
}

/** D42: the form with its model choice filled in ({@link formModel}): what the summary and the bodies read. */
export function withFormModel(form: NewSessionForm, models: ModelSettings | null, provider: CliProviderId = 'claude'): NewSessionForm {
  return { ...form, model: formModel(form, models, provider) };
}

/**
 * D42: the Model row's picker: D31's (`modelChoicePicker`) over the offered
 * models, with the at-start note; disabled while the models load.
 */
export function formModelPicker(form: Pick<NewSessionForm, 'model'>, models: ModelSettings | null, provider: CliProviderId = 'claude'): ModelPicker {
  const choice = formModel(form, models, provider) ?? DEFAULT_MODEL_CHOICE;
  const picker = modelChoicePicker({ current: choice.model, effort: choice.effort, available: formModelOptions(models, provider) }, MODEL_APPLIES_AT_START);
  return models === null && !form.model ? { ...picker, disabled: true, reason: MODELS_LOADING, title: MODELS_LOADING } : picker;
}

/**
 * D42: the choice after a model is picked in the row: D31's rule (the effort is
 * kept when the new model has that level, else Default); the same model changes nothing.
 */
export function pickFormModel(choice: ModelChoice, options: readonly SessionModelOption[], value: string): ModelChoice {
  const body = modelPickBody({ current: choice.model, effort: choice.effort, available: options }, value);
  return body ? { model: normalizeModel(body.model ?? null), effort: normalizeEffort(body.effort ?? null) } : choice;
}

/** D42: the choice after an effort is picked (`null` = Default). */
export function pickFormEffort(choice: ModelChoice, effort: string | null): ModelChoice {
  return { model: choice.model, effort: normalizeEffort(effort) };
}

/**
 * D42: the summary's model line: `model     <model> · <effort>`, the trigger's text (`model     Default`, `model     Opus 5.5 · high`).
 * D62: another CLI than Claude Code is named first (`model     Codex CLI · GPT-5.5 Codex · high`).
 */
export function modelSummaryLine(choice: ModelChoice, options: readonly SessionModelOption[], provider: CliProviderId | null = null): SummaryLine {
  const picker = modelChoicePicker({ current: choice.model, effort: choice.effort, available: options }, MODEL_APPLIES_AT_START);
  const cli = provider && provider !== 'claude' ? `${CLI_LABELS[provider]} · ` : '';
  return { text: `${MODEL_LINE_KEY}${cli}${picker.label}`, tone: 'value' };
}
