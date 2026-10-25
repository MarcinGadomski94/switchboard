import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactListItem } from '../../../core/api.ts';
import { offlineReason } from '../../../core/peers.ts';
import { api, artifactRawUrl, withKeepalive } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { usePeerSync } from '../../components/PeerSync.tsx';
import { deleteErrorText } from '../../views/session/ArtifactDelete.tsx';
import { Button, Card, ComputerTag, EmptyState, Icon, Segmented, Skeleton, TOAST_MS, useToast } from '../components/index.ts';
import { RESULTS_WORDS as W, computerStateToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { ResultDrawer } from './ResultDrawer.tsx';
import {
  FILTER_ICONS,
  RESULT_FILTERS,
  type ResultFilter,
  filterCounts,
  findLinked,
  kindIcon,
  linkOf,
  parseResultsLink,
  pruneSelection,
  resultKey,
  toggleKey,
  visibleResults,
  withoutPending,
} from './results-model.ts';
import './results.css';

export { resultsLink, parseResultsLink, type ResultLink } from './results-model.ts';

/** `/hub` bursts fold into one reload per this many ms. */
const HUB_RELOAD_MS = 250;
/** The first load's placeholder cards (D113). */
const SKELETON_CARDS = 8;

/** D48: why a row cannot be deleted now (its computer is unreachable), else `null`. */
function blockedReason(item: ArtifactListItem): string | null {
  return offlineReason(item.machine);
}

/** Deletes a row through its own route: its agent's, else (no agent) the result's on its computer. */
function deleteRow(item: ArtifactListItem): Promise<void> {
  return item.sessionId ? api.deleteArtifact(item.sessionId, item.id) : api.deleteOrphanArtifact(item.id, item.machine?.id);
}

const kindLabel = (kind: ArtifactListItem['kind']): string => W.kinds[kind];

/**
 * D131 · lane R · Results (`/results`, the prototype's `#s-results`): every result
 * (artifact, D89) on this computer and the paired ones, newest first, as a grid or
 * a list; the type filters with counts; search within; multi-select with Delete
 * and Undo (D111: nothing is deleted until the Undo window ends); the loading
 * placeholders and the paired computers' sync notes (D113); the result drawer.
 *
 * The deep link `/results?open=<id>[&agent=<agentId>][&computer=<computerId>]`
 * opens a result's drawer here (`resultsLink`); closing it removes the query.
 */
export function ResultsPage() {
  const toast = useToast();
  const { search, navigate } = useV2Router();
  const [items, setItems] = useState<readonly ArtifactListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // D111: rows hidden while their Undo window runs (deleted when it ends).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, { readonly item: ArtifactListItem; readonly timer: number }>());

  useEffect(() => {
    let cancelled = false;
    api.artifacts().then(
      (rows) => {
        if (cancelled) return;
        setItems(rows);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useThrottled(() => setTick((n) => n + 1), HUB_RELOAD_MS);
  useHubEvent('artifactsChanged', reload);
  useHubEvent('sessionUpdated', reload);
  const sync = usePeerSync('artifacts', reload);

  const all = useMemo(() => withoutPending(items ?? [], pending), [items, pending]);
  const counts = useMemo(() => filterCounts(all), [all]);
  const shown = useMemo(() => visibleResults(all, filter, query, kindLabel), [all, filter, query]);
  useEffect(() => setSelected((current) => pruneSelection(current, shown, (item) => blockedReason(item) === null)), [shown]);

  // The deep link.
  const link = parseResultsLink(search);
  const open = link && items ? findLinked(items, link) : null;
  const openKey = open ? resultKey(open) : null;
  const goneShown = useRef<string | null>(null);
  useEffect(() => {
    if (!link || items === null || open || goneShown.current === link.id) return;
    goneShown.current = link.id;
    toast({ text: W.notFound, tone: 'error' });
    navigate('/results', { replace: true });
  }, [link?.id, items, open]);
  const closeDrawer = useCallback(() => navigate('/results', { replace: true }), [navigate]);

  // D111: hide now, delete when the Undo window ends (at once when the page goes away).
  const send = useCallback(
    (keys: readonly string[]) => {
      const targets: ArtifactListItem[] = [];
      for (const key of keys) {
        const entry = timers.current.get(key);
        if (!entry) continue;
        window.clearTimeout(entry.timer);
        timers.current.delete(key);
        targets.push(entry.item);
      }
      if (targets.length === 0) return;
      void Promise.allSettled(targets.map((item) => deleteRow(item))).then((results) => {
        const reasons: string[] = [];
        for (const result of results) if (result.status === 'rejected') reasons.push(deleteErrorText(result.reason));
        if (reasons.length > 0) toast({ text: W.deleteFailed(reasons.length, [...new Set(reasons)].join(' · ')), tone: 'error' });
        setPending((current) => new Set([...current].filter((key) => !keys.includes(key))));
        reload();
      });
    },
    [reload, toast],
  );
  const remove = (targets: readonly ArtifactListItem[]): void => {
    const keys = targets.map(resultKey);
    if (keys.length === 0) return;
    for (const item of targets) {
      const key = resultKey(item);
      timers.current.set(key, { item, timer: window.setTimeout(() => send([key]), TOAST_MS) });
    }
    setPending((current) => new Set([...current, ...keys]));
    setSelected((current) => new Set([...current].filter((key) => !keys.includes(key))));
    if (openKey && keys.includes(openKey)) closeDrawer();
    toast({
      text: W.deleted(keys.length),
      undo: () => {
        for (const key of keys) {
          const entry = timers.current.get(key);
          if (entry) window.clearTimeout(entry.timer);
          timers.current.delete(key);
        }
        setPending((current) => new Set([...current].filter((key) => !keys.includes(key))));
      },
    });
  };
  // Leaving the page or hiding the tab sends what is waiting.
  useEffect(() => {
    const flush = (): void => withKeepalive(() => send([...timers.current.keys()]));
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [send]);

  const chosen = shown.filter((item) => selected.has(resultKey(item)));
  const first = items === null;

  return (
    <div className="v2-page v2-res-page" data-wide="" data-testid="v2-page-results" data-area="results" data-view={view} data-filter={filter} data-drawer={open ? '' : undefined} aria-busy={first}>
      <div className="v2-res-ph">
        <div className="v2-grow">
          <h1>{W.title}</h1>
          <p className="v2-page-sub">{W.sub}</p>
        </div>
        <Segmented
          label={W.layout}
          testId="v2-results-layout"
          value={view}
          onChange={setView}
          options={[
            { value: 'grid', label: W.grid, icon: 'grid' },
            { value: 'list', label: W.list, icon: 'list' },
          ]}
        />
      </div>
      <div className="v2-res-filters">
        <div className="v2-res-chips" role="group" aria-label={W.typeFilter}>
          {RESULT_FILTERS.map((key) => (
            <button key={key} type="button" className="v2-res-fchip" data-testid="v2-results-filter" data-filter={key} aria-pressed={key === filter} onClick={() => setFilter(key)}>
              {key === 'all' ? null : <Icon name={FILTER_ICONS[key]} size="s" />}
              {W.filters[key]}
              {first ? null : (
                <span className="v2-res-n" data-testid="v2-results-count">
                  {counts[key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="v2-res-search">
          <Icon name="search" size="s" />
          <input type="search" className="v2-field" data-testid="v2-results-search" placeholder={W.searchWithin} aria-label={W.searchLabel} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      {sync.notes.length > 0 ? (
        <div className="v2-res-sync" data-testid="v2-results-sync">
          {sync.notes.map((note) => (
            <div key={note.id} className="v2-res-sync-note" data-kind={note.kind} data-testid="v2-results-sync-note">
              {note.kind === 'syncing' ? <span className="v2-res-spin" aria-hidden="true" /> : <Icon name="offline" size="s" />}
              <span>{note.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      <span className="v2-res-sr" role="status" aria-live="polite">
        {sync.announcement}
      </span>
      {first && !failed ? (
        <div className="v2-res-grid" data-layout={view} data-testid="v2-results-skeleton">
          <span className="v2-res-sr" role="status">
            {W.loading}
          </span>
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <Card key={index} className="v2-res-card" aria-hidden="true">
              <div className="v2-res-thumb" />
              <div className="v2-res-rb">
                <Skeleton width="70%" />
                <Skeleton width="45%" height={10} style={{ marginTop: 8 }} />
              </div>
            </Card>
          ))}
        </div>
      ) : null}
      {first && failed ? (
        <EmptyState
          icon="alert"
          tone="grey"
          title={W.loadFailed}
          testId="v2-results-error"
          action={
            <Button onClick={() => reload()} data-testid="v2-results-retry">
              {W.tryAgain}
            </Button>
          }
        />
      ) : null}
      {!first && shown.length === 0 ? (
        all.length === 0 ? (
          <EmptyState icon="results" tone="grey" title={W.emptyTitle} text={W.emptyText} testId="v2-results-empty" />
        ) : query.trim() ? (
          <EmptyState icon="search" tone="grey" title={W.noMatchTitle} text={W.noMatchText} testId="v2-results-empty" />
        ) : (
          <EmptyState icon="results" tone="grey" title={W.emptyFilterTitle(W.filters[filter])} text={W.emptyFilterText} testId="v2-results-empty" />
        )
      ) : null}
      {!first && shown.length > 0 ? (
        <div className="v2-res-grid" data-layout={view} data-testid="v2-results-grid">
          {shown.map((item) => (
            <ResultCard
              key={resultKey(item)}
              item={item}
              open={resultKey(item) === openKey}
              checked={selected.has(resultKey(item))}
              onCheck={(on) => setSelected((current) => toggleKey(current, resultKey(item), on))}
              onOpen={() => navigate(linkOf(item))}
            />
          ))}
        </div>
      ) : null}
      {chosen.length > 0 ? (
        <div className="v2-res-selbar" role="group" aria-label={W.selected(chosen.length)} data-testid="v2-results-selbar">
          <b data-testid="v2-results-selcount">{W.selected(chosen.length)}</b>
          <span className="v2-grow" />
          <Button size="sm" icon="trash" data-testid="v2-results-delete" onClick={() => remove(chosen)}>
            {W.delete}
          </Button>
          <Button size="sm" data-testid="v2-results-clear" onClick={() => setSelected(new Set())}>
            {W.clear}
          </Button>
        </div>
      ) : null}
      <ResultDrawer item={open && !pending.has(resultKey(open)) ? open : null} onClose={closeDrawer} onDelete={(item) => remove([item])} />
    </div>
  );
}

/** One result: its thumbnail, title and line (kind · version · agent · computer), a checkbox. */
function ResultCard({ item, open, checked, onCheck, onOpen }: { readonly item: ArtifactListItem; readonly open: boolean; readonly checked: boolean; readonly onCheck: (on: boolean) => void; readonly onOpen: () => void }) {
  const blocked = blockedReason(item);
  const agent = item.sessionId ? (item.sessionTitle ?? item.sessionName ?? '') : W.agentGone;
  return (
    <Card
      interactive
      className="v2-res-card"
      data-testid="v2-result-card"
      data-result-id={item.id}
      data-kind={item.kind}
      data-open={open ? 'true' : undefined}
      data-selected={checked ? 'true' : undefined}
      aria-label={item.title}
      onClick={onOpen}
    >
      <input
        type="checkbox"
        className="v2-res-sel"
        data-testid="v2-result-select"
        aria-label={W.select(item.title)}
        checked={checked}
        disabled={blocked !== null}
        title={blocked ?? undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => onCheck(event.target.checked)}
      />
      <div className="v2-res-thumb" data-kind={item.kind} aria-hidden="true">
        {item.kind === 'image' && item.sessionId ? <img src={artifactRawUrl(item.sessionId, item.id, item.versions)} alt="" loading="lazy" /> : <Thumb kind={item.kind} />}
      </div>
      <div className="v2-res-rb">
        <b className="v2-res-name">{item.title}</b>
        <span className="v2-muted v2-res-line">
          {W.kinds[item.kind]} · {W.version(item.versions)} · {agent}
        </span>
        {item.machine ? <ComputerTag name={item.machine.name} state={computerStateToV2(item.machine.state)} short /> : null}
      </div>
    </Card>
  );
}

/** A drawn thumbnail per kind (the prototype's paper, diagram and table sketches). */
function Thumb({ kind }: { readonly kind: ArtifactListItem['kind'] }) {
  if (kind === 'mermaid' || kind === 'svg') {
    return (
      <svg viewBox="0 0 160 110" width="130" className="v2-res-diagram">
        <g className="v2-res-diagram-box">
          <rect x="8" y="10" width="44" height="22" rx="5" />
          <rect x="58" y="44" width="44" height="22" rx="5" />
          <rect x="108" y="10" width="44" height="22" rx="5" />
          <rect x="108" y="78" width="44" height="22" rx="5" />
        </g>
        <path className="v2-res-diagram-line" d="M52 21 L80 21 80 44M102 55 130 55 130 32M102 60 130 60 130 78" />
      </svg>
    );
  }
  if (kind === 'csv') {
    return (
      <div className="v2-res-minitable">
        {Array.from({ length: 4 }, (_, row) => (
          <div key={row}>
            <i />
            <i />
            <i />
          </div>
        ))}
      </div>
    );
  }
  if (kind === 'code' || kind === 'html') {
    return (
      <div className="v2-res-paper" data-code="">
        <Icon name={kindIcon(kind)} size="s" />
        <i style={{ width: '70%' }} />
        <i style={{ width: '85%', marginLeft: 8 }} />
        <i style={{ width: '60%', marginLeft: 8 }} />
        <i style={{ width: '40%' }} />
      </div>
    );
  }
  return (
    <div className="v2-res-paper">
      <i className="v2-res-paper-h" />
      <i style={{ width: '85%' }} />
      <i style={{ width: '60%' }} />
      {kind === 'pdf' ? (
        <div className="v2-res-paper-bars">
          <u style={{ height: '40%' }} />
          <u style={{ height: '65%' }} />
          <u style={{ height: '90%' }} />
          <u style={{ height: '55%' }} />
        </div>
      ) : (
        <>
          <i style={{ width: '80%' }} />
          <i style={{ width: '55%' }} />
        </>
      )}
      <i />
      <i style={{ width: '75%' }} />
    </div>
  );
}
