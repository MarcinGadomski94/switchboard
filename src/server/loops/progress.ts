import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type LoopProgress, parseLoopProgress } from '../../core/loop-progress.ts';
import { solutionCandidates } from '../../core/worktrees.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { folderOfSession } from '../folders/ref.ts';

/** The progress file of a loop's state (LOOP.md), relative to a working folder. */
export const PROGRESS_FILE = path.join('.loop', 'progress.md');

/** Files larger than this are not read (a progress file is a few KB). */
const MAX_PROGRESS_BYTES = 1024 * 1024;

/** A progress file found for a session. */
export interface FoundProgress {
  /** Absolute path. */
  readonly file: string;
  /** As shown on the card: relative to the session's folder (`/`-separated) when inside it, else absolute. */
  readonly shown: string;
  readonly progress: LoopProgress;
}

/**
 * The session's working folders (D9; D14: in the session's own folder): its
 * live worktrees, then for a workspace folder the folders of its solutions
 * (router layout, `solutionCandidates`) and the workspace root, for a repo
 * folder the repo; then its process cwd. Only folders inside the session's
 * folder or its own worktrees are listed; nothing is created.
 */
export async function sessionWorkingFolders(store: Store, session: SessionRecord): Promise<string[]> {
  const folders: string[] = [];
  for (const worktree of await store.worktrees.list({ sessionId: session.id })) folders.push(worktree.path);
  const folder = folderOfSession(session);
  if (folder) {
    if (folder.kind === 'workspace') for (const solution of session.solutions) folders.push(...(solutionCandidates(folder.root, solution) ?? []));
    folders.push(folder.root);
  }
  if (session.cwd) folders.push(session.cwd);
  return [...new Set(folders.map((dir) => path.resolve(dir)))];
}

/**
 * The newest `.loop/progress.md` among `folders` (by modification time), parsed
 * (`src/core/loop-progress.ts`); `null` when none exists or none can be read.
 * Its shown path is relative to `shownFrom` (the session's folder) when inside it.
 * Read-only and asynchronous.
 */
export async function findLoopProgress(folders: readonly string[], shownFrom: string | null): Promise<FoundProgress | null> {
  let best: { file: string; mtime: number } | null = null;
  for (const folder of folders) {
    const file = path.join(folder, PROGRESS_FILE);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_PROGRESS_BYTES) continue;
      if (!best || info.mtimeMs > best.mtime) best = { file, mtime: info.mtimeMs };
    } catch {
      // absent or unreadable: not a progress file
    }
  }
  if (!best) return null;
  let text: string;
  try {
    text = await readFile(best.file, 'utf8');
  } catch {
    return null;
  }
  return { file: best.file, shown: shownPath(best.file, shownFrom), progress: parseLoopProgress(text) };
}

/** `file` relative to `base` (`/`-separated) when inside it, else absolute. */
function shownPath(file: string, base: string | null): string {
  if (base) {
    const relative = path.relative(path.resolve(base), file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return file;
}
