/**
 * D180 · Changes in the side panel (`docs/v2.md` → *The agent view's side panel*): the Changes
 * tab's data (D90, D174) laid out for a column next to the chat.
 *
 * - **Tool row:** one picker (a picked turn, Last turn, For review while a review is pending,
 *   Since last save point, Whole separate copy, All unsaved) · a filter · **Mark reviewed** while
 *   a review is pending. The pick is remembered by D174's rules (`useDiffScope`).
 * - **The tree** of the files the view changed: paths relative to the project, one signal per
 *   file (`+a −d`, `new` or `deleted`), a folded folder with its `+ / −`.
 * - **The diff:** header (path · Comment · ⋯ with Wrap, Side by side from 760 px, Open the file
 *   · the list button), numbered lines in the reader's syntax colours (`diff-highlight.ts`),
 *   line comments sent to the agent as one message (`diff-comments.ts`).
 * - **Layout** (`PanelSplit`): wide, the tree docked on the right beside the diff (nothing
 *   picked: the first change); narrow, the tree first and a picked diff filling the panel.
 *
 * Since last save point reads the agent's one shared `head` diff (`useHeadDiff`).
 */
import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { common, createLowlight } from 'lowlight';
import { Fragment as JsxFragment, jsx, jsxs } from 'react/jsx-runtime';
import { languageByName } from '../../../core/agent-files.ts';
import type { DiffScope, FileDiff } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { copyText } from '../../views/session/ChatMarkdown.tsx';
import { type DiffLine, deltaText, diffModel, emptyHeadFallback, emptyState, fileKey, scopeOptions, shownScope } from '../../views/session/diff.ts';
import { sideBySide } from '../../views/session/side-by-side.ts';
import { useDiffScope } from '../../views/session/useDiffScope.ts';
import { useSessionRefresh } from '../../views/session/useSessionRefresh.ts';
import { Button, EmptyState, Icon, IconButton, Menu, Skeleton, useToast } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { type TreeFile, changedTree, fileState, firstFileKey } from './changes-tree.ts';
import { type ChangesView, shownChoice, viewChoices, viewKey } from './changes-view.ts';
import { type HastNode, HIGHLIGHT_MAX_LINES, highlightDiff } from './diff-highlight.ts';
import { commentPlace, commentsAt, reviewMessage, useDiffComments } from './diff-comments.ts';
import { escTarget } from './panel-layout.ts';
import { ListButton, PanelSplit, usePanelEsc } from './PanelSplit.tsx';
import { SplitPair, useDiffLayout } from './tabs.tsx';
import { apiErrorText } from './useAgentFiles.ts';
import type { HeadDiffState } from './useHeadDiff.ts';
import type { TurnChangesState } from './useTurnChanges.ts';

const SCOPE_WORDS: Readonly<Record<DiffScope, string>> = { head: AGENT_WORDS.sinceSavePoint, branch: AGENT_WORDS.wholeCopy, repo: AGENT_WORDS.allUnsaved, review: AGENT_WORDS.forReview };

function isScope(value: string): value is DiffScope {
  return value === 'head' || value === 'branch' || value === 'repo' || value === 'review';
}

const lowlight = createLowlight(common);

/** The reader's highlighter for a file named `name` (`null`: plain text). */
function highlighterFor(name: string): ((text: string) => readonly HastNode[] | null) | null {
  const language = languageByName(name);
  if (!language || !lowlight.registered(language)) return null;
  return (text) => {
    try {
      return lowlight.highlight(language, text).children as unknown as readonly HastNode[];
    } catch {
      return null;
    }
  };
}

function renderHast(nodes: readonly HastNode[]): ReactNode {
  return toJsxRuntime({ type: 'root', children: nodes as never }, { Fragment: JsxFragment, jsx: jsx as never, jsxs: jsxs as never });
}

