import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type WorkspaceFileInfo,
  type WorkspaceFileTarget,
  type WorkspaceFilesListing,
  type WorkspaceRootCheck,
  WORKSPACE_BINARY_MAX_BYTES,
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_FILES_MAX_COUNT,
  WORKSPACE_FILES_MAX_TOTAL,
  WORKSPACE_SKIPPED_DIRS,
  WORKSPACE_SKIPPED_FILES,
  WORKSPACE_WALK_MAX_DEPTH,
  WORKSPACE_WALK_MAX_ENTRIES,
  folderNameProblem,
  formatBytes,
  isSafeWorkspaceFileName,
  looksSecret,
} from '../../core/workspace-move.ts';
import { isWorkingTreeTop } from '../solutions/checkout.ts';
import { topOfDir } from '../worktrees/session-repos.ts';
import { LocateRefusal, resolveAllowed } from './locate.ts';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*): the file-system side of
 * moving a workspace's own files and of creating the workspace root on the
 * target. The source lists the root's regular files outside every repo; the
 * target checks the root the developer picked, stages what arrives (bounded,
 * verified) and places it under the root without ever following a link,
 * leaving the root or overwriting a different file. Every write is undone by
 * the take-over's rollback (`placed`, `createdDirs`).
 */

/** Bytes the listing reads at most to hash and check the files (larger workspaces list the rest as over the total). */
const LISTING_READ_MAX = 32 * 1024 * 1024;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `true` when `bytes` has a NUL byte in its first 8 KB. */
function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * The workspace root's own files (source side, read-only): regular files under
 * `root`, breadth first, never inside a git working tree (a folder with a `.git`
 * entry is a repo's), never through a link, never in {@link WORKSPACE_SKIPPED_DIRS},
 * bounded by depth, entries and count. Each file ≤ 1 MB is read once: its sha256,
 * whether it is binary, whether it looks like it holds a secret.
 */
export async function listWorkspaceFiles(rootInput: string): Promise<WorkspaceFilesListing> {
  const root = await realpath(rootInput);
  const files: WorkspaceFileInfo[] = [];
  let truncated = false;
  let visited = 0;
  let read = 0;
  let level: Array<{ dir: string; prefix: string }> = [{ dir: root, prefix: '' }];
  for (let depth = 0; level.length > 0; depth++) {
    const next: Array<{ dir: string; prefix: string }> = [];
    for (const { dir, prefix } of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (visited >= WORKSPACE_WALK_MAX_ENTRIES || files.length >= WORKSPACE_FILES_MAX_COUNT) {
          truncated = true;
          break;
        }
        visited++;
        const name = `${prefix}${entry.name}`;
        const abs = path.join(dir, entry.name);
        // `isDirectory()` / `isFile()` are false for a link: links are never followed or copied.
        if (entry.isDirectory()) {
          if (WORKSPACE_SKIPPED_DIRS.has(entry.name)) continue;
          if (await isWorkingTreeTop(abs)) continue;
          if (depth + 1 >= WORKSPACE_WALK_MAX_DEPTH) {
            truncated = true;
            continue;
          }
          next.push({ dir: abs, prefix: `${name}/` });
          continue;
        }
        if (!entry.isFile() || WORKSPACE_SKIPPED_FILES.has(entry.name) || !isSafeWorkspaceFileName(name)) continue;
        const size = (await lstat(abs).catch(() => null))?.size ?? 0;
        if (size > WORKSPACE_FILE_MAX_BYTES) {
          files.push({ name, size, sha256: null, secret: looksSecret(name, null), binary: false, refused: `over ${formatBytes(WORKSPACE_FILE_MAX_BYTES)}` });
          continue;
        }
        if (read + size > LISTING_READ_MAX) {
          files.push({ name, size, sha256: null, secret: looksSecret(name, null), binary: false, refused: `over the ${formatBytes(WORKSPACE_FILES_MAX_TOTAL)} a move copies` });
          continue;
        }
        const bytes = await readFile(abs).catch(() => null);
        if (bytes === null) continue;
        read += bytes.length;
        const binary = isBinary(bytes);
        files.push({
          name,
          size: bytes.length,
          sha256: binary && bytes.length > WORKSPACE_BINARY_MAX_BYTES ? null : sha256(bytes),
          secret: looksSecret(name, binary ? null : bytes.toString('utf8')),
          binary,
          refused: binary && bytes.length > WORKSPACE_BINARY_MAX_BYTES ? `a binary file over ${formatBytes(WORKSPACE_BINARY_MAX_BYTES)}` : null,
        });
      }
    }
    level = next;
  }
  return { root, files, truncated };
}

