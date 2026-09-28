import { describe, expect, it } from 'vitest';
import type { Folder, FolderCheck, Solution, SolutionGroup } from '../../src/core/api.ts';
import {
  DEFAULT_FORM,
  type NewSessionForm,
  RECOMMENDED,
  UNKNOWN_FOLDER,
  canStart,
  chipGroups,
  figmaUrlList,
  folderChoices,
  formFromPrefill,
  isRepoFolder,
  repoSummaryLines,
  resolveFormFolder,
  toNewRepoSession,
  toSessionBody,
  missingQa,
  readOnlyChipLabel,
  sanitizeName,
  sessionName,
  showsCoordination,
  showsQa,
  startErrorText,
  summaryLines,
  toNewSession,
  toggleSolution,
  workspaceRoot,
  worktreeFolder,
} from '../../src/web/modals/new-session.ts';

function solution(name: string, relativePath: string, rule: Solution['rule'] = 'editable', root = '/ws'): Solution {
  return {
    name,
    path: `${root}/${relativePath}`,
    relativePath,
    type: 'Web',
    status: 'idle',
    rule,
    phase: '—',
    changes: '—',
    flag: '',
    conflict: false,
    conflictSessions: [],
    branches: [],
    ledger: null,
    artifacts: [],
    codebaseMemory: 'unknown',
  };
}

const GROUPS: SolutionGroup[] = [
  { folder: 'microfrontends/', note: '', rule: 'editable', solutions: [solution('auth-front', 'microfrontends/auth-front'), solution('acme-app-front', 'microfrontends/acme-app-front')] },
  { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution('mobile', 'mobile')] },
  { folder: 'other/', note: 'on request only', rule: 'on-request', solutions: [solution('it-dashboard', 'other/it-dashboard', 'on-request')] },
  {
    folder: 'read-only',
    note: 'deprecated/ · infrastructure/ · never edited',
    rule: 'read-only',
    solutions: [
      solution('infrastructure', 'infrastructure', 'read-only'),
      solution('mobile', 'deprecated/mobile', 'read-only'),
      solution('old-chat-front', 'deprecated/microfrontends/old-chat-front', 'read-only'),
    ],
  },
];

function form(patch: Partial<NewSessionForm> = {}): NewSessionForm {
  return { ...DEFAULT_FORM, ...patch };
}

describe('defaults and prefill', () => {
  it('opens with the router recommended answers, no solutions, worktrees on, ultracode off', () => {
    expect(DEFAULT_FORM).toEqual({
      name: '',
      task: '',
      workType: 'feature',
      mode: 'single',
      solutions: [],
      phase: 'ui-first',
      coordination: 'sequential',
      stack: null,
      confluenceUrl: '',
      figmaUrls: '',
      worktrees: true,
      ultracode: false,
      folder: null,
    });
    expect(RECOMMENDED).toEqual({ workType: 'feature', mode: 'single', phase: 'ui-first', coordination: 'sequential' });
    expect(formFromPrefill(null)).toBe(DEFAULT_FORM);
  });

  it('puts every valid prefill field over the defaults (M3.3 "Open fix session")', () => {
    expect(
      formFromPrefill({
        name: 'Fix Nightly',
        task: 'nightly: failed.',
        workType: 'feature',
        mode: 'orchestrator',
        solutions: ['mobile', 'mobile', ' acme-app-front '],
        phase: 'integration',
        coordination: 'none',
        worktrees: false,
        ultracode: true,
      }),
    ).toEqual(
      form({
        name: 'fix-nightly',
        task: 'nightly: failed.',
        mode: 'orchestrator',
        solutions: ['mobile', 'acme-app-front'],
        phase: 'integration',
        coordination: 'none',
        worktrees: false,
        ultracode: true,
      }),
    );
    expect(formFromPrefill({ workType: 'qa', qa: { stack: 'web', confluenceUrl: 'https://c/1', figmaUrls: ['https://f/1', 'https://f/2'] } })).toEqual(
      form({ workType: 'qa', stack: 'web', confluenceUrl: 'https://c/1', figmaUrls: 'https://f/1 https://f/2' }),
    );
  });

  it('ignores invalid prefill values and a null coordination', () => {
    const bad = { mode: 'solo', phase: 'later', workType: 'x', coordination: null, solutions: [1, '', 'mobile'] } as never;
    expect(formFromPrefill(bad)).toEqual(form({ solutions: ['mobile'] }));
  });
});

