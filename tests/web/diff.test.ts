import { describe, expect, it } from 'vitest';
import type { DiffTargets, FileDiff } from '../../src/core/api.ts';
import { EVENT_KINDS } from '../../src/core/model.ts';
import {
  DIFF_SCOPE_KEY,
  EMPTY_HEAD,
  EMPTY_REPO,
  HINT_WHOLE_BRANCH,
  NOT_COMMITTED_NOTE,
  NO_CHANGES,
  REPO_NOTE,
  SCOPE_LABELS,
  deltaText,
  emptyState,
  headerLine,
  loadScope,
  saveScope,
  scopeOptions,
  scopeTitle,
  shownScope,
  diffModel,
  fileKey,
  lineTone,
  refreshesDiff,
  selectedFile,
  shortName,
} from '../../src/web/views/session/diff.ts';

function file(patch: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
  return { solution: 'acme-app-front', branch: 'session/free-talk', added: 1, removed: 0, lines: ['+x'], uncommitted: true, ...patch };
}

const FILES: FileDiff[] = [
  file({ path: 'Pages/FreeTalk/FreeTalk.razor', added: 118, lines: [' @page "/free-talk"', '+<AcmPageHeader Title="Free talk" />', '+'] }),
  file({ path: 'Pages/FreeTalk/TopicChips.razor', added: 51, removed: 12, lines: [' <div>', '-    <AcmChip Size="Compact">', '+    <AcmChip>'] }),
  file({ solution: 'mobile', path: 'Views/FreeTalkView.xaml', added: 96, uncommitted: false }),
  file({ solution: 'root', path: 'contracts/free-talk.md', branch: null, added: 62 }),
];

describe('Diff tab model (M4.5)', () => {
  it('copy is the prototype’s', () => {
    expect(NOT_COMMITTED_NOTE).toBe('Not committed. Commit only when you approve.');
    expect(NO_CHANGES).toBe('No changes yet.');
  });

  it('deltaText: +added, U+2212 −removed, both, or — without line changes', () => {
    expect(deltaText(118, 0)).toBe('+118');
    expect(deltaText(51, 12)).toBe('+51 −12');
    expect(deltaText(0, 4)).toBe('−4');
    expect(deltaText(0, 0)).toBe('—');
  });

  it('lineTone by the first character; shortName = last path segment', () => {
    expect(lineTone('+added')).toBe('add');
    expect(lineTone('+')).toBe('add');
    expect(lineTone('-removed')).toBe('del');
    expect(lineTone(' context')).toBe('ctx');
    expect(lineTone('')).toBe('ctx');
    expect(shortName('Pages/FreeTalk/FreeTalk.razor')).toBe('FreeTalk.razor');
    expect(shortName('README.md')).toBe('README.md');
  });

  it('rows: file name, delta, "solution · path"; the first file is selected by default', () => {
    const model = diffModel(FILES, null);
    expect(model.empty).toBe(false);
    expect(model.rows.map((r) => [r.short, r.delta, r.sub, r.selected])).toEqual([
      ['FreeTalk.razor', '+118', 'acme-app-front · Pages/FreeTalk/FreeTalk.razor', true],
      ['TopicChips.razor', '+51 −12', 'acme-app-front · Pages/FreeTalk/TopicChips.razor', false],
      ['FreeTalkView.xaml', '+96', 'mobile · Views/FreeTalkView.xaml', false],
      ['free-talk.md', '+62', 'root · contracts/free-talk.md', false],
    ]);
    expect(model.pane).toEqual({
      key: fileKey(FILES[0]!),
      name: 'acme-app-front / Pages/FreeTalk/FreeTalk.razor',
      branch: '⎇ session/free-talk',
      note: true,
      lines: [
        { text: ' @page "/free-talk"', tone: 'ctx' },
        { text: '+<AcmPageHeader Title="Free talk" />', tone: 'add' },
        { text: '+', tone: 'add' },
      ],
    });
  });

  it('selection by key: the pane follows it; no branch → no chip; committed → no note', () => {
    const chips = diffModel(FILES, fileKey(FILES[1]!));
    expect(chips.rows.map((r) => r.selected)).toEqual([false, true, false, false]);
    expect(chips.pane.lines.map((l) => l.tone)).toEqual(['ctx', 'del', 'add']);

    const root = diffModel(FILES, fileKey(FILES[3]!));
    expect(root.pane.name).toBe('root / contracts/free-talk.md');
    expect(root.pane.branch).toBe('');
    expect(root.pane.note).toBe(true);

    const committed = diffModel(FILES, fileKey(FILES[2]!));
    expect(committed.pane.name).toBe('mobile / Views/FreeTalkView.xaml');
    expect(committed.pane.note).toBe(false);
  });

  it('a selected file that leaves the diff falls back to the first; the same path in two solutions stays distinct', () => {
    const gone = fileKey({ solution: 'acme-app-front', path: 'deleted.txt' });
    expect(selectedFile(FILES, gone)).toBe(FILES[0]);
    expect(selectedFile([], gone)).toBeNull();
    const twin = [file({ path: 'README.md' }), file({ solution: 'mobile', path: 'README.md', added: 3 })];
    const model = diffModel(twin, fileKey(twin[1]!));
    expect(model.rows.map((r) => r.selected)).toEqual([false, true]);
    expect(model.pane.name).toBe('mobile / README.md');
    expect(new Set(model.rows.map((r) => r.key)).size).toBe(2);
  });

  it('no files: empty list, empty header with the note (as the prototype renders it), no lines', () => {
    const model = diffModel([], null);
    expect(model.empty).toBe(true);
    expect(model.rows).toEqual([]);
    expect(model.pane).toEqual({ key: null, name: '', branch: '', note: true, lines: [] });
  });

  it('refreshes on events that can change files only', () => {
    expect(EVENT_KINDS.filter(refreshesDiff)).toEqual(['impl', 'loop', 'ok', 'tool', 'error']);
  });
});

