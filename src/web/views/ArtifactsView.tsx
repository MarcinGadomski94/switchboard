import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactListItem } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { useThrottled } from '../api/useThrottled.ts';
import { offlineReason } from '../../core/peers.ts';
import { MachineTag } from '../components/MachineTag.tsx';
import { PeerSyncNotes, usePeerSync } from '../components/PeerSync.tsx';
import { FolderTag } from '../folders/FolderTag.tsx';
import { useFolderTags } from '../folders/useFolders.ts';
import { Link } from '../router.tsx';
import { UNKNOWN, formatAge } from '../shell/format.ts';
import { ArtifactDeleteConfirm, ArtifactRowMenu, deleteErrorText } from './session/ArtifactDelete.tsx';
import { KIND_FILTERS, artifactKey, artifactMeta, bulkDeleteFailure, keepSelected, kindTag } from './session/artifacts.ts';
import './session/session-loading.css';
import './artifacts.css';

/** D113: how many placeholder rows the first load shows. */
const SKELETON_ROWS = 6;

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
 * Code · HTML · Diagrams · Images · PDFs · Tables) and a session filter, all applied by
 * `GET /api/artifacts?q=&kind=&session=`. A row opens the session's Artifacts tab
 * on that artifact. Live: `artifactsChanged` reloads it.
 *
 * Delete (D89 follow-up): a row's ⋯ → Delete… (asks first), and a checkbox per
 * row with a select-all of the shown rows for **Delete N** (each through its own
 * route: its session's, or for one without a session `DELETE /api/artifacts/{id}`,
 * a paired machine's on that machine). A row whose machine is unreachable (D48)
 * cannot be selected or deleted and says why. The selection keeps only rows still
 * shown after a reload or a filter change; a partial failure keeps the failed rows
 * selected and says how many failed and why.
 */
export function ArtifactsView() {
  const { tagOf } = useFolderTags();
  const [filterIndex, setFilterIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [session, setSession] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // D113: the first load failed (unreachable, refused): said instead of the placeholders.
  const [failed, setFailed] = useState(false);
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
        setFailed(false);
      },
      () => {
        // Unreachable or refused: keep the last rows (the sidebar shows the service state).
        if (!cancelled) setFailed(true);
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
  // D113: a paired machine's artifacts not in yet (or offline) say so; once they arrive the list reads again.
  const sync = usePeerSync('artifacts', reload);

  const rows = loaded?.rows ?? [];
  const empty = loaded !== null && loaded.key === key && rows.length === 0;
  // D113: the first load shows placeholder rows; a re-query keeps the rows and turns the count's spinner on.
  const first = loaded === null;
  const requery = loaded !== null && loaded.key !== key;
  const sessions = useMemo(() => loaded?.sessions ?? [], [loaded]);

  // Bulk delete: the selected rows' keys (machine + id).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Only rows still shown (a reload, a filter change) and still reachable stay selected.
  useEffect(() => {
    if (loaded === null) return;
    setSelected((current) => keepSelected(current, loaded.rows, selectable));
  }, [loaded]);
  useEffect(() => {
    if (selected.size === 0) setFailure(null);
  }, [selected]);
  const selectableRows = rows.filter(selectable);
  const chosen = rows.filter((row) => selected.has(artifactKey(row)));
  const allChosen = selectableRows.length > 0 && selectableRows.every((row) => selected.has(artifactKey(row)));
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = chosen.length > 0 && !allChosen;
  });
  const toggle = (row: ArtifactListItem, on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(artifactKey(row));
      else next.delete(artifactKey(row));
      return next;
    });
  const bulkDelete = (): void => {
    const targets = chosen;
    setDeleting(true);
    void Promise.allSettled(targets.map((row) => deleteRow(row))).then((results) => {
      const failed = new Set<string>();
      const reasons: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          failed.add(artifactKey(targets[index]!));
          reasons.push(deleteErrorText(result.reason));
        }
      });
      setDeleting(false);
      setConfirming(false);
      setSelected((current) => new Set([...current].filter((entry) => failed.has(entry) || !targets.some((row) => artifactKey(row) === entry))));
      setFailure(bulkDeleteFailure(reasons, targets.length));
      reload();
    });
  };

  return (
    <section className="sb-view sb-art-view" data-view="artifacts" data-testid="view-artifacts" data-filter={filter.label} data-loading={first ? 'true' : undefined} aria-busy={loaded?.key !== key}>
      <div className="sb-art-head">
        <div className="sb-art-title-row">
          <div className="sb-art-title">Artifacts</div>
          <div className="sb-art-count" data-testid="artifacts-count" data-busy={requery ? 'true' : undefined}>
            {requery ? <span className="sb-machine-spinner sb-art-count-spinner" data-testid="artifacts-requery" aria-hidden="true" /> : null}
            {loaded ? `${rows.length} of ${loaded.total}` : failed ? '' : 'Loading…'}
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
        <PeerSyncNotes state={sync} testId="artifacts-sync" />
      </div>
      <div className="sb-art-cols" data-testid="artifacts-cols" data-tour="artifacts-select" data-selecting={chosen.length > 0 ? 'true' : undefined}>
        <label className="sb-art-check" title="Select every artifact shown">
          <input
            ref={selectAll}
            type="checkbox"
            data-testid="artifacts-select-all"
            checked={allChosen}
            disabled={selectableRows.length === 0}
            onChange={(event) => setSelected(event.target.checked ? new Set(selectableRows.map(artifactKey)) : new Set())}
            aria-label="Select all shown artifacts"
          />
          <span className="sb-art-check-label">Select all</span>
        </label>
        {chosen.length > 0 ? (
          <div className="sb-art-bulk" role="group" aria-label="Selected artifacts" data-testid="artifacts-bulk">
            <span className="sb-art-bulk-count" data-testid="artifacts-selected">
              {chosen.length} selected
            </span>
            <button type="button" className="sb-button sb-artv-action" data-danger="true" data-testid="artifacts-delete-selected" disabled={deleting} onClick={() => setConfirming(true)}>
              Delete {chosen.length}
            </button>
            <button type="button" className="sb-button sb-artv-action" data-testid="artifacts-clear-selection" disabled={deleting} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
            {failure ? (
              <span className="sb-art-bulk-error" role="alert" data-testid="artifacts-bulk-error">
                {failure}
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <span aria-hidden="true">Kind</span>
            <span aria-hidden="true">Title</span>
            <span aria-hidden="true">Session</span>
            <span aria-hidden="true">Versions</span>
            <span aria-hidden="true">Saved by</span>
            <span aria-hidden="true" className="sb-art-cols-age">
              Age
            </span>
            <i className="sb-art-cols-end" aria-hidden="true" />
          </>
        )}
      </div>
      <div className="sb-art-rows" data-testid="artifacts-rows">
        {first && !failed ? <ArtifactSkeletons /> : null}
        {first && failed ? (
          <div className="sb-art-empty" role="alert" data-testid="artifacts-load-error">
            The artifacts could not be loaded.{' '}
            <button
              type="button"
              className="sb-button sb-artv-action"
              data-testid="artifacts-retry"
              onClick={() => {
                setFailed(false);
                reload();
              }}
            >
              Try again
            </button>
          </div>
        ) : null}
        {rows.map((artifact) => (
          <ArtifactRow
            key={artifactKey(artifact)}
            artifact={artifact}
            now={now}
            folderTag={tagOf(artifact)}
            checked={selected.has(artifactKey(artifact))}
            onCheck={(on) => toggle(artifact, on)}
            onDeleted={reload}
          />
        ))}
        {empty ? (
          <div className="sb-art-empty" data-testid="artifacts-empty">
            {loaded?.total === 0 ? 'No artifacts yet. Agents save reports, plans, docs, diagrams and mockups here with artifact_save; you can save a message with ⋯ → Save as artifact.' : 'No artifacts match.'}
          </div>
        ) : null}
      </div>
      {confirming ? <ArtifactDeleteConfirm titles={chosen.map((row) => row.title)} busy={deleting} onConfirm={bulkDelete} onCancel={() => setConfirming(false)} /> : null}
    </section>
  );
}

/** D113: the first load's placeholder rows (decoration; "Loading artifacts…" is said once for screen readers). */
function ArtifactSkeletons() {
  return (
    <div data-testid="artifacts-skeleton">
      <span className="sb-skel-note" role="status">
        Loading artifacts…
      </span>
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="sb-art-skel-row" data-testid="artifacts-skeleton-row" aria-hidden="true">
          <span className="sb-skel sb-art-skel-check" />
          <span className="sb-skel sb-art-skel-kind" />
          <span className="sb-skel sb-art-skel-title" style={{ width: `${[46, 62, 38, 54, 70, 42][index % 6]}%` }} />
          <span className="sb-skel sb-art-skel-meta" />
        </div>
      ))}
    </div>
  );
}

