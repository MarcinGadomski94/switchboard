import { describe, expect, it } from 'vitest';
import { placementOf, placementToRemember } from '../../src/core/takeover.ts';
import { crewMoveSummary } from '../../src/core/team.ts';
import {
  type WorkspaceFilesListing,
  WORKSPACE_FILES_MAX_TOTAL,
  defaultChoice,
  fileChoiceProblem,
  filesToSend,
  folderNameProblem,
  isAbsoluteTargetPath,
  isSafeWorkspaceFileName,
  joinTargetPath,
  looksSecret,
  newWorkspacePath,
  pathStyleOf,
  relativeInside,
  sameTargetPath,
  secretByContent,
  suggestWorkspaceParent,
  targetBaseName,
  targetParent,
  workspaceChoiceOf,
  workspaceCopyAudit,
  worksInSummary,
} from '../../src/core/workspace-move.ts';

/** D152 (`docs/peers.md` → *A complete move (D152)*): the pure part, Windows targets included. */

describe('D152: target paths written the target’s way (Windows from a Mac and back)', () => {
  it('knows the style, joins, splits and compares Windows paths without case', () => {
    expect(pathStyleOf('D:\\code\\ws')).toBe('windows');
    expect(pathStyleOf('d:/code/ws')).toBe('windows');
    expect(pathStyleOf('\\\\server\\share\\ws')).toBe('windows');
    expect(pathStyleOf('/Users/dev/ws')).toBe('posix');
    expect(joinTargetPath('D:\\code', 'Acme', 'workspace')).toBe('D:\\code\\Acme\\workspace');
    expect(joinTargetPath('D:\\', 'ws')).toBe('D:\\ws');
    expect(joinTargetPath('D:\\code\\', 'microfrontends/web-front')).toBe('D:\\code\\microfrontends\\web-front');
    expect(joinTargetPath('/Users/dev', 'a\\b')).toBe('/Users/dev/a/b');
    expect(joinTargetPath('/', 'ws')).toBe('/ws');
    expect(targetBaseName('D:\\code\\ws\\')).toBe('ws');
    expect(targetParent('D:\\code\\ws')).toBe('D:\\code');
    expect(targetParent('D:\\ws')).toBe('D:\\');
    expect(targetParent('/Users/dev')).toBe('/Users');
    expect(sameTargetPath('D:\\Code\\WS\\', 'd:/code/ws')).toBe(true);
    expect(sameTargetPath('/Users/Dev', '/Users/dev')).toBe(false);
    expect(relativeInside('D:\\Code\\WS', 'd:\\code\\ws\\microfrontends\\web-front')).toEqual(['microfrontends', 'web-front']);
    expect(relativeInside('/a/ws', '/a/other')).toBeNull();
    expect(isAbsoluteTargetPath('C:\\x')).toBe(true);
    expect(isAbsoluteTargetPath('C:x')).toBe(false);
    expect(isAbsoluteTargetPath('code\\ws')).toBe(false);
  });

  it('builds the new workspace folder from a parent and a name, or a full path, with names that work on Windows too', () => {
    expect(newWorkspacePath({ parent: 'D:\\code\\Acme', name: 'workspace' })).toEqual({ path: 'D:\\code\\Acme\\workspace', problem: null });
    expect(newWorkspacePath({ parent: '/Users/dev/code', name: ' ws ' })).toEqual({ path: '/Users/dev/code/ws', problem: null });
    expect(newWorkspacePath({ full: 'D:\\new\\ws' })).toEqual({ path: 'D:\\new\\ws', problem: null });
    expect(newWorkspacePath({ full: 'new\\ws' }).problem).toContain('not a full path');
    expect(newWorkspacePath({ parent: '', name: 'ws' }).problem).toBe('pick the folder to create it in');
    expect(newWorkspacePath({ parent: 'D:\\code', name: 'a:b' }).problem).toContain('cannot hold');
    expect(folderNameProblem('CON')).toContain('reserves');
    expect(folderNameProblem('ws.')).toContain('end with a dot');
    expect(folderNameProblem('..')).toContain('cannot be');
    expect(folderNameProblem('workspace')).toBeNull();
    expect(suggestWorkspaceParent([{ path: 'D:\\code\\old-ws', kind: 'workspace' }, { path: 'C:\\Users\\dev', kind: 'home' }])).toBe('D:\\code');
    expect(suggestWorkspaceParent([{ path: '/Users/dev', kind: 'home' }])).toBe('/Users/dev');
  });
});

