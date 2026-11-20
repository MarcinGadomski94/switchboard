/**
 * SPIKE · the side panel's Changes as a tree: only the files the chosen view changed,
 * folded into their folders as the Files tab's tree is, each with what changed in it.
 * Pure.
 */

/** One changed file, as the tree needs it. */
export interface TreeFile {
  /** The file's key in the diff (`fileKey`). */
  readonly key: string;
  /** The code project it is in: the tree's first level when the agent changed more than one. */
  readonly repo: string;
  /** Its path inside the project, `/` between the folders. */
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly state: 'new' | 'deleted' | 'changed';
}

/** One row of the tree, top to bottom. */
export type TreeRow =
  | {
      readonly kind: 'folder';
      /** Names the row: the project and the path of its (innermost) folder. */
      readonly id: string;
      /**
       * Every folder of the row, outermost first (a chain has several), each by its
       * project and path. Folding the row folds them all, and the row shows folded
       * while any of them is: so it stays as it was left when the chain gets shorter
       * or longer as files come and go.
       */
      readonly ids: readonly string[];
      /** Its name; a chain of folders that hold nothing else is one row (`src / app / pages`). */
      readonly label: string;
      readonly depth: number;
      readonly open: boolean;
      /** What it holds, folded or not: files and lines. */
      readonly files: number;
      readonly added: number;
      readonly removed: number;
    }
  | { readonly kind: 'file'; readonly key: string; readonly name: string; readonly depth: number; readonly file: TreeFile };

interface Folder {
  readonly name: string;
  /** Its path inside the project. */
  readonly path: string;
  readonly folders: Map<string, Folder>;
  readonly files: Array<{ readonly name: string; readonly file: TreeFile }>;
}

function folder(name: string, path: string): Folder {
  return { name, path, folders: new Map(), files: [] };
}

/** By name, upper and lower case together (as the Files tab lists a folder). */
function byName(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function totals(node: Folder): { files: number; added: number; removed: number } {
  let files = node.files.length;
  let added = 0;
  let removed = 0;
  for (const { file } of node.files) {
    added += file.added;
    removed += file.removed;
  }
  for (const child of node.folders.values()) {
    const inner = totals(child);
    files += inner.files;
    added += inner.added;
    removed += inner.removed;
  }
  return { files, added, removed };
}

/**
 * The changed files as rows. `filter`: only files whose path holds every word (then
 * every folder shows unfolded); `closed`: the folders folded by hand (a row's `ids`).
 * Folders come before files, both by name. With files of more than one code project
 * each project is the first level (also while a filter leaves only one of them).
 */
export function changedTree(files: readonly TreeFile[], options: { readonly filter?: string; readonly closed?: ReadonlySet<string> } = {}): TreeRow[] {
  const words = (options.filter ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const closed = options.closed ?? new Set<string>();
  const several = new Set(files.map((file) => file.repo)).size > 1;
  const repos = new Map<string, Folder>();
  for (const file of files) {
    const where = (several ? `${file.repo}/${file.path}` : file.path).toLowerCase();
    if (!words.every((word) => where.includes(word))) continue;
    let node: Folder = repos.get(file.repo) ?? folder(file.repo, '');
    repos.set(file.repo, node);
    const parts = file.path.split(/[\\/]/).filter(Boolean);
    const name = parts.pop() ?? file.path;
    for (const part of parts) {
      const next: Folder = node.folders.get(part) ?? folder(part, node.path === '' ? part : `${node.path}/${part}`);
      node.folders.set(part, next);
      node = next;
    }
    node.files.push({ name, file });
  }
  const rows: TreeRow[] = [];
  const isOpen = (ids: readonly string[]): boolean => words.length > 0 || !ids.some((id) => closed.has(id));
  const inside = (repo: string, node: Folder, depth: number): void => {
    for (const child of [...node.folders.values()].sort((a, b) => byName(a.name, b.name))) {
      // A chain of folders that hold one folder and nothing else is one row.
      const chain = [child];
      let last = child;
      while (last.files.length === 0 && last.folders.size === 1) {
        const [only] = last.folders.values();
        if (!only) break;
        chain.push(only);
        last = only;
      }
      const ids = chain.map((part) => `${repo}\u0000${part.path}`);
      const open = isOpen(ids);
      rows.push({ kind: 'folder', id: `${repo}\u0000${last.path}`, ids, label: chain.map((part) => part.name).join(' / '), depth, open, ...totals(last) });
      if (open) inside(repo, last, depth + 1);
    }
    for (const entry of [...node.files].sort((a, b) => byName(a.name, b.name))) rows.push({ kind: 'file', key: entry.file.key, name: entry.name, depth, file: entry.file });
  };
  for (const [repo, node] of [...repos].sort((a, b) => byName(a[0], b[0]))) {
    if (!several) {
      inside(repo, node, 0);
      continue;
    }
    const id = `${repo}\u0000`;
    const open = isOpen([id]);
    rows.push({ kind: 'folder', id, ids: [id], label: repo, depth: 0, open, ...totals(node) });
    if (open) inside(repo, node, 1);
  }
  return rows;
}

/** The first file the tree shows (what the panel opens with), `null` when it shows none. */
export function firstFileKey(rows: readonly TreeRow[]): string | null {
  for (const row of rows) if (row.kind === 'file') return row.key;
  return null;
}

/**
 * Whether a diff adds the whole file, removes it, or changes it: read from its first
 * hunk's header (`@@ -0,0 +1,n @@` is a new file, `@@ -1,n +0,0 @@` a deleted one).
 */
export function fileState(lines: readonly string[]): TreeFile['state'] {
  const header = lines.find((line) => line.startsWith('@@'));
  const match = header ? /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header) : null;
  if (!match) return 'changed';
  if (match[1] === '0' && match[2] === '0') return 'new';
  if (match[3] === '0' && match[4] === '0') return 'deleted';
  return 'changed';
}
