import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILES_MAX_COUNT, WORKSPACE_FILES_MAX_TOTAL } from '../../../src/core/workspace-move.ts';
import { checkWorkspaceChunk, checkWorkspaceRoot, listWorkspaceFiles, mkdirTracked, placeWorkspaceFiles, sourceWorkspaceFile, undoPlaced, workspaceFileStates } from '../../../src/server/takeover/workspace.ts';
import { makeTempDir } from '../../helpers/net.ts';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*): the file-system side on real
 * temp folders: the source's listing (never into a repo, never through a link,
 * capped), the target's check of the workspace root to create, the file states,
 * placing staged files (never through a link, never over a different file, nothing
 * outside the root) and the undo.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('workspace-files'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('D152: the source lists the workspace’s own files', () => {
  it('lists regular files outside every repo, never through a link, with the caps', async () => {
    const ws = path.join(tmp, 'ws');
    await mkdir(path.join(ws, 'repo', '.git'), { recursive: true });
    await writeFile(path.join(ws, 'repo', 'inside.txt'), 'a repo file');
    await mkdir(path.join(ws, 'agent-wt'), { recursive: true });
    await writeFile(path.join(ws, 'agent-wt', '.git'), 'gitdir: elsewhere');
    await writeFile(path.join(ws, 'AGENTS.md'), '# Router\n');
    await mkdir(path.join(ws, 'node_modules'), { recursive: true });
    await writeFile(path.join(ws, 'node_modules', 'x.js'), 'skip');
    await writeFile(path.join(ws, 'bin.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(300 * 1024)]));
    await writeFile(path.join(ws, 'small.dat'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(tmp, 'secret-outside.txt'), 'outside');
    await symlink(path.join(tmp, 'secret-outside.txt'), path.join(ws, 'link.txt'));
    await mkdir(path.join(tmp, 'outside-dir'), { recursive: true });
    await writeFile(path.join(tmp, 'outside-dir', 'x.md'), 'outside');
    await symlink(path.join(tmp, 'outside-dir'), path.join(ws, 'linked-dir'));
    const listing = await listWorkspaceFiles(ws);
    expect(listing.root).toBe(ws);
    expect(listing.files.map((file) => file.name).sort()).toEqual(['AGENTS.md', 'bin.dat', 'small.dat']);
    expect(listing.files.find((file) => file.name === 'bin.dat')).toMatchObject({ binary: true, sha256: null });
    expect(listing.files.find((file) => file.name === 'bin.dat')?.refused).toContain('binary file over 256 KB');
    expect(listing.files.find((file) => file.name === 'small.dat')).toMatchObject({ binary: true, refused: null });
    // The source reads a listed file only as a regular file inside the root.
    await expect(sourceWorkspaceFile(ws, 'link.txt')).rejects.toThrow(/link/);
    await expect(sourceWorkspaceFile(ws, 'linked-dir/x.md')).rejects.toThrow(/link/);
    await expect(sourceWorkspaceFile(ws, '../secret-outside.txt')).rejects.toThrow();
    expect(await sourceWorkspaceFile(ws, 'AGENTS.md')).toBe(path.join(ws, 'AGENTS.md'));
  });

  it('stops at the file count', async () => {
    const ws = path.join(tmp, 'many');
    await mkdir(ws, { recursive: true });
    for (let i = 0; i < WORKSPACE_FILES_MAX_COUNT + 5; i++) await writeFile(path.join(ws, `f${String(i).padStart(4, '0')}.md`), 'x');
    const listing = await listWorkspaceFiles(ws);
    expect(listing.files).toHaveLength(WORKSPACE_FILES_MAX_COUNT);
    expect(listing.truncated).toBe(true);
  });
});

describe('D152: the workspace root the developer creates on the target', () => {
  it('accepts a new folder inside the allowed places, asks before using a non-empty one, refuses a repo, a folder inside one and anything outside', async () => {
    const places = [path.join(tmp, 'code')];
    await mkdir(path.join(tmp, 'code'), { recursive: true });
    const fresh = await checkWorkspaceRoot(path.join(tmp, 'code', 'clients', 'ws'), false, places);
    expect(fresh).toMatchObject({ path: path.join(tmp, 'code', 'clients', 'ws'), exists: false, ok: true, reason: null });
    await mkdir(path.join(tmp, 'code', 'empty'), { recursive: true });
    expect(await checkWorkspaceRoot(path.join(tmp, 'code', 'empty'), false, places)).toMatchObject({ exists: true, empty: true, ok: true });
    await mkdir(path.join(tmp, 'code', 'busy'), { recursive: true });
    await writeFile(path.join(tmp, 'code', 'busy', 'AGENTS.md'), '# Router');
    const busy = await checkWorkspaceRoot(path.join(tmp, 'code', 'busy'), false, places);
    expect(busy).toMatchObject({ exists: true, empty: false, workspace: true, needsConfirm: true, ok: false });
    expect(busy.reason).toContain('exists already and is not empty (it is a workspace)');
    expect(await checkWorkspaceRoot(path.join(tmp, 'code', 'busy'), true, places)).toMatchObject({ ok: true, needsConfirm: false });
    await mkdir(path.join(tmp, 'code', 'repo', '.git'), { recursive: true });
    expect((await checkWorkspaceRoot(path.join(tmp, 'code', 'repo'), true, places)).reason).toContain('is a git repository');
    expect((await checkWorkspaceRoot(path.join(tmp, 'code', 'repo', 'sub', 'ws'), false, places)).reason).toContain('would be inside the git repository');
    expect((await checkWorkspaceRoot(path.join(tmp, 'elsewhere', 'ws'), false, places)).reason).toContain('is outside the home folder and the saved folders');
    expect((await checkWorkspaceRoot('relative/ws', false, places)).reason).toContain('is not a full path');
    expect((await checkWorkspaceRoot(path.join(tmp, 'code', 'CON'), false, places)).reason).toContain('reserves');
    // A link out of the allowed places does not make it allowed.
    await mkdir(path.join(tmp, 'outside'), { recursive: true });
    await symlink(path.join(tmp, 'outside'), path.join(tmp, 'code', 'jump'));
    expect((await checkWorkspaceRoot(path.join(tmp, 'code', 'jump', 'ws'), false, places)).ok).toBe(false);
  });
});

describe('D152: placing the files on the target', () => {
  it('writes new files, keeps a same one, never overwrites a different one or follows a link, stays inside the root, and undoes what it made', async () => {
    const root = path.join(tmp, 'target-ws');
    const made = await mkdirTracked(root);
    expect(made).toEqual([root]);
    const stage = path.join(tmp, 'stage');
    const files: Record<string, string> = { 'AGENTS.md': '# Router\n', 'docs/plan.md': 'plan\n', 'same.md': 'same\n', 'diff.md': 'from the source\n', 'via-link/x.md': 'never\n' };
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
      await writeFile(path.join(stage, name), text);
    }
    await writeFile(path.join(root, 'same.md'), 'same\n');
    await writeFile(path.join(root, 'diff.md'), 'the developer’s own\n');
    await mkdir(path.join(tmp, 'outside'), { recursive: true });
    await symlink(path.join(tmp, 'outside'), path.join(root, 'via-link'));
    const states = await workspaceFileStates(root, Object.entries(files).map(([name, text]) => ({ name, size: text.length, sha256: sha(text), secret: null, binary: false, refused: null })));
    expect(Object.fromEntries(states.map((entry) => [entry.name, entry.state]))).toEqual({ 'AGENTS.md': 'new', 'docs/plan.md': 'new', 'same.md': 'same', 'diff.md': 'conflict', 'via-link/x.md': 'conflict' });
    const placed = await placeWorkspaceFiles(
      root,
      Object.entries(files).map(([name, text]) => ({ name, size: text.length, sha256: sha(text), secret: name === 'AGENTS.md' })),
      (name) => path.join(stage, ...name.split('/')),
    );
    expect(placed.copied.sort()).toEqual(['AGENTS.md', 'docs/plan.md']);
    expect(placed.same).toEqual(['same.md']);
    expect(placed.conflicts.sort()).toEqual(['diff.md', 'via-link/x.md']);
    expect(placed.secret).toBe(1);
    expect(await readFile(path.join(root, 'diff.md'), 'utf8')).toBe('the developer’s own\n');
    expect(await readdir(path.join(tmp, 'outside'))).toEqual([]);
    // A name that leaves the root is never written.
    const bad = await placeWorkspaceFiles(root, [{ name: '../escape.md', size: 1, sha256: 'x', secret: false }], () => path.join(stage, 'AGENTS.md'));
    expect(bad.refused).toEqual([{ name: '../escape.md', reason: 'not a name this machine writes' }]);
    await expect(lstat(path.join(tmp, 'escape.md'))).rejects.toThrow();
    // The undo removes only what it made: the developer's files keep the root.
    const notes = await undoPlaced(placed.placed, [...made, ...placed.createdDirs]);
    await expect(lstat(path.join(root, 'AGENTS.md'))).rejects.toThrow();
    await expect(lstat(path.join(root, 'docs'))).rejects.toThrow();
    expect(await readFile(path.join(root, 'diff.md'), 'utf8')).toBe('the developer’s own\n');
    expect(notes.join('\n')).toContain('was left: it holds something this move did not put there');
  });

  it('removes a root it created when nothing else is in it', async () => {
    const root = path.join(tmp, 'a', 'b', 'ws');
    const made = await mkdirTracked(root);
    expect(made).toEqual([path.join(tmp, 'a'), path.join(tmp, 'a', 'b'), root]);
    expect(await undoPlaced([], made)).toEqual([]);
    await expect(lstat(path.join(tmp, 'a'))).rejects.toThrow();
  });

  it('checks every chunk before writing: names, the per-file size, the total and the count', () => {
    const empty = { staged: new Map(), bytes: 0 };
    expect(checkWorkspaceChunk({ name: '../x', size: 1, offset: 0, bytes: 1 }, empty)?.status).toBe(422);
    expect(checkWorkspaceChunk({ name: 'x', size: WORKSPACE_FILE_MAX_BYTES + 1, offset: 0, bytes: 1 }, empty)?.status).toBe(413);
    expect(checkWorkspaceChunk({ name: 'x', size: 10, offset: 5, bytes: 10 }, empty)?.status).toBe(422);
    expect(checkWorkspaceChunk({ name: 'x', size: 1000, offset: 0, bytes: 1000 }, { staged: new Map(), bytes: WORKSPACE_FILES_MAX_TOTAL - 10 })?.message).toContain('at most 20 MB');
    const full = new Map(Array.from({ length: WORKSPACE_FILES_MAX_COUNT }, (_, i) => [`f${i}`, { name: `f${i}`, size: 1, sha256: 'x', secret: false }]));
    expect(checkWorkspaceChunk({ name: 'x', size: 1, offset: 0, bytes: 1 }, { staged: full, bytes: 0 })?.message).toContain(`at most ${WORKSPACE_FILES_MAX_COUNT}`);
    expect(checkWorkspaceChunk({ name: 'docs/ok.md', size: 10, offset: 0, bytes: 10 }, empty)).toBeNull();
  });
});
