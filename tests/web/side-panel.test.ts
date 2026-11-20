import { describe, expect, it } from 'vitest';
import { AGENT_PAGE_BYTES, type AgentDirListing, type AgentFileRef, type AgentPageInfo, fileKindByName, isPageName } from '../../src/core/agent-files.ts';
import type { Agent, SessionDetail, WorkflowRun } from '../../src/core/api.ts';
import type { TurnChange } from '../../src/core/turn-changes.ts';
import { FILES_TAB_START, fold, unfold, withListing } from '../../src/web/v2/agent/files-tab-state.ts';
import { linksSignature } from '../../src/web/v2/agent/useAgentFiles.ts';
import type { ChatRow } from '../../src/web/v2/agent/chat-model.ts';
import { type TreeFile, changedTree, fileState, firstFileKey } from '../../src/web/v2/agent/changes-tree.ts';
import { shownChoice, viewChoices, viewKey } from '../../src/web/v2/agent/changes-view.ts';
import { scopeOptions } from '../../src/web/views/session/diff.ts';
import { type DiffComment, commentsAt, reviewMessage } from '../../src/web/v2/agent/diff-comments.ts';
import { helpersOverview } from '../../src/web/v2/agent/helpers-view.ts';
import { type OverviewItem, foldOverview, overviewItems, overviewSummary } from '../../src/web/v2/agent/side-model.ts';
import { pageFootText, pageLeftNote, pageOpensAs, pageScriptsAction } from '../../src/web/v2/agent/page-view.ts';
import { leavePanelAddress } from '../../src/web/v2/agent/panel-routes.ts';
import { SIDE_DEFAULT_WIDTH, SIDE_SETTINGS_KEY, loadSide, shownSideTab } from '../../src/web/v2/agent/side-settings.ts';
import { lastRepliesOf, lastTurnChange } from '../../src/web/v2/agent/turn-changes.ts';

/**
 * SPIKE · side panel: the pure parts of "what this turn changed", "since your
 * review" and the comments on diff lines.
 */

function reply(id: number, turnEventId: number | null, cont = false): ChatRow {
  return { kind: 'reply', key: `r:${id}`, id, text: 'text', cut: null, n: 1, time: null, at: null, cont, note: false, hasCode: false, turnEventId };
}

function you(id: number): ChatRow {
  return { kind: 'you', key: `u:${id}`, id, text: 'do it', origin: 'user', attachments: [], delivered: true, queued: null, notSent: false, heldNote: null, loop: null, cut: null, time: null, at: null, cont: false };
}

const WORDS = { head: 'Since last save point', branch: 'Whole separate copy', repo: 'All unsaved', review: 'For review' } as const;

function change(turn: number, through = turn): TurnChange {
  return { turn, eventId: turn * 10, through, files: 2, added: 5, removed: 1 };
}

describe('the "N files changed" chip', () => {
  it('sits under the last reply of each turn only, never under a reply without a turn', () => {
    const rows: ChatRow[] = [you(1), reply(2, 1), reply(3, 1, true), you(4), reply(5, 4), { kind: 'gap', key: 'g', text: 'Later' }, reply(6, null)];
    expect([...lastRepliesOf(rows)].sort()).toEqual([3, 5]);
  });
});

