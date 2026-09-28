import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codebaseMemoryProjectId, solutionFreshness } from '../../../src/core/codebase-memory.ts';
import { CODEBASE_MEMORY_DIRTY_FILE, readDirtyList, workspaceRootForms } from '../../../src/server/solutions/codebase-memory.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * M6.4: the async reader of `<root>/.claude/.codebase-memory-dirty` on temp
 * workspaces (never the real one): missing / unreadable files, the fixture files
 * copied in, and a workspace configured through a symlink whose hook wrote ids
 * with the real path.
 */
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'codebase-memory');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A temp workspace folder with a space in its name (as configured, not resolved). */
async function tempWorkspace(): Promise<string> {
  const root = await makeTempDir('cm-dirty');
  cleanups.push(() => removeTempDir(root));
  const workspace = path.join(root, 'work space');
  await mkdir(workspace);
  return workspace;
}

async function writeDirty(workspace: string, text: string): Promise<void> {
  await mkdir(path.join(workspace, '.claude'), { recursive: true });
  await writeFile(path.join(workspace, CODEBASE_MEMORY_DIRTY_FILE), text);
}

describe('readDirtyList', () => {
  it('no `.claude/` or no file: missing, nothing listed, every row fresh', async () => {
    const ws = await tempWorkspace();
    const read = await readDirtyList(ws);
    expect(read).toMatchObject({ state: 'missing', projects: [] });
    expect(solutionFreshness(read.projects, read.roots, 'mobile')).toBe('fresh');
    await mkdir(path.join(ws, '.claude'));
    expect((await readDirtyList(ws)).state).toBe('missing');
  });

  it('a folder in its place: unreadable with the error, rows unknown', async () => {
    const ws = await tempWorkspace();
    await mkdir(path.join(ws, CODEBASE_MEMORY_DIRTY_FILE), { recursive: true });
    const read = await readDirtyList(ws);
    expect(read.state).toBe('unreadable');
    expect(read.projects).toBeNull();
    expect((read.error as NodeJS.ErrnoException).code).toBe('EISDIR');
    expect(solutionFreshness(read.projects, read.roots, 'mobile')).toBe('unknown');
  });

  it('the fixture files read byte for byte (BOM, CRLF, lone CR); another root’s ids name nothing here', async () => {
    const ws = await tempWorkspace();
    await mkdir(path.join(ws, '.claude'));
    await copyFile(path.join(FIXTURES, 'messy.txt'), path.join(ws, CODEBASE_MEMORY_DIRTY_FILE));
    const read = await readDirtyList(ws);
    expect(read.state).toBe('ok');
    expect(read.projects?.map((project) => project.id)).toEqual([
      'Users-dev-Acme Corp-workspace-microfrontends-acme-app-front',
      'Users-dev-Acme Corp-workspace-nugets-auth-nuget-v2',
      'Users-dev-Other Place-workspace-nugets-auth-nuget',
      'Users-dev-Acme Corp-workspace-deprecated-microfrontends-old-front',
      'Users-dev-Acme Corp-workspace-tools-scripts',
      'Users-dev-Acme Corp-workspace',
      'Users-dev-Acme Corp-workspace-other-switchboard',
      'Users-dev-Acme Corp-workspace-mobile',
    ]);
    expect(read.projects?.every((project) => project.relativePath === null)).toBe(true);
    await copyFile(path.join(FIXTURES, 'empty.txt'), path.join(ws, CODEBASE_MEMORY_DIRTY_FILE));
    expect(await readDirtyList(ws)).toMatchObject({ state: 'ok', projects: [] });
  });

  it('ids of this workspace, written with the configured path or the real one, name its folders', async () => {
    const ws = await tempWorkspace();
    const real = await realpath(ws);
    await writeDirty(
      ws,
      [codebaseMemoryProjectId(ws, 'microfrontends/web-front'), codebaseMemoryProjectId(real, 'mobile/src'), ''].join('\n'),
    );
    const read = await readDirtyList(ws);
    expect(read.roots).toEqual([...new Set([path.resolve(ws), real])]);
    expect(read.projects?.map((project) => project.relativePath)).toEqual(['microfrontends/web-front', 'mobile/src']);
    expect(solutionFreshness(read.projects, read.roots, 'microfrontends/web-front')).toBe('dirty');
    expect(solutionFreshness(read.projects, read.roots, 'mobile')).toBe('dirty');
    expect(solutionFreshness(read.projects, read.roots, 'nugets/auth-nuget')).toBe('fresh');
  });

  it('a workspace configured through a symlink: the hook’s real-path ids still count', async () => {
    const ws = await tempWorkspace();
    const real = await realpath(ws);
    const link = path.join(path.dirname(ws), 'linked workspace');
    await symlink(ws, link, 'dir');
    await writeDirty(ws, `${codebaseMemoryProjectId(real, 'nugets/auth-nuget')}\n`);
    expect(await workspaceRootForms(link)).toEqual([link, real]);
    const read = await readDirtyList(link);
    expect(read.projects).toEqual([{ id: codebaseMemoryProjectId(real, 'nugets/auth-nuget'), relativePath: 'nugets/auth-nuget' }]);
    expect(solutionFreshness(read.projects, read.roots, 'nugets/auth-nuget')).toBe('dirty');
    // A relative root resolves the way the hook resolves CLAUDE_PROJECT_DIR.
    expect((await workspaceRootForms(path.relative(process.cwd(), link)))[0]).toBe(link);
  });
});
