/**
 * D40 (`docs/decisions.md` → *Epic/task branching*): the epic/task branching
 * model of a new session's worktrees, created lazily. `origin/<base>` (default
 * `dev`) → the epic branch `feature/<EPIC-KEY>-<Epic-Summary>` → the task branch
 * (D32's ticket branch). Switchboard cuts each task worktree from `origin/<epic>`
 * when the epic is on origin, else from `origin/<base>`; a task without an epic
 * from the repo's origin default branch (`origin/HEAD`, usually `origin/master`).
 * It never creates the epic branch and never pushes: the agent does both, only
 * in a repo it actually changes, at its first change (the hand-off's Rule line).
 *
 * The pure rules shared by the server (validation, hand-off) and the UI (the
 * form's Branching section): branch-name checks after `git check-ref-format`, the
 * derived epic branch name, and the answers-block lines. `docs/worktrees.md` →
 * *Epic/task branching (D40)*, `docs/new-session.md` → *Branching (D40)*.
 */

/** The epic's base branch on origin when the developer names none. */
export const DEFAULT_EPIC_BASE = 'dev';

/** The epic branch's prefix (`feature/<KEY>-<Summary>`). */
export const EPIC_PREFIX = 'feature/';

/** The read-only creation policy the form shows. */
export const CREATION_POLICY = 'lazy: on first code change';

/** An epic key: a Jira-style ticket key and its number (`PROJ-3010`). */
export const EPIC_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

/** The example the epic key messages and placeholder show. */
export const EPIC_KEY_EXAMPLE = 'PROJ-3010';

/** Why an epic key is refused (422 on field `branching.epic.key`). */
export const EPIC_KEY_RULE = `the epic key must be a ticket key and its number, e.g. ${EPIC_KEY_EXAMPLE}`;

/** The longest branch name Switchboard accepts (git allows more; a ref file name must stay short). */
export const BRANCH_NAME_MAX = 200;

/** Characters git forbids anywhere in a ref name: ASCII control characters, DEL, space, `~ ^ : ? * [ \`. */
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f ~^:?*[\\]/g;

/**
 * `true` when `name` is a branch name git accepts (`git check-ref-format --branch`):
 * no ASCII control character, space, `~`, `^`, `:`, `?`, `*`, `[` or `\`; no `..`,
 * `@{` or `//`; not `@`; no leading or trailing `/`, no trailing `.`; no
 * component starting with `.` or ending with `.lock`; and, for a branch, not
 * starting with `-` and not `HEAD`. At most {@link BRANCH_NAME_MAX} characters.
 */
