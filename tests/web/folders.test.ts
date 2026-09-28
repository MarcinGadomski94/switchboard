import { describe, expect, it } from 'vitest';
import type { Folder, FolderCheck, Session } from '../../src/core/api.ts';
import {
  defaultFolder,
  folderByPath,
  folderCheckLine,
  folderName,
  folderRefusal,
  folderTag,
  parentFolder,
  routerName,
  samePath,
  selectedOption,
  sessionCwd,
  switcherOptions,
} from '../../src/web/folders/folders.ts';

/** The saved folders in the UI (D14, `src/web/folders/folders.ts`). */

function check(fields: Partial<FolderCheck> = {}): FolderCheck {
  return { path: '/ws', canonicalPath: '/ws', exists: true, kind: 'workspace', router: null, solutionCount: 3, repoName: null, problem: null, message: '', ...fields };
}

function saved(id: string, folderPath: string, kind: Folder['kind'], isDefault = false, canonicalPath = folderPath): Folder {
  return { id, path: folderPath, canonicalPath, name: folderName(folderPath), kind, isDefault, addedAt: '2026-09-28T00:00:00.000Z', lastUsedAt: null, check: check() };
}

function session(fields: Partial<Session>): Session {
  return {
    origin: 'switchboard',
    id: 's',
    name: 's',
    claudeSessionId: 'c',
    status: 'run',
    workType: null,
    mode: null,
    phase: null,
    coordination: null,
    qaStack: null,
    ultracode: false,
    worktrees: false,
    solutions: [],
    attached: true,
    createdAt: '2026-09-28T00:00:00.000Z',
    lastActivityAt: null,
    agents: [],
    openQuestionCount: 0,
    cwd: null,
    folder: null,
    folderPath: null,
    folderKind: null,
    live: false,
    resumeCommand: 'claude --resume c',
    chips: [],
    loops: [],
    ...fields,
  };
}

describe('check line', () => {
  it('a workspace: the router name and the solution count; a repo: single solution; else ✕ and the reason', () => {
    expect(folderCheckLine(check({ router: { title: 'AGENTS.md (Workspace Router)', lines: 640 }, solutionCount: 38 }))).toEqual({
      ok: true,
      text: '✓ AGENTS.md (Workspace Router) · 38 solutions',
    });
    expect(folderCheckLine(check({ router: { title: 'Workspace Router', lines: 1 }, solutionCount: 1 }))?.text).toBe('✓ AGENTS.md (Workspace Router) · 1 solution');
    expect(folderCheckLine(check({ router: { title: null, lines: 3 }, solutionCount: 0 }))?.text).toBe('✓ AGENTS.md · 0 solutions');
    expect(folderCheckLine(check({ router: { title: 'Router', lines: 3 }, solutionCount: null }))?.text).toBe('✓ AGENTS.md (Router)');
    expect(folderCheckLine(check({ kind: 'repo', repoName: 'switchboard', solutionCount: 1 }))).toEqual({ ok: true, text: '✓ git repo · single solution' });
    const refused = (problem: FolderCheck['problem'], message: string): FolderCheck => check({ kind: null, solutionCount: null, problem, message });
    expect(folderCheckLine(refused('unsupported', 'no AGENTS.md here and not a git repository'))).toEqual({ ok: false, text: '✕ no AGENTS.md here and not a git repository' });
    expect(folderCheckLine(refused('missing', 'folder not found'))?.text).toBe('✕ folder not found');
    expect(folderCheckLine(null)).toBeNull();
    expect(routerName('AGENTS.md (Workspace Router)')).toBe('AGENTS.md (Workspace Router)');
  });
});

