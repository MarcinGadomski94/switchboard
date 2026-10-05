import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItem } from '../../core/api.ts';
import { REMOTE_CONTROL_BADGE, formatHistoryDate, historyBranchLine } from '../../core/history.ts';
import { REMOTE_COPY_NOTE, REMOTE_MODE_LINE } from '../../core/remote-session.ts';
import { CLOSED_TAG, REOPEN_LABEL } from '../../core/session-close.ts';
import { ApiError, api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { useRouter } from '../router.tsx';
import { statusColor } from '../shell/format.ts';
import { actionErrorText } from './session/session-header.ts';
import { CONTINUE_IN_SWITCHBOARD, moveSelectedLabel, pruneSelection, showsDialog } from './history-move.ts';
import { MoveDialog } from './MoveDialog.tsx';
import { openContinueHooked } from '../hooked-continue/store.ts';
import { CONTINUE_HOOKED_LABEL } from '../../core/hooked-continue.ts';
import { useConversationMoves } from './useConversationMoves.ts';
import './history.css';

/** How long typing pauses before the search goes to the service. */
const SEARCH_DELAY_MS = 150;

/** How long the view waits after a `/hub` event before it reloads (a turn sends many). */
const HUB_RELOAD_DELAY_MS = 250;

/** `fn` at most once per `delay` ms after the last call (trailing), cancelled on unmount. */
function useTrailing(fn: () => void, delay: number): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delay);
  }, [delay]);
}

/** The rows of the latest completed load and the search they answer. */
interface Loaded {
  readonly q: string;
  readonly rows: readonly HistoryItem[];
}

/**
 * History (SPEC → History, M7.4): the title, "past sessions · searchable
 * transcripts", a search box, and one row per session (`110px 220px 1fr 200px`):
 * start date, name + mode line, summary + solutions / branches, and the outcome in
 * its status color. Rows come from `GET /api/history?q=` (stored sessions plus
 * terminal-started ones from the local transcripts; the search runs on the
 * service, over the transcripts too). The list reloads when `/hub` reports a
 * session change. D14: rows of a folder other than the default one carry its tag
 * before the mode line. D16: a terminal conversation's row has a checkbox (in the
 * date column) and **Continue in Switchboard** (under its outcome); selected rows
 * move together with **Move selected (n)** in a bar under the list; the move
 * dialog ({@link MoveDialog}) handles what needs the developer, and the (last)
 * moved session opens once the move is over. D33: a closed session's row carries a
 * **Closed** tag (after its mode line) and **Reopen** (under its outcome); Reopen
 * (`POST /api/sessions/{id}/reopen`) puts it back in the sidebar and opens it in
 * the session view.
 */
/** D62 P7: whether History lists Codex / OpenCode conversations (this browser's choice). */
function readCliHistory(): boolean {
  try {
    return window.localStorage.getItem(CLI_HISTORY_KEY) === '1';
  } catch {
    return false;
  }
}

const CLI_HISTORY_KEY = 'sb.history.cli';

