import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactListItem } from '../../core/api.ts';
import { ARTIFACT_FILTERS, artifactLocation, typeParam } from '../../core/artifacts-view.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { Link } from '../router.tsx';
import { UNKNOWN, formatAge } from '../shell/format.ts';
import './artifacts.css';

/** How long the view waits after a `/hub` event before it reloads (a turn sends many). */
const HUB_RELOAD_DELAY_MS = 250;

/** Re-renders every `ms` so the Age column stays current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

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

/** The rows of the latest completed load and the unfiltered total. */
interface Loaded {
  readonly key: string;
  readonly rows: readonly ArtifactListItem[];
  readonly total: number;
}

/**
 * Artifacts (SPEC → Artifacts, M7.3): title with "n of m", search, the type
 * filters (All · Diffs · PRs / branches · Docs & contracts · Ticket replies), and
 * the table `80px 1fr 320px 180px 90px 50px` (Type · Name · Solution · branch ·
 * Session · Status · Age). Rows come from `GET /api/artifacts?type=&q=`, which
 * filters and searches on the server; the total is the unfiltered count. A row
 * opens its source session (the prototype's `openSession`: the Chat tab). The
 * list reloads when `/hub` reports session activity, because the recorder derives
 * artifacts from tool results (gap #9). D14: rows whose session belongs to a
 * folder other than the default one carry its tag in the Session column.
 */
export function ArtifactsView() {
  const { tagOf } = useFolderTags();
  const [filterIndex, setFilterIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const now = useNow(30_000);

  const filter = ARTIFACT_FILTERS[filterIndex] ?? ARTIFACT_FILTERS[0]!;
  const type = typeParam(filter);
  const q = search.trim();
  const key = `${type ?? ''}\n${q}`;

  useEffect(() => {
    let cancelled = false;
    const filtered = type !== undefined || q !== '';
    Promise.all([api.artifacts(filtered ? { type, q } : {}), filtered ? api.artifacts() : null]).then(
      ([rows, all]) => {
        if (!cancelled) setLoaded({ key, rows, total: (all ?? rows).length });
      },
      () => {
        // Unreachable or refused: keep the last rows (the sidebar shows the service state).
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const reload = useTrailing(() => setTick((n) => n + 1), HUB_RELOAD_DELAY_MS);
  useHubEvent('event', reload);
  useHubEvent('sessionUpdated', reload);

  const rows = loaded?.rows ?? [];
  const empty = loaded !== null && loaded.key === key && rows.length === 0;

  return (
    <section
      className="sb-view sb-art-view"
      data-view="artifacts"
      data-testid="view-artifacts"
      data-filter={filter.label}
      aria-busy={loaded?.key !== key}
    >
      <div className="sb-art-head">
        <div className="sb-art-title-row">
          <div className="sb-art-title">Artifacts</div>
          <div className="sb-art-count" data-testid="artifacts-count">
            {loaded ? `${rows.length} of ${loaded.total}` : ''}
          </div>
          <input
            className="sb-art-search"
            data-testid="artifacts-search"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search artifacts, solutions, branches…"
            aria-label="Search artifacts"
          />
        </div>
        <div className="sb-art-filters" role="group" aria-label="Artifact type">
          {ARTIFACT_FILTERS.map((item, index) => (
            <button
              key={item.label}
              type="button"
              className="sb-button sb-art-filter"
              data-testid="artifacts-filter"
              aria-pressed={index === filterIndex}
              onClick={() => setFilterIndex(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sb-art-cols" aria-hidden="true">
        <span>Type</span>
        <span>Name</span>
        <span>Solution · branch</span>
        <span>Session</span>
        <span>Status</span>
        <span className="sb-art-cols-age">Age</span>
      </div>
      <div className="sb-art-rows" data-testid="artifacts-rows">
        {rows.map((artifact) => (
          <ArtifactRow key={artifact.id} artifact={artifact} now={now} folderTag={tagOf(artifact)} />
        ))}
        {empty ? (
          <div className="sb-art-empty" data-testid="artifacts-empty">
            {loaded?.total === 0 ? 'No artifacts yet.' : 'No artifacts match.'}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactRow({ artifact, now, folderTag }: { readonly artifact: ArtifactListItem; readonly now: number; readonly folderTag: string | null }) {
  const cells = (
    <>
      <span className="sb-art-type">{artifact.type}</span>
      <span className="sb-art-name">{artifact.name}</span>
      <span className="sb-art-location">{artifactLocation(artifact)}</span>
      <span className="sb-art-session">
        <FolderTag name={folderTag} title={artifact.folderPath} />
        {artifact.sessionName ?? UNKNOWN}
      </span>
      <span className="sb-art-meta">{artifact.meta ?? ''}</span>
      <span className="sb-art-age">{formatAge(artifact.updatedAt, now)}</span>
    </>
  );
  const common = { className: 'sb-art-row', 'data-testid': 'artifact-row', 'data-type': artifact.type, 'data-artifact-id': artifact.id };
  if (artifact.sessionId && artifact.sessionName) {
    return (
      <Link {...common} to={{ view: 'session', id: artifact.sessionId, tab: 'chat' }} title={`Open ${artifact.sessionName}`}>
        {cells}
      </Link>
    );
  }
  return (
    <div {...common} data-no-session="">
      {cells}
    </div>
  );
}