/** One row of the numbered diff. */
interface NumberedLine {
  readonly tone: DiffLine['tone'] | 'note';
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

/** The diff's lines with old and new line numbers worked out from the `@@ -a,b +c,d @@` headers. */
export function numberedDiff(lines: readonly DiffLine[]): NumberedLine[] {
  const out: NumberedLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let known = false;
  for (const line of lines) {
    if (line.tone === 'hunk') {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line.text);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
        known = true;
        out.push({ tone: 'hunk', text: match[3] ? `Line ${newNo} · ${match[3]}` : `Line ${newNo}`, oldNo: null, newNo: null });
      } else out.push({ tone: 'hunk', text: line.text, oldNo: null, newNo: null });
      continue;
    }
    if (line.text.startsWith('\\')) {
      out.push({ tone: 'note', text: line.text.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }
    const text = line.text.slice(1);
    if (line.tone === 'add') {
      out.push({ tone: 'add', text, oldNo: null, newNo: known ? newNo : null });
      newNo += 1;
    } else if (line.tone === 'del') {
      out.push({ tone: 'del', text, oldNo: known ? oldNo : null, newNo: null });
      oldNo += 1;
    } else {
      out.push({ tone: 'ctx', text, oldNo: known ? oldNo : null, newNo: known ? newNo : null });
      oldNo += 1;
      newNo += 1;
    }
  }
  return out;
}

/** Where a comment is being written: one line of the shown file (by its side and number, never by its place in the list: the diff is read again while you type), or the whole file. */
type Writing = { readonly side: 'new' | 'old'; readonly line: number } | 'file' | null;

/**
 * The box a comment is written in. `withLine`: the whole file's box, which also takes
 * a line number (how a line is commented without a mouse).
 */
function CommentBox({
  place,
  text,
  onText,
  withLine = false,
  onAdd,
  onCancel,
}: {
  readonly place: string;
  /** What is typed so far: kept by the panel, so the box can move with its line when the diff is read again. */
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly withLine?: boolean;
  readonly onAdd: (text: string, line: number | null) => void;
  readonly onCancel: () => void;
}) {
  const [lineText, setLineText] = useState('');
  const root = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const area = field.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);
  const line = /^[1-9]\d{0,6}$/.test(lineText.trim()) ? Number(lineText.trim()) : null;
  const lineWrong = lineText.trim() !== '' && line === null;
  const add = (): void => {
    if (text.trim() !== '' && !lineWrong) onAdd(text, line);
  };
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  // Escape closes the box only. On the window, before the overlays' own Escape (they listen on the document): in the drawer it would close the whole panel and lose what was typed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !root.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="v2-ag-chg-box" ref={root} data-testid="v2-side-comment-box">
      <textarea
        ref={field}
        className="v2-field"
        rows={2}
        placeholder="What should change here?"
        aria-label={`Your comment on ${place}`}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            add();
          }
        }}
      />
      <span className="v2-ag-chg-box-row">
        {withLine ? (
          <input className="v2-field v2-ag-chg-box-line" inputMode="numeric" placeholder="Line (optional)" aria-label="Line number (optional)" aria-invalid={lineWrong || undefined} value={lineText} onChange={(event) => setLineText(event.target.value)} data-testid="v2-side-comment-line" />
        ) : null}
        <Button size="sm" variant="primary" disabled={text.trim() === '' || lineWrong} onClick={add} data-testid="v2-side-comment-add">
          Add comment
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="v2-muted v2-ag-small">⌘↩ adds it</span>
      </span>
    </div>
  );
}

/** Lines added and removed, each in its colour (`deltaText`'s words: nothing for a zero, a dash for neither). */
export function Delta({ added, removed }: { readonly added: number; readonly removed: number }) {
  if (added === 0 && removed === 0) return <span className="v2-ag-chg-delta">{deltaText(0, 0)}</span>;
  return (
    <span className="v2-ag-chg-delta" aria-label={deltaText(added, removed)}>
      {added > 0 ? <span data-sign="added">{deltaText(added, 0)}</span> : null}
      {removed > 0 ? <span data-sign="removed">{deltaText(0, removed)}</span> : null}
    </span>
  );
}

/** "View changes" from Files: open Changes on this file (`n` counts the asks, so the same file can be asked again). */
export interface ChangesFocus {
  readonly path: string;
  readonly n: number;
}

