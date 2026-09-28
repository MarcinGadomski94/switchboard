import path from 'node:path';
import type { FolderKind } from '../../core/model.ts';
import type { FolderRecord } from '../db/repos/folders.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';

/**
 * A folder something works in (D14, `docs/folders.md`): a saved folder, or the
 * folder a session remembers after it left the saved list. Every service that
 * used the one workspace root before D14 takes one of these instead: the
 * supervisor (cwd), the worktree manager (which repo a solution name means), the
 * scanner and live solutions, the first-turn payload, loops, History and
 * Codebase Memory.
 */
export interface FolderRef {
  /** The saved folder's id; `null` when it is not (or no longer) in the saved list. */
  readonly id: string | null;
  /** The path as the developer gave it (what views show). */
  readonly path: string;
  /** The folder resolved on disk (realpath): what sessions run in and paths are compared against. */
  readonly root: string;
  readonly kind: FolderKind;
}

/** A stored folder as a {@link FolderRef} (no file-system access: `root` is the stored canonical path). */
export function folderRefOf(record: FolderRecord): FolderRef {
  return { id: record.id, path: record.path, root: record.canonicalPath, kind: record.kind };
}

/**
 * The folder a session belongs to (D14): its stored `root` + `root_kind` (and the
 * saved folder id, if the folder is still saved). `null` for a session that
 * never started (no root). A session stored before D14 ran at the one workspace
 * root, its `cwd` (the migration copies it; this is only a fallback).
 */
export function folderOfSession(session: Pick<SessionRecord, 'folderId' | 'root' | 'rootKind' | 'cwd'>): FolderRef | null {
  if (session.root && session.rootKind) return { id: session.folderId, path: session.root, root: session.root, kind: session.rootKind };
  if (session.cwd) return { id: session.folderId, path: session.cwd, root: session.cwd, kind: 'workspace' };
  return null;
}

/** A repo folder's one solution: the repo's name, its folder name (D14). */
export function repoSolutionName(folder: Pick<FolderRef, 'root'>): string {
  return path.basename(folder.root);
}
