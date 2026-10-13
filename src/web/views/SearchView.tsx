import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchAnswer, SearchGroup, SearchResult, SearchSegment } from '../../core/search.ts';
import { api } from '../api/client.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { Link, routePath, useRouter } from '../router.tsx';
import { formatAge } from '../shell/format.ts';
import {
  SCOPE_LABEL,
  SEARCH_CHIPS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_PLACEHOLDER,
  type SearchChip,
  byMachine,
  countText,
  kindLabel,
  notSearchedText,
  parseSearchAddress,
  resultRoute,
  searchPath,
  shownGroups,
} from './search-view.ts';
import './search.css';

/** Highlighted text: the query's matches in `<mark>` (plain text, never HTML). */
export function Highlighted({ segments }: { readonly segments: readonly SearchSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="sb-search-mark" data-testid="search-mark">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** What the page shows for the current query: the answer, or where its load stands. */
interface Loaded {
  readonly key: string;
  readonly answer: SearchAnswer | null;
  readonly failed: boolean;
}

/**
 * D97 · the Search page (`docs/search.md` → *Search page*): one field searches
 * the conversations (messages, progress notes, tool calls, session titles), the
 * saved artifacts, the todos and History, here and on the paired machines
 * (`GET /api/search`). Scope chips narrow it to one group; the results come
 * grouped by type and, within a group, by machine, each with its highlighted
 * snippet; a row opens the message in its chat (scrolled to it and highlighted),
 * the artifact, the todo's session or History. ↑ ↓ move through the rows, Enter
 * opens one. One group: "Show more" pages it. The query and chip live in the
 * address (`/search?q=…&scope=…`), so Back and a reload keep them.
 */
export function SearchView() {
  const { search, navigate } = useRouter();
  const address = parseSearchAddress(search);
  const [q, setQ] = useState(address.q);
  const [chip, setChip] = useState<SearchChip>(address.chip);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [more, setMore] = useState<{ readonly key: string; readonly results: readonly SearchResult[]; readonly cursor: string | null; readonly loading: boolean } | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // The address changed from outside (the palette, Back): the field follows it (not its own update: a typed space stays).
  const typed = useRef(q);
  typed.current = q;
  useEffect(() => {
    if (address.q !== typed.current.trim()) setQ(address.q);
    setChip(address.chip);
  }, [address.q, address.chip]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const text = q.trim();
  const key = `${chip}\n${text}`;
  useEffect(() => {
    if (text === '') {
      setLoaded(null);
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      // The address follows the query (replace: typing is one history entry).
      if (searchPath(text, chip) !== `${window.location.pathname}${window.location.search}`) navigate(searchPath(text, chip), { replace: true });
      api.search({ q: text, ...(chip === 'all' ? {} : { scope: chip }) }).then(
        (answer) => {
          if (seq.current === mine) setLoaded({ key, answer, failed: false });
        },
        () => {
          if (seq.current === mine) setLoaded((current) => ({ key, answer: current?.answer ?? null, failed: true }));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `navigate` is stable; `key` is `chip` + `text`.
  }, [key]);

  const answer = text === '' ? null : (loaded?.answer ?? null);
  const groups = useMemo(() => {
    if (!answer) return [];
    const shown = shownGroups(answer.groups, chip);
    // One scope, paged further: the pages after the first are appended.
    if (more && more.key === key && shown[0]) return [{ ...shown[0], results: [...shown[0].results, ...more.results], nextCursor: more.cursor }];
    return shown;
  }, [answer, chip, more, key]);
  const rows = useMemo(() => groups.flatMap((group) => byMachine(group.results).flatMap((block) => block.results)), [groups]);
  const current = Math.max(0, Math.min(selected, rows.length - 1));
  useEffect(() => setSelected(0), [key]);

  const loadMore = (group: SearchGroup): void => {
    if (!group.nextCursor || more?.loading) return;
    const cursor = group.nextCursor;
    setMore((m) => ({ key, results: m?.key === key ? m.results : [], cursor, loading: true }));
    api.search({ q: text, scope: group.scope, cursor }).then(
      (page) => {
        const next = page.groups[0];
        setMore((m) => (m?.key === key ? { key, results: [...m.results, ...(next?.results ?? [])], cursor: next?.nextCursor ?? null, loading: false } : m));
      },
      () => setMore((m) => (m?.key === key ? { ...m, loading: false } : m)),
    );
  };

  const pickChip = (next: SearchChip): void => {
    setChip(next);
    setMore(null);
    if (text !== '') navigate(searchPath(text, next), { replace: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      setSelected(next);
      listRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      const result = rows[current];
      if (result) {
        event.preventDefault();
        navigate(resultRoute(result));
      }
    }
  };

  const busy = text !== '' && loaded?.key !== key;
  const empty = text !== '' && !busy && answer !== null && groups.every((group) => group.results.length === 0);
  const notSearched = answer ? notSearchedText(answer.notSearched) : null;
  let index = 0;

  return (
    <section className="sb-view sb-search-view" data-view="search" data-testid="view-search" data-chip={chip} aria-busy={busy || undefined}>
      <div className="sb-search-head">
        <div className="sb-search-title-row">
          <h1 className="sb-search-title">Search</h1>
          {answer && !answer.indexing.done ? (
            <span className="sb-search-indexing" data-testid="search-indexing" role="status">
              Indexing older history… {answer.indexing.percent}%
            </span>
          ) : null}
        </div>
        <input
          ref={inputRef}
          className="sb-search-input"
          data-testid="search-input"
          data-tour="search-input"
          type="text"
          enterKeyHint="search"
          value={q}
          placeholder={SEARCH_PLACEHOLDER}
          aria-label="Search everything"
          aria-controls="sb-search-results"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQ(event.target.value);
            setMore(null);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="sb-search-chips" role="group" aria-label="Search in" data-tour="search-chips">
          {SEARCH_CHIPS.map(([value, label]) => {
            const group = value === 'all' || !answer || chip !== 'all' ? undefined : answer.groups.find((g) => g.scope === value);
            return (
              <button key={value} type="button" className="sb-button sb-search-chip" data-testid="search-chip" data-chip={value} aria-pressed={chip === value} onClick={() => pickChip(value)}>
                {label}
                {group && group.count > 0 ? <span className="sb-search-chip-count">{group.count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="sb-search-results" id="sb-search-results" data-testid="search-results" ref={listRef}>
        {notSearched ? (
          <div className="sb-search-note" data-testid="search-not-searched">
            {notSearched}
          </div>
        ) : null}
        {loaded?.failed && loaded.key === key ? (
          <div className="sb-search-note" data-testid="search-failed" role="alert">
            Search failed. Try again.
          </div>
        ) : null}
        {text === '' ? (
          <div className="sb-search-empty" data-testid="search-hint">
            Words match anywhere, in any order. Use "quotes" for a phrase and a trailing * for a prefix (deploy*).
          </div>
        ) : null}
        {empty ? (
          <div className="sb-search-empty" data-testid="search-empty">
            No matches.
          </div>
        ) : null}
        {groups.map((group) => (
          <div key={group.scope} className="sb-search-group" data-testid="search-group" data-scope={group.scope}>
            <div className="sb-search-group-head">
              <span className="sb-search-group-label">{SCOPE_LABEL[group.scope]}</span>
              <span className="sb-search-group-count" data-testid="search-group-count">
                {countText(group)}
              </span>
              {chip === 'all' && group.count > group.results.length ? (
                <button type="button" className="sb-button sb-search-all" data-testid="search-show-all" onClick={() => pickChip(group.scope)}>
                  Show all
                </button>
              ) : null}
            </div>
            {byMachine(group.results).map((block) => (
              <div key={block.key} className="sb-search-machine" data-testid="search-machine" data-machine={block.machine?.id ?? 'local'}>
                {block.machine || group.results.some((result) => result.machine) ? (
                  <div className="sb-search-machine-head">{block.machine ? <MachineTag machine={block.machine} /> : <span className="sb-search-this-machine">This machine</span>}</div>
                ) : null}
                {block.results.map((result) => {
                  const at = index++;
                  return <ResultRow key={result.id} result={result} index={at} selected={at === current} onHover={() => setSelected(at)} />;
                })}
              </div>
            ))}
            {chip !== 'all' && group.nextCursor ? (
              <button type="button" className="sb-button sb-search-more" data-testid="search-more" disabled={more?.loading} onClick={() => loadMore(group)}>
                {more?.loading ? 'Loading…' : 'Show more'}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultRow({ result, index, selected, onHover }: { readonly result: SearchResult; readonly index: number; readonly selected: boolean; readonly onHover: () => void }) {
  const route = resultRoute(result);
  const title = result.kind === 'session' || result.kind === 'artifact' || result.kind === 'todo' || result.kind === 'history' ? result.title : null;
  return (
    <Link
      to={route}
      className="sb-search-row"
      data-testid="search-result"
      data-result-id={result.id}
      data-kind={result.kind}
      data-row-index={index}
      data-selected={selected || undefined}
      aria-current={selected || undefined}
      title={`Open ${routePath(route)}`}
      onMouseEnter={onHover}
    >
      <span className="sb-search-kind" data-testid="search-kind">
        {kindLabel(result)}
      </span>
      <span className="sb-search-main">
        <span className="sb-search-row-title" data-testid="search-title">
          {title ? <Highlighted segments={title} /> : (result.sessionTitle ?? '')}
        </span>
        {result.snippet.length > 0 ? (
          <span className="sb-search-snippet" data-testid="search-snippet">
            <Highlighted segments={result.snippet} />
          </span>
        ) : null}
        {title && result.sessionTitle ? <span className="sb-search-where">{result.sessionTitle}</span> : null}
      </span>
      <span className="sb-search-age">{formatAge(result.ts)}</span>
    </Link>
  );
}
