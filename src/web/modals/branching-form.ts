import type { BranchingPreflightRequest, BranchingPreflightRow, NewSessionBranching, NewSessionPrefill } from '../../core/api.ts';
import { CREATION_POLICY, DEFAULT_EPIC_BASE, EPIC_KEY_RULE, checkBranchName, checkEpicKey, epicBranchName, tidyEpicKey } from '../../core/branching.ts';
import type { SummaryLine } from './new-session.ts';

/**
 * Pure logic of the New-session form's **Branching** section (D40,
 * `docs/new-session.md` → *Branching (D40)*): the epic key, summary, derived
 * (editable) epic branch and base, the preflight table's per-repo choices (Drop
 * from task / Use other base), the preflight request, the summary lines, what
 * keeps Start disabled, and the `branching` Start posts. The task branch is
 * D32's Branch field (section 1), not repeated here.
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
}

/** What the section opens with: no epic, base `dev`, no choices. */
export const DEFAULT_BRANCHING: BranchingForm = { epicKey: '', epicSummary: '', epicBranch: null, base: DEFAULT_EPIC_BASE, choices: {} };

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

/** The section's field problems (each one keeps Start disabled): the key, the epic branch, the base. */
export function fieldProblems(form: BranchingForm): { readonly key: string | null; readonly epicBranch: string | null; readonly base: string | null } {
  if (!hasEpic(form)) return { key: null, epicBranch: null, base: null };
  const key = checkEpicKey(form.epicKey);
  const branch = checkBranchName(formEpicBranch(form), 'epic branch', 'feature/PROJ-3010-Summary');
  const base = checkBranchName(form.base, 'epic base branch', DEFAULT_EPIC_BASE);
  return { key: key.ok ? null : EPIC_KEY_RULE, epicBranch: branch.ok ? null : branch.message, base: base.ok ? null : base.message };
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
  const problems = fieldProblems(form);
  if (problems.key || problems.epicBranch || problems.base) return null;
  return {
    folder,
    solutions: [...solutions],
    epicBranch: hasEpic(form) ? formEpicBranch(form).trim() : null,
    base: form.base.trim() || DEFAULT_EPIC_BASE,
    taskBranch: taskBranch.trim() || null,
    bases: baseOverrides(form, solutions),
  };
}

/** What starts a new automatic check: the folder, the solutions, the epic, the base and the overrides (not the task branch). */
export function preflightKey(request: BranchingPreflightRequest | null): string | null {
  if (request === null) return null;
  return JSON.stringify([request.folder ?? null, request.solutions, request.epicBranch ?? null, request.base ?? null, request.bases ?? {}]);
}

/** A row whose task worktree has nothing to be cut from: the base is missing (and no epic on origin). */
export function rowMissesBase(row: BranchingPreflightRow): boolean {
  return row.error === null && row.baseExists === false && row.cutFrom === null;
}

/** The rows that keep Start disabled: base missing and not dropped. */
export function blockingRows(rows: readonly BranchingPreflightRow[] | null, form: Pick<BranchingForm, 'choices'>, solutions: readonly string[]): BranchingPreflightRow[] {
  if (!rows) return [];
  const dropped = droppedSolutions(form, solutions);
  return rows.filter((row) => solutions.includes(row.solution) && rowMissesBase(row) && !dropped.includes(row.solution));
}

/** The `⚠` summary lines of the section (each one keeps Start disabled). */
export function branchingWarnings(form: BranchingForm, solutions: readonly string[], rows: readonly BranchingPreflightRow[] | null): string[] {
  const warnings: string[] = [];
  const problems = fieldProblems(form);
  if (problems.key) warnings.push('⚠ the epic key must be a ticket key, e.g. PROJ-3010');
  if (problems.epicBranch) warnings.push('⚠ the epic branch is not a valid git branch name');
  if (problems.base) warnings.push('⚠ the epic base is not a valid git branch name');
  for (const row of blockingRows(rows, form, solutions)) warnings.push(`⚠ ${row.solution}: origin/${row.base ?? 'HEAD'} is missing: drop it or use another base`);
  if (solutions.length > 0 && droppedSolutions(form, solutions).length === solutions.length) warnings.push('⚠ every solution is dropped');
  return warnings;
}

/** The section keeps Start disabled ({@link branchingWarnings} is not empty). */
export function branchingBlocks(form: BranchingForm, solutions: readonly string[], rows: readonly BranchingPreflightRow[] | null): boolean {
  return branchingWarnings(form, solutions, rows).length > 0;
}

/** The `branching` Start posts (with Worktree on). */
export function toBranching(form: BranchingForm, solutions: readonly string[]): NewSessionBranching {
  const dropped = droppedSolutions(form, solutions);
  const bases = baseOverrides(form, solutions);
  return {
    epic: hasEpic(form) ? { key: form.epicKey.trim(), summary: form.epicSummary.trim(), branch: formEpicBranch(form).trim() } : null,
    base: form.base.trim() || DEFAULT_EPIC_BASE,
    ...(Object.keys(bases).length > 0 ? { bases } : {}),
    ...(dropped.length > 0 ? { dropped } : {}),
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
  };
}

/**
 * The summary with the section's lines (D40): with an epic, `epic      <epic
 * branch>` and `base      origin/<base>` under the `branch` line; the worktree
 * folder lines of dropped repos left out and a `dropped   <names>` line added; the
 * `⚠` lines ({@link branchingWarnings}) before the closing blank + ✓ lines.
 * Without an epic and without choices the summary is unchanged.
 */
export function withBranchingLines(
  lines: readonly SummaryLine[],
  form: BranchingForm,
  solutions: readonly string[],
  worktreeFolderOf: (solution: string) => string,
  rows: readonly BranchingPreflightRow[] | null,
): SummaryLine[] {
  const dropped = droppedSolutions(form, solutions);
  const droppedPaths = new Set(dropped.map(worktreeFolderOf));
  const out = lines.filter((line) => !(line.tone === 'path' && droppedPaths.has(line.text)));
  const added: SummaryLine[] = [];
  if (hasEpic(form)) added.push({ text: `epic      ${formEpicBranch(form).trim() || '—'}`, tone: 'value' }, { text: `base      origin/${form.base.trim() || DEFAULT_EPIC_BASE}`, tone: 'value' });
  if (dropped.length > 0) added.push({ text: `dropped   ${dropped.join(', ')}`, tone: 'value' });
  const branchAt = out.findIndex((line) => line.text.startsWith('branch    '));
  if (added.length > 0) out.splice(branchAt === -1 ? out.length : branchAt + 1, 0, ...added);
  const warnings = branchingWarnings(form, solutions, rows).map((text): SummaryLine => ({ text, tone: 'warn' }));
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