describe('D152: which workspace files may travel', () => {
  it('accepts only relative, forward-slash names that stay under the root', () => {
    for (const ok of ['AGENTS.md', '.claude/settings.local.json', 'docs/a b.md']) expect(isSafeWorkspaceFileName(ok), ok).toBe(true);
    for (const bad of ['', '../x', 'a/../../x', '/etc/x', 'C:/x', 'C:\\x', 'a\\b', 'a//b', './a', 'a/.git/config', '.GIT/x', 'x:stream', 'a\u0000b', 'trailing. ', 'x'.repeat(401)]) {
      expect(isSafeWorkspaceFileName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('marks files that look like they hold secrets, by name or content, never quoting the value', () => {
    expect(looksSecret('.env', null)).toBeTruthy();
    expect(looksSecret('config/.env.production', null)).toBeTruthy();
    expect(looksSecret('.claude/settings.local.json', '{}')).toBeTruthy();
    expect(looksSecret('keys/deploy.pem', null)).toBeTruthy();
    expect(looksSecret('notes.md', 'API_TOKEN=abcdefghijklmnop123')).toBe('holds token-like keys');
    expect(looksSecret('settings.json', '{"env":{"ACME_TOKEN":"x"}}')).toContain('env');
    expect(secretByContent('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeTruthy();
    expect(secretByContent('use ghp_abcdefghijklmnopqrstuvwxyz0123 here')).toBeTruthy();
    expect(secretByContent('clone https://user:pass@example.com/acme/app.git')).toBeTruthy();
    // A router that only names the variables is not marked.
    expect(looksSecret('AGENTS.md', 'Read `ACME_TOKEN` / `ACME_USER` from `.claude/settings.local.json`; the token: set it there.')).toBeNull();
    expect(looksSecret('docs/plan.md', '# Plan')).toBeNull();
  });

  const listing: WorkspaceFilesListing = {
    root: '/ws',
    truncated: false,
    files: [
      { name: 'AGENTS.md', size: 10, sha256: 'a', secret: null, binary: false, refused: null },
      { name: 'docs/plan.md', size: 10, sha256: 'b', secret: null, binary: false, refused: null },
      { name: '.env', size: 10, sha256: 'c', secret: 'named like a file that holds secrets', binary: false, refused: null },
      { name: 'big.zip', size: 5_000_000, sha256: null, secret: null, binary: true, refused: 'over 1.0 MB' },
      { name: 'huge-1.txt', size: WORKSPACE_FILES_MAX_TOTAL / 2 + 1, sha256: 'd', secret: null, binary: false, refused: null },
      { name: 'huge-2.txt', size: WORKSPACE_FILES_MAX_TOTAL / 2 + 1, sha256: 'e', secret: null, binary: false, refused: null },
    ],
  };

  it('ticks plain new files by default; a secret needs the confirmation; caps hold; conflicts are skipped', () => {
    expect(defaultChoice(listing, [{ name: 'docs/plan.md', state: 'conflict', reason: null }]).copy).toEqual(['AGENTS.md', 'huge-1.txt', 'huge-2.txt']);
    expect(fileChoiceProblem(listing, { copy: ['docs/plan.md'] })).toBeNull();
    expect(fileChoiceProblem(listing, { copy: ['.env'] })).toBe('.env looks like it holds secrets: confirm copying it first');
    expect(fileChoiceProblem(listing, { copy: ['.env'], confirmSecrets: true })).toBeNull();
    expect(fileChoiceProblem(listing, { copy: ['big.zip'] })).toContain('cannot be copied');
    expect(fileChoiceProblem(listing, { copy: ['nope.md'] })).toContain('is not one of');
    expect(fileChoiceProblem(listing, { copy: ['huge-1.txt', 'huge-2.txt'] })).toContain('at most 20 MB');
    expect(filesToSend(listing, { copy: ['docs/plan.md', '.env'] }, [{ name: 'docs/plan.md', state: 'conflict', reason: null }], true)).toEqual({ copy: ['.env', 'AGENTS.md'] });
    expect(filesToSend(listing, undefined, null, false)).toEqual({ copy: [] });
    expect(workspaceChoiceOf({ copy: ['a', 'a', 'b'], confirmSecrets: true })).toEqual({ copy: ['a', 'b'], confirmSecrets: true });
    expect(workspaceChoiceOf({ copy: 'a' })).toBeNull();
    expect(workspaceChoiceOf(undefined)).toBeUndefined();
    expect(workspaceCopyAudit(3, 1, 'PC')).toBe('copied 3 workspace files (1 marked secret) to PC');
  });
});

describe('D152: the placement and what is remembered', () => {
  it('reads the new workspace and the per-repo choice, and remembers a created root as a folder', () => {
    expect(placementOf({ roots: [], newWorkspace: { path: ' D:\\code\\ws ', useExisting: true }, repoModes: { web: 'clone', api: 'use' } })).toEqual({
      roots: [],
      newWorkspace: { path: 'D:\\code\\ws', useExisting: true },
      repoModes: { web: 'clone', api: 'use' },
    });
    expect(placementOf({ roots: [], repoModes: { web: 'copy' } })).toBeNull();
    expect(placementOf({ roots: [], newWorkspace: { path: '' } })).toBeNull();
    expect(placementToRemember({ roots: ['D:\\code'], newWorkspace: { path: 'D:\\code\\ws' }, repoModes: { web: 'clone', api: 'use' }, repoPaths: { api: 'D:\\x\\api' } }, 'D:\\code\\ws')).toEqual({
      roots: ['D:\\code\\ws', 'D:\\code'],
      repoPaths: { api: 'D:\\x\\api' },
      repoModes: { api: 'use' },
    });
  });

  it('says which repos an agent works in, and how a crew move ended', () => {
    expect(worksInSummary([])).toBe('no repo found yet');
    expect(worksInSummary([{ name: 'web' }, { name: 'api' }, { name: 'docs' }, { name: 'web' }])).toBe('web, api +1');
    const member = (name: string, state: 'moved' | 'failed' | 'not-moved') => ({ memberId: name, name, machineId: 'x', state, blockers: [], note: null });
    expect(crewMoveSummary({ state: 'failed', members: [member('Dev', 'moved'), member('Tester', 'failed'), member('Writer', 'not-moved')] }, 'PC')).toBe('Tester could not move; moved: Dev (they stay on PC); not moved: Writer.');
    expect(crewMoveSummary({ state: 'done', members: [member('Dev', 'moved')] }, 'PC')).toBe('Moved Dev to PC.');
  });
});