describe('Diff tab views (D90)', () => {
  const WT: DiffTargets = { worktrees: [{ solution: 'web-front', branch: 'PROJ-1-x', base: 'origin/dev', commits: 2 }], inPlace: [] };
  const IN_PLACE: DiffTargets = { worktrees: [], inPlace: [{ solution: 'mobile', branch: 'main' }] };
  const BOTH: DiffTargets = { worktrees: [{ ...WT.worktrees[0]!, commits: 0 }], inPlace: IN_PLACE.inPlace };

  it('copy', () => {
    expect(SCOPE_LABELS).toEqual({ head: 'Since last commit', branch: 'Whole branch', repo: 'All uncommitted changes in this repo' });
    expect(EMPTY_HEAD).toBe('No uncommitted changes since the last commit.');
    expect(EMPTY_REPO).toBe('No uncommitted changes in this repo.');
    expect(REPO_NOTE).toBe("Includes other people's and other sessions' edits in this repo.");
  });

  it('hunk headers are their own tone', () => {
    expect(lineTone('@@ -10,6 +10,8 @@ section')).toBe('hunk');
    expect(diffModel([file({ path: 'a', lines: ['@@ -1 +1 @@', '-a', '+b'] })], null).pane.lines.map((l) => l.tone)).toEqual(['hunk', 'del', 'add']);
  });

  it('options: Since last commit always; Whole branch with a worktree; All uncommitted with an in-place solution', () => {
    expect(scopeOptions(null)).toEqual(['head']);
    expect(scopeOptions({ worktrees: [], inPlace: [] })).toEqual(['head']);
    expect(scopeOptions(WT)).toEqual(['head', 'branch']);
    expect(scopeOptions(IN_PLACE)).toEqual(['head', 'repo']);
    expect(scopeOptions(BOTH)).toEqual(['head', 'branch', 'repo']);
  });

  it('the shown view: the remembered one while the targets load, then only when offered', () => {
    expect(shownScope(null, null)).toBe('head');
    expect(shownScope('branch', null)).toBe('branch');
    expect(shownScope('branch', WT)).toBe('branch');
    expect(shownScope('branch', IN_PLACE)).toBe('head');
    expect(shownScope('repo', IN_PLACE)).toBe('repo');
    expect(shownScope('repo', WT)).toBe('head');
  });

  it('header line: what is shown · n files · +added −removed', () => {
    const two = [file({ path: 'a', added: 100, removed: 8 }), file({ path: 'b', added: 20 })];
    expect(headerLine('head', two, WT)).toBe('Since last commit · 2 files · +120 −8');
    expect(headerLine('head', [file({ path: 'a' })], WT)).toBe('Since last commit · 1 file · +1');
    expect(headerLine('branch', two, WT)).toBe('Whole branch vs origin/dev · 2 files · +120 −8');
    expect(headerLine('repo', two, IN_PLACE)).toBe('All uncommitted changes · 2 files · +120 −8');
    expect(headerLine('head', [], WT)).toBe('Since last commit');
    expect(headerLine('head', [file({ path: 'img.png', added: 0 })], null)).toBe('Since last commit · 1 file');
    // Several worktrees: their distinct bases; a commit id is cut; none known → no "vs".
    const many: DiffTargets = {
      worktrees: [WT.worktrees[0]!, { solution: 'b', branch: 'x', base: 'origin/dev', commits: 0 }, { solution: 'c', branch: 'y', base: 'a'.repeat(40), commits: 0 }],
      inPlace: [],
    };
    expect(scopeTitle('branch', many)).toBe('Whole branch vs origin/dev, aaaaaaa');
    expect(scopeTitle('branch', { worktrees: [{ solution: 'a', branch: 'x', base: null, commits: 0 }], inPlace: [] })).toBe('Whole branch');
  });

  it('empty states: the hint to Whole branch only when a worktree branch has commits', () => {
    expect(emptyState('head', WT)).toEqual({ text: EMPTY_HEAD, hint: HINT_WHOLE_BRANCH });
    expect(emptyState('head', BOTH)).toEqual({ text: EMPTY_HEAD, hint: null });
    expect(emptyState('head', IN_PLACE)).toEqual({ text: EMPTY_HEAD, hint: null });
    expect(emptyState('branch', WT)).toEqual({ text: NO_CHANGES, hint: null });
    expect(emptyState('repo', IN_PLACE)).toEqual({ text: EMPTY_REPO, hint: null });
  });

  it('the view is remembered per session (newest 200), bad storage is ignored', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(loadScope(storage, 's1')).toBeNull();
    saveScope(storage, 's1', 'branch');
    saveScope(storage, 's2', 'repo');
    expect(loadScope(storage, 's1')).toBe('branch');
    expect(loadScope(storage, 's2')).toBe('repo');
    saveScope(storage, 's1', 'head');
    expect(loadScope(storage, 's1')).toBe('head');
    for (let i = 0; i < 250; i++) saveScope(storage, `n${i}`, 'branch');
    expect(Object.keys(JSON.parse(map.get(DIFF_SCOPE_KEY)!)).length).toBe(200);
    expect(loadScope(storage, 's2')).toBeNull();
    map.set(DIFF_SCOPE_KEY, '{"x":"nope","y":"repo"}');
    expect(loadScope(storage, 'x')).toBeNull();
    expect(loadScope(storage, 'y')).toBe('repo');
    map.set(DIFF_SCOPE_KEY, 'not json');
    expect(loadScope(storage, 'y')).toBeNull();
    expect(loadScope(null, 'y')).toBeNull();
    const throwing = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
    expect(() => saveScope(throwing, 's', 'repo')).not.toThrow();
  });
});
