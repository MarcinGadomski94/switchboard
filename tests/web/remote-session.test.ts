import { describe, expect, it } from 'vitest';
import type { Folder, FolderCheck } from '../../src/core/api.ts';
import { TITLE_TOO_LONG, type FormFolder, startErrorText } from '../../src/web/modals/new-session.ts';
import {
  FROM_REMOTE_SESSION,
  canStartRemote,
  remoteFormFolder,
  remoteNames,
  remoteProblems,
  remoteSummaryLines,
  repoFolders,
  toTeleportBody,
} from '../../src/web/modals/remote-session.ts';
import { modeLine } from '../../src/web/shell/format.ts';

/** D25: "From a remote session" in the New-session form (`src/web/modals/remote-session.ts`). */

const check: FolderCheck = { path: '/src/app', canonicalPath: '/src/app', exists: true, kind: 'repo', router: null, solutionCount: 1, repoName: 'app', problem: null, message: '' };

function saved(id: string, folderPath: string, kind: Folder['kind'], isDefault = false): Folder {
  const name = folderPath.split('/').pop() ?? folderPath;
  return { id, path: folderPath, canonicalPath: folderPath, name, label: null, displayName: name, kind, isDefault, addedAt: '2026-09-28T00:00:00.000Z', lastUsedAt: null, check };
}

const WS = saved('f-ws', '/src/workspace', 'workspace', true);
const APP = saved('f-app', '/src/app', 'repo');
const WEB = saved('f-web', '/src/web-front', 'repo');
const APP_FOLDER: FormFolder = { id: APP.id, path: APP.path, name: APP.name, displayName: APP.displayName, kind: APP.kind };
const WS_FOLDER: FormFolder = { id: WS.id, path: WS.path, name: WS.name, displayName: WS.displayName, kind: WS.kind };
const ID = 'session_011CUabcDEFghi';

describe('From a remote session (D25)', () => {
  it('the option and the folders it offers: git repo folders only, the form keeps its own when it is one, else the first', () => {
    expect(FROM_REMOTE_SESSION).toBe('From a remote session');
    expect(repoFolders([WS, APP, WEB]).map((folder) => folder.id)).toEqual(['f-app', 'f-web']);
    expect(remoteFormFolder('f-web', [WS, APP, WEB])).toBe('f-web');
    expect(remoteFormFolder('f-ws', [WS, APP, WEB])).toBe('f-app');
    expect(remoteFormFolder(null, [WS, APP, WEB])).toBe('f-app');
    expect(remoteFormFolder('f-ws', [WS])).toBeNull();
  });

  it('names: the default remote-<8> (made unique) without a typed title; D22 for a typed one', () => {
    expect(remoteNames(ID, '', [])).toEqual({ name: 'remote-011cuabc', title: null });
    expect(remoteNames(`https://claude.ai/code/${ID}?m=0`, ' ', ['remote-011cuabc'])).toEqual({ name: 'remote-011cuabc-2', title: null });
    expect(remoteNames('cse_011CUabcDEFghi', 'Cloud health work', [])).toEqual({ name: 'cloud-health-work', title: 'Cloud health work' });
    expect(remoteNames('nonsense', '', [])).toEqual({ name: 'remote-…', title: null });
  });

  it('Start: a claude.ai/code URL or id, a git repo folder, a title of at most 80 characters', () => {
    expect(canStartRemote(ID, '', APP_FOLDER)).toBe(true);
    expect(canStartRemote(`https://claude.ai/code/${ID}`, 'x'.repeat(80), APP_FOLDER)).toBe(true);
    expect(remoteProblems('', '', APP_FOLDER)).toEqual(['⚠ paste the remote session: a claude.ai/code URL, session_… or cse_…']);
    expect(remoteProblems('https://example.com/code/session_x', '', APP_FOLDER)).toEqual(['⚠ not a claude.ai/code session URL, session_… or cse_… id']);
    expect(remoteProblems(ID, '', WS_FOLDER)).toEqual(["⚠ pick a git repo folder: the checkout of the session's repository"]);
    expect(remoteProblems(ID, '', null)).toEqual(["⚠ pick a git repo folder: the checkout of the session's repository"]);
    expect(remoteProblems(ID, 'x'.repeat(81), APP_FOLDER)).toEqual([TITLE_TOO_LONG]);
    expect(canStartRemote(ID, '', WS_FOLDER)).toBe(false);
    expect(canStartRemote('', '', APP_FOLDER)).toBe(false);
  });

  it('the body: the pasted value trimmed, the folder; the title and the first message only when typed', () => {
    expect(toTeleportBody(`  https://claude.ai/code/${ID}?m=0 `, APP_FOLDER, '', '')).toEqual({ remote: `https://claude.ai/code/${ID}?m=0`, folder: 'f-app' });
    expect(toTeleportBody(ID, APP_FOLDER, ' Cloud work ', ' Run the tests. ')).toEqual({ remote: ID, folder: 'f-app', title: 'Cloud work', task: 'Run the tests.' });
  });

  it('the summary: folder, the remote session as session_<X>, the new worktree as cwd, the name, what is missing, what happens', () => {
    expect(remoteSummaryLines(`https://claude.ai/code/cse_011CUabcDEFghi`, APP_FOLDER, '', '', []).map((line) => [line.tone, line.text])).toEqual([
      ['comment', '# claude code · background · Max'],
      ['value', 'folder    app · git repo'],
      ['value', `remote    ${ID}`],
      ['value', 'cwd       /src/app-wt-remote-011cuabc'],
      ['value', 'name      remote-011cuabc'],
      ['value', ' '],
      ['comment', '# worktree · claude checks out its branch'],
      ['path', '../app-wt-remote-011cuabc'],
      ['value', ' '],
      ['ok', '✓ local copy · history · idle'],
    ]);
    const typed = remoteSummaryLines(ID, APP_FOLDER, 'Cloud work', 'Run the tests.', []);
    expect(typed.map((line) => line.text)).toContain('name      cloud-work');
    expect(typed.at(-1)).toEqual({ text: '✓ local copy · history · first message', tone: 'ok' });
    // Nothing pasted, a workspace folder: no id, no cwd, and the ⚠ lines say why Start is off.
    const empty = remoteSummaryLines('', WS_FOLDER, '', '', []).map((line) => line.text);
    expect(empty).toContain('remote    —');
    expect(empty).toContain('cwd       —');
    expect(empty).toContain('folder    workspace · workspace');
    expect(empty.filter((text) => text.startsWith('⚠'))).toEqual([
      '⚠ paste the remote session: a claude.ai/code URL, session_… or cse_…',
      "⚠ pick a git repo folder: the checkout of the session's repository",
    ]);
  });

  it("a refused teleport's text is shown as the service sent it; the sidebar's mode line reads remote · local copy", () => {
    const text = `You must run claude --teleport ${ID} from a checkout of acme/app`;
    expect(startErrorText(502, { error: 'teleport-failed', message: text })).toBe(`Not started: ${text}`);
    expect(startErrorText(504, { error: 'teleport-timeout', message: 'claude did not report …' })).toBe('Not started: claude did not report …');
    expect(modeLine({ mode: null, workType: null, phase: null, remoteSource: ID })).toBe('remote · local copy');
    expect(modeLine({ mode: null, workType: null, phase: null, origin: 'terminal', remoteSource: null })).toBe('terminal · moved');
  });
});