/** D48: why a row cannot be deleted now (its machine is unreachable), else `null`. */
function blockedReason(artifact: ArtifactListItem): string | null {
  return offlineReason(artifact.machine);
}

/** A row the bulk Delete may take (its machine is reachable). */
function selectable(artifact: ArtifactListItem): boolean {
  return blockedReason(artifact) === null;
}

/** Deletes a row through its own route: its session's, else (no session) the artifact's on its machine. */
function deleteRow(artifact: ArtifactListItem): Promise<void> {
  return artifact.sessionId ? api.deleteArtifact(artifact.sessionId, artifact.id) : api.deleteOrphanArtifact(artifact.id, artifact.machine?.id);
}

/** Props of {@link ArtifactRow}. */
interface ArtifactRowProps {
  readonly artifact: ArtifactListItem;
  readonly now: number;
  readonly folderTag: string | null;
  readonly checked: boolean;
  readonly onCheck: (on: boolean) => void;
  readonly onDeleted: () => void;
}

function ArtifactRow({ artifact, now, folderTag, checked, onCheck, onDeleted }: ArtifactRowProps) {
  const blocked = blockedReason(artifact);
  return (
    <div className="sb-art-item" data-testid="artifact-item" data-artifact-id={artifact.id} data-selected={checked ? 'true' : undefined} data-blocked={blocked ? 'true' : undefined}>
      <label className="sb-art-check" title={blocked ?? undefined}>
        <input type="checkbox" data-testid="artifact-select" checked={checked} disabled={blocked !== null} onChange={(event) => onCheck(event.target.checked)} aria-label={`Select ${artifact.title}`} />
      </label>
      <ArtifactLink artifact={artifact} now={now} folderTag={folderTag} />
      <ArtifactRowMenu title={artifact.title} blocked={blocked} remove={() => deleteRow(artifact)} onDeleted={onDeleted} />
    </div>
  );
}

function ArtifactLink({ artifact, now, folderTag }: { readonly artifact: ArtifactListItem; readonly now: number; readonly folderTag: string | null }) {
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
