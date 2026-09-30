import type { NewSessionPrefill, NewSimpleSession } from '../../core/api.ts';
import { checkBranchName } from '../../core/branching.ts';
import { type NewSessionMode, readKnownSettings } from '../../core/settings.ts';
import { TITLE_MAX } from '../../core/session-title.ts';
import { SIMPLE_BRANCH_EXAMPLE, simpleBranchFromTitle, simpleShortName, simpleTitle, titleFromMessage } from '../../core/simple-session.ts';
import { sessionCwd } from '../folders/folders.ts';
import { type FormFolder, type NewSessionForm, isRepoFolder } from './new-session.ts';

/**
 * D56 · the **simple** New-session form (`docs/new-session.md` → *Simple mode
 * (D56)*): folder, message, optional title, model + effort and one "own
 * worktree" checkbox. It shares the Full form's state ({@link NewSessionForm}:
 * the title is `name`, the message is `task`, and `folder`, `model`,
 * `worktrees`), so what is typed carries over when the developer switches
 * between Simple and Full. The worktree branch the developer edits here is kept
 * apart (`simpleBranch`: `null` = derived), so D32's Branch field never gets a
 * non-ticket name from it. Rules shared with the server: `src/core/simple-session.ts`.
 */

/** The dialog's modes, as the toggle labels them. */
export const MODE_OPTIONS: ReadonlyArray<readonly [NewSessionMode, string]> = [
  ['simple', 'Simple'],
  ['full', 'Full'],
];

/**
 * The mode the dialog opens in: Full for a schedule (M7.1: schedules are Full
 * only) and for a prefill ("Open fix session", a schedule's Edit: it carries
 * router answers); else the remembered mode (`newSession.mode` in `GET
 * /api/settings`, Simple on a fresh install or when the settings cannot be read).
 */
export function openingMode(options: { readonly scheduling: boolean; readonly prefill: NewSessionPrefill | null }, settings: Readonly<Record<string, unknown>> | null): NewSessionMode {
  if (options.scheduling || options.prefill) return 'full';
  return readKnownSettings(settings)['newSession.mode'];
}

/** `true` while the dialog may switch modes (never for a schedule: its form is the Full one). */
export function offersModeToggle(scheduling: boolean): boolean {
  return !scheduling;
}

/** The own-worktree checkbox is offered: the folder is a git repo (a workspace folder's session works in place). */
export function offersWorktree(folder: Pick<FormFolder, 'kind'> | null): boolean {
  return isRepoFolder(folder);
}

/** A simple start makes a worktree: offered and checked. */
export function usesWorktree(form: Pick<NewSessionForm, 'worktrees'>, folder: Pick<FormFolder, 'kind'> | null): boolean {
  return offersWorktree(folder) && form.worktrees;
}

/** What a simple start names the session: the title (typed, else from the message; `null` = none) and the short name. */
export interface SimpleNames {
  readonly name: string;
  readonly title: string | null;
}

/** D56 + D22: the title is the field, else the message's first line ({@link titleFromMessage}); the short name is derived from it. */
export function simpleNames(form: Pick<NewSessionForm, 'name' | 'task'>, takenNames: readonly string[]): SimpleNames {
  const title = simpleTitle(form.name, form.task);
  return { name: simpleShortName(form.name, form.task, takenNames), title: title === '' ? null : title };
}

/** The title field's placeholder: the title the message gives, else a hint. */
export function titlePlaceholder(form: Pick<NewSessionForm, 'task'>): string {
  return titleFromMessage(form.task) || 'Title (optional): taken from the message';
}

/** The worktree branch: as edited, else derived from the title (`sb/<short name>`, a ticket title keeps D32's pre-fill). */
export function simpleBranch(form: Pick<NewSessionForm, 'name' | 'task'>, edited: string | null, takenNames: readonly string[]): string {
  if (edited !== null) return edited;
  const { name } = simpleNames(form, takenNames);
  return simpleBranchFromTitle(simpleTitle(form.name, form.task), name);
}

/** Why the branch cannot be used (any valid git branch name; no ticket rule), else `null`. */
export function branchProblem(branch: string): string | null {
  const check = checkBranchName(branch, 'branch', SIMPLE_BRANCH_EXAMPLE);
  return check.ok ? null : check.message;
}

/** The inputs of the Start rule and the body. */
export interface SimpleStart {
  readonly form: NewSessionForm;
  readonly folder: FormFolder | null;
  /** The edited branch (`null` = derived). */
  readonly branch: string | null;
  readonly takenNames: readonly string[];
}

/** What keeps Start disabled, in the order shown (empty = it can start). */
export function simpleBlockers({ form, folder, branch, takenNames }: SimpleStart): string[] {
  const out: string[] = [];
  if (folder === null) out.push('pick a folder');
  if (form.task.trim() === '') out.push('type the message');
  if (form.name.trim().length > TITLE_MAX) out.push(`the title must be at most ${TITLE_MAX} characters`);
  if (usesWorktree(form, folder)) {
    const problem = branchProblem(simpleBranch(form, branch, takenNames));
    if (problem) out.push(problem);
  }
  return out;
}

/** "Start session" is enabled ({@link simpleBlockers} is empty). */
export function canStartSimple(start: SimpleStart): boolean {
  return simpleBlockers(start).length === 0;
}

/**
 * The `POST /api/sessions` body (`NewSimpleSession`): `simple: true`, the short
 * name, the title when there is one, the message as the task, the folder, the
 * worktree (a repo folder only) with its branch, and D42's model / effort once
 * the form has a choice. No router fields, solutions or branching.
 */
export function toSimpleBody({ form, folder, branch, takenNames }: SimpleStart): NewSimpleSession {
  const { name, title } = simpleNames(form, takenNames);
  const worktrees = usesWorktree(form, folder);
  return {
    simple: true,
    name,
    task: form.task.trim(),
    ...(folder ? { folder: folder.id } : {}),
    worktrees,
    ...(title !== null ? { title } : {}),
    ...(worktrees ? { branch: simpleBranch(form, branch, takenNames).trim() } : {}),
    ...(form.model ? { model: form.model.model, effort: form.model.effort } : {}),
  };
}

/** The muted line under the fields: where the session runs (the repo's worktree folder with the checkbox on). */
export function whereLine({ form, folder, takenNames }: Omit<SimpleStart, 'branch'>): string {
  if (!folder) return 'Runs in the default folder';
  return `Runs in ${sessionCwd(folder, usesWorktree(form, folder), simpleNames(form, takenNames).name)}`;
}

/** The note under the fields for a workspace folder: nothing is pre-answered. */
export const WORKSPACE_NOTE = 'No session-start answers are sent: the agent asks what the workspace router needs.';

/** The label of the own-worktree checkbox. */
export const WORKTREE_LABEL = 'Work in its own git worktree';

/** `true` on macOS / iOS, where the shortcut reads ⌘↩ (as the palette's ⌘K does). */
export function isApple(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** The Start shortcut as the button's hint shows it. */
export function startShortcutLabel(platform: string): string {
  return isApple(platform) ? '⌘↩' : 'Ctrl+↩';
}

/** A key press, as {@link isStartShortcut} reads it. */
export interface KeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

/** ⌘↩ / Ctrl+↩ starts the session (plain Enter types a new line in the message). */
export function isStartShortcut(press: KeyPress): boolean {
  return press.key === 'Enter' && (press.metaKey || press.ctrlKey) && !press.shiftKey && !press.altKey && !press.isComposing;
}
