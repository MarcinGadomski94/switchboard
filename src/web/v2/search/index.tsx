import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchAnswer, SearchGroup, SearchResult, SearchSegment } from '../../../core/search.ts';
import type { SidebarLayout } from '../../../core/sidebar-layout.ts';
import { api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useMachines, useMachineStateChange } from '../../api/useMachines.ts';
import { Card, ComputerTag, EmptyState, Icon, Skeleton } from '../components/index.ts';
import { SEARCH_WORDS, computerStateToV2 } from '../glossary.ts';
import { V2Link, useV2Router } from '../nav.tsx';
import { CrewTag } from '../shared/agent-row.tsx';
import { useOpenAgent } from '../shared/open-agent.ts';
import { teammateOf, useTeamMembers } from '../shared/teammates.ts';
import { clock, timeAgo } from '../shared/time.ts';
import {
  GROUP_ROWS,
  V2_SEARCH_DATES,
  V2_SEARCH_DEBOUNCE_MS,
  V2_SEARCH_TYPES,
  type V2SearchFilters,
  type V2SearchGroup,
  type V2SearchType,
  apiParams,
  folderOptions,
  folderSessions,
  groupAnswer,
  hitHref,
  peekSessionOf,
  isMessageHit,
  parseV2SearchAddress,
  searchNote,
  v2SearchPath,
  whoOf,
} from './search-model.ts';
import './search.css';

