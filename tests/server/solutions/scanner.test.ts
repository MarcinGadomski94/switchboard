import { copyFile, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SolutionGroup } from '../../../src/core/api.ts';
import { ScanError, WorkspaceScanner } from '../../../src/server/solutions/scanner.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * M6.1 oracle: the WorkspaceScanner on fixture workspaces built in temp folders
 * (never the real workspace). The router AGENTS.md is the folder-rule part of the
 * real one (tests/fixtures/workspace/router-AGENTS.md).
 */
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempWorkspace(): Promise<string> {
  const root = await realpath(await makeTempDir('scanner'));
  cleanups.push(() => removeTempDir(root));
  const workspace = path.join(root, 'work space');
  await mkdir(workspace);
  return workspace;
}

/** A main checkout: a folder with a `.git` directory. */
async function repo(workspace: string, relative: string): Promise<void> {
  await mkdir(path.join(workspace, relative, '.git'), { recursive: true });
  await writeFile(path.join(workspace, relative, 'README.md'), 'repo\n');
}

/** A git worktree (or submodule): a folder whose `.git` is a file. */
async function worktree(workspace: string, relative: string): Promise<void> {
  await mkdir(path.join(workspace, relative), { recursive: true });
  await writeFile(path.join(workspace, relative, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
}

/** The fixture workspace of the oracle: every router folder kind, worktrees, strays. */
async function fixtureWorkspace(): Promise<string> {
  const ws = await tempWorkspace();
  await copyFile(ROUTER_FIXTURE, path.join(ws, 'AGENTS.md'));
  await repo(ws, 'microfrontends/acme-app-front');
  await repo(ws, 'microfrontends/auth-front');
  await worktree(ws, 'microfrontends/acme-app-front-wt-free-talk'); // gap #16
  await mkdir(path.join(ws, 'microfrontends', 'not-cloned-front', 'src'), { recursive: true }); // no .git: still a solution slot
  await mkdir(path.join(ws, 'microfrontends', '.idea'), { recursive: true });
  await writeFile(path.join(ws, 'microfrontends', 'notes.md'), 'a file\n');
  await repo(ws, 'mobile');
  await mkdir(path.join(ws, 'mobile', 'Acme.Mobile'), { recursive: true });
  await repo(ws, 'nugets/components-library-nuget');
  await worktree(ws, 'nugets/components-library-nuget-wt-variants');
  await repo(ws, 'microservices/notifications-microservice');
  // functions/ does not exist in this workspace
  await repo(ws, 'other/it-dashboard');
  await repo(ws, 'other/switchboard');
  await worktree(ws, 'other/switchboard/.worktrees/w1-solutions'); // inside a repo: never scanned
  await repo(ws, 'deprecated/microfrontends/old-chat-front');
  await worktree(ws, 'deprecated/microfrontends/old-chat-front-wt-x');
  await repo(ws, 'deprecated/mobile'); // a repo at the type-group level (the router lists `deprecated/mobile/`)
  await mkdir(path.join(ws, 'deprecated', 'mobile', 'src'), { recursive: true });
  await mkdir(path.join(ws, 'deprecated', 'nugets'), { recursive: true }); // an empty type group
  await writeFile(path.join(ws, 'deprecated', 'README.md'), 'archive\n');
  await repo(ws, 'infrastructure');
  await mkdir(path.join(ws, 'infrastructure', 'modules', 'network'), { recursive: true });
  await repo(ws, 'docs-site'); // a root folder the router does not name
  await mkdir(path.join(ws, '.claude', 'agents'), { recursive: true });
  await writeFile(path.join(ws, '.mcp.json'), '{}\n');
  return ws;
}

function summary(groups: SolutionGroup[]): Array<[string, string, string, Array<[string, string, string, string]>]> {
  return groups.map((g) => [g.folder, g.note, g.rule, g.solutions.map((s) => [s.name, s.path, s.type, s.rule] as [string, string, string, string])]);
}

describe('WorkspaceScanner · fixture workspace with the real router rules', () => {
  it('groups every solution by folder with its rule; skips worktrees (gap #16), files, hidden and unnamed folders', async () => {
    const ws = await fixtureWorkspace();
    const p = (...parts: string[]): string => path.join(ws, ...parts);
    const groups = await new WorkspaceScanner({ root: ws }).solutions();
    expect(summary(groups)).toEqual([
      [
        'microfrontends/',
        '',
        'editable',
        [
          ['auth-front', p('microfrontends', 'auth-front'), 'Web', 'editable'],
          ['not-cloned-front', p('microfrontends', 'not-cloned-front'), 'Web', 'editable'],
          ['acme-app-front', p('microfrontends', 'acme-app-front'), 'Web', 'editable'],
        ],
      ],
      ['mobile/', '', 'editable', [['mobile', p('mobile'), 'Mobile', 'editable']]],
      ['nugets/', '', 'editable', [['components-library-nuget', p('nugets', 'components-library-nuget'), 'NuGet', 'editable']]],
      ['microservices/', '', 'editable', [['notifications-microservice', p('microservices', 'notifications-microservice'), 'Backend', 'editable']]],
      [
        'other/',
        'on request only',
        'on-request',
        [
          ['it-dashboard', p('other', 'it-dashboard'), 'Other', 'on-request'],
          ['switchboard', p('other', 'switchboard'), 'Other', 'on-request'],
        ],
      ],
      [
        'read-only',
        'deprecated/ · infrastructure/ · never edited',
        'read-only',
        [
          ['infrastructure', p('infrastructure'), 'Read-only', 'read-only'],
          ['mobile', p('deprecated', 'mobile'), 'Read-only', 'read-only'],
          ['old-chat-front', p('deprecated', 'microfrontends', 'old-chat-front'), 'Read-only', 'read-only'],
        ],
      ],
    ]);
    // Nothing is invented: the live fields stay neutral until M6.2 fills them.
    for (const solution of groups.flatMap((g) => g.solutions)) {
      expect(solution).toMatchObject({ status: 'idle', phase: '—', flag: '', conflict: false, branches: [] });
      expect(solution.changes).toBe(solution.rule === 'read-only' ? 'locked' : '—');
    }
  });

  it('the full scan reports the router file, every folder (present or not) and which solutions are git checkouts', async () => {
    const ws = await fixtureWorkspace();
    const scan = await new WorkspaceScanner({ root: ws }).scan();
    expect(scan.root).toBe(ws);
    expect(scan.router).toEqual({ path: path.join(ws, 'AGENTS.md'), found: true, lines: 66 });
    expect(scan.folders.map((f) => [f.folder, f.rule, f.depth, f.exists, f.inRouter, f.solutions.length])).toEqual([
      ['microfrontends', 'editable', 1, true, true, 3],
      ['mobile', 'editable', 0, true, true, 1],
      ['nugets', 'editable', 1, true, true, 1],
      ['microservices', 'editable', 1, true, true, 1],
      ['functions', 'editable', 1, false, true, 0],
      ['other', 'on-request', 1, true, true, 2],
      ['deprecated', 'read-only', 2, true, true, 2],
      ['infrastructure', 'read-only', 0, true, true, 1],
    ]);
    const web = scan.folders[0]?.solutions ?? [];
    expect(web.map((s) => [s.relativePath, s.git])).toEqual([
      ['microfrontends/auth-front', true],
      ['microfrontends/not-cloned-front', false],
      ['microfrontends/acme-app-front', true],
    ]);
    expect(scan.folders[6]?.solutions.map((s) => s.relativePath)).toEqual(['deprecated/microfrontends/old-chat-front', 'deprecated/mobile']);
  });

  it('folders the router adds are scanned with its rule; the router can tighten a baseline folder', async () => {
    const ws = await tempWorkspace();
    await writeFile(
      path.join(ws, 'AGENTS.md'),
      [
        '# Router',
        '- `microfrontends/<repo-name>-front/` — each microfrontend cloned repo',
        '- `nugets/<repo-name>-nuget/` — NuGet repos; read-only while the feed migrates',
        '- `archive/<repo>/` — old snapshots, never edited',
        '- `labs/<repo>/` — experiments, editable only on explicit developer request',
        '- `tools/` — the shared tools repo',
      ].join('\n'),
    );
    await repo(ws, 'microfrontends/web-front');
    await repo(ws, 'nugets/typography-nuget');
    await repo(ws, 'archive/old-repo');
    await worktree(ws, 'archive/old-repo-wt-x');
    await repo(ws, 'labs/spike');
    await repo(ws, 'tools');
    const scanner = new WorkspaceScanner({ root: ws });
    const groups = await scanner.solutions();
    expect(groups.map((g) => [g.folder, g.note, g.rule, g.solutions.map((s) => `${s.name}:${s.type}`)])).toEqual([
      ['microfrontends/', '', 'editable', ['web-front:Web']],
      ['labs/', 'on request only', 'on-request', ['spike:Other']],
      ['tools/', '', 'editable', ['tools:Other']],
      ['read-only', 'nugets/ · archive/ · never edited', 'read-only', ['old-repo:Read-only', 'typography-nuget:Read-only']],
    ]);
    expect(await scanner.isReadOnly('archive/old-repo')).toBe(true);
    expect(await scanner.isReadOnly('typography-nuget')).toBe(true);
    expect(await scanner.isReadOnly('nugets/typography-nuget')).toBe(true);
    expect(await scanner.isReadOnly('web-front')).toBe(false);
    expect(await scanner.isReadOnly('labs/spike')).toBe(false);
    // `nugets/mobile` does not exist, so a tightened nugets/ never makes the live mobile read-only.
    await repo(ws, 'mobile');
    expect(await scanner.isReadOnly('mobile')).toBe(false);
  });

  it('without a router AGENTS.md the baseline layout applies (router.found = false)', async () => {
    const ws = await tempWorkspace();
    await repo(ws, 'mobile');
    await repo(ws, 'other/it-dashboard');
    await repo(ws, 'infrastructure');
    const scanner = new WorkspaceScanner({ root: ws });
    const scan = await scanner.scan();
    expect(scan.router).toEqual({ path: path.join(ws, 'AGENTS.md'), found: false, lines: 0 });
    expect(scan.folders.every((f) => !f.inRouter)).toBe(true);
    expect((await scanner.solutions()).map((g) => [g.folder, g.rule, g.solutions.map((s) => s.name)])).toEqual([
      ['mobile/', 'editable', ['mobile']],
      ['other/', 'on-request', ['it-dashboard']],
      ['read-only', 'read-only', ['infrastructure']],
    ]);
  });

  it('a single-solution folder that is itself a worktree is skipped; an empty workspace has no groups', async () => {
    const ws = await tempWorkspace();
    await worktree(ws, 'mobile');
    await mkdir(path.join(ws, 'microfrontends'));
    expect(await new WorkspaceScanner({ root: ws }).solutions()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never follows symlinks: a linked solution or a linked group folder is not listed', async () => {
    const ws = await tempWorkspace();
    const outside = path.join(path.dirname(ws), 'outside');
    await repo(outside, 'linked-front');
    await repo(outside, 'nugets-elsewhere/some-nuget');
    await repo(ws, 'microfrontends/web-front');
    await symlink(path.join(outside, 'linked-front'), path.join(ws, 'microfrontends', 'linked-front'));
    await symlink(path.join(outside, 'nugets-elsewhere'), path.join(ws, 'nugets'));
    const scan = await new WorkspaceScanner({ root: ws }).scan();
    expect(scan.folders[0]?.solutions.map((s) => s.name)).toEqual(['web-front']);
    expect(scan.folders[2]).toMatchObject({ folder: 'nugets', exists: false, solutions: [] });
  });

  it('mobile/ holding one nested checkout (mobile/acme-app-mobile/) is the mobile solution with that repo', async () => {
    const workspace = await tempWorkspace();
    await repo(workspace, 'mobile/acme-app-mobile');
    await writeFile(path.join(workspace, 'mobile', 'AGENTS.md'), 'rules\n');
    const scan = await new WorkspaceScanner({ root: workspace }).scan();
    const mobile = scan.folders.find((folder) => folder.folder === 'mobile')?.solutions;
    expect(mobile).toEqual([
      { name: 'mobile', relativePath: 'mobile', path: path.join(workspace, 'mobile'), git: true, repoPath: path.join(workspace, 'mobile', 'acme-app-mobile') },
    ]);
  });

  it('refuses to scan a workspace folder that is gone (ScanError folder-missing)', async () => {
    const ws = await tempWorkspace();
    const missing = path.join(ws, 'nope');
    await expect(new WorkspaceScanner({ root: missing }).scan()).rejects.toBeInstanceOf(ScanError);
    await expect(new WorkspaceScanner({ root: missing }).solutions()).rejects.toMatchObject({ name: 'ScanError', code: 'folder-missing' });
    await writeFile(path.join(ws, 'a-file'), 'x');
    await expect(new WorkspaceScanner({ root: path.join(ws, 'a-file') }).solutions()).rejects.toMatchObject({ code: 'folder-missing' });
    // isReadOnly never throws for a missing root; the other checks refuse such a session.
    expect(await new WorkspaceScanner({ root: missing }).isReadOnly('infrastructure')).toBe(true);
  });

  it('writes nothing: the workspace is byte-for-byte the same after a scan', async () => {
    const ws = await fixtureWorkspace();
    const before = await listTree(ws);
    await new WorkspaceScanner({ root: ws }).scan();
    expect(await listTree(ws)).toEqual(before);
  });
});

describe('WorkspaceScanner · real git checkouts and worktrees', () => {
  let world: GitWorld | undefined;

  afterEach(async () => {
    await world?.cleanup();
    world = undefined;
  });

  it('lists main checkouts, skips `git worktree add` folders (gap #16), and its names resolve like the worktree manager', async () => {
    world = await makeGitWorld();
    const w = world;
    // A real gap #1 worktree next to the repo, and one inside the repo (the lane layout).
    await w.git(w.web, 'worktree', 'add', '-q', '-b', 'session/free-talk', path.join(w.workspace, 'microfrontends', 'web-front-wt-free-talk'));
    await w.git(w.web, 'worktree', 'add', '-q', '-b', 'lane/x', path.join(w.web, '.worktrees', 'x'));
    await w.makeRepo(path.join(w.workspace, 'other', 'switchboard'));
    await w.git(path.join(w.workspace, 'other', 'switchboard'), 'worktree', 'add', '-q', '-b', 'session/y', path.join(w.workspace, 'other', 'switchboard-wt-y'));
    await w.makeRepo(path.join(w.workspace, 'deprecated', 'mobile'));
    await copyFile(ROUTER_FIXTURE, path.join(w.workspace, 'AGENTS.md'));

    const scanner = new WorkspaceScanner({ root: w.workspace });
    const groups = await scanner.solutions();
    expect(groups.map((g) => [g.folder, g.solutions.map((s) => s.name)])).toEqual([
      ['microfrontends/', ['web-front']],
      ['mobile/', ['mobile']],
      ['other/', ['switchboard']],
      ['read-only', ['mobile']],
    ]);

    // Every writable solution the scan lists is a name the worktree manager resolves to the same folder.
    const manager = w.manager();
    for (const solution of groups.filter((g) => g.rule !== 'read-only').flatMap((g) => g.solutions)) {
      const resolved = await manager.resolveRepo(solution.name, w.folder);
      expect(resolved.repoPath, solution.name).toBe(solution.path);
      expect(await scanner.isReadOnly(solution.name), solution.name).toBe(false);
    }
    // The archived mobile is read-only by path, and never makes the live `mobile` read-only.
    expect(await scanner.isReadOnly('deprecated/mobile')).toBe(true);
    expect(await scanner.isReadOnly('mobile')).toBe(false);
  });
});

async function listTree(dir: string): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const info = await stat(full);
      out.push(`${path.relative(dir, full)}|${entry.isDirectory() ? 'd' : info.size}|${info.mtimeMs}`);
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out.sort();
}
