import { describe, expect, it } from 'vitest';
import type { FileDiff } from '../../src/core/api.ts';
import { EVENT_KINDS } from '../../src/core/model.ts';
import {
  NOT_COMMITTED_NOTE,
  NO_CHANGES,
  deltaText,
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
