/**
 * SPIKE · Files in the side panel: the files this agent's conversation touched, a
 * tree over its folders, and a viewer that shows any file as something (text with
 * line numbers and colours, rendered Markdown, an HTML file as its page, an image, a
 * PDF, a sound, a film, a table, or the file's facts with "open in its app").
 */
import { type ReactNode, type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { common, createLowlight } from 'lowlight';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { type AgentFileMeta, type AgentFileRef, type AgentFileSource, isPageName, opensInApp } from '../../../core/agent-files.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { ChatMarkdown, copyText } from '../../views/session/ChatMarkdown.tsx';
import { Button, Chip, EmptyState, Icon, IconButton, Segmented, Skeleton, useToast } from '../components/index.ts';
import { type FilesMode, filesScroll, fold, rememberFilesScroll, unfold, updateFilesTab, useFilesTab, withListing } from './files-tab-state.ts';
import { PAGE_SCRIPTS_HINT, pageFootText, pageLeftNote, pageOpensAs, pageScriptsAction } from './page-view.ts';
import { type AgentFilesState, apiErrorCode, apiErrorText } from './useAgentFiles.ts';

/** The file the viewer shows. */
export interface OpenFile {
  readonly path: string;
  readonly line: number | null;
}

const SOURCE_WORDS: Readonly<Record<AgentFileSource, string>> = { wrote: 'wrote', edited: 'edited', read: 'read', mentioned: 'mentioned' };
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

// ── The viewer ────────────────────────────────────────────────────────────────

function CodeView({ lines, firstLine, language, markLine }: { readonly lines: readonly string[]; readonly firstLine: number; readonly language: string | null; readonly markLine: number | null }) {
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
  return (
    <div className="v2-ag-src" ref={scroller} data-testid="v2-file-code" style={{ ['--v2-ag-src-line' as string]: `${LINE_PX}px` }}>
      <div className="v2-ag-src-in">
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
          { value: 'rendered', label: 'Rendered' },
          { value: 'source', label: 'Source' },
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

function TextBody({ sessionId, meta, confirm, line }: { readonly sessionId: string; readonly meta: AgentFileMeta; readonly confirm: boolean; readonly line: number | null }) {
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
        <CodeView lines={lines} firstLine={first + 1} language={meta.language} markLine={line} />
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
          <CodeView lines={lines} firstLine={first + 1} language="markdown" markLine={line} />
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
      <CodeView lines={lines} firstLine={first + 1} language={meta.language} markLine={line} />
      {footer}
    </>
  );
}

function FileViewer({ sessionId, file, onBack }: { readonly sessionId: string; readonly file: OpenFile; readonly onBack: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [file.path]);
  const meta = useApi(() => api.agentFileMeta(sessionId, file.path), [sessionId, file.path]);
  const info = meta.data;
  const name = info?.name ?? file.path.split(/[\\/]/).pop() ?? file.path;
  const shownPath = info?.path ?? file.path;
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
    body = <TextBody key={`${info.path}:${file.line ?? ''}`} sessionId={sessionId} meta={info} confirm={confirm} line={file.line} />;
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
                  Open in its app
                </Button>
              ) : null}
              <Button size="sm" onClick={() => openWith('folder')}>
                Show in folder
              </Button>
            </span>
          }
          testId="v2-file-binary"
        />
      );
    }
  }
  return (
    <div className="v2-ag-fv" data-testid="v2-file-viewer" data-kind={info?.kind}>
      <div className="v2-ag-fv-head">
        <IconButton icon="back" label="Back to the files" onClick={onBack} />
        <div className="v2-ag-fv-title">
          <b title={name}>{name}</b>
          <span className="v2-muted v2-ag-small" title={shownPath}>
            {shownPath}
            {file.line !== null ? ` · line ${file.line}` : ''}
          </span>
        </div>
        <IconButton icon="copy" label="Copy path" onClick={copy} />
        {/* Only what its app merely shows (documents, pictures, sound, film): never something the system could run. */}
        {opensInApp(name) ? <IconButton icon="external" label="Open in its app" onClick={() => openWith('app')} data-testid="v2-file-open-app" /> : null}
        <IconButton icon="folder" label="Show in folder" onClick={() => openWith('folder')} />
      </div>
      <div className="v2-ag-fv-body">{body}</div>
    </div>
  );
}

// ── The lists ─────────────────────────────────────────────────────────────────

/**
 * Puts a list back where it was scrolled when it is built again (another tab was
 * shown, the panel was hidden), and remembers where it is scrolled: while it scrolls,
 * and once more when it is taken away.
 */
