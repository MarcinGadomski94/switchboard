import type { BranchingPreflightRequest, BranchingPreflightRow, NewSessionBranching, NewSessionPrefill } from '../../core/api.ts';
import { CREATION_POLICY, DEFAULT_EPIC_BASE, EPIC_KEY_RULE, checkBranchName, checkEpicKey, epicBranchName, tidyEpicKey } from '../../core/branching.ts';
import { effectiveParent, parentConflict, parentFromTask, parentStatusWarning, parentText, parseParent } from '../../core/stacking.ts';
import type { SummaryLine } from './new-session.ts';

/**
 * Pure logic of the New-session form's **Branching** section (D40,
 * `docs/new-session.md` → *Branching (D40)*): the epic key, summary, derived
 * (editable) epic branch and base, the preflight table's per-repo choices (Drop
 * from task / Use other base), the preflight request, the summary lines, what
 * keeps Start disabled, and the `branching` Start posts. The task branch is
 * D32's Branch field (section 1), not repeated here. D47: the **Parent** field
 * (a task key or a branch name the task is stacked on; empty = the epic branch),
 * pre-filled from the task text until the developer types there, and the
 * preflight's Resolved base / PR target / Parent status columns.
 */

/** One repo's choice on a preflight row whose base is missing. */
export type RepoChoice = { readonly drop: true } | { readonly base: string };

/** The section's state (kept next to the form's own state in the modal). */
export interface BranchingForm {
  readonly epicKey: string;
  readonly epicSummary: string;
  /** The epic branch as typed; `null` while untouched, so it follows the key and summary. */
  readonly epicBranch: string | null;
  /** The epic's base (default `dev`). */
  readonly base: string;
  /** Per solution: the choice made on its preflight row. */
  readonly choices: Readonly<Record<string, RepoChoice>>;
  /**
   * D47: the parent as typed; `null` while untouched, so it follows the task text
   * ({@link formParent}); `''` = typed empty (the epic branch, never pre-filled again).
   */
  readonly parent?: string | null;
}

/** What the section opens with: no epic, base `dev`, no choices, the parent untouched. */
export const DEFAULT_BRANCHING: BranchingForm = { epicKey: '', epicSummary: '', epicBranch: null, base: DEFAULT_EPIC_BASE, choices: {}, parent: null };

/**
 * D47: the Parent field's value: as typed, else the key the task text stacks on
 * (`parentFromTask`: "create it from PROJ-3013", "stack on PROJ-3013", …), else
 * empty. What the developer typed is never overwritten.
 */
export function formParent(form: Pick<BranchingForm, 'parent'>, task: string): string {
  return form.parent ?? parentFromTask(task) ?? '';
}

/** D47: `true` while the Parent field shows the task text's key (untouched and pre-filled). */
export function parentFromTaskShown(form: Pick<BranchingForm, 'parent'>, task: string): boolean {
  return (form.parent ?? null) === null && parentFromTask(task) !== null;
}

/**
 * D47: the parent the task is stacked on, normalized (a key upper-cased), or
 * `null` (empty, not valid, or the epic branch itself). `form.parent` is read as
 * the field's value (the modal passes {@link formParent}'s).
 */
export function stackedParent(form: BranchingForm): string | null {
  const check = parseParent(form.parent ?? '');
  if (!check.ok) return null;
  const parent = effectiveParent(check.parent, hasEpic(form) ? formEpicBranch(form).trim() : null);
  return parent === null ? null : parentText(parent);
}

/** D47: why the Parent field cannot be used (the server's 422 messages), else `null`. */
export function parentProblem(form: BranchingForm, taskBranch: string): string | null {
  const check = parseParent(form.parent ?? '');
  if (!check.ok) return check.message;
  if (check.parent === null) return null;
  const epic = hasEpic(form);
  return parentConflict(check.parent, { task: taskBranch.trim() || null, base: epic ? form.base.trim() || DEFAULT_EPIC_BASE : null, epic: epic ? formEpicBranch(form).trim() : null });
}

/** The read-only creation line. */
export const CREATION_LINE = `Creation: ${CREATION_POLICY}`;

/** The ms the form waits after the solutions, epic or base settle before it runs the preflight. */
export const PREFLIGHT_DEBOUNCE_MS = 800;

/** `true` once an epic key is typed: the epic variant (else a task without an epic). */
export function hasEpic(form: Pick<BranchingForm, 'epicKey'>): boolean {
  return form.epicKey.trim() !== '';
}

/** The epic branch: as typed, else derived from the key and summary (`epicBranchName`). */
export function formEpicBranch(form: Pick<BranchingForm, 'epicKey' | 'epicSummary' | 'epicBranch'>): string {
  return form.epicBranch ?? epicBranchName(form.epicKey, form.epicSummary);
}

