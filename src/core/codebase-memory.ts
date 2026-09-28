/**
 * codebase-memory freshness (M6.4, `docs/solutions.md` → *Codebase-memory
 * freshness*): the workspace's `.claude/.codebase-memory-dirty` parsed into
 * per-project entries, the freshness of each Solutions row, and the list the
 * Codebase Memory tool's strip shows ("Reindex n now").
 *
 * The file is written by the workspace's dirty-tracker hook
 * (`.claude/hooks/cm-mark-dirty.js`, a PostToolUse hook on Edit / Write /
 * MultiEdit / NotebookEdit): for a file edited at `<root>/<category>/<first
 * folder>/…` with a category from {@link HOOK_CATEGORIES}, it adds the project id
 * of `<root>/<category>/<first folder>` (see {@link codebaseMemoryProjectId}), one
 * id per line, sorted, no times. Agents remove a line after re-indexing that
 * project. No file system here: `src/server/solutions/codebase-memory.ts` reads
 * the file.
 */
import type { CodebaseMemoryFreshness } from './api.ts';

/** The top-level folders the hook records edits in (`<category>/<repo>/…`), as the hook lists them. */
export const HOOK_CATEGORIES: readonly string[] = ['microfrontends', 'microservices', 'functions', 'nugets', 'mobile', 'other', 'infrastructure'];

/** One line of the dirty list. */
export interface DirtyProject {
  /** The line, trimmed: a codebase-memory project id. */
  readonly id: string;
  /**
   * The folder the id names, relative to the workspace root and `/`-separated
   * (`microfrontends/acme-app-front`, `mobile/Acme.Mobile`), when the id
   * is the hook's form under one of the root's forms; `null` for any other id
   * (another root, an unknown category, the root or a category alone).
   */
  readonly relativePath: string | null;
}

/** A solution row as the freshness rules see it. */
export interface FreshnessRow {
  readonly name: string;
  /** Path from the workspace root, `/`-separated (`Solution.relativePath`). */
  readonly relativePath: string;
}

/**
 * One chip of the Codebase Memory strip: a solution with dirty lines, or a line
 * that matches no solution.
 */
export interface DirtyTarget {
  /** The solution's name; without a solution the repo folder the hook named, else the id. */
  readonly name: string;
  /** The solution's relative path; without a solution the hook's folder, else `null`. */
  readonly relativePath: string | null;
  /** `true` when a scanned solution matched. */
  readonly solution: boolean;
  /** The dirty-list lines behind it, in file order (the lines a reindex removes). */
  readonly ids: readonly string[];
}