/** The source's absolute path of a listed workspace file, checked to stay a regular file inside the root (no link on the way). */
export async function sourceWorkspaceFile(root: string, name: string): Promise<string> {
  if (!isSafeWorkspaceFileName(name)) throw new Error(`${name} is not a workspace file name`);
  const real = await realpath(root);
  let current = real;
  const segments = name.split('/');
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i] as string);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${name} goes through a link`);
    if (i < segments.length - 1 ? !info.isDirectory() : !info.isFile()) throw new Error(`${name} is not a regular file`);
  }
  return current;
}

/** The first existing folder at or above `target` and the segments below it. */
async function existingAncestor(target: string): Promise<{ readonly dir: string; readonly rest: string[] }> {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    const info = await lstat(current).catch(() => null);
    if (info !== null) return { dir: current, rest };
    const parent = path.dirname(current);
    if (parent === current) return { dir: current, rest };
    rest.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * D152: the check of the workspace root the developer asked to create on this
 * machine (read-only): a full path; its nearest existing folder inside the home
 * folder or the saved folders (and their parents), writable, not inside a git
 * repository and reached without a link; the new part's names valid here. An
 * existing folder must not be a git checkout; an empty one is used as it is, a
 * non-empty one only after the developer confirmed (`useExisting`).
 */
export async function checkWorkspaceRoot(input: string, useExisting: boolean, places: readonly string[], platform: NodeJS.Platform = process.platform): Promise<WorkspaceRootCheck> {
  const fail = (target: string, reason: string, extra: Partial<WorkspaceRootCheck> = {}): WorkspaceRootCheck => ({ path: target, exists: false, empty: false, workspace: false, needsConfirm: false, ok: false, reason, ...extra });
  const typed = input.trim();
  if (!path.isAbsolute(typed)) return fail(typed, `${typed} is not a full path on this machine`);
  const target = path.resolve(typed);
  const { dir, rest } = await existingAncestor(target);
  for (const segment of rest) {
    const problem = folderNameProblem(segment);
    if (problem !== null) return fail(target, `${segment}: ${problem}`);
  }
  let base: string;
  try {
    base = await resolveAllowed(dir, places);
  } catch (error) {
    const message = error instanceof LocateRefusal && error.status === 403 ? `${dir} is outside the home folder and the saved folders of this machine: pick a folder inside one of them (or save a folder on that drive first)` : error instanceof Error ? error.message : String(error);
    return fail(target, message);
  }
  const final = path.join(base, ...rest);
  if (platform === 'win32' && /[<>"|?*]/.test(final.slice(2))) return fail(final, `${final} has characters a folder name cannot have`);
  const repo = await topOfDir(base);
  if (repo !== null) {
    if (rest.length === 0 && repo === base) return fail(final, `${final} is a git repository: the workspace root holds repos, it is not one`, { exists: true });
    return fail(final, `${final} would be inside the git repository ${repo}: pick a folder outside it`, { exists: rest.length === 0 });
  }
  try {
    await access(base, fsConstants.W_OK);
  } catch {
    return fail(final, `${base} is not writable for Switchboard's service on this machine`, { exists: rest.length === 0 });
  }
  if (rest.length > 0) return { path: final, exists: false, empty: false, workspace: false, needsConfirm: false, ok: true, reason: null };
  const info = await stat(base);
  if (!info.isDirectory()) return fail(final, `${final} is a file`, { exists: true });
  const entries = await readdir(base);
  const workspace = entries.includes('AGENTS.md');
  if (entries.length === 0) return { path: final, exists: true, empty: true, workspace: false, needsConfirm: false, ok: true, reason: null };
  if (useExisting) return { path: final, exists: true, empty: false, workspace, needsConfirm: false, ok: true, reason: null };
  return {
    path: final,
    exists: true,
    empty: false,
    workspace,
    needsConfirm: true,
    ok: false,
    reason: `${final} exists already and is not empty${workspace ? ' (it is a workspace)' : ''}: confirm using it, or pick another folder`,
  };
}

