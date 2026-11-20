import { describe, expect, it } from 'vitest';
import type { AgentFileRef, AgentFileRoot } from '../../src/core/agent-files.ts';
import type { FileDiff } from '../../src/core/api.ts';
import { type HastNode, highlightDiff, splitHighlightedLines } from '../../src/web/v2/agent/diff-highlight.ts';
import {
  EMPTY_HISTORY,
  TOUCHED_ROWS,
  addedLines,
  breadcrumb,
  changedByPath,
  changedUnder,
  fileSignal,
  historyBack,
  historyForward,
  historyOpen,
  infoText,
  pathKey,
  touchedRows,
  touchedText,
  unfoldSetFor,
} from '../../src/web/v2/agent/files-view.ts';
import { helperFailed, helperSections } from '../../src/web/v2/agent/helpers-view.ts';
import { PANEL_NARROW, PANEL_WIDE, WIDE_MIN, escTarget, isWide, toggledWidth } from '../../src/web/v2/agent/panel-layout.ts';
import type { OverviewItem } from '../../src/web/v2/agent/side-model.ts';

/**
 * D180 · the side panel's pure rules (`docs/v2.md` → *The agent view's side panel*). Each test
 * names the production line whose change makes it fail (the handoff's break-one-line pass).
 */

const ROOT = 'C:\\work\\acme-notes';
const roots: AgentFileRoot[] = [{ path: ROOT, label: 'acme-notes · main', kind: 'worktree' }];

function ref(path: string, over: Partial<AgentFileRef> = {}): AgentFileRef {
  const parts = path.split('\\');
  return { path, name: parts[parts.length - 1] ?? path, dir: parts.slice(0, -1).join('\\'), sources: ['edited'], mentionedAs: [], line: null, exists: true, at: null, ...over };
}

function diff(path: string, lines: string[], added = 1, removed = 0, solution = 'acme-notes'): FileDiff {
  return { solution, path, branch: 'main', added, removed, lines, uncommitted: true };
}

describe('the panel layout (panel-layout.ts)', () => {
  it('is wide from 760 px (`isWide`: width >= WIDE_MIN)', () => {
    expect([isWide(WIDE_MIN - 1), isWide(WIDE_MIN), isWide(PANEL_WIDE)]).toEqual([false, true, true]);
  });

  it('⟷ goes 560 ↔ 820, never above the room the view has (`toggledWidth`)', () => {
    expect(toggledWidth(PANEL_NARROW, 4000)).toBe(PANEL_WIDE);
    expect(toggledWidth(PANEL_WIDE, 4000)).toBe(PANEL_NARROW);
    expect(toggledWidth(PANEL_NARROW, 700)).toBe(700);
  });

  it('Esc closes the popover first, then the reader, then a helper chat, then the diff (`ESC_ORDER`)', () => {
    expect(escTarget({ popover: true, reader: true, helper: true, diff: true })).toBe('popover');
    expect(escTarget({ popover: false, reader: true, helper: true, diff: true })).toBe('reader');
    expect(escTarget({ popover: false, reader: false, helper: true, diff: true })).toBe('helper');
    expect(escTarget({ popover: false, reader: false, helper: false, diff: true })).toBe('diff');
    expect(escTarget({ popover: false, reader: false, helper: false, diff: false })).toBeNull();
  });
});

