import type { Folder, NewRepoSession, NewSession, NewSessionPrefill, SolutionGroup } from '../../core/api.ts';
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
import { FOLDER_KIND_LABEL, sessionCwd } from '../folders/folders.ts';
import { baseName, workspaceRootOf } from '../views/solutions-format.ts';

/**
 * Pure logic of the New-session modal (M5.1, SPEC → Modals → New session). The
 * copy, options and summary lines are the prototype's (`docs/handoff/prototype/
 * Switchboard App.dc.html`: the `ns` state, `pills`, `nsGroups`, `nsSummary`,
 * `canLaunch`); the values map onto the contract's `NewSession`
 * (`docs/handoff/contracts/local-api.md`). Rules that are not in the prototype are
 * listed in `docs/new-session.md`. D14 adds the Folder row: the form targets a
 * saved folder, and a **repo** folder keeps only Task, Worktree and Ultracode
 * (`docs/folders.md` → *UI*).
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
}

/**
 * The folder the form targets (D14): a saved {@link Folder}'s id, path, name and
 * kind. A repo folder hides the router sections and is its own one solution.
 */
export type FormFolder = Pick<Folder, 'id' | 'path' | 'name' | 'kind'>;

/** `true` for a repo folder (D14): only Task, Worktree and Ultracode apply. */
export function isRepoFolder(folder: Pick<FormFolder, 'kind'> | null | undefined): boolean {
  return folder?.kind === 'repo';
}

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

/** The name field as typed: whitespace becomes `-`, letters lower case (prototype `onNsName`). */
export function sanitizeName(value: string): string {
  return value.replace(/\s+/g, '-').toLowerCase();
}

/** The session name the form starts: the field, or `session` while it is empty (prototype `sname`). */
export function sessionName(form: Pick<NewSessionForm, 'name'>): string {
  return (form.name || 'session').trim();
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

/** `true` when a session with the form's name is already listed. */
export function nameTaken(form: Pick<NewSessionForm, 'name'>, takenNames: readonly string[]): boolean {
  return takenNames.includes(sessionName(form));
}

/**
 * "Start session" is enabled: at least one solution, a name that is not taken
 * (SPEC), and for QA the stack + both sources the fields mark "(required)". For a
 * repo folder (D14) only the name counts: the repo is the one solution and the
 * router sections do not apply.
 */
export function canStart(form: NewSessionForm, takenNames: readonly string[], folder: Pick<FormFolder, 'kind'> | null = null): boolean {
  if (isRepoFolder(folder)) return sessionName(form) !== '' && !nameTaken(form, takenNames);
  return form.solutions.length > 0 && sessionName(form) !== '' && !nameTaken(form, takenNames) && missingQa(form).length === 0;
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
  };
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
  };
}

/** What "Start session" posts: a {@link NewRepoSession} for a repo folder, else a {@link NewSession}. */
export function toSessionBody(form: NewSessionForm, folder: FormFolder | null): NewSession | NewRepoSession {
  return folder && isRepoFolder(folder) ? toNewRepoSession(form, folder) : toNewSession(form);
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
 * first, then most recently used, then the order added), each by name, `(default)`
 * after the default one; a name two folders share gets its path.
 */
export function folderChoices(folders: readonly Folder[]): FolderChoice[] {
  const count = new Map<string, number>();
  for (const folder of folders) count.set(folder.name, (count.get(folder.name) ?? 0) + 1);
  return folders.map((folder) => {
    const name = (count.get(folder.name) ?? 0) > 1 ? `${folder.name} · ${folder.path}` : folder.name;
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
 * The live summary (prototype `nsSummary`): what the session will start with,
 * in the router's terms, the worktree folders, and why Start is disabled. D14:
 * a `folder` line (its name and kind) before `cwd` once the folder is known,
 * and `cwd` is the folder's; a repo folder has only the folder, the cwd (the repo,
 * or its worktree with Worktree on) and ultracode ({@link repoSummaryLines}).
 */
export function summaryLines(form: NewSessionForm, root: string | null, takenNames: readonly string[], folder: FormFolder | null = null): SummaryLine[] {
  if (folder && isRepoFolder(folder)) return repoSummaryLines(form, folder, takenNames);
  const name = sessionName(form);
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const lines: SummaryLine[] = [{ text: '# claude code · background · Max', tone: 'comment' }];
  if (folder) lines.push(value(`folder    ${folder.name} · ${FOLDER_KIND_LABEL[folder.kind]}`));
  lines.push(
    value(`cwd       ${folder?.path ?? root ?? '—'}`),
    value(`work      ${form.workType === 'qa' ? 'test-authoring (QA)' : 'feature-building'}`),
    value(`mode      ${form.mode === 'orchestrator' ? 'workspace orchestrator' : 'single-solution'}`),
    value(`phase     ${form.phase === 'ui-first' ? 'UI-first' : 'integration'}`),
  );
  if (showsQa(form)) lines.push(value(`stack     ${form.stack ?? '—'}`));
  else if (showsCoordination(form)) lines.push(value(`mobile    ${COORDINATION_SUMMARY[form.coordination]}`));
  lines.push(value(`ultracode ${form.ultracode ? 'on' : 'off'}`), value(' '));
  lines.push({ text: form.worktrees ? '# worktrees' : '# no worktrees · edits in place', tone: 'comment' });
  if (form.worktrees) for (const solution of form.solutions) lines.push({ text: worktreeFolder(solution, name), tone: 'path' });
  if (form.solutions.length === 0) lines.push({ text: '⚠ pick at least one solution', tone: 'warn' });
  if (nameTaken(form, takenNames)) lines.push({ text: '⚠ a session with this name exists', tone: 'warn' });
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
 * (no router answers: a single repo has no router).
 */
export function repoSummaryLines(form: NewSessionForm, folder: FormFolder, takenNames: readonly string[]): SummaryLine[] {
  const name = sessionName(form);
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const lines: SummaryLine[] = [
    { text: '# claude code · background · Max', tone: 'comment' },
    value(`folder    ${folder.name} · ${FOLDER_KIND_LABEL[folder.kind]}`),
    value(`cwd       ${sessionCwd(folder, form.worktrees, name)}`),
    value(`ultracode ${form.ultracode ? 'on' : 'off'}`),
    value(' '),
    { text: form.worktrees ? '# worktree' : '# no worktree · edits in place', tone: 'comment' },
  ];
  if (form.worktrees) lines.push({ text: worktreeFolder(folder.name, name), tone: 'path' });
  if (nameTaken(form, takenNames)) lines.push({ text: '⚠ a session with this name exists', tone: 'warn' });
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
