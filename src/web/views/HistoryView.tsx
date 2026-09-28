import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItem } from '../../core/api.ts';
import { formatHistoryDate, historyBranchLine } from '../../core/history.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { statusColor } from '../shell/format.ts';
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
 * session change.
 */
export function HistoryView() {
  const [search, setSearch] = useState('');
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
      api.history(q === '' ? undefined : q).then(
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
  }, [q, tick]);

  const reload = useTrailing(() => setTick((n) => n + 1), HUB_RELOAD_DELAY_MS);
  useHubEvent('sessionUpdated', reload);

  const rows = loaded?.rows ?? [];
  const settled = loaded !== null && loaded.q === q;

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
          <HistoryRow key={item.claudeSessionId} item={item} />
        ))}
        {settled && rows.length === 0 ? (
          <div className="sb-hist-empty" data-testid="history-empty">
            {q === '' ? 'No sessions yet.' : 'No sessions match.'}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function HistoryRow({ item }: { readonly item: HistoryItem }) {
  return (
    <div
      className="sb-hist-row"
      data-testid="history-row"
      data-claude-session-id={item.claudeSessionId}
      data-session-id={item.sessionId ?? undefined}
      data-status={item.status}
    >
      <span className="sb-hist-date">{formatHistoryDate(item.startedAt)}</span>
      <div className="sb-hist-namecol">
        <span className="sb-hist-name">{item.name}</span>
        <span className="sb-hist-mode">{item.mode}</span>
      </div>
      <div className="sb-hist-sumcol">
        <span className="sb-hist-summary">{item.summary}</span>
        <span className="sb-hist-sols">{historyBranchLine(item)}</span>
      </div>
      <span className="sb-hist-outcome" style={{ color: statusColor(item.status) }}>
        {item.outcome}
      </span>
    </div>
  );
}