function useKeptScroll(sessionId: string, mode: FilesMode): { readonly ref: (element: HTMLDivElement | null) => void; readonly onScroll: (event: UIEvent<HTMLDivElement>) => void } {
  const shown = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (element: HTMLDivElement | null): void => {
      const leaving = shown.current;
      // Taken away: its place is read while it is still laid out (a detached one would say 0).
      if (!element && leaving && leaving.isConnected && leaving.getClientRects().length > 0) rememberFilesScroll(sessionId, mode, leaving.scrollTop);
      if (element) element.scrollTop = filesScroll(sessionId, mode);
      shown.current = element;
    },
    [sessionId, mode],
  );
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => rememberFilesScroll(sessionId, mode, event.currentTarget.scrollTop), [sessionId, mode]);
  return { ref, onScroll };
}

function TouchedList({ sessionId, state, onOpen }: { readonly sessionId: string; readonly state: AgentFilesState; readonly onOpen: (file: OpenFile) => void }) {
  const [filter, setFilter] = useState('');
  const scroll = useKeptScroll(sessionId, 'touched');
  if (state.error && state.files === null) return <EmptyState icon="alert" tone="grey" title="Could not list the files" text={state.error} testId="v2-files-error" />;
  if (state.files === null) {
    return (
      <div className="v2-ag-files-pad">
        <Skeleton lines={5} height={14} />
      </div>
    );
  }
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = state.files.filter((file) => words.every((word) => file.path.toLowerCase().includes(word)));
  if (state.files.length === 0) {
    return <EmptyState icon="results" tone="grey" title="No files yet" text="Files show here once the agent writes, edits, reads or names one." testId="v2-files-empty" />;
  }
  return (
    <>
      <input className="v2-field v2-ag-files-filter" type="search" placeholder="Filter by name or folder" aria-label="Filter the files" value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="v2-files-filter" />
      <div className="v2-ag-files-list" role="list" ref={scroll.ref} onScroll={scroll.onScroll}>
        {shown.map((file: AgentFileRef) => (
          <button key={file.path} type="button" role="listitem" className="v2-ag-files-row" disabled={!file.exists} title={file.exists ? file.path : `${file.path} (gone)`} onClick={() => onOpen({ path: file.path, line: file.line })} data-path={file.path} data-testid="v2-files-row">
            <span className="v2-ag-files-name">
              {file.name}
              {file.line !== null ? <span className="v2-muted">:{file.line}</span> : null}
            </span>
            <span className="v2-ag-files-dir">{file.dir}</span>
            <span className="v2-ag-files-chips">
              {file.exists ? null : <Chip size="s">gone</Chip>}
              {file.sources.map((source) => (
                <Chip key={source} size="s" tone={source === 'wrote' || source === 'edited' ? 'outline' : undefined}>
                  {SOURCE_WORDS[source]}
                </Chip>
              ))}
            </span>
          </button>
        ))}
        {shown.length === 0 ? <p className="v2-muted v2-ag-small v2-ag-files-pad">Nothing matches “{filter}”.</p> : null}
        {state.truncated ? <p className="v2-muted v2-ag-small v2-ag-files-pad">Only the first files are listed.</p> : null}
      </div>
    </>
  );
}

/** Reads what a folder holds into the agent's remembered tree (also when the tree is not on screen any more). */
function loadDir(sessionId: string, dir: string): void {
  api.agentDir(sessionId, dir).then(
    (listing) => updateFilesTab(sessionId, (state) => withListing(state, dir, listing)),
    (error: unknown) => updateFilesTab(sessionId, (state) => withListing(state, dir, { error: apiErrorText(error) })),
  );
}

/**
 * The tree over the agent's folders. Which folders are unfolded is remembered per
 * agent (`files-tab-state.ts`): it is as it was left when a file is closed, another
 * tab was shown or the panel was hidden.
 */