export function isValidBranchName(name: string): boolean {
  if (name === '' || name.length > BRANCH_NAME_MAX) return false;
  if (name === '@' || name === 'HEAD' || name.startsWith('-')) return false;
  if (new RegExp(FORBIDDEN_CHARS.source).test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Result of {@link checkBranchName} / {@link checkEpicKey}: the value (trimmed), or why it is refused. */
export type BranchingCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * A branch name as the API takes it: text that, once trimmed, is a valid branch
 * name ({@link isValidBranchName}). `label` names the field in the message
 * (`the epic branch must be a valid git branch name, e.g. …`).
 */
export function checkBranchName(value: unknown, label: string, example: string): BranchingCheck {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '') return { ok: false, message: `name the ${label}, e.g. ${example}` };
  return isValidBranchName(name) ? { ok: true, name } : { ok: false, message: `the ${label} must be a valid git branch name, e.g. ${example}` };
}

/** The epic key as the API takes it: once trimmed, {@link EPIC_KEY}. */
export function checkEpicKey(value: unknown): BranchingCheck {
  const key = typeof value === 'string' ? value.trim() : '';
  return EPIC_KEY.test(key) ? { ok: true, name: key } : { ok: false, message: EPIC_KEY_RULE };
}

/**
 * Text as one part of a branch name: whitespace runs → `-`, the characters git
 * forbids dropped (control characters, `~ ^ : ? * [ \`), a `/` → `-` (it would
 * open a sub-folder of refs), `@{` → `@`, runs of `.` → one `.`, runs of `-`
 * merged, no `-` or `.` at either end and no `.lock` at the end. The letters'
 * case is kept.
 */
export function branchPart(text: string): string {
  let part = text
    .trim()
    .replace(/\s+/g, '-')
    .replace(FORBIDDEN_CHARS, '')
    .replace(/\//g, '-')
    .replace(/@\{/g, '@')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-');
  for (;;) {
    const trimmed = part.replace(/^[-.]+|[-.]+$/g, '').replace(/\.lock$/i, '');
    if (trimmed === part) return part;
    part = trimmed;
  }
}

/** The epic key typed tidied: {@link branchPart}, upper case (`proj 3010` → `PROJ-3010`). */
export function tidyEpicKey(text: string): string {
  return branchPart(text).toUpperCase();
}

/**
 * The epic branch a key and summary derive (D40): `feature/<KEY>-<Summary>`,
 * the key tidied ({@link tidyEpicKey}) and the summary kept in its casing with
 * spaces → `-`, the characters git forbids dropped and runs of `-` merged
 * ({@link branchPart}). `PROJ-3010` + "Platform tracking and KPI delivery process
 * development" → `feature/PROJ-3010-Platform-tracking-and-KPI-delivery-process-development`.
 * An empty summary gives `feature/<KEY>`; an empty key gives `''` (no epic).
 */
export function epicBranchName(key: string, summary: string): string {
  const tidyKey = tidyEpicKey(key);
  if (tidyKey === '') return '';
  const tidySummary = branchPart(summary);
  const name = `${EPIC_PREFIX}${tidySummary === '' ? tidyKey : `${tidyKey}-${tidySummary}`}`;
  if (name.length <= BRANCH_NAME_MAX) return name;
  // A very long summary is cut; the cut end is tidied like the rest (no `-`, `.` or `.lock` at the end).
  return `${EPIC_PREFIX}${branchPart(name.slice(EPIC_PREFIX.length, BRANCH_NAME_MAX).replace(/\//g, '-'))}`;
}

/** A session's epic (D40): the key and summary the developer typed, and its branch (derived, editable). */
export interface SessionEpic {
  readonly key: string;
  readonly summary: string;
  readonly branch: string;
}

/**
 * A session's branching choices (D40), as validated and stored (`sessions.branching`):
 * the epic (`null` = a task without an epic), the epic's base (default `dev`), the
 * per-repo base overrides the preflight offered, and the repos dropped from the
 * task. Keys are the solution names as posted.
 */
export interface SessionBranching {
  readonly epic: SessionEpic | null;
  /** The epic's base branch on origin (`dev`); read only with an epic. */
  readonly base: string;
  /** Per solution: the base used instead (an epic's base, or the origin default branch without an epic). */
  readonly bases: Readonly<Record<string, string>>;
  /** Solutions dropped from the task (no worktree; they leave the session's solutions). */
  readonly dropped: readonly string[];
}

/** A task without an epic and no per-repo choices (D40's default for a body without `branching`). */
export const TASK_ONLY: SessionBranching = { epic: null, base: DEFAULT_EPIC_BASE, bases: {}, dropped: [] };

/**
 * The branch a repo's task worktree is cut from (without `origin/`): the epic
 * when it is on origin, else the repo's base override, else the epic's base;
 * without an epic, the override, else `defaultBranch` (the repo's origin default,
 * `origin/HEAD`). `null` when nothing is known (no epic on origin and no default).
 */
export function cutPoint(branching: SessionBranching, solution: string, facts: { readonly epicOnOrigin: boolean; readonly defaultBranch: string | null }): string | null {
  const override = branching.bases[solution];
  if (branching.epic) return facts.epicOnOrigin ? branching.epic.branch : (override ?? branching.base);
  return override ?? facts.defaultBranch;
}

/** What the answers block says about a session's branching (D40). */
export interface HandoffBranching {
  /** The task branch (D32). */
  readonly task: string;
  readonly epic: Pick<SessionEpic, 'key' | 'branch'> | null;
  /** The epic's base (the epic variant). */
  readonly base: string;
  /**
   * Task only: the origin branches the worktrees were cut from (`origin/main`),
   * distinct, for the repos without an override; empty when none is known (no
   * worktree made up front, D38).
   */
  readonly defaultBases: readonly string[];
  /** Per-repo base overrides: `[<folder>, <base>]`. */
  readonly overrides: ReadonlyArray<readonly [folder: string, base: string]>;
  /** Folders dropped from the task. */
  readonly dropped: readonly string[];
}

/** The model line of an epic session. */
export const EPIC_MODEL = 'epic/task (lazy)';

/** A task-only session's base when no worktree tells which origin default branch applies (D38). */
export const DEFAULT_BRANCH_BASE = "origin/HEAD, the repo's origin default branch, usually origin/master";

/**
 * The Rule line of an epic session (D40, verbatim with the base filled in):
 * create and push the epic + task branches only in a repo at its first code
 * change; cut the epic from the current `origin/<base>` when it is missing on
 * origin; never create either branch in repos that are not changed.
 */
export function epicRule(base: string, overrides: boolean): string {
  return (
    'create and push the epic + task branches with `git push -u origin <same name>` only in a repo at its first code change; ' +
    `cut the epic from the current \`origin/${base}\`${overrides ? " (or the repo's base override below)" : ''} when it is missing on origin; ` +
    'never create either branch in repos that are not changed'
  );
}

/**
 * The answers-block lines of a session's branching (D40), each `- Label: value`:
 * - **epic:** `Branching model: epic/task (lazy)`, `Epic: <KEY> · <epic branch>
 *   (base: origin/<base>)`, `Task branch: <task> (base: <epic branch>)` and the
 *   Rule line ({@link epicRule});
 * - **task only:** `Branching model: task only: <task> (base: origin/master)`,
 *   with the origin default branch the worktrees were cut from (each repo's when
 *   they differ; {@link DEFAULT_BRANCH_BASE} when none is known);
 * - then, when any, `Base overrides: <folder>: origin/<base>; …` and
 *   `Dropped repos (no base branch): <folder>, …`.
 */
export function branchingLines(branching: HandoffBranching): string[] {
  const lines: string[] = [];
  if (branching.epic) {
    lines.push(
      `- Branching model: ${EPIC_MODEL}`,
      `- Epic: ${branching.epic.key} · ${branching.epic.branch} (base: origin/${branching.base})`,
      `- Task branch: ${branching.task} (base: ${branching.epic.branch})`,
      `- Rule: ${epicRule(branching.base, branching.overrides.length > 0)}`,
    );
  } else {
    const bases = branching.defaultBases;
    const base = bases.length === 0 ? DEFAULT_BRANCH_BASE : bases.length === 1 ? (bases[0] as string) : `each repo's origin default branch: ${bases.join(', ')}`;
    lines.push(`- Branching model: task only: ${branching.task} (base: ${base})`);
  }
  if (branching.overrides.length > 0) lines.push(`- Base overrides: ${branching.overrides.map(([folder, base]) => `${folder}: origin/${base}`).join('; ')}`);
  if (branching.dropped.length > 0) lines.push(`- Dropped repos (no base branch): ${branching.dropped.join(', ')}`);
  return lines;
}

/**
 * The branch `git ls-remote --symref origin HEAD` says origin's HEAD points at
 * (`ref: refs/heads/master\tHEAD` → `master`), else `null`.
 */
export function parseSymrefHead(stdout: string): string | null {
  const match = /^ref:\s*refs\/heads\/(\S+)\s+HEAD\s*$/m.exec(stdout.replace(/\r\n/g, '\n'));
  return match?.[1] ?? null;
}