describe('what the Files tab remembers per agent', () => {
  const listing = (dir: string, names: readonly string[]): AgentDirListing => ({ dir, root: 'C:\\work', parent: null, truncated: false, entries: names.map((name) => ({ name, path: `${dir}\\${name}`, type: 'file' as const, size: 1, modifiedAt: null })) });

  it('starts with nothing unfolded, nothing opened, and "Touched by this agent" cut to its first rows', () => {
    expect(FILES_TAB_START).toMatchObject({ roots: null, dirs: {}, opened: false, showAll: false, history: { items: [], at: -1 } });
  });

  it('unfolds a folder (loading until its listing comes), folds it again, and keeps the other folders as they are', () => {
    let state = unfold(FILES_TAB_START, 'C:\\work');
    state = unfold(state, 'C:\\work\\src');
    expect(state.dirs).toEqual({ 'C:\\work': 'loading', 'C:\\work\\src': 'loading' });
    state = withListing(state, 'C:\\work\\src', listing('C:\\work\\src', ['app.cs']));
    expect(state.dirs['C:\\work\\src']).toMatchObject({ entries: [{ name: 'app.cs' }] });
    // Folding the first leaves the second unfolded underneath (it shows again when the first is unfolded).
    state = fold(state, 'C:\\work');
    expect(Object.keys(state.dirs)).toEqual(['C:\\work\\src']);
  });

  it('drops a listing that arrives after its folder was folded again', () => {
    const folded = fold(unfold(FILES_TAB_START, 'C:\\work'), 'C:\\work');
    expect(withListing(folded, 'C:\\work', listing('C:\\work', ['README.md'])).dirs).toEqual({});
    expect(withListing(folded, 'C:\\work', { error: 'gone' }).dirs).toEqual({});
  });
});

describe('an HTML file shown as a page', () => {
  it('is offered for an HTML file only (its source is still text)', () => {
    expect(['index.html', 'Old.HTM', 'C:\\work\\site\\about.html'].map(isPageName)).toEqual([true, true, true]);
    expect(['README.md', 'logo.svg', 'page.xhtml', 'View.cshtml', 'NoteList.razor', 'html', '.html'].map(isPageName)).toEqual([false, false, false, false, false, false, false]);
    expect(fileKindByName('index.html')).toBe('text');
  });

  const info = (over: Partial<AgentPageInfo> = {}): AgentPageInfo => ({ loaded: 0, left: [], leftMore: 0, scripted: false, ...over });

  it('opens as its page, unless it was opened at a line (the source is what a line number means) or is too big to show as one', () => {
    expect(pageOpensAs(null, 289)).toBe('rendered');
    expect(pageOpensAs(12, 289)).toBe('source');
    expect([pageOpensAs(null, AGENT_PAGE_BYTES), pageOpensAs(null, AGENT_PAGE_BYTES + 1)]).toEqual(['rendered', 'source']);
  });

  it('says under a page how many of its files came with it and, when it has scripts, whether they run', () => {
    expect(pageFootText(info(), false, '1.0 KB')).toBe('1.0 KB');
    expect(pageFootText(info({ loaded: 1 }), false, '1.0 KB')).toBe('1 file loaded with it · 1.0 KB');
    expect(pageFootText(info({ loaded: 2, scripted: true }), false, '289 B')).toBe('2 files loaded with it · its scripts are off · 289 B');
    expect(pageFootText(info({ loaded: 3, scripted: true }), true, '289 B')).toBe('3 files loaded with it · its scripts run · 289 B');
    expect([pageScriptsAction(false), pageScriptsAction(true)]).toEqual(['Run its scripts', 'Stop its scripts']);
  });

  it('says nothing above a page that is shown whole', () => {
    expect(pageLeftNote(info({ loaded: 2 }))).toBeNull();
  });

  it('names the first thing that was not loaded with why, counts the rest, and lists all it knows', () => {
    const remote = { ref: 'https://cdn.example.com/lib/app.min.js?v=3', why: 'remote' as const };
    expect(pageLeftNote(info({ left: [remote] }))).toEqual({
      text: 'Not loaded: app.min.js (another address, nothing is fetched)',
      lines: ['https://cdn.example.com/lib/app.min.js?v=3: another address, nothing is fetched'],
    });
    const note = pageLeftNote(info({ loaded: 1, left: [{ ref: '/css/site.css', why: 'site-root' }, { ref: 'gone.png', why: 'missing' }, { ref: '../other/a.css', why: 'outside' }, remote], leftMore: 7 }));
    expect(note?.text).toBe('Not loaded: site.css (starts at the site’s root, which one file does not tell) and 10 more');
    expect(note?.lines).toEqual([
      '/css/site.css: starts at the site’s root, which one file does not tell',
      'gone.png: no such file, or it cannot be read',
      '../other/a.css: not in the page’s own folders',
      'https://cdn.example.com/lib/app.min.js?v=3: another address, nothing is fetched',
      '… and 7 more',
    ]);
  });
});