describe('"Touched by this agent" (files-view.ts → touchedRows)', () => {
  const files = [ref(`${ROOT}\\a.md`, { at: '2026-11-20T10:00:00.000Z' }), ref(`${ROOT}\\b.md`, { at: '2026-11-20T10:30:00.000Z' }), ref(`${ROOT}\\c.md`), ...[1, 2, 3, 4, 5].map((n) => ref(`${ROOT}\\n${n}.md`, { at: `2026-11-20T09:0${n}:00.000Z` }))];

  it('is newest first (the `localeCompare` of `at`, newest before oldest; unknown times last)', () => {
    expect(touchedRows(files, '', true).rows.map((file) => file.name)).toEqual(['b.md', 'a.md', 'n5.md', 'n4.md', 'n3.md', 'n2.md', 'n1.md', 'c.md']);
  });

  it('shows 5 rows until Show all, and says there are more (`slice(0, TOUCHED_ROWS)`, `more`)', () => {
    const cut = touchedRows(files, '', false);
    expect(cut.rows).toHaveLength(TOUCHED_ROWS);
    expect([cut.total, cut.more]).toEqual([8, true]);
    expect(touchedRows(files.slice(0, 5), '', false).more).toBe(false);
  });

  it('is filtered by the filter (`matchesFilter` on the path)', () => {
    expect(touchedRows(files, 'n3', true).rows.map((file) => file.name)).toEqual(['n3.md']);
  });

  it('says what the agent did, with the time for a write or an edit (`touchedText`)', () => {
    const time = (iso: string): string => iso.slice(11, 16);
    expect(touchedText(ref('x', { sources: ['wrote', 'read'], at: '2026-11-20T10:38:00.000Z' }), time)).toBe('wrote 10:38');
    expect(touchedText(ref('x', { sources: ['read'], at: '2026-11-20T10:38:00.000Z' }), time)).toBe('read');
    expect(touchedText(ref('x', { exists: false }), time)).toBe('deleted');
  });
});

describe("a tree row's one signal (files-view.ts → fileSignal)", () => {
  const changed = changedByPath([diff('notes/a.md', ['@@ -1 +1,2 @@', ' a', '+b'], 1, 0), diff('notes/new.md', ['@@ -0,0 +1 @@', '+x']), diff('old.md', ['@@ -1 +0,0 @@', '-x'], 0, 1)], roots);
  const touched = new Map([ref(`${ROOT}\\README.md`, { sources: ['read'] }), ref(`${ROOT}\\docs\\plan.md`, { sources: ['mentioned'] }), ref(`${ROOT}\\notes\\a.md`, { sources: ['read'] })].map((file) => [pathKey(file.path), file] as const));

  it('is the head diff first: +a −d, new or deleted (`diffFileState`)', () => {
    expect(fileSignal(`${ROOT}\\notes\\a.md`, changed, touched)).toEqual({ kind: 'delta', added: 1, removed: 0 });
    expect(fileSignal(`${ROOT}\\notes\\new.md`, changed, touched)).toEqual({ kind: 'new' });
    expect(fileSignal(`${ROOT}\\old.md`, changed, touched)).toEqual({ kind: 'deleted' });
  });

  it('else a muted read or mentioned from the touched list, else nothing', () => {
    expect(fileSignal(`${ROOT}\\README.md`, changed, touched)).toEqual({ kind: 'read' });
    expect(fileSignal(`${ROOT}\\docs\\plan.md`, changed, touched)).toEqual({ kind: 'mentioned' });
    expect(fileSignal(`${ROOT}\\other.md`, changed, touched)).toBeNull();
  });

  it('matches a Windows path whatever its case and slashes (`pathKey`)', () => {
    expect(fileSignal('c:/WORK/acme-notes/notes/A.md', changed, touched)).toEqual({ kind: 'delta', added: 1, removed: 0 });
  });

  it('leaves out a change of a repo that is not one of the roots (`changedByPath`)', () => {
    expect(changedByPath([diff('x.md', ['@@ -0,0 +1 @@', '+x'], 1, 0, 'elsewhere')], roots).size).toBe(0);
  });
});

