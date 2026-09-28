import { useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { Link } from '../../router.tsx';

/** `HH:MM` in local time. */
function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'message' in error.body) {
    return String((error.body as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Codebase Memory tool's bottom strip (SPEC → Tools): the projects listed in
 * the workspace's `.codebase-memory-dirty` (`GET /api/codebase-memory`) and
 * "Reindex n now", which starts a background session from the built-in reindex
 * prompt (gap #4, `POST /api/codebase-memory/reindex`). The list is read again on
 * every session change, because the reindex session removes the lines it refreshed.
 */
export function CodebaseMemoryStrip() {
  const status = useApi(api.codebaseMemory);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  useHubEvent('sessionUpdated', () => status.reload());

  const projects = status.data?.projects ?? [];
  const indexed = status.data?.indexed ?? null;

  const reindex = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.reindexCodebaseMemory().then(
      (session) => {
        setStarted(session);
        setBusy(false);
        status.reload();
      },
      (caught: unknown) => {
        setError(errorText(caught));
        setBusy(false);
        status.reload();
      },
    );
  };

  return (
    <div className="sb-cm-strip" data-testid="cm-strip">
      <span className="sb-cm-strip-file">.codebase-memory-dirty</span>
      {projects.map((project) => (
        <span key={project.id} className="sb-cm-chip" data-testid="cm-dirty" title={project.path ?? project.id}>
          <span className="sb-cm-chip-dot" />
          <span className="sb-cm-chip-name">{project.name}</span>
          {project.markedAt ? <span className="sb-cm-chip-time">{clock(project.markedAt)}</span> : null}
        </span>
      ))}
      {status.data && projects.length === 0 && !started ? <span data-testid="cm-clean">nothing to reindex</span> : null}
      <span className="sb-cm-strip-note" data-testid="cm-note" data-error={error ? 'true' : undefined}>
        {error ?? (indexed ? `${indexed.projects} projects indexed · ${indexed.mode} mode` : '')}
      </span>
      {started ? (
        <Link to={{ view: 'session', id: started.id, tab: 'chat' }} className="sb-cm-reindex" data-testid="cm-reindex">
          ✓ Reindex started
        </Link>
      ) : projects.length > 0 ? (
        <button type="button" className="sb-button sb-cm-reindex" data-testid="cm-reindex" aria-disabled={busy} onClick={reindex}>
          {`Reindex ${projects.length} now`}
        </button>
      ) : null}
    </div>
  );
}