/**
 * What is at each workspace file's path under `root` here (read-only): nothing
 * (`new`), the same content (`same`), something else (`conflict`: never
 * overwritten), or a name / a link on the way that cannot be written (`refused`).
 */
export async function workspaceFileStates(root: string | null, files: readonly WorkspaceFileInfo[]): Promise<WorkspaceFileTarget[]> {
  const out: WorkspaceFileTarget[] = [];
  const realRoot = root === null ? null : await realpath(root).catch(() => null);
  for (const file of files) {
    if (!isSafeWorkspaceFileName(file.name)) {
      out.push({ name: file.name, state: 'refused', reason: 'not a name this machine writes' });
      continue;
    }
    if (realRoot === null) {
      out.push({ name: file.name, state: 'new', reason: null });
      continue;
    }
    out.push(await stateAt(realRoot, file.name, file.sha256));
  }
  return out;
}

async function stateAt(root: string, name: string, sha: string | null): Promise<WorkspaceFileTarget> {
  const segments = name.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i] as string);
    const info = await lstat(current).catch(() => null);
    if (info === null) return { name, state: 'new', reason: null };
    if (info.isSymbolicLink()) return { name, state: 'conflict', reason: `a link is at ${segments.slice(0, i + 1).join('/')} here: skipped` };
    const last = i === segments.length - 1;
    if (!last && !info.isDirectory()) return { name, state: 'conflict', reason: `${segments.slice(0, i + 1).join('/')} is a file here: skipped` };
    if (last) {
      if (!info.isFile()) return { name, state: 'conflict', reason: 'a folder is there: skipped' };
      if (sha !== null && info.size <= WORKSPACE_FILE_MAX_BYTES) {
        const bytes = await readFile(current).catch(() => null);
        if (bytes !== null && sha256(bytes) === sha) return { name, state: 'same', reason: 'already there with the same content' };
      }
      return { name, state: 'conflict', reason: 'a different file is there: skipped, never overwritten' };
    }
  }
  return { name, state: 'new', reason: null };
}

/** A staged workspace file on the target: its checked size, checksum and the source's secret mark. */
export interface StagedWorkspaceFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly secret: boolean;
}

/**
 * The receiving side's check of one chunk of a workspace file (before a byte is
 * written): a safe name, a size within the caps, the op's running total and file
 * count within theirs. Throws a message for the 422 / 413 answer.
 */
export function checkWorkspaceChunk(input: { readonly name: unknown; readonly size: number; readonly offset: number; readonly bytes: number }, op: { readonly staged: ReadonlyMap<string, StagedWorkspaceFile>; readonly bytes: number }): { readonly status: number; readonly message: string } | null {
  if (!isSafeWorkspaceFileName(input.name)) return { status: 422, message: `${String(input.name)} is not a workspace file name this machine writes` };
  if (!Number.isInteger(input.size) || input.size < 0 || input.size > WORKSPACE_FILE_MAX_BYTES) return { status: 413, message: `${input.name} is over the ${formatBytes(WORKSPACE_FILE_MAX_BYTES)} a workspace file may have` };
  if (!Number.isInteger(input.offset) || input.offset < 0) return { status: 422, message: 'offset must be a whole number of bytes' };
  if (input.offset + input.bytes > input.size) return { status: 422, message: `${input.name}: more bytes than the announced size` };
  if (input.offset === 0 && !op.staged.has(input.name)) {
    if (op.staged.size >= WORKSPACE_FILES_MAX_COUNT) return { status: 413, message: `at most ${WORKSPACE_FILES_MAX_COUNT} workspace files are copied in one move` };
    if (op.bytes + input.size > WORKSPACE_FILES_MAX_TOTAL) return { status: 413, message: `at most ${formatBytes(WORKSPACE_FILES_MAX_TOTAL)} of workspace files are copied in one move` };
  }
  return null;
}

/** Writes a chunk of a staged file (offset 0 starts it again). */
export async function writeStagedChunk(file: string, offset: number, bytes: Buffer): Promise<number> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const have = (await stat(file).catch(() => null))?.size ?? 0;
  if (offset !== 0 && offset !== have) throw new Error(`expected offset ${have}, got ${offset}`);
  const handle: FileHandle = await open(file, offset === 0 ? 'w' : 'a', 0o600);
  try {
    await handle.write(bytes, 0, bytes.length);
  } finally {
    await handle.close();
  }
  return offset + bytes.length;
}