describe('name', () => {
  it('turns whitespace into dashes and lower-cases (prototype onNsName)', () => {
    expect(sanitizeName('Free Talk  640')).toBe('free-talk-640');
  });

  it('falls back to "session" while the field is empty (prototype sname)', () => {
    expect(sessionName({ name: '' })).toBe('session');
    expect(sessionName({ name: 'free-talk-640' })).toBe('free-talk-640');
  });
});

describe('sections', () => {
  it('shows mobile coordination only for feature + single + a *-front in scope', () => {
    expect(showsCoordination(form({ solutions: ['acme-app-front'] }))).toBe(true);
    expect(showsCoordination(form({ solutions: ['other/web-front'] }))).toBe(true);
    expect(showsCoordination(form({ solutions: ['mobile'] }))).toBe(false);
    expect(showsCoordination(form({ solutions: ['acme-app-front'], mode: 'orchestrator' }))).toBe(false);
    expect(showsCoordination(form({ solutions: ['acme-app-front'], workType: 'qa' }))).toBe(false);
  });

  it('shows the QA contract for test-authoring only', () => {
    expect(showsQa(form({ workType: 'qa' }))).toBe(true);
    expect(showsQa(form())).toBe(false);
  });

  it('splits the Figma field on spaces, commas and new lines', () => {
    expect(figmaUrlList(' https://f/1,https://f/2\nhttps://f/3  ')).toEqual(['https://f/1', 'https://f/2', 'https://f/3']);
    expect(figmaUrlList('  ')).toEqual([]);
  });
});