describe("the chat links' lookup", () => {
  const file = (over: Partial<AgentFileRef> = {}): AgentFileRef => ({ path: 'C:\\work\\README.md', name: 'README.md', dir: 'C:\\work', sources: ['mentioned'], mentionedAs: ['README.md'], line: 3, exists: true, ...over });

  it('stays the same when the same files are read again (so the chat is not rendered again), and changes with a link', () => {
    const base = linksSignature([file()]);
    // Why a file is listed does not change its link.
    expect(linksSignature([file({ sources: ['read', 'mentioned'] })])).toBe(base);
    expect(linksSignature([file({ line: 4 })])).not.toBe(base);
    expect(linksSignature([file({ mentionedAs: ['README.md', './README.md'] })])).not.toBe(base);
    expect(linksSignature([file(), file({ path: 'C:\\work\\app.js', name: 'app.js', mentionedAs: ['app.js'], line: null })])).not.toBe(base);
    // A file that is gone is no link.
    expect(linksSignature([file({ exists: false })])).toBe('');
    expect(linksSignature(null)).toBe('');
  });
});

describe('the views the Changes panel offers (D180, with D174 For review)', () => {
  const targets = (review: boolean, worktree = false, inPlace = false) => ({
    worktrees: worktree ? [{ repo: 'acme', path: 'C:\\w', branch: 'b', base: null, commits: 0 }] : [],
    inPlace: inPlace ? ['acme'] : [],
    ...(review ? { review: { since: '2026-11-20T10:00:00.000Z' } } : {}),
  });

  it("offers the Diff's own views without a picked turn: For review only while a review is pending, first", () => {
    // Line under test: `viewChoices` pushing the scopes in `scopeOptions`' order.
    expect(viewChoices({ kind: 'scope' }, scopeOptions(targets(false, true) as never), WORDS).map((choice) => choice.label)).toEqual(['Since last save point', 'Whole separate copy']);
    expect(viewChoices({ kind: 'scope' }, scopeOptions(targets(true, true, true) as never), WORDS).map((choice) => choice.label)).toEqual(['For review', 'Since last save point', 'Whole separate copy', 'All unsaved']);
  });

  it('puts a picked turn first, then Last turn, then For review and the other views', () => {
    const last = change(5);
    expect(viewChoices({ kind: 'turn', change: change(4, 4) }, ['review', 'head', 'repo'], WORDS, last)).toEqual([
      { value: 'turn', label: 'Turn 4' },
      { value: 'last', label: 'Last turn' },
      { value: 'review', label: 'For review' },
      { value: 'head', label: 'Since last save point' },
      { value: 'repo', label: 'All unsaved' },
    ]);
    // A turn range keeps its label.
    expect(viewChoices({ kind: 'turn', change: change(4, 5) }, ['head'], WORDS)[0]).toEqual({ value: 'turn', label: 'Turns 4–5' });
  });

  it("fetches again when the turn or the Diff's view changes; the Diff's view does not matter while a turn is shown", () => {
    const keys = [viewKey({ kind: 'scope' }, 'head'), viewKey({ kind: 'scope' }, 'branch'), viewKey({ kind: 'scope' }, 'review'), viewKey({ kind: 'turn', change: change(4) }, 'head'), viewKey({ kind: 'turn', change: change(5) }, 'head')];
    expect(new Set(keys).size).toBe(5);
    expect(viewKey({ kind: 'turn', change: change(4) }, 'head')).toBe(viewKey({ kind: 'turn', change: change(4) }, 'branch'));
  });

  it('always offers "Last turn" when the last turn changed something, and names a picked turn only when it is another one', () => {
    const last = change(5);
    expect(viewChoices({ kind: 'scope' }, ['head'], WORDS, last)).toEqual([
      { value: 'last', label: 'Last turn' },
      { value: 'head', label: 'Since last save point' },
    ]);
    // The last turn itself is picked (from its chip): it is "Last turn", not "Turn 5" as well.
    expect(viewChoices({ kind: 'turn', change: last }, ['head'], WORDS, last).map((choice) => choice.value)).toEqual(['last', 'head']);
    expect(shownChoice({ kind: 'turn', change: last }, 'head', last)).toBe('last');
    expect(shownChoice({ kind: 'turn', change: change(3) }, 'head', last)).toBe('turn');
    expect([shownChoice({ kind: 'scope' }, 'review', last), shownChoice({ kind: 'scope' }, 'branch', last)]).toEqual(['review', 'branch']);
  });

  it('takes for the last turn the newest turn with changes, when it reaches the agent\'s latest turn', () => {
    expect(lastTurnChange([change(1), change(2), change(5)], 5)).toEqual(change(5));
    // Two messages that ran as one turn (4–5): that is the last turn.
    expect(lastTurnChange([change(2), change(4, 5)], 5)).toEqual(change(4, 5));
    // The latest turn changed nothing: there is no "Last turn" to show.
    expect(lastTurnChange([change(1), change(3)], 5)).toBeNull();
    expect(lastTurnChange([], 0)).toBeNull();
  });
});