export interface ChangesPanelProps {
  readonly sessionId: string;
  /** D166: the agent's pending review (Mark reviewed shows while there is one). */
  readonly review: { readonly fileCount: number; readonly turns: number; readonly since: string } | null;
  readonly onOpenFile: (path: string) => void;
  /** What to show; a turn is picked from its chip in the chat. */
  readonly view: ChangesView;
  readonly onView: (view: ChangesView) => void;
  readonly turns: TurnChangesState;
  /** The agent's shared `head` diff (Since last save point). */
  readonly head: HeadDiffState;
  /** The panel is wide (≥ 760 px): the tree beside the diff, Side by side offered. */
  readonly wide: boolean;
  /** Counts the clicks on the Changes tab while it is shown: each goes back to the list. */
  readonly backToList: number;
  readonly focus: ChangesFocus | null;
  /** Puts the comments' message into the message box. */
  readonly onSendComments: (text: string) => void;
  /** Why the agent takes no message now (`null` = it does). */
  readonly sendBlocked: string | null;
}

export function ChangesPanel({ sessionId, review, onOpenFile, view, onView, turns, head, wide, backToList, focus, onSendComments, sendBlocked }: ChangesPanelProps) {
  const toast = useToast();
  // This agent's views: another agent's answer (still held while this one's is on its way) is not used.
  const targets = useApi(async () => ({ sessionId, targets: await api.sessionDiffTargets(sessionId) }), [sessionId]);
  const known = targets.data !== null && targets.data.sessionId === sessionId ? targets.data.targets : targets.error ? { worktrees: [], inPlace: [] } : null;
  // D174: For review while a review is pending (unless another view was picked during it).
  const since = known ? (known.review?.since ?? null) : (review?.since ?? null);
  const [remembered, pick] = useDiffScope(sessionId, since);
  const picked = shownScope(remembered, known);
  /** D174: Since last save point came back empty with nothing picked on a copy with commits: the whole copy (not remembered). */
  const [auto, setAuto] = useState<{ readonly sessionId: string; readonly scope: DiffScope } | null>(null);
  const scope = auto !== null && auto.sessionId === sessionId && remembered === null && picked === 'head' ? auto.scope : picked;
  const shared = view.kind === 'scope' && scope === 'head';
  // What is fetched, this agent's: an answer for another key (another view, another agent) is never shown.
  const key = `${sessionId}\u0000${viewKey(view, scope)}`;
  /** The key whose newest read failed: an error is shown for its own view only, never while another view loads. */
  const failed = useRef<{ asked: number; key: string | null }>({ asked: 0, key: null });
  const diff = useApi(async () => {
    if (shared) return { key, files: null as readonly FileDiff[] | null };
    const mine = (failed.current.asked += 1);
    const settle = (failedKey: string | null): void => {
      if (failed.current.asked === mine) failed.current.key = failedKey;
    };
    try {
      const files = view.kind === 'turn' ? await api.turnChangesDiff(sessionId, view.change.turn, view.change.turn) : await api.sessionDiff(sessionId, undefined, scope);
      settle(null);
      return { key, files: files as readonly FileDiff[] | null };
    } catch (caught) {
      settle(key);
      throw caught;
    }
  }, [key, shared]);
  const reloadDiff = diff.reload;
  const reloadTargets = targets.reload;
  /**
   * When the diff is read again. The Diff's own views follow every change of the agent's files
   * (D90). A turn's diff may snapshot the working trees on each read, so it is read again only
   * when the agent's turns change or the window gets the focus back; a turn between two save
   * points never changes again.
   */
  const policy = useRef({ snapshots: false, settled: false });
  policy.current = { snapshots: view.kind === 'turn', settled: view.kind === 'turn' && view.change.through < turns.latestTurn };
  const reload = useCallback(() => {
    if (!policy.current.snapshots) reloadDiff();
    reloadTargets();
  }, [reloadDiff, reloadTargets]);
  useSessionRefresh(sessionId, reload);
  const seen = useRef({ turns, key });
  useEffect(() => {
    const before = seen.current;
    seen.current = { turns, key };
    if (before.turns !== turns && before.key === key && policy.current.snapshots && !policy.current.settled) reloadDiff();
  }, [turns, key, reloadDiff]);
  useEffect(() => {
    const onFocus = (): void => {
      if (policy.current.snapshots && !policy.current.settled) reloadDiff();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reloadDiff]);

  const [selected, setSelected] = useState<string | null>(null);
  /** Narrow: a diff was opened (it fills the panel); the tab's click or Esc goes back to the list. */
  const [opened, setOpened] = useState(false);
  /** Wide: the docked tree is shown. Narrow: the tree pops over the diff. */
  const [docked, setDocked] = useState(true);
  const [popover, setPopover] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [layout, pickLayout] = useDiffLayout();
  const [marking, setMarking] = useState(false);
  const [writing, setWriting] = useState<Writing>(null);
  /** What is typed in the open comment box. */
  const [draft, setDraft] = useState('');
  const write = (next: Writing): void => {
    setWriting(next);
    setDraft('');
  };
  const [listed, setListed] = useState(false);
  /** The tree: what is typed to filter it, and the folders folded by hand. */
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  useEffect(() => {
    setSelected(null);
    setFilter('');
    setClosed(new Set());
    setOpened(false);
    setPopover(false);
  }, [sessionId]);
  // The Changes tab clicked while shown: back to the list.
  const seenBack = useRef(backToList);
  useEffect(() => {
    if (backToList === seenBack.current) return;
    seenBack.current = backToList;
    setOpened(false);
    setPopover(false);
  }, [backToList]);
  useEffect(() => setPopover(false), [wide]);
  const files = shared ? (head.files ?? null) : diff.data !== null && diff.data.key === key ? diff.data.files : null;
  const diffError = shared ? head.error : diff.error !== null && failed.current.key === key ? diff.error : null;
  const fallback = view.kind === 'scope' ? emptyHeadFallback(scope, remembered, files, known) : null;
  useEffect(() => {
    if (fallback !== null) setAuto({ sessionId, scope: fallback });
  }, [fallback, sessionId]);
  // "View changes" from Files: this file, opened.
  useEffect(() => {
    if (!focus || files === null) return;
    const file = files.find((candidate) => candidate.path === focus.path || focus.path.replace(/\\/g, '/').endsWith(`/${candidate.path}`));
    if (file) {
      setSelected(fileKey(file));
      setOpened(true);
    }
    // Once per ask, when this view's files are there.
  }, [focus?.n, files === null]);
  const treeFiles = useMemo<TreeFile[]>(() => (files ?? []).map((file) => ({ key: fileKey(file), repo: file.solution, path: file.path, added: file.added, removed: file.removed, state: fileState(file.lines) })), [files]);
  const tree = useMemo(() => changedTree(treeFiles, { filter, closed }), [treeFiles, filter, closed]);
  // Nothing picked (or the picked file is not in this view): the first file of the whole tree, as it reads top to bottom. A fold or a filter changes the tree only, never the file shown.
  const pickedKey = useMemo(() => (selected !== null && treeFiles.some((file) => file.key === selected) ? selected : firstFileKey(changedTree(treeFiles))), [selected, treeFiles]);
  const model = useMemo(() => diffModel(files ?? [], pickedKey), [files, pickedKey]);
  const lines = useMemo(() => numberedDiff(model.pane.lines), [model.pane.lines]);
  const list = files ?? [];
  const shownFile = list.find((file) => fileKey(file) === model.pane.key) ?? null;
  const colours = useMemo(() => {
    if (!shownFile || lines.length > HIGHLIGHT_MAX_LINES) return null;
    const highlight = highlighterFor(shownFile.path);
    return highlight ? highlightDiff(lines, highlight) : null;
  }, [shownFile, lines]);
  const split = layout === 'split' && wide;
  const splitRows = useMemo(() => (split ? sideBySide(model.pane.lines.map((line) => line.text)) : []), [split, model.pane.lines]);
  useEffect(() => {
    setWriting(null);
    setDraft('');
  }, [key, model.pane.key]);
  const options = scopeOptions(known);
  const choices = viewChoices(view, options, SCOPE_WORDS, turns.last);
  const choice = shownChoice(view, scope, turns.last);
  const choose = (value: string): void => {
    if (value === 'last' && turns.last) onView({ kind: 'turn', change: turns.last });
    else if (isScope(value) && options.includes(value)) {
      pick(value);
      onView({ kind: 'scope' });
    }
  };
  /** A filter shows every match unfolded: folding waits until it is cleared. */
  const filtering = filter.trim() !== '';
  /** Folds an open row or unfolds a folded one: every folder of it (`TreeRow.ids`). */
  const toggleFolder = (ids: readonly string[], open: boolean): void => {
    if (filtering) return;
    setClosed((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (open) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
  /** The one row Tab stops at (the arrows move along the rest): the shown file's while the tree shows it, else the first. */
  const tabStop = tree.findIndex((row) => row.kind === 'file' && row.key === model.pane.key);
  /** ↑ / ↓ move along the tree's rows, Home / End to its ends; ← folds a folder, → unfolds it. */
  const treeKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('button')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const row = tree[at];
      if (!row || row.kind !== 'folder' || row.open !== (event.key === 'ArrowLeft')) return;
      event.preventDefault();
      toggleFolder(row.ids, row.open);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1] : rows[at + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  const empty = emptyState(scope, known);
  const { comments, add, remove, clear } = useDiffComments(sessionId);
  const perFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments) counts.set(comment.fileKey, (counts.get(comment.fileKey) ?? 0) + 1);
    return counts;
  }, [comments]);
  const severalRepos = useMemo(() => new Set(comments.map((comment) => comment.repo)).size > 1, [comments]);
  useEffect(() => {
    if (comments.length === 0) setListed(false);
  }, [comments.length]);
  const fileComments = shownFile ? comments.filter((comment) => comment.fileKey === fileKey(shownFile) && comment.line === null) : [];
  /** Narrow and a diff opened: the diff fills the panel. */
  const showingDiff = model.pane.key !== null && shownFile !== null && (wide || opened);
  usePanelEsc(escTarget({ popover: !wide && popover, reader: false, helper: false, diff: !wide && opened && showingDiff }), (target) => {
    if (target === 'popover') setPopover(false);
    else if (target === 'diff') setOpened(false);
  });

  const markReviewed = (): void => {
    setMarking(true);
    api.markReviewed(sessionId).then(
      () => setMarking(false),
      (error: unknown) => {
        setMarking(false);
        toast({ text: apiErrorText(error), tone: 'error' });
      },
    );
  };
  const send = (): void => {
    onSendComments(reviewMessage(comments));
    clear();
    toast({ text: 'Your comments are in the message box. Send them when you are ready.' });
  };
  const copy = (): void => {
    void copyText(reviewMessage(comments)).then((ok) => toast({ text: ok ? 'Comments copied.' : 'Could not copy the comments.', ...(ok ? {} : { tone: 'error' as const }) }));
  };

  let emptyTitle = empty.text;
  let emptyText: string | undefined = empty.hint ? 'The agent already saved its work as commits.' : scope === 'head' ? 'Nothing is waiting to be saved.' : undefined;
  if (view.kind === 'turn') {
    emptyTitle = 'Nothing differs for this turn';
    emptyText = 'The files are as they were before it.';
  } else if (scope === 'review') {
    emptyTitle = AGENT_WORDS.noReviewChanges;
    emptyText = AGENT_WORDS.noReviewChangesText;
  }

  const added = list.reduce((sum, file) => sum + file.added, 0);
  const removed = list.reduce((sum, file) => sum + file.removed, 0);
  const choiceLabel = choices.find((candidate) => candidate.value === choice)?.label ?? SCOPE_WORDS[scope];
  const severalTrees = new Set(list.map((file) => file.solution)).size > 1;

  const treeList = (
    <div className="v2-ag-chg-tree" data-testid="v2-side-changes-tree">
      <div className="v2-ag-chg-rows" role="group" aria-label="Changed files" onKeyDown={treeKey}>
        {tree.map((row, index) =>
          row.kind === 'folder' ? (
            <button
              key={`d:${row.id}`}
              type="button"
              className="v2-ag-tree-row v2-ag-chg-row"
              style={{ paddingLeft: 10 + row.depth * 14 }}
              tabIndex={index === Math.max(tabStop, 0) ? 0 : -1}
              aria-expanded={row.open}
              aria-disabled={filtering || undefined}
              title={`${row.label} · ${row.files} file${row.files === 1 ? '' : 's'}${filtering ? ' · unfolded while you filter' : ''}`}
              onClick={() => toggleFolder(row.ids, row.open)}
              data-testid="v2-side-change-folder"
            >
              <Icon name={row.open ? 'chev-down' : 'chev'} size="s" />
              <Icon name="folder" size="s" />
              <span className="v2-ag-tree-name v2-grow">{row.label}</span>
              {/* Unfolded, its files say it; folded, the folder does. */}
              {row.open ? null : <Delta added={row.added} removed={row.removed} />}
            </button>
          ) : (
            <button
              key={`f:${row.key}`}
              type="button"
              className="v2-ag-tree-row v2-ag-chg-row"
              style={{ paddingLeft: 10 + row.depth * 14 + 18 }}
              tabIndex={index === Math.max(tabStop, 0) ? 0 : -1}
              aria-current={row.key === model.pane.key ? 'true' : undefined}
              title={row.file.path}
              onClick={() => {
                setSelected(row.key);
                setOpened(true);
                setPopover(false);
              }}
              data-state={row.file.state}
              data-testid="v2-side-change-file"
            >
              <Icon name="results" size="s" />
              <span className="v2-ag-tree-name v2-grow">{row.name}</span>
              {perFile.get(row.key) ? (
                <span className="v2-ag-chg-count" title="Your comments on this file">
                  <Icon name="chat" size="s" />
                  {perFile.get(row.key)}
                </span>
              ) : null}
              {/* One signal: new, deleted, or what changed. */}
              {row.file.state === 'changed' ? <Delta added={row.file.added} removed={row.file.removed} /> : <span className="v2-ag-chg-state">{row.file.state}</span>}
            </button>
          ),
        )}
        {tree.length === 0 ? <p className="v2-muted v2-ag-small v2-ag-tree-note">Nothing matches “{filter.trim()}”.</p> : null}
      </div>
    </div>
  );

  const listButton = <ListButton panel="changes" expanded={wide ? docked : popover} label={AGENT_WORDS.panelList} onToggle={() => (wide ? setDocked((on) => !on) : setPopover((on) => !on))} />;

  const diffView =
    showingDiff && shownFile ? (
      <div className="v2-ag-chg-diff" data-testid="v2-side-diff" data-wrap={wrap ? 'true' : undefined} data-layout={split ? 'split' : 'unified'}>
        <div className="v2-ag-chg-diff-h">
          <span className="v2-grow v2-mono" title={`${shownFile.solution} · ${shownFile.path}`} data-testid="v2-side-diff-path">
            {severalTrees ? `${shownFile.solution}/` : ''}
            {shownFile.path}
          </span>
          <Button size="sm" variant="ghost" onClick={() => write('file')} title="Comment on this file, or on one of its lines by number" data-testid="v2-side-diff-comment">
            {AGENT_WORDS.comment}
          </Button>
          <IconButton ref={setMoreAnchor} icon="more" label={AGENT_WORDS.more} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((on) => !on)} data-testid="v2-side-diff-more" />
          <Menu
            items={[
              { id: 'wrap', label: AGENT_WORDS.wrapLines, icon: wrap ? 'check' : 'circle', onSelect: () => setWrap((on) => !on) },
              ...(wide ? [{ id: 'split', label: AGENT_WORDS.sideBySide, icon: split ? 'check' : 'circle', onSelect: () => pickLayout(split ? 'unified' : 'split') }] : []),
              { id: 'open', label: AGENT_WORDS.openTheFile, icon: 'eye', onSelect: () => onOpenFile(shownFile.path) },
            ]}
            anchor={moreAnchor}
            open={moreOpen}
            onClose={() => setMoreOpen(false)}
            label={AGENT_WORDS.more}
            testId="v2-side-diff-menu"
          />
          {listButton}
        </div>
        {split ? (
          <div className="v2-ag-split-grid" role="table" aria-label={shownFile.path} data-testid="v2-side-diff-split">
            <div className="v2-ag-split-colh" role="columnheader">
              {AGENT_WORDS.before}
            </div>
            <div className="v2-ag-split-colh" role="columnheader">
              {AGENT_WORDS.after}
            </div>
            {splitRows.map((row, index) =>
              row.kind === 'hunk' ? (
                <div key={index} className="v2-ag-split-hunk" data-tone="hunk">
                  {row.text}
                </div>
              ) : (
                <SplitPair key={index} left={row.left} right={row.right} />
              ),
            )}
          </div>
        ) : (
          <div className="v2-ag-chg-lines">
            {fileComments.map((comment) => (
              <div key={comment.id} className="v2-ag-chg-note" data-testid="v2-side-comment">
                <span className="v2-ag-chg-note-text">{comment.text}</span>
                <IconButton icon="x" label="Remove this comment" onClick={() => remove(comment.id)} />
              </div>
            ))}
            {writing === 'file' ? (
              <CommentBox
                place={shownFile.path}
                text={draft}
                onText={setDraft}
                withLine
                onCancel={() => write(null)}
                onAdd={(text, lineNo) => {
                  // With a line number: that line of the file as it is now (its text, when the diff shows it).
                  const row = lineNo === null ? null : (lines.find((line) => line.newNo === lineNo && (line.tone === 'add' || line.tone === 'ctx')) ?? null);
                  add({ repo: shownFile.solution, fileKey: fileKey(shownFile), path: shownFile.path, side: 'new', line: lineNo, code: row?.text ?? '', text });
                  write(null);
                }}
              />
            ) : null}
            {lines.map((line, index) => {
              const side = line.tone === 'del' ? 'old' : 'new';
              const no = line.tone === 'add' || line.tone === 'ctx' ? line.newNo : line.tone === 'del' ? line.oldNo : null;
              const here = no === null ? [] : commentsAt(comments, fileKey(shownFile), side, no);
              const writingHere = no !== null && writing !== null && writing !== 'file' && writing.side === side && writing.line === no;
              const coloured = colours?.[index] ?? null;
              return (
                <Fragment key={index}>
                  <div className="v2-ag-chg-line" data-tone={line.tone} data-commented={here.length > 0 ? 'true' : undefined}>
                    <span className="v2-ag-chg-no">{line.oldNo ?? ''}</span>
                    <span className="v2-ag-chg-no">{line.newNo ?? ''}</span>
                    <span className={coloured ? 'v2-ag-chg-text hljs' : 'v2-ag-chg-text'}>{line.text === '' ? ' ' : coloured ? renderHast(coloured) : line.text}</span>
                    {no !== null ? (
                      <button type="button" className="v2-ag-chg-add" tabIndex={-1} aria-label={`Comment on line ${no}`} title="Comment on this line" data-testid="v2-side-line-comment" onClick={() => write({ side, line: no })}>
                        +
                      </button>
                    ) : null}
                  </div>
                  {here.map((comment) => (
                    <div key={comment.id} className="v2-ag-chg-note" data-testid="v2-side-comment">
                      <span className="v2-ag-chg-note-text">{comment.text}</span>
                      <IconButton icon="x" label="Remove this comment" onClick={() => remove(comment.id)} />
                    </div>
                  ))}
                  {writingHere && no !== null ? (
                    <CommentBox
                      place={`${shownFile.path}:${no}`}
                      text={draft}
                      onText={setDraft}
                      onCancel={() => write(null)}
                      onAdd={(text) => {
                        add({ repo: shownFile.solution, fileKey: fileKey(shownFile), path: shownFile.path, side, line: no, code: line.text, text });
                        write(null);
                      }}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div className="v2-ag-chg" data-testid="v2-side-changes" data-scope={scope} data-view={view.kind} data-choice={choice} data-tour="v2-side-changes">
      <div className="v2-ag-chg-head">
        {/* One picker for what to show, with what that view holds. */}
        {choices.length > 1 ? (
          <>
            <Button ref={setPickerAnchor} size="sm" aria-haspopup="menu" aria-expanded={pickerOpen} title={AGENT_WORDS.changesWhich} onClick={() => setPickerOpen((open) => !open)} data-testid="v2-side-changes-scope">
              {choiceLabel}
              {files !== null && list.length > 0 ? <Delta added={added} removed={removed} /> : null}
              <Icon name="chev-down" size="s" />
            </Button>
            <Menu
              items={choices.map((candidate) => ({
                id: candidate.value,
                label: candidate.label,
                icon: candidate.value === choice ? 'check' : 'circle',
                onSelect: () => {
                  choose(candidate.value);
                  // The menu is gone with the pick: the focus goes back to its button.
                  pickerAnchor?.focus();
                },
              }))}
              anchor={pickerAnchor}
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              label={AGENT_WORDS.changesWhich}
              align="start"
              testId="v2-side-changes-scope-menu"
            />
          </>
        ) : (
          <span className="v2-muted v2-ag-small">{choices[0]?.label ?? SCOPE_WORDS[scope]}</span>
        )}
        <input className="v2-field v2-ag-chg-filter v2-grow" type="search" placeholder={AGENT_WORDS.filterFiles} aria-label="Filter the changed files" value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="v2-side-changes-filter" />
        {review ? (
          <Button size="sm" variant="primary" icon="check" disabled={marking} onClick={markReviewed} data-testid="v2-side-changes-reviewed">
            {AGENT_WORDS.markReviewed}
          </Button>
        ) : null}
      </div>
      {files === null ? (
        diffError ? (
          <EmptyState icon="alert" tone="grey" title="Could not read the changes" text={apiErrorText(diffError)} testId="v2-side-changes-error" />
        ) : (
          <div className="v2-ag-chg-pad">
            <Skeleton lines={4} height={14} />
          </div>
        )
      ) : model.empty ? (
        <EmptyState
          icon="copy"
          tone="grey"
          title={emptyTitle}
          text={emptyText}
          action={
            view.kind === 'scope' && empty.hint && options.includes('branch') ? (
              <Button size="sm" onClick={() => pick('branch')} data-testid="v2-side-changes-branch">
                Show the {SCOPE_WORDS.branch.toLowerCase()}
              </Button>
            ) : undefined
          }
          testId="v2-side-changes-empty"
        />
      ) : (
        <>
          <span className="v2-sr" data-testid="v2-side-changes-sum">
            {list.length} file{list.length === 1 ? '' : 's'} changed · {deltaText(added, removed)}
          </span>
          <PanelSplit panel="changes" wide={wide} docked={docked} popover={popover} onClosePopover={() => setPopover(false)} list={treeList} content={diffView} testId="v2-side-changes-split" />
        </>
      )}
      {comments.length > 0 ? (
        <div className="v2-ag-chg-send" data-testid="v2-side-comments-bar">
          {listed ? (
            <ul className="v2-ag-chg-all" aria-label="Your comments" data-testid="v2-side-comments-list">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <span className="v2-ag-chg-all-where">
                    <span className="v2-mono">{commentPlace(comment)}</span>
                    {severalRepos ? <span className="v2-muted"> in {comment.repo}</span> : null}
                    {comment.side === 'old' ? <span className="v2-muted"> (removed line)</span> : null}
                  </span>
                  <span className="v2-ag-chg-all-text">{comment.text}</span>
                  <IconButton icon="x" label={`Remove the comment on ${commentPlace(comment)}`} onClick={() => remove(comment.id)} />
                </li>
              ))}
            </ul>
          ) : null}
          <div className="v2-ag-chg-send-row">
            <button type="button" className="v2-ag-chg-send-count v2-grow" aria-expanded={listed} onClick={() => setListed((on) => !on)} title="Show every comment, also those on lines this view does not show" data-testid="v2-side-comments-toggle">
              <Icon name={listed ? 'chev-down' : 'chev'} size="s" />
              <b>
                {comments.length} comment{comments.length === 1 ? '' : 's'}
              </b>{' '}
              <span className="v2-muted">for the agent</span>
            </button>
            <Button size="sm" variant="ghost" onClick={clear} data-testid="v2-side-comments-discard">
              Discard
            </Button>
            <Button size="sm" variant="ghost" icon="copy" onClick={copy} data-testid="v2-side-comments-copy">
              Copy
            </Button>
            <Button size="sm" variant="primary" disabled={sendBlocked !== null} title={sendBlocked ?? 'Puts them in the message box: you send them'} onClick={send} data-testid="v2-side-comments-send">
              Send to agent
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