describe('"N changed" on a folded folder (files-view.ts → changedUnder)', () => {
  const changed = changedByPath([diff('notes/a.md', []), diff('notes/deep/b.md', []), diff('README.md', [])], roots);
  it('counts the changed files anywhere below the folder, not beside it', () => {
    expect(changedUnder(`${ROOT}\\notes`, changed)).toBe(2);
    expect(changedUnder(`${ROOT}\\notes\\deep`, changed)).toBe(1);
    expect(changedUnder(`${ROOT}\\not`, changed)).toBe(0);
    expect(changedUnder(ROOT, changed)).toBe(3);
  });
});

describe("the reader's history (files-view.ts → historyOpen / historyBack / historyForward)", () => {
  it('goes back and forward; opening from the middle drops what was ahead; the same file twice is one step', () => {
    let h = historyOpen(historyOpen(historyOpen(EMPTY_HISTORY, 'a'), 'b'), 'c');
    expect(h).toEqual({ items: ['a', 'b', 'c'], at: 2 });
    h = historyBack(historyBack(h));
    expect(h.at).toBe(0);
    expect(historyBack(h)).toBe(h);
    expect(historyForward(h).at).toBe(1);
    h = historyOpen(h, 'd');
    expect(h).toEqual({ items: ['a', 'd'], at: 1 });
    expect(historyOpen(h, 'd')).toBe(h);
    expect(historyForward(h)).toBe(h);
  });
});

describe('the breadcrumb (files-view.ts → breadcrumb / unfoldSetFor)', () => {
  it('names the root, then each folder down to the file', () => {
    const trail = breadcrumb(`${ROOT}\\src\\Acme.Notes\\Note.cs`, roots);
    expect(trail?.crumbs.map((crumb) => crumb.name)).toEqual(['acme-notes · main', 'src', 'Acme.Notes']);
    expect(trail?.name).toBe('Note.cs');
    expect(breadcrumb('D:\\elsewhere\\x.cs', roots)).toBeNull();
  });

  it("unfolds every folder from the root down to the one clicked (the crumbs' dirs)", () => {
    expect(unfoldSetFor(`${ROOT}\\src\\Acme.Notes`, roots)).toEqual([ROOT, `${ROOT}\\src`, `${ROOT}\\src\\Acme.Notes`]);
  });
});

describe("the reader's info line and changed lines (files-view.ts → infoText / addedLines)", () => {
  const time = (iso: string): string => iso.slice(11, 16);
  it('follows the source: Written / Edited / Read by the agent, Deleted, Mentioned in the chat; nothing for a file it never touched', () => {
    expect(infoText(ref('x', { sources: ['edited'], at: '2026-11-20T10:21:00.000Z' }), time)).toBe('Edited by the agent at 10:21');
    expect(infoText(ref('x', { sources: ['wrote'] }), time)).toBe('Written by the agent');
    expect(infoText(ref('x', { sources: ['mentioned'] }), time)).toBe('Mentioned in the chat');
    expect(infoText(ref('x', { exists: false }), time)).toBe('Deleted by the agent');
    expect(infoText(null, time)).toBeNull();
  });

  it('marks the new side line numbers a diff adds (context and removed lines move the count right)', () => {
    expect([...addedLines(['@@ -3,3 +3,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -20 +21 @@', '-x', '+y'])]).toEqual([4, 5, 21]);
  });
});

