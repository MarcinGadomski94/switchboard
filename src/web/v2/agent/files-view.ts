/**
 * D180 · Files in the side panel as one view (`docs/v2.md` → *The agent view's side panel*),
 * pure: the "Touched by this agent" list, each tree row's one signal, a folded folder's
 * "N changed", the reader's history, the breadcrumb's unfold set, the info line and the
 * changed-line marks.
 */
import type { AgentFileRef, AgentFileRoot } from '../../../core/agent-files.ts';
import type { FileDiff } from '../../../core/api.ts';

/** Rows "Touched by this agent" shows before "Show all". */
export const TOUCHED_ROWS = 5;

/** `/`-separated, and case-folded for a Windows path (`C:\…`), so two forms of one path compare equal. */
export function pathKey(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(slashed) || file.includes('\\') ? slashed.toLowerCase() : slashed;
}

/** `true` when the file's path or name holds every word of `filter` (case-insensitive). */
export function matchesFilter(file: string, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const text = file.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * The "Touched by this agent" rows: newest first (`at`, then the server's order), filtered,
 * {@link TOUCHED_ROWS} of them unless `all`. `total` is how many match; `more` whether "Show all"
 * has anything to add.
 */
export function touchedRows(files: readonly AgentFileRef[], filter: string, all: boolean): { readonly rows: readonly AgentFileRef[]; readonly total: number; readonly more: boolean } {
  const ordered = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => matchesFilter(file.path, filter))
    .sort((a, b) => {
      const at = (b.file.at ?? '').localeCompare(a.file.at ?? '');
      return at !== 0 ? at : a.index - b.index;
    })
    .map(({ file }) => file);
  return { rows: all ? ordered : ordered.slice(0, TOUCHED_ROWS), total: ordered.length, more: ordered.length > TOUCHED_ROWS };
}

/** What a touched row says the agent did: the strongest source (deleted for a file that is gone). */
export type TouchedWhat = 'wrote' | 'edited' | 'read' | 'mentioned' | 'deleted';

export function touchedWhat(file: Pick<AgentFileRef, 'sources' | 'exists'>): TouchedWhat {
  if (!file.exists) return 'deleted';
  for (const source of ['wrote', 'edited', 'read', 'mentioned'] as const) if (file.sources.includes(source)) return source;
  return 'mentioned';
}

/** "wrote 10:38", "read", "mentioned": the source, with the time for a write or an edit. */
export function touchedText(file: Pick<AgentFileRef, 'sources' | 'exists' | 'at'>, time: (iso: string) => string): string {
  const what = touchedWhat(file);
  return (what === 'wrote' || what === 'edited') && file.at ? `${what} ${time(file.at)}` : what;
}

/**
 * Each changed file of the `head` diff (`files`) as an absolute path, keyed by {@link pathKey}:
 * its repo is the root named like its `solution` (the repo's folder name, or the label before a
 * worktree's ` · branch`); a workspace's own files (`solution` "root") are under the first plain
 * folder. A file whose repo is not one of the roots is left out (no signal, rather than a wrong one).
 */
export function changedByPath(files: readonly FileDiff[] | null, roots: readonly AgentFileRoot[] | null): ReadonlyMap<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  if (!files || !roots) return out;
  for (const file of files) {
    const root =
      file.solution === 'root'
        ? roots.find((candidate) => candidate.kind === 'folder')
        : roots.find((candidate) => candidate.kind !== 'folder' && (candidate.label.split(' · ')[0] === file.solution || baseName(candidate.path) === file.solution)) ??
          roots.find((candidate) => baseName(candidate.path) === file.solution);
    if (!root) continue;
    out.set(pathKey(`${root.path.replace(/[\\/]+$/, '')}/${file.path}`), file);
  }
  return out;
}

