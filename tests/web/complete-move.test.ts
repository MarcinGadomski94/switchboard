import { describe, expect, it } from 'vitest';
import type { TakeoverPreview } from '../../src/core/takeover.ts';
import {
  EMPTY_CHOICE,
  carryRows,
  choiceAfterPreview,
  choiceBody,
  fileRows,
  newRootFrom,
  outsideClonePath,
  outsideRows,
  repoModeOf,
  shareChoice,
  splitClonePath,
  tickedSecrets,
  toggleFile,
  withNewWorkspace,
  withOutsideMode,
  withRepoCarried,
  withRepoMode,
  workspaceView,
  worksInLine,
} from '../../src/web/takeover/complete-move.ts';

/** D152: the move dialog's pure parts (the workspace root, use / clone, the files, a crew's shared choices). */

function preview(over: { folder?: string; machine?: string; repos?: Array<{ key: string; name: string; remoteKey: string; path: string }>; files?: boolean; root?: TakeoverPreview['target']['workspaceRoot'] } = {}): TakeoverPreview {
  return {
    source: {
      machine: { id: over.machine ?? 'mac', name: 'Mac' },
      folder: { path: over.folder ?? '/Users/dev/Acme', kind: 'workspace' },
      repos: over.repos ?? [{ key: 'web', name: 'web-front', remoteKey: 'example.com/acme/web', path: '/Users/dev/Acme/microfrontends/web-front' }],
      workspaceFiles:
        over.files === false
          ? null
          : {
              root: '/Users/dev/Acme',
              truncated: false,
              files: [
                { name: 'AGENTS.md', size: 2048, sha256: 'a', secret: null, binary: false, refused: null },
                { name: '.claude/settings.local.json', size: 300, sha256: 'b', secret: 'holds environment values (an "env" block)', binary: false, refused: null },
                { name: 'docs/plan.md', size: 20, sha256: 'c', secret: null, binary: false, refused: null },
                { name: 'video.mp4', size: 9_000_000, sha256: null, secret: null, binary: true, refused: 'over 1.0 MB' },
              ],
            },
    },
    target: {
      folder: null,
      repos: [],
      workspaceRoot: over.root ?? null,
      workspaceFiles: [
        { name: 'AGENTS.md', state: 'new', reason: null },
        { name: '.claude/settings.local.json', state: 'new', reason: null },
        { name: 'docs/plan.md', state: 'conflict', reason: 'a different file is there: skipped, never overwritten' },
        { name: 'video.mp4', state: 'new', reason: null },
      ],
    },
    placement: null,
    remembered: false,
  } as unknown as TakeoverPreview;
}