/** The finished staged file's checksum and whether its content looks like a secret (the receiving side's own check). */
export async function inspectStaged(file: string, name: string): Promise<{ readonly sha256: string; readonly secret: string | null; readonly binary: boolean; readonly size: number }> {
  const bytes = await readFile(file);
  const binary = isBinary(bytes);
  return { sha256: sha256(bytes), secret: looksSecret(name, binary ? null : bytes.toString('utf8')), binary, size: bytes.length };
}

/** What placing the staged files did (the undo log). */
export interface PlacedFiles {
  readonly copied: string[];
  readonly same: string[];
  readonly conflicts: string[];
  readonly refused: Array<{ readonly name: string; readonly reason: string }>;
  /** Absolute paths of files this placing created (the undo removes them). */
  readonly placed: string[];
  /** Folders this placing created, outermost first (the undo removes them if empty). */
  readonly createdDirs: string[];
  readonly secret: number;
}

/**
 * Creates the missing folders of `target` (outermost first), never through a
 * link; returns the ones it made (the undo removes them, innermost first, if empty).
 */
export async function mkdirTracked(target: string): Promise<string[]> {
  const { dir, rest } = await existingAncestor(path.resolve(target));
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
  const made: string[] = [];
  let current = dir;
  for (const segment of rest) {
    current = path.join(current, segment);
    await mkdir(current);
    made.push(current);
  }
  return made;
}

/**
 * Places the staged files under `root` (target side). Every folder on the way is
 * a real folder (a link or a file is a conflict, never followed), a missing one is
 * created; a file is written with `COPYFILE_EXCL` (never over anything); one that is
 * there already is `same` (equal content) or a `conflict` (skipped). Paths are built
 * from checked names only, so nothing leaves the root.
 */
export async function placeWorkspaceFiles(rootInput: string, staged: readonly StagedWorkspaceFile[], stagedPath: (name: string) => string): Promise<PlacedFiles> {
  const root = await realpath(rootInput);
  const result: { -readonly [K in keyof PlacedFiles]: PlacedFiles[K] } = { copied: [], same: [], conflicts: [], refused: [], placed: [], createdDirs: [], secret: 0 };
  for (const file of staged) {
    if (!isSafeWorkspaceFileName(file.name)) {
      result.refused.push({ name: file.name, reason: 'not a name this machine writes' });
      continue;
    }
    const segments = file.name.split('/');
    let current = root;
    let blocked: string | null = null;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (info === null) {
        await mkdir(current);
        result.createdDirs.push(current);
      } else if (info.isSymbolicLink() || !info.isDirectory()) {
        blocked = `${path.relative(root, current).split(path.sep).join('/')} is ${info.isSymbolicLink() ? 'a link' : 'a file'} here`;
        break;
      }
    }
    if (blocked !== null) {
      result.conflicts.push(file.name);
      continue;
    }
    const dest = path.join(current, segments[segments.length - 1] as string);
    const there = await lstat(dest).catch(() => null);
    if (there !== null) {
      if (there.isFile() && !there.isSymbolicLink()) {
        const bytes = await readFile(dest).catch(() => null);
        if (bytes !== null && sha256(bytes) === file.sha256) {
          result.same.push(file.name);
          continue;
        }
      }
      result.conflicts.push(file.name);
      continue;
    }
    try {
      await copyFile(stagedPath(file.name), dest, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        result.conflicts.push(file.name);
        continue;
      }
      throw error;
    }
    if (file.secret) await chmod(dest, 0o600).catch(() => undefined);
    result.placed.push(dest);
    result.copied.push(file.name);
    if (file.secret) result.secret++;
  }
  return result;
}

/** The undo of {@link placeWorkspaceFiles} / {@link mkdirTracked}: the files it wrote, then the folders it made if they are empty (never a folder with anything else in it). */
export async function undoPlaced(files: readonly string[], dirs: readonly string[]): Promise<string[]> {
  const notes: string[] = [];
  for (const file of [...files].reverse()) {
    await rm(file, { force: true }).catch((error: unknown) => notes.push(`could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`));
  }
  for (const dir of [...dirs].reverse()) {
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      notes.push(code === 'ENOTEMPTY' || code === 'EEXIST' ? `${dir} was left: it holds something this move did not put there` : `could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}
