/**
 * Pure model of the Diff tab (SPEC → Session → Diff; M4.5): the 300px file list
 * and the unified diff of the selected file, from the session's `FileDiff[]`
 * (`GET /api/sessions/{id}/diff`, gap #10). Copy and formats are the prototype's
 * (`docs/handoff/prototype/Switchboard App.dc.html`, `files` / `df`); the rules
 * are in `docs/derivations.md` → *Diff tab*.
 */
import type { DiffScope, DiffTargets, FileDiff } from '../../../core/api.ts';
import type { EventKind } from '../../../core/model.ts';

/** The header note while the selected file has uncommitted changes (prototype copy). */
export const NOT_COMMITTED_NOTE = 'Not committed. Commit only when you approve.';

/** The file list's empty state (prototype copy). */
export const NO_CHANGES = 'No changes yet.';

/** How a diff line is colored: `+` added, `-` removed, `@@` a hunk header (D90: a subtle separator row), anything else context. */
export type DiffTone = 'add' | 'del' | 'hunk' | 'ctx';

/** One row of the file list. */
export interface DiffFileRow {
  /** Stable identity across refreshes: solution + path. */
  readonly key: string;
  /** The file name (last path segment). */
  readonly short: string;
  /** `+118`, `+51 −12`, `−4`, or `—` without line changes (binary, empty, mode only). */
  readonly delta: string;
  /** `<solution> · <path>`. */
  readonly sub: string;
  readonly selected: boolean;
}

/** One line of the unified diff, verbatim (its `+` / `-` / space marker included). */
export interface DiffLine {
  readonly text: string;
  readonly tone: DiffTone;
}

/** The right pane: header + body of the selected file. */
export interface DiffPane {
  /** Key of the shown file, `null` without files. */
  readonly key: string | null;
  /** `<solution> / <path>`, empty without files. */
  readonly name: string;
  /** `⎇ <branch>`, empty without a branch (workspace-root files, a detached checkout). */
  readonly branch: string;
  /** Show {@link NOT_COMMITTED_NOTE}: `false` only for a file whose changes are all committed. */
  readonly note: boolean;
  readonly lines: readonly DiffLine[];
}

/** The whole tab. */
export interface DiffModel {
  readonly rows: readonly DiffFileRow[];
  readonly pane: DiffPane;
  /** No changed files: the list shows {@link NO_CHANGES}. */
  readonly empty: boolean;
}

const MINUS = '−';
const NONE = '—';

/**
 * Event kinds after which the diff is fetched again: edits and shell commands
 * (`impl`), loop / self-heal steps, other tools (MCP, subagents), results and
 * failures. Reads (`plan`), questions (`ask`) and chat text change no file (gap #7).
 */
const REFRESH_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['impl', 'loop', 'ok', 'tool', 'error']);

/** `true` when a `/hub` `event` of this kind can change the session's files. */
export function refreshesDiff(kind: EventKind): boolean {
  return REFRESH_KINDS.has(kind);
}

/** Identity of a file across refreshes (a path can repeat across solutions). */
export function fileKey(file: Pick<FileDiff, 'solution' | 'path'>): string {
  return `${file.solution}\u0000${file.path}`;
}

/** The list's `+added −removed` (the prototype's `+51 −12`, U+2212 minus); `—` when neither. */
export function deltaText(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`${MINUS}${removed}`);
  return parts.length > 0 ? parts.join(' ') : NONE;
}