export function HistoryView() {
  const { tagOf } = useFolderTags();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const openSession = useCallback(
    (id: string) => {
      setSelected(new Set());
      navigate({ view: 'session', id, tab: 'chat' });
    },
    [navigate],
  );
  const moves = useConversationMoves(openSession);
  // D33: Reopen of a closed session's row: the session opens once it is back.
  const [reopening, setReopening] = useState<string | null>(null);
  const [reopenError, setReopenError] = useState<{ readonly sessionId: string; readonly text: string } | null>(null);
  const reopen = async (sessionId: string): Promise<void> => {
    if (reopening) return;
    setReopening(sessionId);
    setReopenError(null);
    try {
      await api.reopenSession(sessionId);
      openSession(sessionId);
    } catch (caught) {
      const error = caught instanceof ApiError ? caught : new ApiError(0, String(caught));
      setReopenError({ sessionId, text: actionErrorText(error.status, error.body) });
    } finally {
      setReopening(null);
    }
  };
  const [search, setSearch] = useState('');
  // D62 P7: the Codex / OpenCode terminal conversations, on request (listing them reads those CLIs' records); remembered in this browser.
  const [withCli, setWithCli] = useState(() => readCliHistory());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const q = search.trim();
  /** The search of the previous request: a new one waits for typing to pause, a reload does not. */
  const lastQ = useRef(q);

  useEffect(() => {
    let cancelled = false;
    const delay = lastQ.current === q ? 0 : SEARCH_DELAY_MS;
    lastQ.current = q;
    const timer = setTimeout(() => {
      api.history(q === '' ? undefined : q, withCli).then(
        (rows) => {
          if (!cancelled) setLoaded({ q, rows });
        },
        () => {
          // Unreachable or refused: keep the last rows (the sidebar shows the service state).
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, tick, withCli]);

  const reload = useTrailing(() => setTick((n) => n + 1), HUB_RELOAD_DELAY_MS);
  useHubEvent('sessionUpdated', reload);

  const rows = loaded?.rows ?? [];
  const settled = loaded !== null && loaded.q === q;
  // D16: the selection keeps only rows that can still move (a moved row becomes a stored session).
  const loadedRows = loaded?.rows;
  useEffect(() => {
    setSelected((current) => {
      const next = pruneSelection(current, loadedRows ?? []);
      return next.size === current.size ? current : next;
    });
  }, [loadedRows]);
  const toggle = (id: string): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const moving = moves.items !== null;
  const selectedRows = rows.filter((row) => selected.has(row.claudeSessionId));

  return (
    <section className="sb-view sb-hist-view" data-view="history" data-testid="view-history" aria-busy={!settled}>
      <div className="sb-hist-head">
        <div className="sb-hist-title">History</div>
        <div className="sb-hist-sub">past sessions · searchable transcripts</div>
        <input
          className="sb-hist-search"
          data-testid="history-search"
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations, solutions, branches…"
          aria-label="Search history"
        />
      </div>
      <div className="sb-hist-rows" data-testid="history-rows">
        {rows.map((item) => (
          <HistoryRow
            key={item.claudeSessionId}
            item={item}
            folderTag={tagOf(item)}
            selected={selected.has(item.claudeSessionId)}
            moving={moving}
            onToggle={() => toggle(item.claudeSessionId)}
            onContinue={() => moves.start([item])}
            reopening={item.sessionId !== null && reopening === item.sessionId}
            reopenError={item.sessionId !== null && reopenError?.sessionId === item.sessionId ? reopenError.text : null}
            onReopen={() => item.sessionId && void reopen(item.sessionId)}
          />
        ))}
        {settled && rows.length === 0 ? (
          <div className="sb-hist-empty" data-testid="history-empty">
            {q === '' ? 'No sessions yet.' : 'No sessions match.'}
          </div>
        ) : null}
        {/* D62 P7: Codex CLI / OpenCode terminal conversations, on request (the rows' last line: the rows box keeps the prototype's size). */}
        <label className="sb-hist-cli" data-testid="history-cli">
          <input
            type="checkbox"
            data-testid="history-cli-toggle"
            checked={withCli}
            onChange={(event) => {
              setWithCli(event.target.checked);
              try {
                window.localStorage.setItem(CLI_HISTORY_KEY, event.target.checked ? '1' : '0');
              } catch {
                // A browser without storage forgets it.
              }
            }}
          />
          Also list Codex CLI and OpenCode terminal conversations
        </label>
      </div>
      {selectedRows.length > 0 ? (
        <div className="sb-hist-movebar" data-testid="history-movebar">
          <span className="sb-hist-movebar-count">{`${selectedRows.length} selected · terminal conversations`}</span>
          <button type="button" className="sb-button sb-hist-move-outlined" data-testid="history-clear-selection" disabled={moving} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <button type="button" className="sb-button sb-hist-move-primary" data-testid="history-move-selected" disabled={moving} onClick={() => moves.start(selectedRows)}>
            {moveSelectedLabel(selectedRows.length)}
          </button>
        </div>
      ) : null}
      {moves.items && showsDialog(moves.items) ? <MoveDialog moves={moves} onOpen={openSession} /> : null}
    </section>
  );
}

interface HistoryRowProps {
  readonly item: HistoryItem;
  readonly folderTag: string | null;
  /** D16: the row's checkbox (terminal conversations only). */
  readonly selected: boolean;
  /** D16: a move runs: the row's move controls wait. */
  readonly moving: boolean;
  readonly onToggle: () => void;
  readonly onContinue: () => void;
  /** D33: Reopen of this closed session runs. */
  readonly reopening: boolean;
  /** D33: why Reopen was refused, else `null`. */
  readonly reopenError: string | null;
  readonly onReopen: () => void;
}

function HistoryRow({ item, folderTag, selected, moving, onToggle, onContinue, reopening, reopenError, onReopen }: HistoryRowProps) {
  // D16: a terminal conversation not in Switchboard yet can continue there (the demo's prototype rows cannot).
  const movable = item.terminal === true && item.sessionId === null;
  // D33: a closed Switchboard session can be reopened.
  const closed = typeof item.closedAt === 'string' && item.sessionId !== null;
  // D72: a hooked terminal session (open or closed: continuing reopens it) can continue as a Switchboard-run session.
  const hooked = item.hooked === true && item.sessionId !== null;
  const continueHooked = hooked ? (
    <button
      type="button"
      className="sb-button sb-hist-continue"
      data-testid="history-continue-hooked"
      onClick={() => item.sessionId && openContinueHooked({ sessionId: item.sessionId, title: item.displayTitle ?? item.name, machineName: null })}
    >
      {CONTINUE_HOOKED_LABEL}
    </button>
  ) : null;
  const outcome = (
    <span className="sb-hist-outcome" style={{ color: statusColor(item.status) }}>
      {item.outcome}
    </span>
  );
  return (
    <div
      className="sb-hist-row"
      data-testid="history-row"
      data-claude-session-id={item.claudeSessionId}
      data-session-id={item.sessionId ?? undefined}
      data-status={item.status}
      data-terminal={movable ? 'true' : undefined}
      data-closed={closed ? 'true' : undefined}
      data-hooked={hooked ? 'true' : undefined}
    >
      <span className="sb-hist-date">
        {movable ? (
          <input
            type="checkbox"
            className="sb-hist-check"
            data-testid="history-select"
            aria-label={`Select ${item.displayTitle ?? item.name}`}
            checked={selected}
            disabled={moving}
            onChange={onToggle}
          />
        ) : null}
        {formatHistoryDate(item.startedAt)}
      </span>
      <div className="sb-hist-namecol">
        {/* D22: a stored session's title, else its name; a terminal conversation's name. */}
        <span className="sb-hist-name" title={item.displayTitle && item.displayTitle !== item.name ? item.name : undefined}>
          {item.displayTitle ?? item.name}
        </span>
        {/* D25: a local copy of a remote session is tagged `remote · local copy`; its tooltip says what that means. */}
        <span className="sb-hist-mode" title={item.mode === REMOTE_MODE_LINE ? REMOTE_COPY_NOTE : undefined}>
          <FolderTag name={folderTag} title={item.folderPath} />
          {item.mode}
          {/* D24: the conversation had Remote Control on (a `bridge-session` line in its transcript). */}
          {item.remoteControl ? (
            <span className="sb-hist-badge" data-testid="history-remote-badge" title="This conversation had Remote Control on (claude.ai / the Claude app)">
              {REMOTE_CONTROL_BADGE}
            </span>
          ) : null}
          {/* D33: closed out of the sidebar; Reopen puts it back. */}
          {closed ? (
            <span className="sb-hist-closed" data-testid="history-closed-tag" title={`Closed ${formatHistoryDate(item.closedAt as string)} · Reopen puts it back in the sidebar`}>
              {CLOSED_TAG}
            </span>
          ) : null}
        </span>
      </div>
      <div className="sb-hist-sumcol">
        <span className="sb-hist-summary">{item.summary}</span>
        <span className="sb-hist-sols">{historyBranchLine(item)}</span>
      </div>
      {movable ? (
        <div className="sb-hist-outcol">
          {outcome}
          <button type="button" className="sb-button sb-hist-continue" data-testid="history-continue" disabled={moving} onClick={onContinue}>
            {CONTINUE_IN_SWITCHBOARD}
          </button>
        </div>
      ) : hooked && !closed ? (
        <div className="sb-hist-outcol">
          {outcome}
          {continueHooked}
        </div>
      ) : closed ? (
        <div className="sb-hist-outcol">
          {outcome}
          <button type="button" className="sb-button sb-hist-continue" data-testid="history-reopen" disabled={reopening} aria-busy={reopening || undefined} onClick={onReopen}>
            {REOPEN_LABEL}
          </button>
          {continueHooked}
          {reopenError ? (
            <span className="sb-hist-reopen-error" role="alert" data-testid="history-reopen-error">
              {reopenError}
            </span>
          ) : null}
        </div>
      ) : (
        outcome
      )}
    </div>
  );
}