describe('syntax colours in the diff (diff-highlight.ts)', () => {
  const span = (cls: string, ...children: HastNode[]): HastNode => ({ type: 'element', tagName: 'span', properties: { className: [cls] }, children });
  const text = (value: string): HastNode => ({ type: 'text', value });

  it('cuts a highlighted tree into lines, repeating a span that crosses a line end (`splitHighlightedLines`)', () => {
    const lines = splitHighlightedLines([text('a = '), span('hljs-comment', text('/* one\ntwo */')), text('\nb')]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([text('a = '), span('hljs-comment', text('/* one'))]);
    expect(lines[1]).toEqual([span('hljs-comment', text('two */'))]);
    expect(lines[2]).toEqual([text('b')]);
    expect(splitHighlightedLines([text('x\n\ny')])).toEqual([[text('x')], [], [text('y')]]);
  });

  it('highlights each side of a hunk once: context and removed lines from the old side, context and added from the new', () => {
    const calls: string[] = [];
    const highlight = (source: string): HastNode[] => {
      calls.push(source);
      return [span('hljs-x', text(source))];
    };
    const out = highlightDiff(
      [
        { tone: 'hunk', text: 'Line 1' },
        { tone: 'ctx', text: 'a' },
        { tone: 'del', text: 'b' },
        { tone: 'add', text: 'B' },
      ],
      highlight,
    );
    expect(calls).toEqual(['a\nb', 'a\nB']);
    expect(out[0]).toBeNull();
    expect(out[2]).toEqual([span('hljs-x', text('b'))]);
    expect(out[3]).toEqual([span('hljs-x', text('B'))]);
  });

  it('leaves a hunk plain when the highlighter cannot read it', () => {
    expect(highlightDiff([{ tone: 'add', text: 'x' }], () => null)).toEqual([null]);
  });
});

describe("the Helpers tab's red dot (helpers-view.ts → helperFailed)", () => {
  it('shows only when a helper failed, never for the main agent or a helper that waits', () => {
    expect(helperFailed([{ kind: 'subagent', status: 'fail' }])).toBe(true);
    expect(helperFailed([{ kind: 'main', status: 'fail' }, { kind: 'subagent', status: 'need' }, { kind: 'subagent', status: 'done' }])).toBe(false);
  });
});

describe("the Helpers tab's sections (helpers-view.ts → helperSections)", () => {
  const agent = (id: string, sessionStatus: 'run' | 'need' | 'fail' | 'done', depth: 0 | 1 = 0, main = false): OverviewItem => ({
    kind: 'agent',
    id,
    main,
    name: id,
    description: '',
    solution: '—',
    solutionPath: null,
    status: sessionStatus === 'run' ? 'working' : sessionStatus === 'need' ? 'needs' : sessionStatus === 'fail' ? 'stopped' : 'done',
    sessionStatus,
    statusText: sessionStatus,
    depth,
    opensChat: true,
  });
  const run = (runId: string, working: boolean): OverviewItem => ({ kind: 'workflow', runId, name: runId, summary: 'phase 2 · 4 of 6', status: working ? 'working' : 'done', statusText: '', resume: null });

  it('puts failed and waiting helpers in Needs you, running runs with their working helpers in Working, the rest finished', () => {
    const sections = helperSections([agent('main', 'run', 0, true), run('r1', true), agent('h1', 'run', 1), agent('h2', 'done', 1), agent('h3', 'fail', 1), agent('s1', 'run'), agent('s2', 'need'), run('r2', false), agent('h4', 'done', 1), agent('s3', 'done')]);
    expect(sections.needsYou.map((item) => item.id)).toEqual(['h3', 's2']);
    expect(sections.working.map((entry) => [entry.run?.kind === 'workflow' ? entry.run.runId : null, entry.helpers.map((item) => item.id)])).toEqual([
      ['r1', ['h1']],
      [null, ['s1']],
    ]);
    expect(sections.finishedCount).toBe(2);
    expect(sections.finished.map((item) => (item.kind === 'workflow' ? item.runId : item.id))).toEqual(['r2', 'h4', 's3']);
    expect(sections.stoppedRuns).toEqual([]);
  });

  it('puts a stopped run that can resume in Needs you (Resume run), not among the finished', () => {
    const stopped: OverviewItem = { ...(run('r3', false) as Extract<OverviewItem, { kind: 'workflow' }>), status: 'stopped', resume: 'Resume the run.' };
    const sections = helperSections([stopped, agent('h5', 'done', 1)]);
    expect(sections.stoppedRuns.map((item) => item.runId)).toEqual(['r3']);
    expect([sections.finishedCount, sections.working.length]).toEqual([0, 0]);
  });
});