/** The section's field problems (each one keeps Start disabled): the key, the epic branch, the base; D47: the parent. */
export function fieldProblems(
  form: BranchingForm,
  taskBranch = '',
): { readonly key: string | null; readonly epicBranch: string | null; readonly base: string | null; readonly parent: string | null } {
  const parent = parentProblem(form, taskBranch);
  if (!hasEpic(form)) return { key: null, epicBranch: null, base: null, parent };
  const key = checkEpicKey(form.epicKey);
  const branch = checkBranchName(formEpicBranch(form), 'epic branch', 'feature/PROJ-3010-Summary');
  const base = checkBranchName(form.base, 'epic base branch', DEFAULT_EPIC_BASE);
  return { key: key.ok ? null : EPIC_KEY_RULE, epicBranch: branch.ok ? null : branch.message, base: base.ok ? null : base.message, parent };
}

/** The choices that still apply: for picked solutions only, a base override only while it is a valid branch name. */
export function activeChoices(form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): Record<string, RepoChoice> {
  const active: Record<string, RepoChoice> = {};
  for (const solution of solutions) {
    const choice = form.choices[solution];
    if (!choice) continue;
    if ('drop' in choice || checkBranchName(choice.base, 'base', DEFAULT_EPIC_BASE).ok) active[solution] = 'drop' in choice ? choice : { base: choice.base.trim() };
  }
  return active;
}

/** The solutions dropped from the task. */
export function droppedSolutions(form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): string[] {
  const active = activeChoices(form, solutions);
  return solutions.filter((solution) => active[solution] && 'drop' in (active[solution] as RepoChoice));
}

/** The per-solution base overrides. */
export function baseOverrides(form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): Record<string, string> {
  const bases: Record<string, string> = {};
  for (const [solution, choice] of Object.entries(activeChoices(form, solutions))) if ('base' in choice) bases[solution] = choice.base;
  return bases;
}

/**
 * The preflight request (`POST /api/branching/preflight`), or `null` when there is
 * nothing to check (no solutions: D38) or a field is not valid yet. The task
 * branch rides along but does not start a new check by itself ({@link preflightKey}).
 */
export function preflightRequest(form: BranchingForm, folder: string | null, solutions: readonly string[], taskBranch: string): BranchingPreflightRequest | null {
  if (solutions.length === 0) return null;
  const problems = fieldProblems(form, taskBranch);
  if (problems.key || problems.epicBranch || problems.base || problems.parent) return null;
  const parent = stackedParent(form);
  return {
    folder,
    solutions: [...solutions],
    epicBranch: hasEpic(form) ? formEpicBranch(form).trim() : null,
    base: form.base.trim() || DEFAULT_EPIC_BASE,
    taskBranch: taskBranch.trim() || null,
    bases: baseOverrides(form, solutions),
    ...(parent !== null ? { parent } : {}),
  };
}

/** What starts a new automatic check: the folder, the solutions, the epic, the base, the overrides and (D47) the parent (not the task branch). */
export function preflightKey(request: BranchingPreflightRequest | null): string | null {
  if (request === null) return null;
  const key: unknown[] = [request.folder ?? null, request.solutions, request.epicBranch ?? null, request.base ?? null, request.bases ?? {}];
  if (request.parent) key.push(request.parent);
  return JSON.stringify(key);
}

/** A row whose task worktree has nothing to be cut from: the base is missing (and no epic on origin). */
export function rowMissesBase(row: BranchingPreflightRow): boolean {
  return row.error === null && row.baseExists === false && row.cutFrom === null;
}

/** The rows that keep Start disabled: base missing and not dropped. */
export function blockingRows(rows: readonly BranchingPreflightRow[] | null, form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): BranchingPreflightRow[] {
  if (!rows) return [];
  const dropped = droppedSolutions(form, solutions);
  return rows.filter((row) => solutions.includes(row.solution) && rowMissesBase(row) && !rowParentError(row) && !dropped.includes(row.solution));
}

/** D47: a row whose typed parent names several origin branches (the full name is needed). */
export function rowParentError(row: BranchingPreflightRow): string | null {
  return row.error === null ? (row.parent?.error ?? null) : null;
}

/** D47: the rows whose parent is ambiguous and not dropped (each keeps Start disabled). */
export function ambiguousRows(rows: readonly BranchingPreflightRow[] | null, form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): BranchingPreflightRow[] {
  if (!rows) return [];
  const dropped = droppedSolutions(form, solutions);
  return rows.filter((row) => solutions.includes(row.solution) && rowParentError(row) !== null && !dropped.includes(row.solution));
}