/** `\` → `/`, leading and trailing slashes removed. */
function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * The codebase-memory project id of a folder, as the hook computes it: the
 * absolute path with `\` turned into `/` and trailing slashes dropped, then every
 * run of `:`, `/` and `\` turned into one `-`, and leading / trailing `-` removed
 * (`D:\…\nugets\auth-nuget` → `D-…-nugets-auth-nuget`,
 * `/Users/me/ws/mobile` → `Users-me-ws-mobile`). Spaces and case are kept.
 */
export function codebaseMemoryProjectId(root: string, relativePath = ''): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = normalizeRelative(relativePath);
  const absolute = relative === '' ? base : `${base}/${relative}`;
  return absolute.replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The project ids in a dirty-list file, in file order: a byte-order mark
 * removed, `\n` / `\r\n` / `\r` line ends, each line trimmed, blank lines and
 * repeated ids (compared case-insensitively, the first spelling kept) dropped.
 */
export function dirtyLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

/** The distinct, lower-cased project ids of the root's forms, longest first. */
function rootIds(roots: readonly string[]): string[] {
  const ids = new Set(roots.map((root) => codebaseMemoryProjectId(root).toLowerCase()).filter((id) => id !== ''));
  return [...ids].sort((a, b) => b.length - a.length);
}

/**
 * Names one dirty-list line. `roots` are the forms of the workspace root the hook
 * may have seen (as configured, as its real path). An id that is a root's id
 * followed by `-<category>-<folder>` (a category from {@link HOOK_CATEGORIES},
 * compared case-insensitively; the hook's form) names `<category>/<folder>`; the
 * folder keeps the line's spelling. Categories hold no `-`, so the first `-`
 * after the root ends the category and the rest is the folder (which may contain
 * `-`). Anything else has no relative path (it can still be a solution's own
 * project id, {@link concernsSolution}).
 */
export function dirtyProject(id: string, roots: readonly string[]): DirtyProject {
  const lower = id.toLowerCase();
  for (const rootId of rootIds(roots)) {
    if (!lower.startsWith(`${rootId}-`)) continue;
    const rest = id.slice(rootId.length + 1);
    const dash = rest.indexOf('-');
    if (dash <= 0) continue;
    const category = rest.slice(0, dash).toLowerCase();
    const folder = rest.slice(dash + 1);
    if (!HOOK_CATEGORIES.includes(category) || folder === '') continue;
    return { id, relativePath: `${category}/${folder}` };
  }
  return { id, relativePath: null };
}

/** A dirty-list file's text → its projects in file order ({@link dirtyLines}, {@link dirtyProject}). */
export function parseDirtyFile(text: string, roots: readonly string[]): DirtyProject[] {
  return dirtyLines(text).map((id) => dirtyProject(id, roots));
}

/** `true` when one path is the other or contains it, on `/` boundaries, case-insensitively. */
function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * Whether a dirty-list line concerns the solution at `relativePath`:
 * - the line is the solution's own project id under one of the root's forms
 *   (case-insensitive), or
 * - the folder the line names is the solution's folder, lies inside it (a whole
 *   top-level solution such as `mobile/`: the hook records `mobile/<first
 *   folder>`), or contains it (a solution nested deeper than the hook's
 *   `<category>/<folder>` granularity: the edit may have been in it).
 */
export function concernsSolution(project: DirtyProject, roots: readonly string[], relativePath: string): boolean {
  const relative = normalizeRelative(relativePath);
  if (relative === '') return false;
  const id = project.id.toLowerCase();
  if (roots.some((root) => codebaseMemoryProjectId(root, relative).toLowerCase() === id)) return true;
  return project.relativePath !== null && overlaps(project.relativePath, relative);
}

/**
 * A solution's codebase-memory freshness: `unknown` when the dirty list could
 * not be read (`null`), `dirty` when a line concerns it ({@link concernsSolution}),
 * else `fresh` (a missing file is an empty list: nothing edited since the last
 * index).
 */
export function solutionFreshness(
  projects: readonly DirtyProject[] | null,
  roots: readonly string[],
  relativePath: string,
): CodebaseMemoryFreshness {
  if (projects === null) return 'unknown';
  return projects.some((project) => concernsSolution(project, roots, relativePath)) ? 'dirty' : 'fresh';
}

/** The last `/` segment of a path. */
function baseName(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] as string;
}

/**
 * The Codebase Memory strip's list: one entry per solution that dirty lines
 * concern (named like its Solutions row, so `mobile` appears once however many
 * `mobile/<folder>` lines the hook wrote), then one per line no solution matches
 * (named after the hook's folder, else the id; lines naming the same folder share
 * one entry). A line that concerns several solutions counts for each. Entries
 * keep the order of their first line; "Reindex n now" is their count.
 */
export function dirtyTargets(projects: readonly DirtyProject[], roots: readonly string[], solutions: readonly FreshnessRow[]): DirtyTarget[] {
  const targets = new Map<string, { name: string; relativePath: string | null; solution: boolean; ids: string[] }>();
  const add = (key: string, name: string, relativePath: string | null, solution: boolean, id: string): void => {
    const target = targets.get(key) ?? { name, relativePath, solution, ids: [] };
    if (!target.ids.includes(id)) target.ids.push(id);
    targets.set(key, target);
  };
  for (const project of projects) {
    const rows = solutions.filter((row) => concernsSolution(project, roots, row.relativePath));
    if (rows.length > 0) {
      for (const row of rows) {
        const relative = normalizeRelative(row.relativePath);
        add(`solution:${relative.toLowerCase()}`, row.name, relative, true, project.id);
      }
    } else if (project.relativePath !== null) {
      add(`folder:${project.relativePath.toLowerCase()}`, baseName(project.relativePath), project.relativePath, false, project.id);
    } else {
      add(`id:${project.id.toLowerCase()}`, project.id, null, false, project.id);
    }
  }
  return [...targets.values()];
}
