import { describe, expect, it } from 'vitest';
import type { Folder, FolderCheck, Solution, SolutionGroup } from '../../src/core/api.ts';
import { BRANCH_REQUIRED, BRANCH_RULE } from '../../src/core/ticket-branch.ts';
import { toScheduleInput } from '../../src/web/modals/schedule-form.ts';
import {
  DEFAULT_FORM,
  type NewSessionForm,
  RECOMMENDED,
  UNKNOWN_FOLDER,
  branchBlocks,
  branchCheck,
  canStart,
  chipGroups,
  figmaUrlList,
  folderChoices,
  formBranch,
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
  showsBranch,
  showsCoordination,
  showsQa,
  SOLUTIONS_BY_AGENT,
  SOLUTIONS_HINT_NONE,
  solutionsHint,
  startErrorText,
  summaryLines,
  toNewSession,
  toStartBody,
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
      branch: null,
      model: null,
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
  it('is the prototype nsSummary for an orchestrator feature session with worktrees (D32: plus the branch line)', () => {
    const lines = summaryLines(form({ name: 'free-talk-640', mode: 'orchestrator', solutions: ['acme-app-front', 'mobile'], branch: 'PROJ-0640-free-talk' }), 'D:\\acme', []);
    expect(lines).toEqual([
      { text: '# claude code · background · Max', tone: 'comment' },
      { text: 'cwd       D:\\acme', tone: 'value' },
      { text: 'work      feature-building', tone: 'value' },
      { text: 'mode      workspace orchestrator', tone: 'value' },
      { text: 'phase     UI-first', tone: 'value' },
      { text: 'ultracode off', tone: 'value' },
      { text: ' ', tone: 'value' },
      { text: '# worktrees', tone: 'comment' },
      { text: 'branch    PROJ-0640-free-talk', tone: 'value' },
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

    // D22: a taken name is no warning any more: the short name gets -2 (and the summary says so, without worktrees).
    expect(summaryLines(form({ solutions: ['mobile'], worktrees: false }), '/ws', ['session']).map((l) => l.text)).toContain('name      session-2');
    // D32: with worktrees, the branch line (— until the Branch field is a ticket branch) and its warning.
    const qa = summaryLines(form({ workType: 'qa', solutions: [] }), '/ws', ['session']).map((l) => l.text);
    expect(qa).toContain('work      test-authoring (QA)');
    expect(qa).toContain('stack     —');
    expect(qa).toContain('branch    —');
    expect(qa).not.toContain('name      session-2');
    // D38: no solutions is no warning: the agent determines them.
    expect(qa).toContain('solutions  chosen by the agent');
    expect(qa.filter((t) => t.startsWith('⚠'))).toEqual([
      '⚠ name the branch after its ticket',
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
  it('is disabled with a title over 80 characters or an incomplete QA contract, not without solutions (D38; D22: a taken name gets -2)', () => {
    const branch = 'PROJ-1-work';
    // D38: none picked = the agent determines them.
    expect(canStart(form({ solutions: [], branch }), [])).toBe(true);
    expect(canStart(form({ solutions: [] }), [])).toBe(false);
    expect(canStart(form({ solutions: ['mobile'], branch }), [])).toBe(true);
    expect(canStart(form({ name: 'taken', solutions: ['mobile'], branch }), ['taken'])).toBe(true);
    expect(canStart(form({ solutions: ['mobile'], branch }), ['session'])).toBe(true);
    expect(canStart(form({ name: 'T'.repeat(80), solutions: ['mobile'], branch }), [])).toBe(true);
    expect(canStart(form({ name: 'T'.repeat(81), solutions: ['mobile'], branch }), [])).toBe(false);
    const qa = form({ workType: 'qa', solutions: ['mobile'], branch });
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
    // D32: with its worktree (the default) it also needs a ticket branch; without one the name alone.
    expect(canStart(form({ name: 'fix', workType: 'qa', branch: 'PROJ-1-fix' }), [], repoFolder)).toBe(true);
    expect(canStart(form({ name: 'fix', branch: 'PROJ-1-fix' }), ['fix'], repoFolder)).toBe(true);
    expect(canStart(form({ name: 'fix' }), [], repoFolder)).toBe(false);
    expect(canStart(form({ name: 'fix', worktrees: false }), ['fix'], repoFolder)).toBe(true);
    expect(canStart(form({ name: 'Fix it '.repeat(12), branch: 'PROJ-1-fix' }), [], repoFolder)).toBe(false);
    // D38: a workspace folder no longer needs a picked solution either.
    expect(canStart(form({ name: 'fix', branch: 'PROJ-1-fix' }), [], wsFolder)).toBe(true);
    expect(canStart(form({ name: 'fix', workType: 'qa', branch: 'PROJ-1-fix' }), [], wsFolder)).toBe(false);
  });

  it('the summary names the folder; a repo shows its cwd (the worktree with Worktree on) and no router lines', () => {
    const lines = summaryLines(form({ name: 'n', solutions: ['mobile'], folder: 'f-ws' }), '/derived', [], wsFolder).map((l) => l.text);
    expect(lines.slice(0, 4)).toEqual(['# claude code · background · Max', 'folder    workspace · workspace', 'cwd       /src/workspace', 'work      feature-building']);
    expect(summaryLines(form({ name: 'n', solutions: ['mobile'] }), '/derived', []).map((l) => l.text)[1]).toBe('cwd       /derived');
    expect(repoSummaryLines(form({ name: 'fix', worktrees: true, branch: 'PROJ-7-fix-the-build' }), repoFolder, []).map((l) => [l.text, l.tone])).toEqual([
      ['# claude code · background · Max', 'comment'],
      ['folder    switchboard · git repo', 'value'],
      ['cwd       /src/switchboard-wt-fix', 'value'],
      ['ultracode off', 'value'],
      [' ', 'value'],
      ['# worktree', 'comment'],
      ['branch    PROJ-7-fix-the-build', 'value'],
      ['../switchboard-wt-fix', 'path'],
      [' ', 'value'],
      ['✓ task + worktree note · no router answers', 'ok'],
    ]);
    // D32: without a ticket branch yet: `—` and the warning.
    expect(repoSummaryLines(form({ name: 'fix', worktrees: true, branch: 'fix' }), repoFolder, []).map((l) => l.text).slice(5, 9)).toEqual([
      '# worktree',
      'branch    —',
      '../switchboard-wt-fix',
      '⚠ name the branch after its ticket',
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

describe('Branch field (D32)', () => {
  const repoFolder = { id: 'f-repo', path: '/src/switchboard', name: 'switchboard', displayName: 'switchboard', kind: 'repo' as const };

  it('shows only while a worktree is made; follows a ticket title until the developer types in it', () => {
    expect(showsBranch(form())).toBe(true);
    expect(showsBranch(form({ worktrees: false }))).toBe(false);
    expect(formBranch(form({ name: 'PROJ-1984 Purchase complete' }))).toBe('PROJ-1984-purchase-complete');
    expect(formBranch(form({ name: 'JIRA Ticket handling' }))).toBe('');
    expect(formBranch(form({ name: 'PROJ-1984 Purchase complete', branch: 'PROJ-2-other' }))).toBe('PROJ-2-other');
    // Cleared by the developer: stays empty (no longer follows the title).
    expect(formBranch(form({ name: 'PROJ-1984 Purchase complete', branch: '' }))).toBe('');
  });

  it('checks the branch: a message under the field and Start disabled until it is a ticket branch', () => {
    expect(branchCheck(form())).toEqual({ ok: false, message: BRANCH_REQUIRED });
    expect(branchCheck(form({ branch: 'proj-1-x' }))).toEqual({ ok: false, message: BRANCH_RULE });
    expect(branchCheck(form({ name: 'PROJ-1984' }))).toEqual({ ok: false, message: BRANCH_RULE });
    expect(branchCheck(form({ name: 'PROJD-0001 Test ticket name' }))).toEqual({ ok: true, name: 'PROJD-0001-test-ticket-name' });
    expect(branchBlocks(form({ solutions: ['mobile'] }))).toBe(true);
    expect(branchBlocks(form({ solutions: ['mobile'], worktrees: false }))).toBe(false);
    expect(canStart(form({ solutions: ['mobile'] }), [])).toBe(false);
    expect(canStart(form({ solutions: ['mobile'], worktrees: false }), [])).toBe(true);
    expect(canStart(form({ name: 'PROJ-1984 Purchase complete', solutions: ['mobile'] }), [])).toBe(true);
    expect(canStart(form({ name: 'PROJ-1984 Purchase complete', solutions: ['mobile'], branch: 'nope' }), [])).toBe(false);
  });

  it('Start posts the branch only with a worktree (workspace: one branch for every solution; repo folder); a schedule never', () => {
    expect(toStartBody(form({ name: 'PROJ-1984 Purchase complete', solutions: ['acme-app-front', 'mobile'] }), null, [])).toMatchObject({
      name: 'proj-1984-purchase-complete',
      title: 'PROJ-1984 Purchase complete',
      solutions: ['acme-app-front', 'mobile'],
      worktrees: true,
      branch: 'PROJ-1984-purchase-complete',
    });
    expect(toStartBody(form({ name: 'x', branch: ' PROJ-5-x ' }), repoFolder, [])).toMatchObject({ worktrees: true, branch: 'PROJ-5-x' });
    expect('branch' in toStartBody(form({ name: 'x', solutions: ['mobile'], worktrees: false, branch: 'PROJ-5-x' }), null, [])).toBe(false);
    expect('branch' in toSessionBody(form({ name: 'x', solutions: ['mobile'], branch: 'PROJ-5-x' }), null)).toBe(false);
    expect(toScheduleInput(form({ name: 'nightly', task: 'Check.', solutions: ['mobile'], branch: 'PROJ-5-x' }), '0 2 * * *', undefined).template).not.toHaveProperty('branch');
  });

  it('a prefilled branch counts as typed', () => {
    expect(formFromPrefill({ name: 'PROJ-1 a', branch: ' PROJ-2-b ' }).branch).toBe('PROJ-2-b');
    expect(formFromPrefill({ branch: '  ' }).branch).toBeNull();
  });
});

describe('D38 · solutions chosen by the agent', () => {
  const ws = { id: 'f-ws', path: '/ws', name: 'ws', displayName: 'ws', kind: 'workspace' } as const;
  const repo = { id: 'f-repo', path: '/r/app', name: 'app', displayName: 'app', kind: 'repo' } as const;

  it('Start needs no picked solution in a workspace folder; the other rules stay (QA contract, the D32 branch, the title)', () => {
    expect(canStart(form({ name: 'Free talk', branch: 'PROJ-1-free-talk' }), [], ws)).toBe(true);
    expect(canStart(form({ name: 'Free talk', worktrees: false }), [], ws)).toBe(true);
    // Worktrees on: the Branch field still shows (the agent may create a worktree) and is still required.
    expect(showsBranch(form())).toBe(true);
    expect(canStart(form({ name: 'Free talk' }), [], ws)).toBe(false);
    expect(canStart(form({ workType: 'qa', worktrees: false }), [], ws)).toBe(false);
    expect(canStart(form({ workType: 'qa', worktrees: false, stack: 'web', confluenceUrl: 'https://c/1', figmaUrls: 'https://f/1' }), [], ws)).toBe(true);
    expect(canStart(form({ name: 'T'.repeat(81), worktrees: false }), [], ws)).toBe(false);
  });

  it('the summary reads `solutions  chosen by the agent` instead of the warning, with and without worktrees', () => {
    expect(SOLUTIONS_BY_AGENT).toBe('solutions  chosen by the agent');
    expect(summaryLines(form({ name: 'PROJ-12 Free talk' }), null, [], ws)).toEqual([
      { text: '# claude code · background · Max', tone: 'comment' },
      { text: 'folder    ws · workspace', tone: 'value' },
      { text: 'cwd       /ws', tone: 'value' },
      { text: 'work      feature-building', tone: 'value' },
      { text: 'mode      single-solution', tone: 'value' },
      { text: 'phase     UI-first', tone: 'value' },
      { text: 'ultracode off', tone: 'value' },
      { text: ' ', tone: 'value' },
      { text: '# worktrees', tone: 'comment' },
      { text: 'branch    PROJ-12-free-talk', tone: 'value' },
      { text: 'solutions  chosen by the agent', tone: 'value' },
      { text: ' ', tone: 'value' },
      { text: '✓ answers pre-filled → agent confirms, no re-ask', tone: 'ok' },
    ]);
    const inPlace = summaryLines(form({ name: 'free-talk', worktrees: false }), null, [], ws).map((line) => line.text);
    expect(inPlace.slice(8)).toEqual(['# no worktrees · edits in place', 'solutions  chosen by the agent', ' ', '✓ answers pre-filled → agent confirms, no re-ask']);
    expect(inPlace.some((text) => text.startsWith('⚠'))).toBe(false);
    // Picked solutions keep their worktree folders and no such line.
    const picked = summaryLines(form({ name: 'free-talk', solutions: ['mobile'], branch: 'PROJ-1-x' }), null, [], ws).map((line) => line.text);
    expect(picked).toContain('../mobile-wt-free-talk');
    expect(picked).not.toContain(SOLUTIONS_BY_AGENT);
  });

  it('the chips hint says to leave them empty while none is picked; a repo folder is unchanged', () => {
    expect(solutionsHint(form(), ws)).toBe(SOLUTIONS_HINT_NONE);
    expect(SOLUTIONS_HINT_NONE).toBe('0 selected · leave empty to let the agent choose · read-only folders locked');
    expect(solutionsHint(form({ solutions: ['mobile', 'web-front'] }), ws)).toBe('2 selected · read-only folders locked');
    expect(solutionsHint(form(), null)).toBe(SOLUTIONS_HINT_NONE);
    expect(solutionsHint(form(), repo)).toBe('1 selected · a git repo is one solution');
    expect(repoSummaryLines(form({ name: 'fix', branch: 'PROJ-1-fix' }), repo, []).map((line) => line.text)).not.toContain(SOLUTIONS_BY_AGENT);
  });

  it('Start posts an empty `solutions` for a workspace (and the branch with worktrees)', () => {
    expect(toStartBody(form({ name: 'PROJ-12 Free talk', folder: 'f-ws' }), ws, [])).toMatchObject({ name: 'proj-12-free-talk', solutions: [], worktrees: true, branch: 'PROJ-12-free-talk', folder: 'f-ws' });
    expect(toStartBody(form({ name: 'free-talk', worktrees: false }), ws, [])).toMatchObject({ solutions: [], worktrees: false });
  });
});
