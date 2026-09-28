import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type DirtyProject, parseDirtyFile } from '../../core/codebase-memory.ts';

/** The dirty list of the workspace's codebase-memory freshness hooks, under the workspace root. */
export const CODEBASE_MEMORY_DIRTY_FILE = path.join('.claude', '.codebase-memory-dirty');

/** The dirty list as read from disk (M6.4, `docs/solutions.md` → *Codebase-memory freshness*). */
export interface DirtyListRead {
  /**
   * `ok`: read; `missing`: no file (nothing was edited since the last index);
   * `unreadable`: it exists but cannot be read (freshness unknown).
   */
  readonly state: 'ok' | 'missing' | 'unreadable';
  /** The lines in file order; `[]` when missing, `null` when unreadable. */
  readonly projects: readonly DirtyProject[] | null;
  /** The forms of the workspace root the hook may have written ids for: as configured (resolved) and as its real path. */
  readonly roots: readonly string[];
  /** Why it could not be read (`unreadable` only). */
  readonly error?: unknown;
}

/**
 * The forms of a workspace root the dirty-tracker hook may have seen: the root as
 * configured (resolved, the hook resolves `CLAUDE_PROJECT_DIR` the same way) and
 * its real path when that differs (a symlinked root, `/var` → `/private/var` on
 * macOS).
 */
export async function workspaceRootForms(root: string): Promise<string[]> {
  const resolved = path.resolve(root);
  const real = await realpath(resolved).catch(() => resolved);
  return [...new Set([resolved, real])];
}

/**
 * Reads `<root>/.claude/.codebase-memory-dirty` (async, read-only; the file
 * belongs to the workspace's hooks and to the agents that re-index) and parses it
 * against the root's forms. A missing file (or a missing `.claude/`) is an empty
 * list; any other failure (a folder in its place, no permission) is `unreadable`.
 */
export async function readDirtyList(root: string): Promise<DirtyListRead> {
  const roots = await workspaceRootForms(root);
  try {
    const text = await readFile(path.join(root, CODEBASE_MEMORY_DIRTY_FILE), 'utf8');
    return { state: 'ok', projects: parseDirtyFile(text, roots), roots };
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing', projects: [], roots };
    return { state: 'unreadable', projects: null, roots, error };
  }
}