/** The tone of one diff line by its first character (`@@` = a hunk header). */
export function lineTone(line: string): DiffTone {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** The last `/`-segment of a path (git paths always use `/`). */
export function shortName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * The file the pane shows: the one with `selectedKey`, else the first (a new
 * session, or the selected file left the diff, e.g. its change was reverted).
 */
export function selectedFile(files: readonly FileDiff[], selectedKey: string | null): FileDiff | null {
  if (selectedKey !== null) {
    const found = files.find((file) => fileKey(file) === selectedKey);
    if (found) return found;
  }
  return files[0] ?? null;
}

/** The Diff tab for `files` (server order: per solution, by path) with `selectedKey` picked. */
export function diffModel(files: readonly FileDiff[], selectedKey: string | null): DiffModel {
  const shown = selectedFile(files, selectedKey);
  const shownKey = shown ? fileKey(shown) : null;
  const rows = files.map((file) => {
    const key = fileKey(file);
    return {
      key,
      short: shortName(file.path),
      delta: deltaText(file.added, file.removed),
      sub: `${file.solution} · ${file.path}`,
      selected: key === shownKey,
    };
  });
  const pane: DiffPane = shown
    ? {
        key: shownKey,
        name: `${shown.solution} / ${shown.path}`,
        branch: shown.branch ? `⎇ ${shown.branch}` : '',
        note: shown.uncommitted,
        lines: shown.lines.map((text) => ({ text, tone: lineTone(text) })),
      }
    : { key: null, name: '', branch: '', note: true, lines: [] };
  return { rows, pane, empty: files.length === 0 };
}

// ── D90: which changes the tab shows ─────────────────────────────────────

/** The view toggle's labels. */
export const SCOPE_LABELS: Readonly<Record<DiffScope, string>> = {
  head: 'Since last commit',
  branch: 'Whole branch',
  repo: 'All uncommitted changes in this repo',
};

/** The toggles' tooltips. */
export const SCOPE_TITLES: Readonly<Record<DiffScope, string>> = {
  head: "Uncommitted changes against the last commit; in a repo the session works in place, only the files this session touched",
  branch: 'Everything the branch contains: its commits and the uncommitted changes, against where it left its base branch',
  repo: "Every uncommitted change in the repo, including other people's and other sessions' edits",
};

/** The note under the header while `repo` is shown. */
export const REPO_NOTE = "Includes other people's and other sessions' edits in this repo.";

/** Empty states per view. */
export const EMPTY_HEAD = 'No uncommitted changes since the last commit.';
export const EMPTY_REPO = 'No uncommitted changes in this repo.';
/** Under {@link EMPTY_HEAD} when a worktree's branch has commits. */
export const HINT_WHOLE_BRANCH = 'The branch has commits: switch to Whole branch to see them.';

/**
 * The views the tab offers: Since last commit always; Whole branch with a
 * worktree; All uncommitted changes with a solution worked on in place. Without
 * targets (still loading, a machine before D90) only the default.
 */
export function scopeOptions(targets: DiffTargets | null): DiffScope[] {
  const options: DiffScope[] = ['head'];
  if (targets && targets.worktrees.length > 0) options.push('branch');
  if (targets && targets.inPlace.length > 0) options.push('repo');
  return options;
}

/**
 * The view to show: the remembered one while the targets load (no second fetch),
 * then the remembered one only when it is offered, else Since last commit.
 */
export function shownScope(remembered: DiffScope | null, targets: DiffTargets | null): DiffScope {
  if (remembered === null) return 'head';
  if (targets === null) return remembered;
  return scopeOptions(targets).includes(remembered) ? remembered : 'head';
}

/** `Whole branch vs origin/dev` (the worktrees' distinct bases), `Whole branch` without one. */
export function scopeTitle(scope: DiffScope, targets: DiffTargets | null): string {
  if (scope === 'head') return SCOPE_LABELS.head;
  if (scope === 'repo') return 'All uncommitted changes';
  const bases = [...new Set((targets?.worktrees ?? []).map((w) => w.base).filter((base): base is string => base !== null).map(shortBase))];
  return bases.length > 0 ? `Whole branch vs ${bases.join(', ')}` : 'Whole branch';
}

/** A base ref as the header names it: a full commit id cut to 7 characters. */
function shortBase(base: string): string {
  return /^[0-9a-f]{40,64}$/i.test(base) ? base.slice(0, 7) : base;
}

/** `Since last commit · 4 files · +120 −8`; the title alone without files; no delta without line changes. */
export function headerLine(scope: DiffScope, files: readonly FileDiff[], targets: DiffTargets | null): string {
  const title = scopeTitle(scope, targets);
  if (files.length === 0) return title;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const parts = [title, `${files.length} ${files.length === 1 ? 'file' : 'files'}`];
  if (added > 0 || removed > 0) parts.push(deltaText(added, removed));
  return parts.join(' · ');
}

/** The empty state of a view and its hint (`null` = none). */
export function emptyState(scope: DiffScope, targets: DiffTargets | null): { readonly text: string; readonly hint: string | null } {
  if (scope === 'branch') return { text: NO_CHANGES, hint: null };
  if (scope === 'repo') return { text: EMPTY_REPO, hint: null };
  const commits = (targets?.worktrees ?? []).some((w) => w.commits > 0);
  return { text: EMPTY_HEAD, hint: commits ? HINT_WHOLE_BRANCH : null };
}

/** `localStorage` key of the view picked per session (session id → scope). */
export const DIFF_SCOPE_KEY = 'switchboard.diffScopes';

/** At most this many sessions' views are kept (the newest). */
const MAX_REMEMBERED = 200;

/** The minimal storage this needs (`window.localStorage`; tests pass a map). */
export interface ScopeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readScopes(storage: ScopeStorage | null): Record<string, DiffScope> {
  try {
    const raw = storage?.getItem(DIFF_SCOPE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, DiffScope] => entry[1] === 'head' || entry[1] === 'branch' || entry[1] === 'repo'));
  } catch {
    return {};
  }
}

/** The view this browser last picked for the session, `null` when none. */
export function loadScope(storage: ScopeStorage | null, sessionId: string): DiffScope | null {
  return readScopes(storage)[sessionId] ?? null;
}

/** Remembers the session's view (the default is stored too: the newest pick wins). */
export function saveScope(storage: ScopeStorage | null, sessionId: string, scope: DiffScope): void {
  const all = readScopes(storage);
  delete all[sessionId];
  all[sessionId] = scope;
  try {
    storage?.setItem(DIFF_SCOPE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_REMEMBERED))));
  } catch {
    // Storage blocked: the pick lasts this page only.
  }
}

/**
 * D90 ruling (2026-10-09): the session tab's "Diff · n": the count of the view the
 * Diff tab shows (`counted`, `GET …/diff/count`); a machine without that route
 * (`unsupported`) shows the detail's whole-branch count (`detailFiles`); `null`
 * (no count) while neither is known.
 */
export function diffTabCount(counted: number | null, unsupported: boolean, detailFiles: number | null): number | null {
  if (counted !== null) return counted;
  return unsupported ? detailFiles : null;
}