describe('chip groups', () => {
  it('lists writable groups, then one locked chip per read-only top folder, sorted', () => {
    const rows = chipGroups(GROUPS, ['mobile']);
    expect(rows.map((row) => row.folder)).toEqual(['microfrontends/', 'mobile/', 'other/', 'read-only']);
    expect(rows[0]?.chips).toEqual([
      { value: 'auth-front', label: 'auth-front', selected: false, locked: false },
      { value: 'acme-app-front', label: 'acme-app-front', selected: false, locked: false },
    ]);
    expect(rows[1]?.chips).toEqual([{ value: 'mobile', label: '✓ mobile', selected: true, locked: false }]);
    // The archived deprecated/mobile never shows as selected because the live mobile is.
    expect(rows[3]?.chips).toEqual([
      { value: 'deprecated/*', label: 'deprecated/*', selected: false, locked: true },
      { value: 'infrastructure', label: 'infrastructure', selected: false, locked: true },
    ]);
    expect(readOnlyChipLabel('deprecated/microfrontends/x')).toBe('deprecated/*');
    expect(readOnlyChipLabel('infrastructure')).toBe('infrastructure');
  });

  it('uses the relative path when two writable rows share a name', () => {
    const groups: SolutionGroup[] = [
      { folder: 'mobile/', note: '', rule: 'editable', solutions: [solution('mobile', 'mobile')] },
      { folder: 'nugets/', note: '', rule: 'editable', solutions: [solution('mobile', 'nugets/mobile')] },
    ];
    expect(chipGroups(groups, []).flatMap((row) => row.chips.map((chip) => chip.value))).toEqual(['mobile', 'nugets/mobile']);
  });

  it('adds a row for selected solutions the scan does not list; nothing while loading', () => {
    const rows = chipGroups(GROUPS, ['mobile', 'gone-front']);
    expect(rows.at(-1)).toEqual({ folder: UNKNOWN_FOLDER, chips: [{ value: 'gone-front', label: '✓ gone-front', selected: true, locked: false }] });
    expect(chipGroups([], ['gone-front'])).toEqual([{ folder: UNKNOWN_FOLDER, chips: [{ value: 'gone-front', label: '✓ gone-front', selected: true, locked: false }] }]);
    expect(chipGroups(null, ['gone-front'])).toEqual([]);
  });

  it('toggles a solution, keeping the order of picking', () => {
    expect(toggleSolution(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSolution(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('summary', () => {
  it('is the prototype nsSummary for an orchestrator feature session with worktrees', () => {
    const lines = summaryLines(form({ name: 'free-talk-640', mode: 'orchestrator', solutions: ['acme-app-front', 'mobile'] }), 'D:\\acme', []);
    expect(lines).toEqual([
      { text: '# claude code · background · Max', tone: 'comment' },
      { text: 'cwd       D:\\acme', tone: 'value' },
      { text: 'work      feature-building', tone: 'value' },
      { text: 'mode      workspace orchestrator', tone: 'value' },
      { text: 'phase     UI-first', tone: 'value' },
      { text: 'ultracode off', tone: 'value' },
      { text: ' ', tone: 'value' },
      { text: '# worktrees', tone: 'comment' },
      { text: '../acme-app-front-wt-free-talk-640', tone: 'path' },
      { text: '../mobile-wt-free-talk-640', tone: 'path' },
      { text: ' ', tone: 'value' },
      { text: '✓ answers pre-filled → agent confirms, no re-ask', tone: 'ok' },
    ]);
  });

  it('shows the mobile line for single + front, the stack for QA, no worktrees, and the warnings', () => {
    const single = summaryLines(form({ name: 'x', solutions: ['acme-app-front'], coordination: 'none', worktrees: false, ultracode: true }), null, []).map((l) => l.text);
    expect(single).toContain('mobile    no counterpart');
    expect(single).toContain('cwd       —');
    expect(single).toContain('ultracode on');
    expect(single).toContain('# no worktrees · edits in place');
    expect(single.some((t) => t.startsWith('../'))).toBe(false);

    // D22: a taken name is no warning any more: the short name gets -2 (and the summary says so).
    const qa = summaryLines(form({ workType: 'qa', solutions: [] }), '/ws', ['session']).map((l) => l.text);
    expect(qa).toContain('work      test-authoring (QA)');
    expect(qa).toContain('stack     —');
    expect(qa).toContain('branch    session/session-2');
    expect(qa.filter((t) => t.startsWith('⚠'))).toEqual([
      '⚠ pick at least one solution',
      '⚠ pick the stack under test',
      '⚠ add the Confluence page URL',
      '⚠ add the Figma frame URLs',
    ]);
    expect(worktreeFolder('other/tool', 'x')).toBe('../tool-wt-x');
  });

  it('derives the workspace root from the scan', () => {
    expect(workspaceRoot(GROUPS)).toBe('/ws');
    expect(workspaceRoot(null)).toBeNull();
    expect(workspaceRoot([])).toBeNull();
  });
});

describe('start', () => {
  it('is disabled without solutions, with a title over 80 characters, or with an incomplete QA contract (D22: a taken name gets -2)', () => {
    expect(canStart(form({ solutions: [] }), [])).toBe(false);
    expect(canStart(form({ solutions: ['mobile'] }), [])).toBe(true);
    expect(canStart(form({ name: 'taken', solutions: ['mobile'] }), ['taken'])).toBe(true);
    expect(canStart(form({ solutions: ['mobile'] }), ['session'])).toBe(true);
    expect(canStart(form({ name: 'T'.repeat(80), solutions: ['mobile'] }), [])).toBe(true);
    expect(canStart(form({ name: 'T'.repeat(81), solutions: ['mobile'] }), [])).toBe(false);
    const qa = form({ workType: 'qa', solutions: ['mobile'] });
    expect(missingQa(qa)).toEqual(['stack', 'confluence', 'figma']);
    expect(canStart(qa, [])).toBe(false);
    expect(canStart({ ...qa, stack: 'both', confluenceUrl: 'https://c/1', figmaUrls: 'https://f/1' }, [])).toBe(true);
  });

  it('builds the contract body: coordination only when it applies, qa only for QA', () => {
    expect(toNewSession(form({ name: 'a', task: ' Do it. ', solutions: ['acme-app-front'], coordination: 'parallel-twin' }))).toEqual({
      name: 'a',
      task: 'Do it.',
      workType: 'feature',
      mode: 'single',
      solutions: ['acme-app-front'],
      phase: 'ui-first',
      coordination: 'parallel-twin',
      qa: null,
      worktrees: true,
      ultracode: false,
    });
    expect(toNewSession(form({ name: 'b', solutions: ['mobile'], coordination: 'none' })).coordination).toBeNull();
    expect(
      toNewSession(form({ name: 'c', workType: 'qa', solutions: ['acme-app-front'], stack: 'web', confluenceUrl: ' https://c/1 ', figmaUrls: 'https://f/1, https://f/2' })),
    ).toMatchObject({ workType: 'qa', coordination: null, qa: { stack: 'web', confluenceUrl: 'https://c/1', figmaUrls: ['https://f/1', 'https://f/2'] } });
    expect(toNewSession(form({ solutions: ['mobile'] })).name).toBe('session');
  });

  it('turns a refusal into one line', () => {
    expect(startErrorText(422, { error: 'invalid', errors: [{ field: 'name', message: 'a session named "x" already exists' }, { field: 'solutions', message: 'choose at least one solution' }] })).toBe(
      'Not started: a session named "x" already exists; choose at least one solution',
    );
    expect(startErrorText(409, { error: 'branch-exists', message: 'branch session/x already exists' })).toBe('Not started: branch session/x already exists');
    expect(startErrorText(500, null)).toBe('Not started: HTTP 500');
    expect(startErrorText(0, null)).toBe('Not started: Switchboard is not reachable.');
  });
});

describe('folders (D14)', () => {
  const check: FolderCheck = { path: '/ws', canonicalPath: '/ws', exists: true, kind: 'workspace', router: null, solutionCount: 2, repoName: null, problem: null, message: '' };
  function saved(id: string, folderPath: string, kind: Folder['kind'], isDefault = false): Folder {
    const name = folderPath.split('/').pop() ?? folderPath;
    return { id, path: folderPath, canonicalPath: folderPath, name, label: null, displayName: name, kind, isDefault, addedAt: '2026-09-28T00:00:00.000Z', lastUsedAt: null, check };
  }
  const ws = saved('f-ws', '/src/workspace', 'workspace', true);
  const repo = saved('f-repo', '/src/switchboard', 'repo');
  const repoFolder = { id: repo.id, path: repo.path, name: repo.name, displayName: repo.displayName, kind: repo.kind };
  const wsFolder = { id: ws.id, path: ws.path, name: ws.name, displayName: ws.displayName, kind: ws.kind };

  it('takes the prefill folder, else the default one once the saved folders are known', () => {
    expect(formFromPrefill({ folder: ' f-repo ' }).folder).toBe('f-repo');
    expect(formFromPrefill({ folder: '' }).folder).toBeNull();
    expect(resolveFormFolder('f-repo', [ws, repo])).toBe('f-repo');
    expect(resolveFormFolder('gone', [ws, repo])).toBe('f-ws');
    expect(resolveFormFolder(null, [repo, { ...ws, isDefault: true }])).toBe('f-ws');
    expect(resolveFormFolder(null, [])).toBeNull();
  });

  it('lists the saved folders by name, (default) after the default one, the path for a shared name', () => {
    expect(folderChoices([ws, repo]).map((c) => c.label)).toEqual(['workspace (default)', 'switchboard']);
    const twin = saved('f-2', '/other/switchboard', 'repo');
    expect(folderChoices([ws, repo, twin]).map((c) => c.label)).toEqual(['workspace (default)', 'switchboard · /src/switchboard', 'switchboard · /other/switchboard']);
  });

  it('D18: the dropdown shows display names (the path as the tooltip); a display name two folders share (any case) gets the path', () => {
    const named = { ...repo, label: 'Tool box', displayName: 'Tool box' };
    const main = { ...ws, label: 'Main', displayName: 'Main' };
    expect(folderChoices([main, named]).map((c) => [c.id, c.label, c.path])).toEqual([
      ['f-ws', 'Main (default)', '/src/workspace'],
      ['f-repo', 'Tool box', '/src/switchboard'],
    ]);
    const other = saved('f-3', '/other/tool box', 'repo');
    expect(folderChoices([main, named, other]).map((c) => c.label)).toEqual(['Main (default)', 'Tool box · /src/switchboard', 'tool box · /other/tool box']);
    // The summary names the folder by its display name; the repo's solution, cwd and worktree keep its own name.
    const namedFolder = { id: named.id, path: named.path, name: named.name, displayName: named.displayName, kind: named.kind };
    expect(summaryLines(form({ name: 'n', folder: 'f-repo', worktrees: true }), null, [], namedFolder).map((l) => l.text).slice(1, 3)).toEqual([
      'folder    Tool box · git repo',
      'cwd       /src/switchboard-wt-n',
    ]);
    expect(summaryLines(form({ name: 'n', folder: 'f-repo', worktrees: true }), null, [], namedFolder).map((l) => l.text)).toContain('../switchboard-wt-n');
    expect(toSessionBody(form({ name: 'fix', folder: 'f-repo' }), namedFolder)).toMatchObject({ folder: 'f-repo', solutions: ['switchboard'] });
    const mainFolder = { id: main.id, path: main.path, name: main.name, displayName: main.displayName, kind: main.kind };
    expect(summaryLines(form({ name: 'n', solutions: ['mobile'], folder: 'f-ws' }), '/derived', [], mainFolder).map((l) => l.text)[1]).toBe('folder    Main · workspace');
  });

  it('sends the folder with a workspace session and a NewRepoSession for a repo folder', () => {
    const body = toSessionBody(form({ name: 'x', solutions: ['mobile'], folder: 'f-ws' }), wsFolder);
    expect(body).toMatchObject({ name: 'x', solutions: ['mobile'], folder: 'f-ws', workType: 'feature' });
    expect('folder' in toSessionBody(form({ name: 'x', solutions: ['mobile'] }), null)).toBe(false);
    expect(toSessionBody(form({ name: 'fix', task: ' Fix it. ', workType: 'qa', solutions: ['mobile'], folder: 'f-repo', worktrees: true }), repoFolder)).toEqual({
      name: 'fix',
      task: 'Fix it.',
      folder: 'f-repo',
      solutions: ['switchboard'],
      worktrees: true,
      ultracode: false,
    });
    expect(toNewRepoSession(form({ name: 'fix', worktrees: false, ultracode: true }), repoFolder)).toMatchObject({ worktrees: false, ultracode: true });
    expect(isRepoFolder(repoFolder)).toBe(true);
    expect(isRepoFolder(wsFolder)).toBe(false);
    expect(isRepoFolder(null)).toBe(false);
  });

  it('a repo folder starts with a free name alone (no solutions, no QA contract; D22: a taken name gets -2, a title over 80 characters blocks)', () => {
    expect(canStart(form({ name: 'fix', workType: 'qa' }), [], repoFolder)).toBe(true);
    expect(canStart(form({ name: 'fix' }), ['fix'], repoFolder)).toBe(true);
    expect(canStart(form({ name: 'Fix it '.repeat(12) }), [], repoFolder)).toBe(false);
    expect(canStart(form({ name: 'fix' }), [], wsFolder)).toBe(false);
  });

  it('the summary names the folder; a repo shows its cwd (the worktree with Worktree on) and no router lines', () => {
    const lines = summaryLines(form({ name: 'n', solutions: ['mobile'], folder: 'f-ws' }), '/derived', [], wsFolder).map((l) => l.text);
    expect(lines.slice(0, 4)).toEqual(['# claude code · background · Max', 'folder    workspace · workspace', 'cwd       /src/workspace', 'work      feature-building']);
    expect(summaryLines(form({ name: 'n', solutions: ['mobile'] }), '/derived', []).map((l) => l.text)[1]).toBe('cwd       /derived');
    expect(repoSummaryLines(form({ name: 'fix', worktrees: true }), repoFolder, []).map((l) => [l.text, l.tone])).toEqual([
      ['# claude code · background · Max', 'comment'],
      ['folder    switchboard · git repo', 'value'],
      ['cwd       /src/switchboard-wt-fix', 'value'],
      ['ultracode off', 'value'],
      [' ', 'value'],
      ['# worktree', 'comment'],
      ['../switchboard-wt-fix', 'path'],
      [' ', 'value'],
      ['✓ task + worktree note · no router answers', 'ok'],
    ]);
    const inPlace = summaryLines(form({ name: 'fix', worktrees: false }), null, ['fix'], repoFolder).map((l) => l.text);
    expect(inPlace).toEqual([
      '# claude code · background · Max',
      'folder    switchboard · git repo',
      'cwd       /src/switchboard',
      'ultracode off',
      ' ',
      '# no worktree · edits in place',
      // D22: "fix" is taken, so the session is fix-2.
      'name      fix-2',
      ' ',
      '✓ task only · no router answers',
    ]);
  });
});