function BrowseTree({ sessionId, onOpen }: { readonly sessionId: string; readonly onOpen: (file: OpenFile) => void }) {
  const [tab, update] = useFilesTab(sessionId);
  const scroll = useKeptScroll(sessionId, 'browse');
  const fetched = useApi(async () => ({ sessionId, roots: (await api.agentFileRoots(sessionId)).roots }), [sessionId]);
  // `useApi` keeps its last answer while another agent's loads: only this agent's folders.
  const fresh = fetched.data !== null && fetched.data.sessionId === sessionId ? fetched.data.roots : null;
  useEffect(() => {
    if (fresh) update((state) => (state.roots !== null && state.roots.length === fresh.length && state.roots.every((root, index) => root.path === fresh[index]?.path && root.label === fresh[index]?.label) ? state : { ...state, roots: fresh }));
  }, [fresh, update]);
  // The folders known from before show at once; they are read again in the background.
  const rootList = tab.roots ?? fresh;
  const dirs = tab.dirs;
  const toggle = (dir: string): void => {
    if (dir in dirs) update((state) => fold(state, dir));
    else {
      update((state) => unfold(state, dir));
      loadDir(sessionId, dir);
    }
  };
  // The first folder unfolds by itself, once: one folder is the common case.
  const first = rootList?.[0]?.path ?? null;
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
    // Once per time the tree is shown for this agent: `dirs` is what it held at that moment.
  }, [sessionId]);

  if (fetched.error && rootList === null) return <EmptyState icon="alert" tone="grey" title="Could not read the folders" text={apiErrorText(fetched.error)} />;
  if (rootList === null) {
    return (
      <div className="v2-ag-files-pad">
        <Skeleton lines={5} height={14} />
      </div>
    );
  }
  if (rootList.length === 0) return <EmptyState icon="folder" tone="grey" title="No folder to browse" text="This agent has no working folder on this computer." />;

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
    return (
      <>
        {state.entries.map((entry) =>
          entry.type === 'dir' ? (
            <div key={entry.path}>
              <button type="button" className="v2-ag-tree-row" style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={entry.path in dirs} onClick={() => toggle(entry.path)} data-testid="v2-tree-dir">
                <Icon name={entry.path in dirs ? 'chev-down' : 'chev'} size="s" />
                <Icon name="folder" size="s" />
                <span className="v2-ag-tree-name">{entry.name}</span>
              </button>
              {renderDir(entry.path, depth + 1)}
            </div>
          ) : (
            <button key={entry.path} type="button" className="v2-ag-tree-row" style={{ paddingLeft: 10 + depth * 14 + 18 }} onClick={() => onOpen({ path: entry.path, line: null })} title={`${entry.path}${entry.size !== null ? ` · ${sizeText(entry.size)}` : ''}`} data-path={entry.path} data-testid="v2-tree-file">
              <Icon name="results" size="s" />
              <span className="v2-ag-tree-name">{entry.name}</span>
            </button>
          ),
        )}
        {state.entries.length === 0 ? (
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

  return (
    <div className="v2-ag-tree" ref={scroll.ref} onScroll={scroll.onScroll} data-testid="v2-files-tree">
      {rootList.map((root) => (
        <div key={root.path}>
          <button type="button" className="v2-ag-tree-row v2-ag-tree-root" aria-expanded={root.path in dirs} onClick={() => toggle(root.path)} title={root.path} data-testid="v2-tree-root">
            <Icon name={root.path in dirs ? 'chev-down' : 'chev'} size="s" />
            <Icon name="folder" size="s" />
            <span className="v2-ag-tree-name">{root.label}</span>
            <span className="v2-muted v2-ag-small">{root.kind === 'worktree' ? 'separate copy' : root.kind === 'repo' ? 'code project' : 'folder'}</span>
          </button>
          {renderDir(root.path, 1)}
        </div>
      ))}
    </div>
  );
}

export function FilesPanel({ sessionId, files, open, onOpen, onClose }: { readonly sessionId: string; readonly files: AgentFilesState; readonly open: OpenFile | null; readonly onOpen: (file: OpenFile) => void; readonly onClose: () => void }) {
  const [tab, update] = useFilesTab(sessionId);
  const lists = useRef<HTMLDivElement | null>(null);
  const viewing = open !== null;
  /** The file last shown: its row gets the focus when the viewer closes. */
  const last = useRef<string | null>(null);
  if (open) last.current = open.path;
  const mode = tab.mode;
  useLayoutEffect(() => {
    const root = lists.current;
    if (viewing || !root) return;
    // Back from a file: its row has the focus (the list itself never moved).
    const path = last.current;
    last.current = null;
    if (path === null) return;
    const row = [...root.querySelectorAll<HTMLElement>('[data-path]')].find((element) => element.dataset['path'] === path);
    row?.focus({ preventScroll: true });
  }, [viewing]);
  return (
    <>
      {/* The lists stay laid out under the viewer (not seen, not reachable): back from a file, the tree is as unfolded and as scrolled as it was. */}
      <div className="v2-ag-files2" ref={lists} data-under={viewing ? 'true' : undefined} aria-hidden={viewing || undefined} data-testid="v2-side-files" data-mode={mode}>
        <div className="v2-ag-files-head">
          <Segmented<FilesMode>
            label="Which files"
            size="s"
            value={mode}
            options={[
              { value: 'browse', label: 'Browse' },
              { value: 'touched', label: 'This agent’s files' },
            ]}
            onChange={(next) => update((state) => ({ ...state, mode: next }))}
            testId="v2-files-mode"
          />
        </div>
        {mode === 'touched' ? <TouchedList sessionId={sessionId} state={files} onOpen={onOpen} /> : <BrowseTree sessionId={sessionId} onOpen={onOpen} />}
      </div>
      {open ? <FileViewer sessionId={sessionId} file={open} onBack={onClose} /> : null}
    </>
  );
}