function baseName(file: string): string {
  const parts = file.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

/** A file's state in a diff by its lines: a new file has only added lines from line 0, a deleted one only removed lines to line 0. */
export function diffFileState(file: Pick<FileDiff, 'lines'>): 'new' | 'deleted' | 'changed' {
  const hunks = file.lines.filter((line) => line.startsWith('@@'));
  if (hunks.length === 1 && /^@@ -0,0 /.test(hunks[0] as string)) return 'new';
  if (hunks.length === 1 && / \+0,0 @@/.test(hunks[0] as string)) return 'deleted';
  return 'changed';
}

/** The one signal on the right of a tree row (`null`: nothing). */
export type FileSignal = { readonly kind: 'delta'; readonly added: number; readonly removed: number } | { readonly kind: 'new' } | { readonly kind: 'deleted' } | { readonly kind: 'read' } | { readonly kind: 'mentioned' };

/**
 * A file row's one signal: from the `head` diff (`+a −d`, `new`, `deleted`); else, from the
 * touched list, a muted `read` or `mentioned`; else nothing.
 */
export function fileSignal(file: string, changed: ReadonlyMap<string, FileDiff>, touched: ReadonlyMap<string, AgentFileRef>): FileSignal | null {
  const key = pathKey(file);
  const diff = changed.get(key);
  if (diff) {
    const state = diffFileState(diff);
    return state === 'changed' ? { kind: 'delta', added: diff.added, removed: diff.removed } : { kind: state };
  }
  const ref = touched.get(key);
  if (!ref) return null;
  if (ref.sources.includes('read')) return { kind: 'read' };
  if (ref.sources.includes('mentioned')) return { kind: 'mentioned' };
  return null;
}

/** How many changed files a folder holds (anywhere below it): a folded folder says "N changed". */
export function changedUnder(dir: string, changed: ReadonlyMap<string, FileDiff>): number {
  const prefix = `${pathKey(dir).replace(/\/+$/, '')}/`;
  let count = 0;
  for (const key of changed.keys()) if (key.startsWith(prefix)) count += 1;
  return count;
}

/** The files opened in the panel for one agent, and which one shows. */
export interface ReaderHistory {
  readonly items: readonly string[];
  readonly at: number;
}

export const EMPTY_HISTORY: ReaderHistory = { items: [], at: -1 };

/** Opens `file`: what was ahead of the current one is dropped (as a browser does); the same file again is no new step. */
export function historyOpen(history: ReaderHistory, file: string): ReaderHistory {
  if (history.at >= 0 && history.items[history.at] === file) return history;
  const items = [...history.items.slice(0, history.at + 1), file];
  return { items, at: items.length - 1 };
}

export function historyBack(history: ReaderHistory): ReaderHistory {
  return history.at > 0 ? { ...history, at: history.at - 1 } : history;
}

export function historyForward(history: ReaderHistory): ReaderHistory {
  return history.at < history.items.length - 1 ? { ...history, at: history.at + 1 } : history;
}

/** One folder of the breadcrumb. */
export interface Crumb {
  readonly name: string;
  /** The folder's absolute path. */
  readonly dir: string;
}

/** The breadcrumb of `file` under the root that holds it: the root, then each folder down to the file's. `null` outside every root. */
export function breadcrumb(file: string, roots: readonly AgentFileRoot[]): { readonly root: AgentFileRoot; readonly crumbs: readonly Crumb[]; readonly name: string } | null {
  const key = pathKey(file);
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((candidate) => key.startsWith(`${pathKey(candidate.path).replace(/\/+$/, '')}/`));
  if (!root) return null;
  const sep = root.path.includes('\\') ? '\\' : '/';
  const base = root.path.replace(/[\\/]+$/, '');
  const rest = file.slice(base.length + 1).split(/[\\/]/);
  const name = rest.pop() ?? file;
  const crumbs: Crumb[] = [{ name: root.label, dir: base }];
  let dir = base;
  for (const part of rest) {
    dir = `${dir}${sep}${part}`;
    crumbs.push({ name: part, dir });
  }
  return { root, crumbs, name };
}

/** The folders to unfold so `dir` shows in the tree: every folder from its root down to it. */
export function unfoldSetFor(dir: string, roots: readonly AgentFileRoot[]): string[] {
  const trail = breadcrumb(`${dir.replace(/[\\/]+$/, '')}/x`, roots);
  return trail ? trail.crumbs.map((crumb) => crumb.dir) : [];
}

/** The reader's info line for a file the agent touched ("Edited by the agent at 10:21"), `null` for one it did not. */
export function infoText(file: Pick<AgentFileRef, 'sources' | 'exists' | 'at'> | null, time: (iso: string) => string): string | null {
  if (!file) return null;
  const what = touchedWhat(file);
  const when = file.at ? ` at ${time(file.at)}` : '';
  if (what === 'mentioned') return `Mentioned in the chat${when}`;
  const verb = { wrote: 'Written', edited: 'Edited', read: 'Read', deleted: 'Deleted' }[what];
  return `${verb} by the agent${when}`;
}

/** The new side's line numbers a diff adds (the reader's changed-line marks). */
export function addedLines(lines: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  let newNo = 0;
  for (const line of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newNo = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      out.add(newNo);
      newNo += 1;
    } else if (line.startsWith('-')) continue;
    else newNo += 1;
  }
  return out;
}