describe('the tree of changed files', () => {
  const f = (path: string, added = 1, removed = 0, repo = 'acme-notes', state: TreeFile['state'] = 'changed'): TreeFile => ({ key: `${repo}\u0000${path}`, repo, path, added, removed, state });
  const files = [f('src/Acme.Notes/Services/NoteService.cs', 18, 3), f('README.md', 2, 1), f('src/Acme.Notes/Components/NoteList.razor', 20, 4), f('app.js', 1, 0), f('docs/new.md', 7, 0, 'acme-notes', 'new')];
  /** The rows as short lines: indentation = depth, a folder with what it holds. */
  const lines = (rows: ReturnType<typeof changedTree>): string[] =>
    rows.map((row) => `${'  '.repeat(row.depth)}${row.kind === 'folder' ? `${row.open ? '▾' : '▸'} ${row.label} (${row.files}: +${row.added} −${row.removed})` : `${row.name}${row.file.state === 'changed' ? '' : ` [${row.file.state}]`}`}`);

  it('folds the files into their folders: folders first, by name, a chain of single folders as one row, each folder with what it holds', () => {
    expect(lines(changedTree(files))).toEqual([
      '▾ docs (1: +7 −0)',
      '  new.md [new]',
      '▾ src / Acme.Notes (2: +38 −7)',
      '  ▾ Components (1: +20 −4)',
      '    NoteList.razor',
      '  ▾ Services (1: +18 −3)',
      '    NoteService.cs',
      'app.js',
      'README.md',
    ]);
    expect(firstFileKey(changedTree(files))).toBe('acme-notes\u0000docs/new.md');
    // By name, upper and lower case together (not all capitals first), whatever order the files come in.
    const mixed = ['b.md', 'Zeta.md', 'alpha.md', 'Beta.md', 'a.md', 'C.md', 'Docs/x.md', 'app/y.md', 'Build/z.md'];
    for (const order of [mixed, [...mixed].reverse(), [...mixed].sort()]) {
      expect(lines(changedTree(order.map((name) => f(name)))).map((line) => line.trim().replace(/ \(.*$/, ''))).toEqual(['▾ app', 'y.md', '▾ Build', 'z.md', '▾ Docs', 'x.md', 'a.md', 'alpha.md', 'b.md', 'Beta.md', 'C.md', 'Zeta.md']);
    }
    expect(changedTree([])).toEqual([]);
    expect(firstFileKey([])).toBeNull();
  });

  it('keeps a folded folder as one row that still says what it holds', () => {
    const top = changedTree(files).find((row) => row.kind === 'folder' && row.label === 'src / Acme.Notes');
    const closed = new Set([top && top.kind === 'folder' ? top.id : '']);
    expect(lines(changedTree(files, { closed }))).toEqual(['▾ docs (1: +7 −0)', '  new.md [new]', '▸ src / Acme.Notes (2: +38 −7)', 'app.js', 'README.md']);
    // `firstFileKey` reads the rows it is given: here the first file that still shows. (The panel asks it for the whole tree: a fold or a filter does not change the file it shows.)
    expect(firstFileKey(changedTree(files, { closed: new Set([...closed, 'acme-notes\u0000docs']) }))).toBe('acme-notes\u0000app.js');
  });

  it('keeps a folded row folded when its chain of folders gets shorter or longer as files come and go', () => {
    const folder = (rows: ReturnType<typeof changedTree>, label: string) => {
      const row = rows.find((candidate) => candidate.kind === 'folder' && candidate.label === label);
      if (!row || row.kind !== 'folder') throw new Error(`no folder "${label}"`);
      return row;
    };
    const one = [f('src/app/pages/a.ts')];
    const two = [...one, f('src/app/x.ts')];
    // Folding "src / app / pages" folds every folder of the chain.
    const chain = new Set(folder(changedTree(one), 'src / app / pages').ids);
    expect(chain).toEqual(new Set(['acme-notes\u0000src', 'acme-notes\u0000src/app', 'acme-notes\u0000src/app/pages']));
    // A file appears in a middle folder: the row is "src / app" now, and still folded.
    expect(lines(changedTree(two, { closed: chain }))).toEqual(['▸ src / app (2: +2 −0)']);
    // The other way round: "pages" is folded under "src / app", then the file beside it goes: the longer chain is the folded row.
    const pages = new Set(folder(changedTree(two), 'pages').ids);
    expect(lines(changedTree(two, { closed: pages }))).toEqual(['▾ src / app (2: +2 −0)', '  ▸ pages (1: +1 −0)', '  x.ts']);
    expect(lines(changedTree(one, { closed: pages }))).toEqual(['▸ src / app / pages (1: +1 −0)']);
    // A project's row is one folder.
    expect(folder(changedTree([f('a.ts', 1, 0, 'web'), f('b.ts', 1, 0, 'auth')]), 'web').ids).toEqual(['web\u0000']);
  });

  it('filters by every word in the path, shows what matches unfolded, and joins what is left of the folders', () => {
    const closed = new Set(changedTree(files).flatMap((row) => (row.kind === 'folder' ? [row.id] : [])));
    expect(lines(changedTree(files, { filter: ' note  SERV ', closed }))).toEqual(['▾ src / Acme.Notes / Services (1: +18 −3)', '  NoteService.cs']);
    expect(lines(changedTree(files, { filter: 'md' }))).toEqual(['▾ docs (1: +7 −0)', '  new.md [new]', 'README.md']);
    expect(changedTree(files, { filter: 'nothing-like-this' })).toEqual([]);
  });

  it('puts each code project first when the agent changed more than one, also while a filter leaves one', () => {
    const two = [f('src/a.ts', 1, 0, 'web'), f('src/b.ts', 2, 0, 'auth'), f('README.md', 1, 1, 'web')];
    expect(lines(changedTree(two))).toEqual(['▾ auth (1: +2 −0)', '  ▾ src (1: +2 −0)', '    b.ts', '▾ web (2: +2 −1)', '  ▾ src (1: +1 −0)', '    a.ts', '  README.md']);
    expect(lines(changedTree(two, { filter: 'readme' }))).toEqual(['▾ web (1: +1 −1)', '  README.md']);
    // With several projects their names can be typed too (with one project the name is on no row, so it filters nothing).
    expect(lines(changedTree(two, { filter: 'auth' }))).toEqual(['▾ auth (1: +2 −0)', '  ▾ src (1: +2 −0)', '    b.ts']);
    expect(changedTree([f('src/a.ts', 1, 0, 'web')], { filter: 'web' })).toEqual([]);
    // A folder of one project is folded alone: the folder of the same name in the other stays as it is.
    expect(lines(changedTree(two, { closed: new Set(['web\u0000src']) }))).toEqual(['▾ auth (1: +2 −0)', '  ▾ src (1: +2 −0)', '    b.ts', '▾ web (2: +2 −1)', '  ▸ src (1: +1 −0)', '  README.md']);
    // A whole project folds too.
    expect(lines(changedTree(two, { closed: new Set(['web\u0000']) }))).toEqual(['▾ auth (1: +2 −0)', '  ▾ src (1: +2 −0)', '    b.ts', '▸ web (2: +2 −1)']);
    // The same path in two projects is two files.
    const same = changedTree([f('package.json', 1, 0, 'web'), f('package.json', 1, 0, 'auth')]).filter((row) => row.kind === 'file');
    expect(same.map((row) => (row.kind === 'file' ? row.key : ''))).toEqual(['auth\u0000package.json', 'web\u0000package.json']);
  });

  it('tells a new file and a deleted one from a changed one by its first hunk', () => {
    expect(fileState(['@@ -0,0 +1,3 @@', '+a', '+b', '+c'])).toBe('new');
    expect(fileState(['@@ -1,2 +0,0 @@', '-a', '-b'])).toBe('deleted');
    expect(fileState(['@@ -1,2 +1,3 @@ class A', ' a', '+b', ' c'])).toBe('changed');
    expect(fileState(['@@ -1 +1 @@', '-a', '+b'])).toBe('changed');
    expect(fileState([])).toBe('changed');
  });
});

describe('what the side panel remembers', () => {
  const stored = (value: unknown) => ({ getItem: (key: string) => (key === SIDE_SETTINGS_KEY ? JSON.stringify(value) : null), setItem: () => undefined });

  it('opens on Changes at first, keeps a tab it knows, and has one width whatever the tab', () => {
    expect(loadSide(null)).toEqual({ tab: 'changes', width: SIDE_DEFAULT_WIDTH });
    expect(loadSide(stored({ tab: 'helpers', width: 700 }))).toEqual({ tab: 'helpers', width: 700 });
    expect(loadSide(stored({ tab: 'details', width: 700 })).tab).toBe('details');
    expect(loadSide(stored({ tab: 'nonsense', width: 12 }))).toEqual({ tab: 'changes', width: SIDE_DEFAULT_WIDTH });
    // What an earlier build stored (a width per kind of tab): the reading width is the one kept.
    expect(loadSide(stored({ tab: 'files', width: 344, wideWidth: 904 }))).toEqual({ tab: 'files', width: 904 });
  });

  it('shows Changes instead of a tab that has nothing to show for this agent', () => {
    expect(shownSideTab('helpers', { helpers: false })).toBe('changes');
    expect(shownSideTab('helpers', { helpers: true })).toBe('helpers');
    expect([shownSideTab('details', { helpers: false }), shownSideTab('files', { helpers: false })]).toEqual(['details', 'files']);
  });
});

describe('an address that only opens something in the side panel', () => {
  it("is left one step back when it was opened from the agent's own page, so Back does not meet that page twice", () => {
    expect(leavePanelAddress('/agents/a1', '/agents/a1')).toBe('back');
  });

  it('is replaced when it came from anywhere else: another page, another tab of the agent, a pasted or reloaded address', () => {
    expect(leavePanelAddress('/', '/agents/a1')).toBe('replace');
    expect(leavePanelAddress('/agents/b2', '/agents/a1')).toBe('replace');
    // Back from there must return to Results, not skip it.
    expect(leavePanelAddress('/agents/a1/results', '/agents/a1')).toBe('replace');
    expect(leavePanelAddress(null, '/agents/a1')).toBe('replace');
  });
});

describe('the helpers the side panel lists', () => {
  const NOW = Date.parse('2026-11-18T12:00:00.000Z');
  const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
  const helper = (id: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({ id, kind: 'subagent', name: id, description: null, solutionPath: null, branch: null, status, statusText: null, toolUseId: `call-${id}`, workflow: null, startedAt: ago(60), updatedAt: ago(60), endedAt: null, ...extra });
  const ofRun = (id: string, runId: string, endedAt: string): Agent =>
    helper(id, 'done', { kind: 'workflow', toolUseId: null, updatedAt: null, endedAt, workflow: { runId, index: 1, agentId: id, phase: null, model: null, startedAt: ago(60), endedAt, action: null, cwd: null, version: 0 } });
  const run = (runId: string, endedAt: string): WorkflowRun => ({ runId, taskId: null, name: runId, summary: null, status: 'done', phase: null, phases: [], agentCount: 1, doneCount: 1, failedCount: 0, startedAt: ago(60), endedAt });
  const session = {
    status: 'run',
    task: 'Task',
    agents: [
      helper('main', 'run', { kind: 'main', toolUseId: null }),
      // Launched in the background: its own row ended at once, the agent still waits for it.
      helper('background', 'done', { endedAt: ago(25) }),
      helper('done-new', 'done', { endedAt: ago(2) }),
      helper('done-old', 'done', { endedAt: ago(30) }),
      ofRun('of-new-run', 'run-new', ago(3)),
      ofRun('of-old-run', 'run-old', ago(40)),
    ],
    workflows: [run('run-new', ago(3)), run('run-old', ago(40))],
  } as unknown as SessionDetail;
  const waitsFor = [{ kind: 'agent' as const, toolUseId: 'call-background' }];
  const ids = (items: readonly OverviewItem[]): string[] => items.map((item) => (item.kind === 'workflow' ? `run:${item.runId}` : `${item.id}:${item.depth}`));

  it('keeps a row for every helper: one that is done, one of a finished run, one still working in the background', () => {
    // What Details lists (the agents overview): a helper leaves it the moment it is done.
    expect(ids(foldOverview(overviewItems(session), session, NOW).shown)).toEqual(['main:0']);
    const fold = helpersOverview(session, waitsFor, NOW);
    // The working ones first, then those that ended in the last 10 minutes; the older ones fold (a run with its helpers as one).
    expect(ids(fold.shown)).toEqual(['main:0', 'background:0', 'done-new:0', 'run:run-new', 'of-new-run:1']);
    expect(ids(fold.earlier)).toEqual(['done-old:0', 'run:run-old', 'of-old-run:1']);
    expect(fold.earlierCount).toBe(2);
    expect(overviewSummary(fold.shown)).toBe('4 agents · 2 working');
  });

  it('says a helper in the background is working and a finished one is done, and each opens its chat', () => {
    const rows = new Map([...helpersOverview(session, waitsFor, NOW).shown, ...helpersOverview(session, waitsFor, NOW).earlier].flatMap((item) => (item.kind === 'agent' ? [[item.id, item] as const] : [])));
    expect(rows.get('background')).toMatchObject({ sessionStatus: 'run', status: 'working', opensChat: true });
    expect(rows.get('done-new')).toMatchObject({ sessionStatus: 'done', status: 'done', opensChat: true });
    expect(rows.get('of-old-run')).toMatchObject({ sessionStatus: 'done', depth: 1, opensChat: true });
    expect(rows.get('main')).toMatchObject({ main: true, opensChat: false });
    // Nothing waited for any more: the one from the background is a finished helper like the others (it ended 25 minutes ago: folded).
    expect(ids(helpersOverview(session, [], NOW).shown)).toEqual(['main:0', 'done-new:0', 'run:run-new', 'of-new-run:1']);
    expect(ids(helpersOverview(session, null, NOW).earlier)).toEqual(['background:0', 'done-old:0', 'run:run-old', 'of-old-run:1']);
  });
});

describe('comments on diff lines', () => {
  const comments: DiffComment[] = [
    { id: 'a', repo: 'repo', fileKey: 'repo\u0000src/app.js', path: 'src/app.js', side: 'new', line: 12, code: 'const total = sum(items)', text: 'Rename this to grandTotal.' },
    { id: 'b', repo: 'repo', fileKey: 'repo\u0000docs/plan.md', path: 'docs/plan.md', side: 'old', line: 3, code: '- old step', text: 'Why was this removed?\nIt is still needed.' },
    { id: 'c', repo: 'repo', fileKey: 'repo\u0000img/logo.svg', path: 'img/logo.svg', side: 'new', line: null, code: '', text: '  Too big.  ' },
    { id: 'd', repo: 'repo', fileKey: 'repo\u0000src/app.js', path: 'src/app.js', side: 'new', line: 2, code: 'const s = `x`', text: 'Use a plain string.' },
  ];

  it('become one message for the agent: by file and line, each with its place, the line and what you wrote', () => {
    expect(reviewMessage(comments)).toBe(
      [
        'Review comments on your changes:',
        '',
        '1. `docs/plan.md:3` (a line you removed) · `- old step`',
        '   Why was this removed?',
        '   It is still needed.',
        '',
        '2. `img/logo.svg`',
        '   Too big.',
        '',
        '3. `src/app.js:2` · `` const s = `x` ``',
        '   Use a plain string.',
        '',
        '4. `src/app.js:12` · `const total = sum(items)`',
        '   Rename this to grandTotal.',
      ].join('\n'),
    );
  });

  it('name the repository when the comments are on more than one (the same path can be in both)', () => {
    const two: DiffComment[] = [
      { id: 'a', repo: 'web', fileKey: 'web\u0000package.json', path: 'package.json', side: 'new', line: 5, code: '"name": "web"', text: 'Bump this.' },
      { id: 'b', repo: 'auth', fileKey: 'auth\u0000package.json', path: 'package.json', side: 'new', line: 5, code: '"name": "auth"', text: 'And this.' },
    ];
    expect(reviewMessage(two)).toBe(
      ['Review comments on your changes:', '', '1. `package.json:5` in `auth` · `"name": "auth"`', '   And this.', '', '2. `package.json:5` in `web` · `"name": "web"`', '   Bump this.'].join('\n'),
    );
  });

  it('cut a very long line in the message, and say nothing without comments', () => {
    const long: DiffComment = { id: 'x', repo: 'repo', fileKey: 'repo\u0000a.min.js', path: 'a.min.js', side: 'new', line: 1, code: 'x'.repeat(500), text: 'Minified?' };
    expect(reviewMessage([long])).toBe(`Review comments on your changes:\n\n1. \`a.min.js:1\` · \`${'x'.repeat(160)}…\`\n   Minified?`);
    expect(reviewMessage([])).toBe('');
  });

  it('show on their own line of their own file and side only', () => {
    expect(commentsAt(comments, 'repo\u0000src/app.js', 'new', 12).map((c) => c.id)).toEqual(['a']);
    expect(commentsAt(comments, 'repo\u0000src/app.js', 'old', 12)).toEqual([]);
    expect(commentsAt(comments, 'repo\u0000docs/plan.md', 'new', 12)).toEqual([]);
    expect(commentsAt(comments, 'repo\u0000src/app.js', 'new', null)).toEqual([]);
  });
});
