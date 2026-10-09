import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { useRouter } from '../../router.tsx';
import { formatAge } from '../../shell/format.ts';
import { ArtifactViewer } from './ArtifactViewer.tsx';
import { artifactMeta, kindTag } from './artifacts.ts';
import './artifacts.css';

/** Bursts of `artifactsChanged` fold into one fetch per this many ms. */
const RELOAD_MS = 250;

/**
 * D89 · the session's Artifacts tab (`docs/artifacts.md`): the artifacts saved on
 * purpose in this session (by its agent's `artifact_save` or the developer's Save
 * as artifact), newest first: kind tag, title, version count, size, who saved it,
 * age. Picking one opens it in the {@link ArtifactViewer} beside the list (on a
 * phone: instead of it, with ‹ back); its address is
 * `/sessions/{id}/artifacts/{artifactId}`. Live: `artifactsChanged` reloads it.
 */
export function ArtifactsTab({ sessionId, artifactId, blocked }: { readonly sessionId: string; readonly artifactId: string | null; readonly blocked: string | null }) {
  // Keyed by session: another session starts without the previous one's rows.
  return <SessionArtifacts key={sessionId} sessionId={sessionId} artifactId={artifactId} blocked={blocked} />;
}

function SessionArtifacts({ sessionId, artifactId, blocked }: { readonly sessionId: string; readonly artifactId: string | null; readonly blocked: string | null }) {
  const list = useApi(() => api.sessionArtifacts(sessionId), [sessionId]);
  const reload = useThrottled(list.reload, RELOAD_MS);
  useHubEvent('artifactsChanged', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  // Saves missed while the hub was down.
  const hub = useHubStatus();
  const [wasOpen, setWasOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (hub === 'open' && wasOpen === false) reload();
    setWasOpen(hub === 'open');
  }, [hub]);
  const { navigate } = useRouter();
  const open = (id: string | null): void => navigate({ view: 'session', id: sessionId, tab: 'artifacts', ...(id ? { artifactId: id } : {}) }, { replace: id !== null && artifactId !== null });

  const rows = list.data ?? [];
  const selected = rows.find((artifact) => artifact.id === artifactId) ?? null;
  const state = list.data === null ? (list.error ? 'error' : 'loading') : rows.length === 0 ? 'empty' : 'ready';

  return (
    <div className="sb-arts" data-testid="session-artifacts" data-session-id={sessionId} data-state={state} data-open={selected ? 'true' : undefined}>
      <div className="sb-arts-list" data-testid="artifacts-list" role="list" aria-label="Artifacts">
        {state === 'empty' ? (
          <div className="sb-arts-empty" data-testid="artifacts-empty">
            <div className="sb-arts-empty-title">No artifacts yet</div>
            <div>The agent saves reports, plans, docs, diagrams and mockups here with its artifact_save tool. You can save an agent's message too: ⋯ → Save as artifact.</div>
          </div>
        ) : null}
        {list.error && list.data === null ? (
          <div className="sb-arts-empty" role="alert" data-testid="artifacts-error">
            {list.error.message}
          </div>
        ) : null}
        {rows.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            role="listitem"
            className="sb-button sb-arts__row"
            data-testid="artifact-row"
            data-kind={artifact.kind}
            data-artifact-id={artifact.id}
            aria-current={artifact.id === selected?.id ? 'true' : undefined}
            onClick={() => open(artifact.id)}
          >
            <span className="sb-arts__tag" data-testid="artifact-tag">
              {kindTag(artifact)}
            </span>
            <span className="sb-arts__name" data-testid="artifact-name">
              {artifact.title}
            </span>
            <span className="sb-arts__meta" data-testid="artifact-meta">
              {artifactMeta(artifact)}
            </span>
            <span className="sb-arts__age">{formatAge(artifact.updatedAt)}</span>
          </button>
        ))}
      </div>
      {selected ? (
        <ArtifactViewer
          key={selected.id}
          sessionId={sessionId}
          artifact={selected}
          blocked={blocked}
          onBack={() => open(null)}
          onDeleted={() => {
            open(null);
            list.reload();
          }}
        />
      ) : rows.length > 0 ? (
        <div className="sb-arts-pick" data-testid="artifacts-pick">
          Pick an artifact to see it.
        </div>
      ) : null}
    </div>
  );
}
