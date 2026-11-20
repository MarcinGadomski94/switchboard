/**
 * D180 · Files in the side panel as one view (`docs/v2.md` → *The agent view's side panel*,
 * the rules in `files-view.ts`):
 *
 * - **Filter files**, which filters both parts below;
 * - **Touched by this agent · N**: newest first, 5 rows then Show all (icon · name · folder ·
 *   what and when);
 * - **the folder tree**, one heading per root, lazy as before; each file row carries one signal
 *   (from the shared `head` diff: `+a −d`, `new`, `deleted`; else a muted `read` / `mentioned`), a
 *   folded folder "N changed".
 * - **The reader** (`PanelSplit`: beside the list when wide, filling the panel when narrow):
 *   back / forward through the files opened here, a breadcrumb whose folders open the list
 *   there, ⋯ (Copy path, Open in its app, Show in folder), the list button; an info line for a
 *   file the agent touched ("Edited by the agent at 10:21 · +12 −3 · View changes"); the body as
 *   before (code in colours, Markdown, an HTML file as its page with scripts off, pictures, PDF,
 *   sound, film, tables) with the lines the `head` diff adds marked.
 */
import { type ReactNode, type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { common, createLowlight } from 'lowlight';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { type AgentFileMeta, type AgentFileRef, type AgentFileRoot, isPageName, opensInApp } from '../../../core/agent-files.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { ChatMarkdown, copyText } from '../../views/session/ChatMarkdown.tsx';
import { Button, EmptyState, Icon, IconButton, Menu, Segmented, Skeleton, useToast } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { Delta } from './ChangesPanel.tsx';
import { filesScroll, fold, rememberFilesScroll, unfold, unfoldAll, updateFilesTab, useFilesTab, withListing } from './files-tab-state.ts';
import { type FileSignal, addedLines, breadcrumb, changedByPath, changedUnder, fileSignal, historyBack, historyForward, historyOpen, infoText, matchesFilter, pathKey, touchedRows, touchedText, touchedWhat, unfoldSetFor } from './files-view.ts';
import { PAGE_SCRIPTS_HINT, pageFootText, pageLeftNote, pageOpensAs, pageScriptsAction } from './page-view.ts';
import { escTarget } from './panel-layout.ts';
import { ListButton, PanelSplit, usePanelEsc } from './PanelSplit.tsx';
import { type AgentFilesState, apiErrorCode, apiErrorText } from './useAgentFiles.ts';
import type { HeadDiffState } from './useHeadDiff.ts';

/** The file the reader shows. */
export interface OpenFile {
  readonly path: string;
  readonly line: number | null;
}

const lowlight = createLowlight(common);
/** The code view's line height (px): the gutter, the text and the marked line share it. */
const LINE_PX = 20;
const CSV_ROWS = 500;

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateText(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/** "10:38" today, else the date and time. */
export function timeText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hm = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? hm : `${date.toLocaleDateString()} ${hm}`;
}

/** Rows of a CSV or TSV text: quoted cells, doubled quotes, the delimiter guessed from the first line. */
export function csvRows(text: string, max: number): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (mark: string): number => first.split(mark).length - 1;
  const delimiter = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if ((cell !== '' || row.length > 0) && rows.length < max) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── The reader's body ─────────────────────────────────────────────────────────

function CodeView({ lines, firstLine, language, markLine, added }: { readonly lines: readonly string[]; readonly firstLine: number; readonly language: string | null; readonly markLine: number | null; readonly added: ReadonlySet<number> }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const text = useMemo(() => lines.join('\n'), [lines]);
  const highlighted = useMemo<ReactNode>(() => {
    if (!language || !lowlight.registered(language)) return null;
    try {
      return toJsxRuntime(lowlight.highlight(language, text), { Fragment, jsx: jsx as never, jsxs: jsxs as never });
    } catch {
      return null;
    }
  }, [language, text]);
  const marked = markLine !== null && markLine >= firstLine && markLine < firstLine + lines.length ? markLine - firstLine : null;
  useEffect(() => {
    if (marked === null || !scroller.current) return;
    scroller.current.scrollTop = Math.max(0, marked * LINE_PX - 4 * LINE_PX);
  }, [marked, text]);
  // D180: the lines the agent's uncommitted change adds: a green bar and a faint green background.
  const changedRows = useMemo(() => lines.map((_, index) => firstLine + index).filter((no) => added.has(no)), [lines, firstLine, added]);
  return (
    <div className="v2-ag-src" ref={scroller} data-testid="v2-file-code" style={{ ['--v2-ag-src-line' as string]: `${LINE_PX}px` }}>
      <div className="v2-ag-src-in">
        {changedRows.map((no) => (
          <div key={no} className="v2-ag-src-added" style={{ top: (no - firstLine) * LINE_PX }} data-testid="v2-file-added" />
        ))}
        {marked !== null ? <div className="v2-ag-src-mark" style={{ top: marked * LINE_PX }} data-testid="v2-file-mark" /> : null}
        <div className="v2-ag-src-gutter" aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index}>{firstLine + index}</span>
          ))}
        </div>
        <pre className="v2-ag-src-pre">
          <code className={language ? `hljs language-${language}` : undefined}>{highlighted ?? text}</code>
        </pre>
      </div>
    </div>
  );
}