describe('D152 · the move dialog', () => {
  it('ticks plain new files by default, marks secrets unticked, disables what cannot be copied, and requires AGENTS.md for a new root', () => {
    const p = preview({ root: { path: 'D:\\code\\Acme\\workspace', exists: false, empty: false, workspace: false, needsConfirm: false, ok: true, reason: null } });
    const choice = choiceAfterPreview(EMPTY_CHOICE, p);
    expect(choice.files).toEqual({ copy: ['AGENTS.md'], confirmSecrets: false });
    const rows = Object.fromEntries(fileRows(p, choice.files, true).map((row) => [row.name, row]));
    expect(rows['AGENTS.md']).toMatchObject({ ticked: true, required: true });
    expect(rows['.claude/settings.local.json']).toMatchObject({ ticked: false, disabled: null });
    expect(rows['.claude/settings.local.json']?.secret).toContain('env');
    expect(rows['docs/plan.md']).toMatchObject({ ticked: false, target: 'different there: skipped' });
    expect(rows['video.mp4']).toMatchObject({ ticked: false, disabled: 'over 1.0 MB' });
    const ticked = toggleFile(choice.files, '.claude/settings.local.json', true);
    expect(tickedSecrets(p, ticked)).toEqual(['.claude/settings.local.json']);
    expect(choiceBody({ ...choice, files: ticked })).toEqual({ workspaceFiles: { copy: ['AGENTS.md', '.claude/settings.local.json'] } });
  });

  it('builds the new root from a parent and a name or a full path, and applies it only when asked', () => {
    expect(newRootFrom('parent', 'D:\\code\\Acme', 'workspace', '')).toEqual({ path: 'D:\\code\\Acme\\workspace', problem: null });
    expect(newRootFrom('full', '', '', 'D:\\code\\Acme\\workspace')).toEqual({ path: 'D:\\code\\Acme\\workspace', problem: null });
    expect(newRootFrom('parent', '', 'workspace', '').problem).toBe('pick the folder to create it in');
    const created = withNewWorkspace(null, 'D:\\code\\ws');
    expect(created).toEqual({ roots: [], newWorkspace: { path: 'D:\\code\\ws' } });
    expect(withNewWorkspace(created, 'D:\\code\\ws', true)).toEqual({ roots: [], newWorkspace: { path: 'D:\\code\\ws', useExisting: true } });
    expect(withNewWorkspace(created, null)).toBeNull();
    const view = workspaceView(preview(), created);
    expect(view).toMatchObject({ show: true, suggestedName: 'Acme', creating: 'D:\\code\\ws', found: false });
    expect(worksInLine(preview())).toBe('web-front (/Users/dev/Acme/microfrontends/web-front)');
  });

  it('D152 follow-up 2026-11-05: carries every repo by default, the ones it only read or ran commands in too; any can be left out', () => {
    const repos = [
      { key: 'web', name: 'web-front', remoteKey: 'example.com/acme/web', path: '/Users/dev/Acme/microfrontends/web-front', found: 'edited', evidence: ['edited', 'read'] },
      { key: 'api', name: 'api', remoteKey: 'example.com/acme/api', path: '/Users/dev/Acme/microservices/api', found: 'commands', evidence: ['commands', 'read'] },
      { key: 'docs', name: 'docs', remoteKey: 'example.com/acme/docs', path: '/Users/dev/Acme/docs-repo', found: 'read', evidence: ['read'] },
    ];
    const base = preview({ repos });
    const p = { ...base, target: { ...base.target, repos: repos.map((repo) => ({ key: repo.key, name: repo.name })) } } as unknown as TakeoverPreview;
    expect(carryRows(p, EMPTY_CHOICE).map((row) => [row.name, row.why, row.carried, row.key])).toEqual([
      ['web-front', 'edited · read', true, 'web'],
      ['api', 'commands · read', true, 'api'],
      ['docs', 'read', true, 'docs'],
    ]);
    expect(choiceBody(EMPTY_CHOICE)).toEqual({});
    const leftOut = withRepoCarried(EMPTY_CHOICE, '/Users/dev/Acme/docs-repo', false);
    expect(choiceBody(leftOut)).toEqual({ excludeRepos: ['/Users/dev/Acme/docs-repo'] });
    expect(carryRows(p, leftOut).find((row) => row.name === 'docs')).toMatchObject({ carried: false, key: null });
    expect(withRepoCarried(leftOut, '/Users/dev/Acme/docs-repo', true)).toEqual(EMPTY_CHOICE);
    expect(worksInLine(p)).toBe('web-front (/Users/dev/Acme/microfrontends/web-front; edited · read) · api (/Users/dev/Acme/microservices/api; commands · read) · docs (/Users/dev/Acme/docs-repo; read)');
  });

  it('switches a repo between use and clone', () => {
    const cloned = withRepoMode(null, 'web', 'clone');
    expect(cloned).toEqual({ roots: [], repoModes: { web: 'clone' } });
    expect(repoModeOf(cloned, 'web')).toBe('clone');
    expect(withRepoMode(cloned, 'web', 'use')).toEqual({ roots: [] });
  });

  it('a crew: a new root goes to the teammates of the same workspace, a repo choice to the ones with the same repo', () => {
    const previews = {
      a: preview({ repos: [{ key: 'web', name: 'web-front', remoteKey: 'example.com/acme/web', path: '/x' }] }),
      b: preview({ repos: [{ key: 'web-2', name: 'web-front', remoteKey: 'example.com/acme/web', path: '/y' }] }),
      c: preview({ folder: '/Users/dev/other', repos: [{ key: 'api', name: 'api', remoteKey: 'example.com/acme/api', path: '/z' }] }),
    };
    const next = { ...EMPTY_CHOICE, placement: withRepoMode(withNewWorkspace(null, 'D:\\ws'), 'web', 'clone') };
    const shared = shareChoice({}, previews, 'a', next);
    expect(shared['b']?.placement).toEqual({ roots: [], newWorkspace: { path: 'D:\\ws' }, repoModes: { 'web-2': 'clone' } });
    expect(shared['c']?.placement ?? null).toBeNull();
  });
});