describe('paths', () => {
  it('name, parent and comparison in either OS form (gap #17)', () => {
    expect(folderName('/src/switchboard/')).toBe('switchboard');
    expect(folderName('D:\\acme')).toBe('acme');
    expect(parentFolder('/src/switchboard')).toBe('/src');
    expect(parentFolder('/switchboard')).toBe('/');
    expect(parentFolder('D:\\ws\\app')).toBe('D:\\ws');
    expect(parentFolder('D:\\app')).toBe('D:\\');
    expect(samePath('D:\\ws\\', 'D:/ws')).toBe(true);
    expect(samePath('/a', '/b')).toBe(false);
    expect(samePath(null, '/a')).toBe(false);
  });

  it('the cwd of a new session: the folder, or a repo worktree next to the repo', () => {
    expect(sessionCwd({ path: '/src/ws', kind: 'workspace', name: 'ws' }, true, 'x')).toBe('/src/ws');
    expect(sessionCwd({ path: '/src/switchboard', kind: 'repo', name: 'switchboard' }, false, 'x')).toBe('/src/switchboard');
    expect(sessionCwd({ path: '/src/switchboard', kind: 'repo', name: 'switchboard' }, true, 'fix-it')).toBe('/src/switchboard-wt-fix-it');
    expect(sessionCwd({ path: 'D:\\ws\\other\\tool', kind: 'repo', name: 'tool' }, true, 'n')).toBe('D:\\ws\\other\\tool-wt-n');
    expect(sessionCwd({ path: '/tool', kind: 'repo', name: 'tool' }, true, 'n')).toBe('/tool-wt-n');
  });
});

describe('default folder, tags and the switcher', () => {
  const ws = saved('f-ws', '/src/workspace', 'workspace', true, '/real/workspace');
  const repo = saved('f-repo', '/src/switchboard', 'repo');
  const folders = [ws, repo];

  it('the default folder is the marked one (else the first)', () => {
    expect(defaultFolder(folders)?.id).toBe('f-ws');
    expect(defaultFolder([repo])?.id).toBe('f-repo');
    expect(defaultFolder([])).toBeNull();
    expect(defaultFolder(null)).toBeNull();
    expect(folderByPath(folders, '/real/workspace')?.id).toBe('f-ws');
  });

  it('tags rows of other folders with the folder name; the default folder and unknown rows get none', () => {
    expect(folderTag({ folder: 'f-ws', folderPath: '/real/workspace' }, folders)).toBeNull();
    expect(folderTag({ folder: null, folderPath: '/real/workspace' }, folders)).toBeNull();
    expect(folderTag({ folder: null, folderPath: '/src/workspace/' }, folders)).toBeNull();
    expect(folderTag({ folder: 'f-repo', folderPath: '/src/switchboard' }, folders)).toBe('switchboard');
    expect(folderTag({ folder: null, folderPath: '/src/switchboard' }, folders)).toBe('switchboard');
    // A folder that left the saved list: its path's name.
    expect(folderTag({ folder: null, folderPath: '/gone/old-repo' }, folders)).toBe('old-repo');
    expect(folderTag({ folder: 'f-repo' }, folders)).toBe('switchboard');
    // Nothing known: no tag (a schedule saved before any folder runs in the default one).
    expect(folderTag({ folder: null, folderPath: null }, folders)).toBeNull();
    expect(folderTag({ folder: 'f-repo' }, null)).toBeNull();
  });

  it('switcher: the default first, the other saved folders, then folders only sessions use, each once', () => {
    const options = switcherOptions([repo, ws], [
      session({ folder: 'f-repo', folderPath: '/src/switchboard', folderKind: 'repo' }),
      session({ folder: null, folderPath: '/gone/old-repo', folderKind: 'repo' }),
      session({ folder: null, folderPath: '/gone/old-repo/', folderKind: 'repo' }),
      session({ folder: null, folderPath: '/real/workspace', folderKind: 'workspace' }),
      session({ folder: null, folderPath: null }),
    ]);
    expect(options.map((o) => [o.value, o.label, o.saved])).toEqual([
      ['f-ws', '/src/workspace (default)', true],
      ['f-repo', '/src/switchboard', true],
      ['/gone/old-repo', '/gone/old-repo', false],
    ]);
    expect(selectedOption(options, null)?.value).toBe('f-ws');
    expect(selectedOption(options, 'f-repo')?.value).toBe('f-repo');
    expect(selectedOption(options, '/src/switchboard/')?.value).toBe('f-repo');
    expect(selectedOption(options, 'unknown')).toBeNull();
    expect(selectedOption([], null)).toBeNull();
  });

  it('a refusal in the server’s words', () => {
    expect(folderRefusal(422, { error: 'invalid', message: 'no AGENTS.md here and not a git repository' })).toBe('no AGENTS.md here and not a git repository');
    expect(folderRefusal(500, null)).toBe('HTTP 500');
    expect(folderRefusal(0, null)).toBe('Switchboard is not reachable.');
  });
});