/** How a file that can be shown two ways is shown: as what it makes (Markdown, an HTML page) or as its source. */
type FileView = 'rendered' | 'source';

function ViewSwitch({ view, onChange, testId }: { readonly view: FileView; readonly onChange: (view: FileView) => void; readonly testId: string }) {
  return (
    <div className="v2-ag-fv-bar">
      <Segmented<FileView>
        label="How to show it"
        size="s"
        value={view}
        options={[
          { value: 'rendered', label: AGENT_WORDS.rendered },
          { value: 'source', label: AGENT_WORDS.source },
        ]}
        onChange={onChange}
        testId={testId}
      />
    </div>
  );
}

/**
 * An HTML file as a page. It is shown in a sandboxed frame, closed off from this app,
 * under rules that fetch nothing from an address (`pagePolicy`,
 * `src/server/agent-files/page.ts`), with the stylesheets and pictures of its own
 * folders put into it; what was left out is said above it. Its scripts stay off until
 * the developer runs them, for this file, this time: with scripts no browser rule
 * keeps what the page holds from being sent away ({@link PAGE_SCRIPTS_HINT}).
 */
function PageBody({ sessionId, meta, confirm }: { readonly sessionId: string; readonly meta: AgentFileMeta; readonly confirm: boolean }) {
  const [scripts, setScripts] = useState(false);
  /** Counts Reload: a new number asks the server for the page anew (the file, or one it uses, may have changed). */
  const [turn, setTurn] = useState(0);
  const how = useMemo(() => ({ confirm, scripts, version: `${meta.modifiedAt}:${turn}` }), [confirm, scripts, meta.modifiedAt, turn]);
  const asked = useApi(async () => ({ how, info: await api.agentPageInfo(sessionId, meta.path, how) }), [sessionId, meta.path, how]);
  // `useApi` keeps its last answer while the next one loads: only the answer to what is asked now counts.
  const info = asked.data !== null && asked.data.how === how && !asked.loading ? asked.data.info : null;
  if (asked.error && info === null && !asked.loading) return <EmptyState icon="alert" tone="grey" title="Could not show this as a page" text={apiErrorText(asked.error)} testId="v2-file-page-error" />;
  // The page is asked for once what it is shown with is known (the server builds both from one reading).
  if (info === null) {
    return (
      <div className="v2-ag-files-pad">
        <Skeleton lines={6} height={14} />
      </div>
    );
  }
  const note = pageLeftNote(info);
  const src = api.agentPageUrl(sessionId, meta.path, how);
  return (
    <>
      {note ? (
        <details className="v2-ag-fv-note v2-ag-small" data-testid="v2-file-page-left">
          <summary>{note.text}</summary>
          <ul>
            {note.lines.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {/* Never `allow-same-origin`: the page must not be this app. `allow-scripts` is for the frame document's own script; the page's scripts run only when the address asks for them. A new address is a new frame (no entry in the tab's history). */}
      <iframe key={src} className="v2-ag-fv-frame" title={meta.name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} data-testid="v2-file-page" data-scripts={scripts ? 'on' : 'off'} />
      <div className="v2-ag-fv-foot v2-muted v2-ag-small">
        <span className="v2-grow" data-testid="v2-file-page-foot">
          {pageFootText(info, scripts, sizeText(meta.size))}
        </span>
        <Button size="sm" onClick={() => setTurn((count) => count + 1)} title="Read the file again" data-testid="v2-file-page-reload">
          Reload
        </Button>
        {info.scripted ? (
          <Button size="sm" onClick={() => setScripts((running) => !running)} title={PAGE_SCRIPTS_HINT} aria-pressed={scripts} data-testid="v2-file-page-scripts">
            {pageScriptsAction(scripts)}
          </Button>
        ) : null}
      </div>
    </>
  );
}

/** A line this far down is opened near itself, not from the top of the file. */
const FAR_LINE = 1500;
/** Lines shown above a far line. */
const LINES_BEFORE = 200;

function TextBody({ sessionId, meta, confirm, line, added }: { readonly sessionId: string; readonly meta: AgentFileMeta; readonly confirm: boolean; readonly line: number | null; readonly added: ReadonlySet<number> }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const page = meta.kind === 'text' && isPageName(meta.name);
  // Opened at a line: the source is what the line number means.
  const [view, setView] = useState<FileView>(() => (page ? pageOpensAs(line, meta.size) : line === null ? 'rendered' : 'source'));
  /** Index of the first line held (0 unless the file was opened at a far line). */
  const first = line !== null && line > FAR_LINE ? line - LINES_BEFORE : 0;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(
    (offset: number, before: readonly string[]): void => {
      setLoading(true);
      api.agentFileText(sessionId, meta.path, offset, confirm).then(
        (answer) => {
          if (!alive.current) return;
          setLines([...before, ...answer.lines]);
          setMore(answer.more);
          setTotal(answer.totalLines);
          setError(null);
          setLoading(false);
        },
        (failure: unknown) => {
          if (!alive.current) return;
          setError(apiErrorText(failure));
          setLoading(false);
        },
      );
    },
    [sessionId, meta.path, confirm],
  );
  useEffect(() => {
    setLines(null);
    load(first, []);
  }, [load, meta.modifiedAt, first]);

  const pageSwitch = page ? <ViewSwitch view={view} onChange={setView} testId="v2-file-page-view" /> : null;
  // An HTML file's page does not wait for its source, nor fail with it.
  if (page && view === 'rendered') {
    return (
      <>
        {pageSwitch}
        <PageBody sessionId={sessionId} meta={meta} confirm={confirm} />
      </>
    );
  }
  if (error && lines === null) {
    return (
      <>
        {pageSwitch}
        <EmptyState icon="alert" tone="grey" title="Could not read this file" text={error} />
      </>
    );
  }
  if (lines === null) {
    return (
      <>
        {pageSwitch}
        <div className="v2-ag-files-pad">
          <Skeleton lines={6} height={14} />
        </div>
      </>
    );
  }
  const footer = (
    <div className="v2-ag-fv-foot v2-muted v2-ag-small">
      <span className="v2-grow">
        {first > 0 ? `Lines ${first + 1}–${first + lines.length}` : `${lines.length} line${lines.length === 1 ? '' : 's'}`}
        {total !== null && total > lines.length ? ` of ${total}` : more ? ' so far' : ''} · {sizeText(meta.size)}
      </span>
      {more ? (
        <Button size="sm" disabled={loading} onClick={() => load(first + lines.length, lines)} data-testid="v2-file-more">
          {loading ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
  if (page) {
    return (
      <>
        {pageSwitch}
        <CodeView lines={lines} firstLine={first + 1} language={meta.language} markLine={line} added={added} />
        {footer}
      </>
    );
  }
  if (meta.kind === 'markdown') {
    return (
      <>
        <ViewSwitch view={view} onChange={setView} testId="v2-file-md-view" />
        {view === 'rendered' ? (
          <div className="v2-ag-fv-md" data-testid="v2-file-md">
            <ChatMarkdown text={lines.join('\n')} testId="v2-file-md-text" />
          </div>
        ) : (
          <CodeView lines={lines} firstLine={first + 1} language="markdown" markLine={line} added={added} />
        )}
        {footer}
      </>
    );
  }
  if (meta.kind === 'csv') {
    const rows = csvRows(lines.join('\n'), CSV_ROWS);
    const head = rows[0] ?? [];
    return (
      <>
        <div className="v2-ag-fv-table" data-testid="v2-file-csv">
          <table>
            <thead>
              <tr>
                {head.map((cell, index) => (
                  <th key={index}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {footer}
      </>
    );
  }
  return (
    <>
      <CodeView lines={lines} firstLine={first + 1} language={meta.language} markLine={line} added={added} />
      {footer}
    </>
  );
}

// ── The reader ────────────────────────────────────────────────────────────────

interface ReaderProps {
  readonly sessionId: string;
  readonly file: OpenFile;
  readonly roots: readonly AgentFileRoot[] | null;
  /** The agent's own record of the file (`null`: it never touched it). */
  readonly touched: AgentFileRef | null;
  /** The file's `head` change, when it has one. */
  readonly change: { readonly added: number; readonly removed: number; readonly lines: readonly string[] } | null;
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  /** A breadcrumb folder: the list, unfolded down to it. */
  readonly onFolder: (dir: string) => void;
  readonly onViewChanges: (path: string) => void;
  readonly listButton: ReactNode;
}

function Reader({ sessionId, file, roots, touched, change, canBack, canForward, onBack, onForward, onFolder, onViewChanges, listButton }: ReaderProps) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [file.path]);
  const meta = useApi(() => api.agentFileMeta(sessionId, file.path), [sessionId, file.path]);
  const info = meta.data;
  const name = info?.name ?? file.path.split(/[\\/]/).pop() ?? file.path;
  const shownPath = info?.path ?? file.path;
  const trail = roots ? breadcrumb(shownPath, roots) : null;
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  const added = useMemo(() => (change ? addedLines(change.lines) : new Set<number>()), [change]);
  const openWith = (how: 'app' | 'folder'): void => {
    api.openAgentFile(sessionId, shownPath, how).then(
      () => toast({ text: how === 'app' ? 'Opened in its app.' : 'Shown in its folder.' }),
      (error: unknown) => toast({ text: apiErrorText(error), tone: 'error' }),
    );
  };
  const copy = (): void => {
    void copyText(shownPath).then((ok) => toast({ text: ok ? 'Path copied.' : 'Could not copy the path.', ...(ok ? {} : { tone: 'error' as const }) }));
  };
  let body: ReactNode;
  if (meta.error) {
    const code = apiErrorCode(meta.error);
    body = <EmptyState icon={code === 'outside' ? 'shield' : 'alert'} tone="grey" title={code === 'outside' ? 'This file can’t be opened here' : code === 'missing' ? 'No such file' : 'Could not open this file'} text={apiErrorText(meta.error)} testId="v2-file-error" />;
  } else if (!info) {
    body = (
      <div className="v2-ag-files-pad">
        <Skeleton lines={6} height={14} />
      </div>
    );
  } else if (info.secret !== null && !confirm) {
    body = (
      <EmptyState
        icon="shield"
        tone="grey"
        title="This file looks like it holds secrets"
        text={`Why: ${info.secret}. It is shown only when you ask.`}
        action={
          <Button size="sm" onClick={() => setConfirm(true)} data-testid="v2-file-secret-show">
            Show it anyway
          </Button>
        }
        testId="v2-file-secret"
      />
    );
  } else if (info.kind === 'text' || info.kind === 'markdown' || info.kind === 'csv') {
    body = <TextBody key={`${info.path}:${file.line ?? ''}`} sessionId={sessionId} meta={info} confirm={confirm} line={file.line} added={added} />;
  } else {
    const raw = api.agentFileRawUrl(sessionId, info.path, confirm);
    if (info.kind === 'image') {
      body = (
        <div className="v2-ag-fv-media" data-testid="v2-file-image">
          <img src={raw} alt={info.name} />
        </div>
      );
    }
    // The browser's own PDF viewer: without its thumbnail strip and fitted to the panel's width (a narrow column).
    else if (info.kind === 'pdf') body = <iframe className="v2-ag-fv-frame" title={info.name} src={`${raw}#navpanes=0&view=FitH`} data-testid="v2-file-pdf" />;
    else if (info.kind === 'audio') {
      body = (
        <div className="v2-ag-fv-media" data-testid="v2-file-audio">
          <audio controls src={raw} />
        </div>
      );
    } else if (info.kind === 'video') {
      body = (
        <div className="v2-ag-fv-media" data-testid="v2-file-video">
          <video controls src={raw} />
        </div>
      );
    } else {
      body = (
        <EmptyState
          icon="results"
          tone="grey"
          title="No preview for this kind of file"
          text={`${info.mime} · ${sizeText(info.size)} · changed ${dateText(info.modifiedAt)}`}
          action={
            <span className="v2-row" style={{ gap: 8 }}>
              {opensInApp(info.name) ? (
                <Button size="sm" onClick={() => openWith('app')}>
                  {AGENT_WORDS.openInApp}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => openWith('folder')}>
                {AGENT_WORDS.showInFolder}
              </Button>
            </span>
          }
          testId="v2-file-binary"
        />
      );
    }
  }
  const infoLine = infoText(touched, timeText);
  return (
    <div className="v2-ag-fv" data-testid="v2-file-viewer" data-kind={info?.kind}>
      <div className="v2-ag-fv-head">
        <IconButton icon="back" label={AGENT_WORDS.backFile} disabled={!canBack} onClick={onBack} data-testid="v2-file-back" />
        <IconButton icon="chev" label={AGENT_WORDS.forwardFile} disabled={!canForward} onClick={onForward} data-testid="v2-file-forward" />
        <nav className="v2-ag-fv-crumbs v2-grow" aria-label="Where the file is" title={shownPath} data-testid="v2-file-crumbs">
          {trail
            ? trail.crumbs.map((crumb) => (
                <span key={crumb.dir} className="v2-ag-fv-crumb">
                  <button type="button" className="v2-ag-fv-crumb-b" onClick={() => onFolder(crumb.dir)} data-testid="v2-file-crumb">
                    {crumb.name}
                  </button>
                  <span className="v2-muted" aria-hidden="true">
                    /
                  </span>
                </span>
              ))
            : null}
          <b className="v2-ag-fv-crumb-file">{trail?.name ?? name}</b>
          {file.line !== null ? <span className="v2-muted"> · line {file.line}</span> : null}
        </nav>
        <IconButton ref={setMoreAnchor} icon="more" label={AGENT_WORDS.more} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((on) => !on)} data-testid="v2-file-more-menu" />
        <Menu
          items={[
            { id: 'copy', label: AGENT_WORDS.copyPath, icon: 'copy', onSelect: copy },
            // Only what its app merely shows (documents, pictures, sound, film): never something the system could run.
            ...(opensInApp(name) ? [{ id: 'app', label: AGENT_WORDS.openInApp, icon: 'external', onSelect: () => openWith('app') }] : []),
            { id: 'folder', label: AGENT_WORDS.showInFolder, icon: 'folder', onSelect: () => openWith('folder') },
          ]}
          anchor={moreAnchor}
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          label={AGENT_WORDS.more}
          testId="v2-file-menu"
        />
        {listButton}
      </div>
      {infoLine ? (
        <div className="v2-ag-fv-info v2-ag-small" data-testid="v2-file-info" data-tour="v2-side-info">
          <span>{infoLine}</span>
          {change ? (
            <>
              <span className="v2-muted"> · </span>
              <Delta added={change.added} removed={change.removed} />
              <span className="v2-muted"> · </span>
              <button type="button" className="v2-link-btn" onClick={() => onViewChanges(shownPath)} data-testid="v2-file-view-changes">
                {AGENT_WORDS.viewChanges}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="v2-ag-fv-body">{body}</div>
    </div>
  );
}

// ── The list ──────────────────────────────────────────────────────────────────

/** Reads what a folder holds into the agent's remembered tree (also when the tree is not on screen any more). */
function loadDir(sessionId: string, dir: string): void {
  api.agentDir(sessionId, dir).then(
    (listing) => updateFilesTab(sessionId, (state) => withListing(state, dir, listing)),
    (error: unknown) => updateFilesTab(sessionId, (state) => withListing(state, dir, { error: apiErrorText(error) })),
  );
}

function Signal({ signal }: { readonly signal: FileSignal | null }) {
  if (signal === null) return null;
  if (signal.kind === 'delta') return <Delta added={signal.added} removed={signal.removed} />;
  return (
    <span className="v2-ag-files-sig" data-signal={signal.kind} data-testid="v2-file-signal">
      {signal.kind}
    </span>
  );
}

/** Puts the list back where it was scrolled when it is built again, and remembers where it is scrolled. */
function useKeptScroll(sessionId: string): { readonly ref: (element: HTMLDivElement | null) => void; readonly onScroll: (event: UIEvent<HTMLDivElement>) => void } {
  const shown = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (element: HTMLDivElement | null): void => {
      const leaving = shown.current;
      if (!element && leaving && leaving.isConnected && leaving.getClientRects().length > 0) rememberFilesScroll(sessionId, leaving.scrollTop);
      if (element) element.scrollTop = filesScroll(sessionId);
      shown.current = element;
    },
    [sessionId],
  );
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => rememberFilesScroll(sessionId, event.currentTarget.scrollTop), [sessionId]);
  return { ref, onScroll };
}

export interface FilesPanelProps {
  readonly sessionId: string;
  readonly files: AgentFilesState;
  readonly head: HeadDiffState;
  readonly wide: boolean;
  /** Counts the clicks on the Files tab while it is shown: each closes the reader (back to the list). */
  readonly backToList: number;
  readonly open: OpenFile | null;
  readonly onOpen: (file: OpenFile) => void;
  readonly onClose: () => void;
  readonly onViewChanges: (path: string) => void;
}

export function FilesPanel({ sessionId, files, head, wide, backToList, open, onOpen, onClose, onViewChanges }: FilesPanelProps) {
  const [tab, update] = useFilesTab(sessionId);
  const scroll = useKeptScroll(sessionId);
  const [filter, setFilter] = useState('');
  const [docked, setDocked] = useState(true);
  const [popover, setPopover] = useState(false);
  useEffect(() => {
    setFilter('');
    setPopover(false);
  }, [sessionId]);
  useEffect(() => setPopover(false), [wide]);
  useEffect(() => {
    if (backToList === 0) return;
    setPopover(false);
    onClose();
    // Each click once.
  }, [backToList]);
  const fetched = useApi(async () => ({ sessionId, roots: (await api.agentFileRoots(sessionId)).roots }), [sessionId]);
  // `useApi` keeps its last answer while another agent's loads: only this agent's folders.
  const fresh = fetched.data !== null && fetched.data.sessionId === sessionId ? fetched.data.roots : null;
  useEffect(() => {
    if (fresh) update((state) => (state.roots !== null && state.roots.length === fresh.length && state.roots.every((root, index) => root.path === fresh[index]?.path && root.label === fresh[index]?.label) ? state : { ...state, roots: fresh }));
  }, [fresh, update]);
  const roots = tab.roots ?? fresh;
  const dirs = tab.dirs;
  const changed = useMemo(() => changedByPath(head.files, roots), [head.files, roots]);
  const touchedByKey = useMemo(() => new Map((files.files ?? []).map((file) => [pathKey(file.path), file] as const)), [files.files]);
  const touched = useMemo(() => touchedRows(files.files ?? [], filter, tab.showAll), [files.files, filter, tab.showAll]);
  // Wide, nothing opened yet: the file the agent touched last (never an empty half).
  const lastTouched = useMemo(() => touchedRows(files.files ?? [], '', false).rows.find((file) => file.exists) ?? null, [files.files]);
  const shown: OpenFile | null = open ?? (wide && lastTouched ? { path: lastTouched.path, line: null } : null);
  // The reader's history: opening a file (from the list, the chat or a breadcrumb) is a step.
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (open === null || open.path === lastOpened.current) return;
    lastOpened.current = open.path;
    update((state) => ({ ...state, history: historyOpen(state.history, open.path) }));
  }, [open, update]);
  const history = tab.history;
  const goHistory = (next: typeof history): void => {
    const path = next.items[next.at];
    if (path === undefined) return;
    lastOpened.current = path;
    update((state) => ({ ...state, history: next }));
    onOpen({ path, line: null });
  };

  const toggle = (dir: string): void => {
    if (dir in dirs) update((state) => fold(state, dir));
    else {
      update((state) => unfold(state, dir));
      loadDir(sessionId, dir);
    }
  };
  // The first folder unfolds by itself, once: one folder is the common case.
  const first = roots?.[0]?.path ?? null;
  useEffect(() => {
    if (first === null || tab.opened) return;
    update((state) => (state.opened ? state : { ...unfold(state, first), opened: true }));
    loadDir(sessionId, first);
  }, [first, tab.opened, sessionId, update]);
  // Shown again after a while: the unfolded folders are read again (a file may be new), without folding anything.
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (refreshed.current === sessionId) return;
    refreshed.current = sessionId;
    for (const [dir, state] of Object.entries(dirs)) if (state !== 'loading') loadDir(sessionId, dir);
  }, [sessionId]);
  /** A breadcrumb folder: every folder down to it unfolded, the filter cleared, the list shown. */
  const showFolder = (dir: string): void => {
    if (!roots) return;
    const toOpen = unfoldSetFor(dir, roots).filter((folder) => !(folder in dirs));
    update((state) => unfoldAll(state, toOpen));
    for (const folder of toOpen) loadDir(sessionId, folder);
    setFilter('');
    if (wide) setDocked(true);
    else setPopover(true);
  };
  const pick = (file: OpenFile): void => {
    setPopover(false);
    onOpen(file);
  };
  /** Back from the reader to the list (narrow), with the file's row focused. */
  const listRef = useRef<HTMLDivElement | null>(null);
  const last = useRef<string | null>(null);
  if (open) last.current = open.path;
  useLayoutEffect(() => {
    const root = listRef.current;
    if (open !== null || !root) return;
    const path = last.current;
    last.current = null;
    if (path === null) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-path]')].find((element) => element.dataset['path'] === path);
    row?.focus({ preventScroll: true });
  }, [open]);
  usePanelEsc(escTarget({ popover: !wide && popover, reader: !wide && open !== null, helper: false, diff: false }), (target) => {
    if (target === 'popover') setPopover(false);
    else if (target === 'reader') onClose();
  });

  const filtering = filter.trim() !== '';
  /** Whether a loaded folder holds (anywhere below) a file the filter matches. */
  const holdsMatch = (dir: string, seen: Set<string> = new Set()): boolean => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    const state = dirs[dir];
    if (!state || state === 'loading' || 'error' in state) return false;
    return state.entries.some((entry) => (entry.type === 'dir' ? matchesFilter(entry.name, filter) || holdsMatch(entry.path, seen) : matchesFilter(entry.path, filter)));
  };
  const openKey = shown ? pathKey(shown.path) : null;
  const renderDir = (dir: string, depth: number): ReactNode => {
    const state = dirs[dir];
    if (state === undefined) return null;
    if (state === 'loading') {
      return (
        <div className="v2-ag-tree-note v2-muted v2-ag-small" style={{ paddingLeft: 14 + depth * 14 }}>
          Loading…
        </div>
      );
    }
    if ('error' in state) {
      return (
        <div className="v2-ag-tree-note v2-ag-small" style={{ paddingLeft: 14 + depth * 14 }}>
          {state.error}
        </div>
      );
    }
    const entries = filtering ? state.entries.filter((entry) => (entry.type === 'dir' ? matchesFilter(entry.name, filter) || holdsMatch(entry.path) : matchesFilter(entry.path, filter))) : state.entries;
    return (
      <>
        {entries.map((entry) => {
          if (entry.type === 'dir') {
            const unfolded = entry.path in dirs;
            const count = unfolded ? 0 : changedUnder(entry.path, changed);
            return (
              <div key={entry.path}>
                <button type="button" className="v2-ag-tree-row" style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={unfolded} onClick={() => toggle(entry.path)} data-path={entry.path} data-testid="v2-tree-dir">
                  <Icon name={unfolded ? 'chev-down' : 'chev'} size="s" />
                  <Icon name="folder" size="s" />
                  <span className="v2-ag-tree-name v2-grow">{entry.name}</span>
                  {count > 0 ? (
                    <span className="v2-ag-files-sig" data-signal="changed" data-testid="v2-tree-dir-changed">
                      {count} changed
                    </span>
                  ) : null}
                </button>
                {renderDir(entry.path, depth + 1)}
              </div>
            );
          }
          const signal = fileSignal(entry.path, changed, touchedByKey);
          return (
            <button
              key={entry.path}
              type="button"
              className="v2-ag-tree-row"
              style={{ paddingLeft: 10 + depth * 14 + 18 }}
              aria-current={openKey !== null && pathKey(entry.path) === openKey ? 'true' : undefined}
              onClick={() => pick({ path: entry.path, line: null })}
              title={`${entry.path}${entry.size !== null ? ` · ${sizeText(entry.size)}` : ''}`}
              data-path={entry.path}
              data-testid="v2-tree-file"
            >
              <Icon name="results" size="s" />
              <span className="v2-ag-tree-name v2-grow">{entry.name}</span>
              <Signal signal={signal} />
            </button>
          );
        })}
        {entries.length === 0 && !filtering ? (
          <div className="v2-ag-tree-note v2-muted v2-ag-small" style={{ paddingLeft: 14 + depth * 14 }}>
            Empty
          </div>
        ) : null}
        {state.truncated ? (
          <div className="v2-ag-tree-note v2-muted v2-ag-small" style={{ paddingLeft: 14 + depth * 14 }}>
            More entries are not shown.
          </div>
        ) : null}
      </>
    );
  };

  /** A path relative to the root that holds it, for the touched rows' faint folder. */
  const relativeDir = (dir: string): string => {
    const root = roots ? [...roots].sort((a, b) => b.path.length - a.path.length).find((candidate) => pathKey(`${dir}/`).startsWith(`${pathKey(candidate.path).replace(/\/+$/, '')}/`)) : undefined;
    if (!root) return dir;
    const rest = dir.slice(root.path.replace(/[\\/]+$/, '').length + 1);
    return rest === '' ? '' : rest.replace(/\\/g, '/');
  };

  const list = (
    <div className="v2-ag-files2" ref={listRef} data-testid="v2-side-files">
      <input className="v2-field v2-ag-files-filter" type="search" placeholder={AGENT_WORDS.filterFiles} aria-label="Filter the files" value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="v2-files-filter" />
      <div className="v2-ag-files-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {files.error && files.files === null ? <p className="v2-ag-small v2-ag-files-pad">{files.error}</p> : null}
        {files.files && files.files.length > 0 ? (
          <section className="v2-ag-files-touched" aria-label={AGENT_WORDS.touchedByAgent} data-testid="v2-files-touched">
            <h4 className="v2-ag-files-h">
              {AGENT_WORDS.touchedByAgent} · {touched.total}
            </h4>
            <div role="list">
              {touched.rows.map((file) => {
                const what = touchedWhat(file);
                return (
                  <button
                    key={file.path}
                    type="button"
                    role="listitem"
                    className="v2-ag-files-row"
                    disabled={!file.exists}
                    title={file.exists ? file.path : `${file.path} (deleted)`}
                    aria-current={openKey !== null && pathKey(file.path) === openKey ? 'true' : undefined}
                    onClick={() => pick({ path: file.path, line: file.line })}
                    data-path={file.path}
                    data-what={what}
                    data-testid="v2-files-row"
                  >
                    <Icon name="results" size="s" />
                    <span className="v2-ag-files-name">{file.name}</span>
                    <span className="v2-ag-files-dir v2-grow">{relativeDir(file.dir)}</span>
                    <span className="v2-ag-files-when v2-muted">{touchedText(file, timeText)}</span>
                  </button>
                );
              })}
            </div>
            {touched.more ? (
              <button type="button" className="v2-link-btn v2-ag-files-more" onClick={() => update((state) => ({ ...state, showAll: !state.showAll }))} data-testid="v2-files-show-all">
                {tab.showAll ? AGENT_WORDS.showFewer : AGENT_WORDS.showAll}
              </button>
            ) : null}
          </section>
        ) : null}
        <div className="v2-ag-tree" data-testid="v2-files-tree">
          {fetched.error && roots === null ? <p className="v2-ag-small v2-ag-files-pad">{apiErrorText(fetched.error)}</p> : null}
          {roots === null && !fetched.error ? (
            <div className="v2-ag-files-pad">
              <Skeleton lines={5} height={14} />
            </div>
          ) : null}
          {roots !== null && roots.length === 0 ? <p className="v2-muted v2-ag-small v2-ag-files-pad">This agent has no working folder on this computer.</p> : null}
          {(roots ?? []).map((root) => (
            <div key={root.path}>
              <button type="button" className="v2-ag-tree-row v2-ag-tree-root" aria-expanded={root.path in dirs} onClick={() => toggle(root.path)} title={root.path} data-path={root.path} data-testid="v2-tree-root">
                <Icon name={root.path in dirs ? 'chev-down' : 'chev'} size="s" />
                <span className="v2-ag-tree-name v2-muted">{root.label}</span>
              </button>
              {renderDir(root.path, 1)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  const listButton = <ListButton panel="files" expanded={wide ? docked : popover} label={AGENT_WORDS.panelList} onToggle={() => (wide ? setDocked((on) => !on) : setPopover((on) => !on))} />;
  const shownChange = shown ? (changed.get(pathKey(shown.path)) ?? null) : null;
  const reader = shown ? (
    <Reader
      sessionId={sessionId}
      file={shown}
      roots={roots}
      touched={touchedByKey.get(pathKey(shown.path)) ?? null}
      change={shownChange}
      canBack={history.at > 0}
      canForward={history.at < history.items.length - 1}
      onBack={() => goHistory(historyBack(history))}
      onForward={() => goHistory(historyForward(history))}
      onFolder={showFolder}
      onViewChanges={onViewChanges}
      listButton={listButton}
    />
  ) : null;
  return <PanelSplit panel="files" wide={wide} docked={docked} popover={popover} onClosePopover={() => setPopover(false)} list={list} content={reader} testId="v2-side-files-split" />;
}
