import { useEffect, useMemo, useState } from 'react';
import type { ArtifactListItem } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { Link } from '../router.tsx';
import { UNKNOWN, formatAge } from '../shell/format.ts';
import { KIND_FILTERS, artifactMeta, kindTag } from './session/artifacts.ts';
import './artifacts.css';

/** `/hub` bursts fold into one reload per this many ms. */
const HUB_RELOAD_MS = 250;

/** Re-renders every `ms` so the Age column stays current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** The rows of the latest completed load and the unfiltered total. */
interface Loaded {
  readonly key: string;
  readonly rows: readonly ArtifactListItem[];
  readonly total: number;
  /** Every session that has artifacts (for the session filter), newest first. */
  readonly sessions: readonly { readonly id: string; readonly label: string }[];
}

/**
 * D89 · the Artifacts page (`docs/artifacts.md` → *Artifacts page*): every
 * artifact saved on purpose, in every session (this machine's and, D48, the paired
 * machines'), newest first: kind · title · session · versions · saved by · age.
 * Search (title, kind, language, session, machine), the kind filters (All · Docs ·
 * Code · HTML · Diagrams · Images · Tables) and a session filter, all applied by
 * `GET /api/artifacts?q=&kind=&session=`. A row opens the session's Artifacts tab
 * on that artifact. Live: `artifactsChanged` reloads it.
 */
export function ArtifactsView() {
  const { tagOf } = useFolderTags();
  const [filterIndex, setFilterIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [session, setSession] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const now = useNow(30_000);

  const filter = KIND_FILTERS[filterIndex] ?? KIND_FILTERS[0]!;
  const kind = filter.kinds ? filter.kinds.join(',') : undefined;
  const q = search.trim();
  const key = `${kind ?? ''}\n${q}\n${session}`;

  useEffect(() => {
    let cancelled = false;
    const filtered = kind !== undefined || q !== '' || session !== '';
    Promise.all([api.artifacts(filtered ? { kind, q, session: session || undefined } : {}), filtered ? api.artifacts() : null]).then(
      ([rows, all]) => {
        if (cancelled) return;
        const every = all ?? rows;
        const seen = new Map<string, string>();
        for (const item of every) if (item.sessionId && !seen.has(item.sessionId)) seen.set(item.sessionId, item.sessionTitle ?? item.sessionName ?? UNKNOWN);
        setLoaded({ key, rows, total: every.length, sessions: [...seen].map(([id, label]) => ({ id, label })) });
      },
      () => {
        // Unreachable or refused: keep the last rows (the sidebar shows the service state).
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const reload = useThrottled(() => setTick((n) => n + 1), HUB_RELOAD_MS);
  useHubEvent('artifactsChanged', reload);
  // A session renamed (its title in the Session column).
  useHubEvent('sessionUpdated', reload);

  const rows = loaded?.rows ?? [];
  const empty = loaded !== null && loaded.key === key && rows.length === 0;
  const sessions = useMemo(() => loaded?.sessions ?? [], [loaded]);

  return (
    <section className="sb-view sb-art-view" data-view="artifacts" data-testid="view-artifacts" data-filter={filter.label} aria-busy={loaded?.key !== key}>
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
            placeholder="Search artifacts and sessions…"
            aria-label="Search artifacts"
          />
        </div>
        <div className="sb-art-filters" role="group" aria-label="Artifact kind" data-tour="artifacts-filters">
          {KIND_FILTERS.map((item, index) => (
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
          <select className="sb-art-session-filter" data-testid="artifacts-session" value={session} onChange={(event) => setSession(event.target.value)} aria-label="Session">
            <option value="">All sessions</option>
            {sessions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="sb-art-cols" aria-hidden="true">
        <span>Kind</span>
        <span>Title</span>
        <span>Session</span>
        <span>Versions</span>
        <span>Saved by</span>
        <span className="sb-art-cols-age">Age</span>
      </div>
      <div className="sb-art-rows" data-testid="artifacts-rows">
        {rows.map((artifact) => (
          <ArtifactRow key={`${artifact.sessionId ?? ''}/${artifact.id}`} artifact={artifact} now={now} folderTag={tagOf(artifact)} />
        ))}
        {empty ? (
          <div className="sb-art-empty" data-testid="artifacts-empty">
            {loaded?.total === 0 ? 'No artifacts yet. Agents save reports, plans, docs, diagrams and mockups here with artifact_save; you can save a message with ⋯ → Save as artifact.' : 'No artifacts match.'}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ArtifactRow({ artifact, now, folderTag }: { readonly artifact: ArtifactListItem; readonly now: number; readonly folderTag: string | null }) {
  const cells = (
    <>
      <span className="sb-art-type">{kindTag(artifact)}</span>
      <span className="sb-art-name">{artifact.title}</span>
      <span className="sb-art-location">
        <MachineTag machine={artifact.machine} />
        <FolderTag name={folderTag} title={artifact.folderPath} />
        {artifact.sessionTitle ?? artifact.sessionName ?? UNKNOWN}
      </span>
      <span className="sb-art-session" title={artifactMeta(artifact)}>
        v{artifact.versions}
      </span>
      <span className="sb-art-meta">{artifact.createdBy === 'agent' ? 'agent' : 'you'}</span>
      <span className="sb-art-age">{formatAge(artifact.updatedAt, now)}</span>
    </>
  );
  const common = { className: 'sb-art-row', 'data-testid': 'artifact-row', 'data-kind': artifact.kind, 'data-artifact-id': artifact.id };
  if (artifact.sessionId) {
    return (
      <Link {...common} to={{ view: 'session', id: artifact.sessionId, tab: 'artifacts', artifactId: artifact.id }} title={`Open ${artifact.title}`}>
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