describe('D152 follow-up · Outside the workspace', () => {
  const outsidePreview = (): TakeoverPreview => {
    const base = preview({
      repos: [
        { key: 'web', name: 'web-front', remoteKey: 'example.com/acme/web', path: '/Users/dev/Acme/microfrontends/web-front' },
        { key: 'tool-repo', name: 'tool-repo', remoteKey: 'example.com/acme/tool', path: '/Users/dev/Personal/tool-repo' },
        { key: 'notes', name: 'notes', remoteKey: 'example.com/acme/notes', path: '/Users/dev/Personal/notes' },
      ],
    });
    const repos = base.source.repos.map((repo) =>
      repo.key === 'tool-repo' ? { ...repo, outside: true, carry: true, evidence: ['edited', 'commands'] } : repo.key === 'notes' ? { ...repo, outside: true, carry: false, evidence: ['commands'] } : repo,
    );
    return {
      ...base,
      source: { ...base.source, repos },
      target: {
        ...base.target,
        repos: [
          { key: 'web', name: 'web-front', action: 'use', matchedPath: 'D:\\code\\ws\\microfrontends\\web-front', cloneTo: null, summary: 'Use it' },
          { key: 'tool-repo', name: 'tool-repo', action: 'clone', matchedPath: null, cloneTo: 'D:\\code\\tool-repo', summary: 'Clone into D:\\code\\tool-repo' },
        ],
      },
    } as unknown as TakeoverPreview;
  };

  it('lists the outside repos with their default and the target’s plan; the carry list keeps only the workspace’s', () => {
    const p = outsidePreview();
    const rows = outsideRows(p, EMPTY_CHOICE);
    expect(rows.map((row) => [row.key, row.mode, row.defaultCarry, row.action, row.cloneTo])).toEqual([
      ['tool-repo', 'clone', true, 'clone', 'D:\\code\\tool-repo'],
      ['notes', 'leave', false, null, null],
    ]);
    expect(rows[0]?.why).toBe('edited · commands');
    expect(rows[1]?.defaultText).toContain('left out by default');
    expect(carryRows(p, EMPTY_CHOICE).map((row) => row.name)).toEqual(['web-front']);
  });

  it('use / clone / leave set the placement’s carry choice and the use-or-clone mode; the clone folder is a parent + a name, the target’s way', () => {
    const left = withOutsideMode(EMPTY_CHOICE, 'tool-repo', 'leave');
    expect(left.placement).toEqual({ roots: [], outsideCarry: { 'tool-repo': false } });
    expect(outsideRows(outsidePreview(), left)[0]?.mode).toBe('leave');
    const carried = withOutsideMode(left, 'notes', 'clone');
    expect(carried.placement).toEqual({ roots: [], outsideCarry: { 'tool-repo': false, notes: true }, repoModes: { notes: 'clone' } });
    const used = withOutsideMode(carried, 'notes', 'use');
    expect(used.placement).toEqual({ roots: [], outsideCarry: { 'tool-repo': false, notes: true } });
    expect(choiceBody(used)).toEqual({ placement: { roots: [], outsideCarry: { 'tool-repo': false, notes: true } } });
    expect(outsideClonePath('D:\\code\\tools', 'tool-repo')).toEqual({ path: 'D:\\code\\tools\\tool-repo', problem: null });
    expect(outsideClonePath('', 'tool-repo').path).toBeNull();
    expect(outsideClonePath('/Users/me', 'a:b').path).toBeNull();
    expect(splitClonePath('D:\\code\\tool-repo')).toEqual({ parent: 'D:\\code', name: 'tool-repo' });
    // Cloning or picking a checkout keeps the workspace the target found as the folder (never "choose a folder").
    expect(withOutsideMode(EMPTY_CHOICE, 'notes', 'clone', 'D:\\code\\ws').placement).toEqual({ roots: ['D:\\code\\ws'], outsideCarry: { notes: true }, repoModes: { notes: 'clone' } });
    // A placement that only says which outside repos travel is kept (not dropped as "no folders").
    expect(withNewWorkspace({ roots: [], outsideCarry: { notes: true } }, null)).toEqual({ roots: [], outsideCarry: { notes: true } });
  });
});
