import { useMemo } from 'react';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { artifactRows } from './artifacts.ts';
import { useSessionRefresh } from './useSessionRefresh.ts';
import './artifacts.css';

/**
 * Artifacts tab (SPEC → Session → Artifacts; M4.6): type tag + name + meta
 * rows, one per artifact the session produced (gap #9: PR, BRANCH, DIFF per
 * solution + branch, CONTRACT, QA, FOLLOWUP, DOC). Real data only: `GET
 * /api/sessions/{id}` (its `artifacts`, and its `files` for the DIFF rows'
 * counts), fetched again on the same triggers as the Diff tab
 * (`useSessionRefresh`; `docs/derivations.md` → *Artifacts tab*).
 */
export function ArtifactsTab({ sessionId }: { readonly sessionId: string }) {
  // Keyed by session: another session starts without the previous one's rows.
  return <SessionArtifacts key={sessionId} sessionId={sessionId} />;
}

function SessionArtifacts({ sessionId }: { readonly sessionId: string }) {
  const detail = useApi(() => api.getSession(sessionId), [sessionId]);
  useSessionRefresh(sessionId, detail.reload);

  const data = detail.data;
  const rows = useMemo(() => (data ? artifactRows(data.artifacts, data.files) : []), [data]);
  const state = data === null ? (detail.error ? 'error' : 'loading') : data.artifacts.length === 0 ? 'empty' : 'ready';

  return (
    <div className="sb-arts" data-testid="session-artifacts" data-session-id={sessionId} data-state={state}>
      {rows.map((row) => (
        <div key={row.key} className="sb-arts__row" data-testid="artifact-row" data-type={row.tag} title={row.title || undefined}>
          <span className="sb-arts__tag" data-testid="artifact-tag">
            {row.tag}
          </span>
          <div className="sb-arts__name" data-testid="artifact-name">
            {row.name}
          </div>
          <span className="sb-arts__meta" data-testid="artifact-meta">
            {row.meta}
          </span>
        </div>
      ))}
    </div>
  );
}