/** The `⚠` summary lines of the section (each one keeps Start disabled). */
export function branchingWarnings(form: BranchingForm, solutions: readonly string[], rows: readonly BranchingPreflightRow[] | null, taskBranch = ''): string[] {
  const warnings: string[] = [];
  const problems = fieldProblems(form, taskBranch);
  if (problems.key) warnings.push('⚠ the epic key must be a ticket key, e.g. PROJ-3010');
  if (problems.epicBranch) warnings.push('⚠ the epic branch is not a valid git branch name');
  if (problems.base) warnings.push('⚠ the epic base is not a valid git branch name');
  if (problems.parent) warnings.push(`⚠ ${problems.parent}`);
  for (const row of blockingRows(rows, form, solutions)) warnings.push(`⚠ ${row.solution}: origin/${row.base ?? 'HEAD'} is missing: drop it or use another base`);
  if (stackedParent(form) !== null) for (const row of ambiguousRows(rows, form, solutions)) warnings.push(`⚠ ${row.solution}: ${rowParentError(row) as string}`);
  if (solutions.length > 0 && droppedSolutions(form, solutions).length === solutions.length) warnings.push('⚠ every solution is dropped');
  return warnings;
}

/** The section keeps Start disabled ({@link branchingWarnings} is not empty). */
export function branchingBlocks(form: BranchingForm, solutions: readonly string[], rows: readonly BranchingPreflightRow[] | null, taskBranch = ''): boolean {
  return branchingWarnings(form, solutions, rows, taskBranch).length > 0;
}