/** Highlighted text: the query's matches in `<mark>` (plain text, never HTML); `max` cuts it with an ellipsis. */
function Marked({ segments, max }: { readonly segments: readonly SearchSegment[]; readonly max?: number }) {
  let left = max ?? Number.POSITIVE_INFINITY;
  const out: SearchSegment[] = [];
  for (const segment of segments) {
    if (left <= 0) break;
    out.push(segment.text.length > left ? { ...segment, text: `${segment.text.slice(0, left)}…` } : segment);
    left -= segment.text.length;
  }
  return (
    <>
      {out.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="v2-mark" data-testid="v2-search-mark">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface Loaded {
  readonly key: string;
  readonly answer: SearchAnswer | null;
  readonly failed: boolean;
}

/**
 * D131 · Search (`/search?q=`, ⌘⇧F), lane R: every message, result, task and
 * closed agent, on every computer (the D97 search, `GET /api/search`), grouped
 * Messages · Results · Tasks · Closed agents, filtered by type, computer, folder
 * and date (all in the address). A message opens its agent's chat at that exact
 * message (`/agents/:id/events/:eventId`). Paired computers that were not
 * searched say so (offline / reconnecting). Pure part: `search-model.ts`.
 */
export function SearchPage() {
  const { search, navigate } = useV2Router();
  const address = parseV2SearchAddress(search);
  const [q, setQ] = useState(address.q);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [more, setMore] = useState<{ readonly key: string; readonly results: readonly SearchResult[]; readonly cursor: string | null; readonly loading: boolean } | null>(null);
  const [layout, setLayout] = useState<SidebarLayout | null>(null);
  const [self, setSelf] = useState<string>('');
  const [tick, setTick] = useState(0);
  const machines = useMachines();
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const typed = useRef(q);
  typed.current = q;

  // The address changed from outside (the palette, Back): the field follows.
  useEffect(() => {
    if (address.q !== typed.current.trim()) setQ(address.q);
  }, [address.q]);

  useEffect(() => {
    inputRef.current?.focus();
    void api.sidebarLayout().then(setLayout, () => undefined);
    void api.machines().then((view) => setSelf(view.self.name), () => undefined);
  }, []);
  useHubEvent('sidebarLayoutChanged', setLayout);
  // A computer drops off or comes back: search again, so the note and the rows follow.
  useMachineStateChange(() => setTick((n) => n + 1));

  const filters: V2SearchFilters = { ...address, q };
  const text = q.trim();
  const key = `${address.type}\n${text}\n${tick}`;

  const go = (next: Partial<V2SearchFilters>): void => {
    navigate(v2SearchPath({ ...filters, ...next }), { replace: true });
  };

  useEffect(() => {
    if (text === '') {
      setLoaded(null);
      if (address.q !== '') navigate(v2SearchPath({ ...address, q: '' }), { replace: true });
      return;
    }
    const mine = ++seq.current;
    const timer = window.setTimeout(() => {
      if (text !== address.q) navigate(v2SearchPath({ ...address, q: text }), { replace: true });
      api.search(apiParams({ ...address, q: text })).then(
        (answer) => {
          if (seq.current === mine) setLoaded({ key, answer, failed: false });
        },
        () => {
          if (seq.current === mine) setLoaded((current) => ({ key, answer: current?.answer ?? null, failed: true }));
        },
      );
    }, V2_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `navigate` is stable; `key` covers type, text and the machines' changes.
  }, [key]);

  const answer = text === '' ? null : (loaded?.answer ?? null);
  const merged = useMemo<Pick<SearchAnswer, 'groups'> | null>(() => {
    if (!answer) return null;
    if (!more || more.key !== key || address.type === 'all') return answer;
    return { groups: answer.groups.map((group): SearchGroup => ({ ...group, results: [...group.results, ...more.results], nextCursor: more.cursor })) };
  }, [answer, more, key, address.type]);
  const sessions = useMemo(() => folderSessions(layout, address.folder), [layout, address.folder]);
  const groups = groupAnswer(merged, filters, { folderSessions: sessions, now: Date.now() });
  const busy = text !== '' && loaded?.key !== key;
  const empty = text !== '' && !busy && answer !== null && groups.every((group) => group.results.length === 0);
  const paired = machines.filter((machine) => !answer?.notSearched.some((entry) => entry.machine.id === machine.id));
  const note = answer ? searchNote(answer.notSearched, [self || SEARCH_WORDS.thisComputer, ...paired.map((machine) => machine.name)], address.date) : null;
  const nextCursor = address.type !== 'all' ? (more?.key === key ? more.cursor : (answer?.groups[0]?.nextCursor ?? null)) : null;

  const loadMore = (): void => {
    if (!nextCursor || more?.loading || address.type === 'all') return;
    const params = apiParams({ ...address, q: text });
    setMore((m) => ({ key, results: m?.key === key ? m.results : [], cursor: nextCursor, loading: true }));
    api.search({ ...params, cursor: nextCursor }).then(
      (page) => {
        const next = page.groups[0];
        setMore((m) => (m?.key === key ? { key, results: [...m.results, ...(next?.results ?? [])], cursor: next?.nextCursor ?? null, loading: false } : m));
      },
      () => setMore((m) => (m?.key === key ? { ...m, loading: false } : m)),
    );
  };

  const computers = [
    { value: 'all', label: SEARCH_WORDS.computerAny },
    { value: 'local', label: self || SEARCH_WORDS.thisComputer },
    ...machines.map((machine) => ({ value: machine.id, label: `${machine.name}${machine.state === 'online' ? '' : ` · ${computerStateToV2(machine.state)}`}` })),
  ];

  return (
    <div className="v2-page v2-srch" data-testid="v2-page-search" data-area="search" aria-busy={busy || undefined}>
      <h1>{SEARCH_WORDS.title}</h1>
      <p className="v2-page-sub">{SEARCH_WORDS.sub}</p>
      <div className="v2-srch-box">
        <Icon name="search" size="s" />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          className="v2-srch-input"
          data-testid="v2-search-input"
          aria-label={SEARCH_WORDS.input}
          placeholder={SEARCH_WORDS.placeholder}
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setMore(null);
          }}
        />
      </div>
      <div className="v2-srch-filters">
        <div className="v2-srch-chips" role="group" aria-label="Type">
          {V2_SEARCH_TYPES.map((type: V2SearchType) => (
            <button key={type} type="button" className="v2-srch-chip" aria-pressed={address.type === type} data-type={type} data-testid="v2-search-type" onClick={() => go({ type })}>
              {SEARCH_WORDS.types[type]}
            </button>
          ))}
        </div>
        <span className="v2-grow" />
        <div className="v2-srch-selects">
          <select className="v2-field v2-srch-select" aria-label={SEARCH_WORDS.computer} data-testid="v2-search-computer" value={address.computer} onChange={(event) => go({ computer: event.target.value })}>
            {computers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select className="v2-field v2-srch-select" aria-label={SEARCH_WORDS.folder} data-testid="v2-search-folder" value={address.folder} onChange={(event) => go({ folder: event.target.value })}>
            {folderOptions(layout).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select className="v2-field v2-srch-select" aria-label={SEARCH_WORDS.date} data-testid="v2-search-date" value={address.date} onChange={(event) => go({ date: event.target.value as V2SearchFilters['date'] })}>
            {V2_SEARCH_DATES.map((date) => (
              <option key={date} value={date}>
                {SEARCH_WORDS.dates[date]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {note ? (
        <p className="v2-srch-note" data-testid="v2-search-note" data-kind={note.kind}>
          <Icon name={note.kind === 'missing' ? 'offline' : 'check-circle'} size="s" />
          <span>
            {note.strong ? <b>{note.strong}</b> : null}
            {note.strong ? ' · ' : ''}
            {note.text}
          </span>
        </p>
      ) : null}
      {answer && !answer.indexing.done ? (
        <p className="v2-srch-note" role="status" data-testid="v2-search-indexing">
          <Icon name="refresh" size="s" />
          {SEARCH_WORDS.indexing} {answer.indexing.percent}%
        </p>
      ) : null}
      {loaded?.failed && loaded.key === key ? (
        <p className="v2-srch-note" role="alert" data-testid="v2-search-failed">
          <Icon name="alert" size="s" />
          {SEARCH_WORDS.failed}
        </p>
      ) : null}
      <div data-testid="v2-search-results">
        {text === '' ? <EmptyState icon="search" tone="grey" title={SEARCH_WORDS.hintTitle} text={SEARCH_WORDS.hintText} testId="v2-search-hint" /> : null}
        {busy && !answer ? <SearchSkeleton /> : null}
        {empty ? <EmptyState icon="search" tone="grey" title={SEARCH_WORDS.nothingTitle} text={SEARCH_WORDS.nothingText} testId="v2-search-empty" /> : null}
        {empty
          ? null
          : groups.map((group) => <Group key={group.type} group={group} single={address.type !== 'all'} onShowAll={() => go({ type: group.type })} />)}
        {address.type !== 'all' && nextCursor && !empty ? (
          <button type="button" className="v2-btn v2-srch-more" data-testid="v2-search-more" disabled={more?.loading} onClick={loadMore}>
            {SEARCH_WORDS.showMore}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function SearchSkeleton() {
  return (
    <div data-testid="v2-search-skeleton" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i} pad className="v2-srch-skel">
          <Skeleton width="40%" height={12} />
          <Skeleton width="85%" height={10} style={{ marginTop: 10 }} />
        </Card>
      ))}
    </div>
  );
}

function Group({ group, single, onShowAll }: { readonly group: V2SearchGroup; readonly single: boolean; readonly onShowAll: () => void }) {
  const rows = single ? group.results : group.results.slice(0, GROUP_ROWS);
  return (
    <section className="v2-srch-group" data-testid="v2-search-group" data-type={group.type} aria-label={group.label}>
      <div className="v2-srch-group-h">
        <Icon name={group.icon} />
        <h2>{group.label}</h2>
        <span className="v2-srch-count" data-testid="v2-search-count">
          {group.count}
        </span>
        {!single && group.more ? (
          <button type="button" className="v2-srch-link" data-testid="v2-search-show-all" onClick={onShowAll}>
            {SEARCH_WORDS.showAll}
          </button>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <Card className="v2-srch-list">
          {rows.map((result) => (
            <Hit key={result.id} result={result} icon={group.icon} />
          ))}
        </Card>
      ) : null}
    </section>
  );
}

function Hit({ result, icon }: { readonly result: SearchResult; readonly icon: string }) {
  const href = hitHref(result);
  const openAgent = useOpenAgent();
  const peekAt = peekSessionOf(result);
  // Fix after 2.0: a teammate's hits name it by its teammate's name (with its crew).
  const members = useTeamMembers();
  const mate = teammateOf('sessionId' in result.target ? result.target.sessionId : null, members);
  const tag = result.machine ? <ComputerTag name={result.machine.name} state={computerStateToV2(result.machine.state)} short /> : null;
  if (isMessageHit(result)) {
    return (
      <V2Link to={href} className="v2-srch-row" data-testid="v2-search-hit" data-result-id={result.id} data-kind="message">
        <span className="v2-srch-ficon">
          <Icon name="chat" />
        </span>
        <span className="v2-grow v2-srch-main">
          <span className="v2-srch-ttl">
            {mate?.name ?? result.teamRole ?? result.sessionTitle ?? ''}
            {mate ? <CrewTag crew={mate.crewName} /> : null}{' '}
            <span className="v2-srch-who">
              · {whoOf(result)} · {clock(result.ts) || timeAgo(result.ts)}
            </span>
          </span>
          <span className="v2-srch-sub" data-testid="v2-search-snippet">
            “<Marked segments={result.snippet} max={150} />”
          </span>
        </span>
        {tag}
        <span className="v2-srch-tag">
          <Icon name="arrow-r" size="s" />
          {SEARCH_WORDS.exactMessage}
        </span>
      </V2Link>
    );
  }
  const snippet = result.target.type === 'session' || result.snippet.length === 0 ? null : result.snippet;
  const where = result.sessionTitle && result.kind !== 'session' ? (mate?.name ?? result.sessionTitle) : null;
  return (
    <V2Link
      to={href}
      className="v2-srch-row"
      data-testid="v2-search-hit"
      data-result-id={result.id}
      data-kind={result.kind}
      onClick={(event) => {
        // An agent's title peeks at it (a modifier click still opens its page in a new tab).
        if (peekAt === null || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openAgent(peekAt);
      }}
    >
      <span className="v2-srch-ficon">
        <Icon name={result.kind === 'session' ? 'agents' : icon} />
      </span>
      <span className="v2-grow v2-srch-main">
        <span className="v2-srch-ttl">
          {mate && result.kind === 'session' ? mate.name : <Marked segments={result.title} />}
          {mate && result.kind === 'session' ? <CrewTag crew={mate.crewName} /> : null}
        </span>
        <span className="v2-srch-sub">
          {snippet ? <Marked segments={snippet} max={150} /> : null}
          {snippet && where ? ' · ' : ''}
          {where ?? ''}
          {!snippet && !where ? `${result.kind === 'session' ? `${SEARCH_WORDS.agent} · ` : ''}${timeAgo(result.ts)}` : ''}
        </span>
      </span>
      {tag}
    </V2Link>
  );
}