/** The `branching` Start posts (with Worktree on). */
export function toBranching(form: BranchingForm, solutions: readonly string[]): NewSessionBranching {
  const dropped = droppedSolutions(form, solutions);
  const bases = baseOverrides(form, solutions);
  const parent = stackedParent(form);
  return {
    epic: hasEpic(form) ? { key: form.epicKey.trim(), summary: form.epicSummary.trim(), branch: formEpicBranch(form).trim() } : null,
    base: form.base.trim() || DEFAULT_EPIC_BASE,
    ...(Object.keys(bases).length > 0 ? { bases } : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
    ...(parent !== null ? { parent } : {}),
  };
}

/** The section's state from a prefill's `branching` (M3.3 "Open fix session"), else the defaults. */
export function branchingFromPrefill(prefill: NewSessionPrefill | null | undefined): BranchingForm {
  const raw = prefill?.branching;
  if (!raw || typeof raw !== 'object') return DEFAULT_BRANCHING;
  const epic = raw.epic && typeof raw.epic === 'object' ? raw.epic : null;
  return {
    ...DEFAULT_BRANCHING,
    epicKey: typeof epic?.key === 'string' ? tidyEpicKey(epic.key) : '',
    epicSummary: typeof epic?.summary === 'string' ? epic.summary : '',
    epicBranch: typeof epic?.branch === 'string' && epic.branch.trim() !== '' ? epic.branch.trim() : null,
    base: typeof raw.base === 'string' && raw.base.trim() !== '' ? raw.base.trim() : DEFAULT_EPIC_BASE,
    ...(typeof raw.parent === 'string' && raw.parent.trim() !== '' ? { parent: raw.parent.trim() } : {}),
  };
}

/**
 * The summary with the section's lines (D40): with an epic, `epic      <epic
 * branch>` and `base      origin/<base>` under the `branch` line; the worktree
 * folder lines of dropped repos left out and a `dropped   <names>` line added; the
 * `⚠` lines ({@link branchingWarnings}) before the closing blank + ✓ lines.
 * Without an epic and without choices the summary is unchanged. D47: a stacked
 * task adds `parent    <parent> (stacked)` after them.
 */
export function withBranchingLines(
  lines: readonly SummaryLine[],
  form: BranchingForm,
  solutions: readonly string[],
  worktreeFolderOf: (solution: string) => string,
  rows: readonly BranchingPreflightRow[] | null,
  taskBranch = '',
): SummaryLine[] {
  const dropped = droppedSolutions(form, solutions);
  const droppedPaths = new Set(dropped.map(worktreeFolderOf));
  const out = lines.filter((line) => !(line.tone === 'path' && droppedPaths.has(line.text)));
  const added: SummaryLine[] = [];
  if (hasEpic(form)) added.push({ text: `epic      ${formEpicBranch(form).trim() || '—'}`, tone: 'value' }, { text: `base      origin/${form.base.trim() || DEFAULT_EPIC_BASE}`, tone: 'value' });
  if (dropped.length > 0) added.push({ text: `dropped   ${dropped.join(', ')}`, tone: 'value' });
  const parent = stackedParent(form);
  if (parent !== null) added.push({ text: `parent    ${parent} (stacked)`, tone: 'value' });
  const branchAt = out.findIndex((line) => line.text.startsWith('branch    '));
  if (added.length > 0) out.splice(branchAt === -1 ? out.length : branchAt + 1, 0, ...added);
  const warnings = branchingWarnings(form, solutions, rows, taskBranch).map((text): SummaryLine => ({ text, tone: 'warn' }));
  if (warnings.length > 0) out.splice(Math.max(0, out.length - 2), 0, ...warnings);
  return out;
}

/** One preflight cell: its text and whether it reads well (`ok`), badly (`warn`) or just informs (`muted`). */
export interface PreflightCell {
  readonly text: string;
  readonly tone: 'ok' | 'warn' | 'muted';
}

/** A preflight row as the table shows it: base, epic and task cells. */
export function preflightCells(row: BranchingPreflightRow): { readonly base: PreflightCell; readonly epic: PreflightCell | null; readonly task: PreflightCell | null } {
  if (row.error !== null) return { base: { text: row.error, tone: row.repoPath === null ? 'warn' : 'muted' }, epic: null, task: null };
  const baseName = `origin/${row.base ?? 'HEAD'}`;
  const base: PreflightCell = row.baseExists ? { text: `✓ ${baseName}`, tone: 'ok' } : { text: row.base === null ? '⚠ no origin default branch' : `⚠ no ${baseName}`, tone: 'warn' };
  const epic: PreflightCell | null = row.epic
    ? row.epic.exists
      ? { text: `✓ on origin${row.epic.behind !== null ? ` · ${row.epic.behind} behind` : ''}`, tone: 'ok' }
      : { text: '— not on origin (cut lazily)', tone: 'muted' }
    : null;
  const task: PreflightCell | null = row.task
    ? row.task.exists
      ? { text: '✓ on origin (reused)', tone: 'ok' }
      : row.task.local
        ? { text: '✓ local (reused)', tone: 'ok' }
        : { text: '— new', tone: 'muted' }
    : null;
  return { base, epic, task };
}

/**
 * D47: a stacked row's extra cells: **Resolved base** (`origin/<parent>`,
 * `origin/<epic>`, `origin/dev (epic not created yet)`, …), **PR target** (the
 * parent, the epic, `(epic, created lazily)`), **Parent status** (`PR #306 open`;
 * merged / closed = a warning, "parent merged — base on its target instead";
 * `no PR`; `— parent not in repo`). `null` for a row that is not stacked or
 * could not be read.
 */
export function stackedCells(row: BranchingPreflightRow): { readonly resolved: PreflightCell; readonly target: PreflightCell; readonly status: PreflightCell } | null {
  const parent = row.parent ?? null;
  if (row.error !== null || parent === null) return null;
  if (parent.error !== null) {
    const warn: PreflightCell = { text: `⚠ ${parent.error}`, tone: 'warn' };
    return { resolved: warn, target: { text: '—', tone: 'muted' }, status: { text: '—', tone: 'muted' } };
  }
  const epicMissing = row.epic !== null && row.epic.exists === false;
  const notes: string[] = [];
  if (parent.branch === null && epicMissing) notes.push('epic not created yet');
  if (parent.branch === null) notes.push('parent not in repo');
  const resolved: PreflightCell =
    row.cutFrom === null
      ? { text: '⚠ nothing to cut from', tone: 'warn' }
      : { text: `${row.cutFrom}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`, tone: parent.branch !== null ? 'ok' : 'muted' };
  const targetName = row.prTarget ?? null;
  const target: PreflightCell =
    targetName === null
      ? { text: '—', tone: 'muted' }
      : { text: row.epic !== null && targetName === row.epic.branch && parent.branch === null ? `${targetName} (epic${epicMissing ? ', created lazily' : ''})` : targetName, tone: 'muted' };
  let status: PreflightCell;
  if (parent.branch === null) status = { text: '— parent not in repo', tone: 'muted' };
  else if (parent.pr !== null) {
    const warning = parentStatusWarning({ kind: 'pr', pr: { ...parent.pr, headRefOid: null } });
    const text = `PR #${parent.pr.number} ${parent.pr.state.toLowerCase()}`;
    status = warning ? { text: `⚠ ${text} · ${warning}`, tone: 'warn' } : { text: `✓ ${text}`, tone: 'ok' };
  } else if (parent.noPr) status = { text: 'no PR', tone: 'muted' };
  else status = { text: 'PR status unknown', tone: 'muted' };
  return { resolved, target, status };
}
