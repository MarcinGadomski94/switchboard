import { useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { FolderSwitcher } from '../../folders/FolderSwitcher.tsx';
import { useFolderSwitch } from '../../folders/useFolders.ts';
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
 * D14: one folder at a time, the folder switcher first in the strip (`?folder=`
 * keeps it on reload); a repo folder has no dirty list.
 */
export function CodebaseMemoryStrip() {
  const folderSwitch = useFolderSwitch();
  const folderParam = folderSwitch.param;
  const status = useApi(() => api.codebaseMemory(folderParam).then((result) => ({ folder: folderParam, result })), [folderParam]);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  useHubEvent('sessionUpdated', () => status.reload());

  // A switch never shows the last folder's projects while the new ones load.
  const current = status.data && status.data.folder === folderParam ? status.data.result : null;
  const projects = current?.projects ?? [];
  const indexed = current?.indexed ?? null;
  const loadError = !current && !status.loading && status.error ? errorText(status.error) : null;

  const pick = (value: string): void => {
    setStarted(null);
    setError(null);
    folderSwitch.select(value);
  };

  const reindex = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api.reindexCodebaseMemory(folderParam).then(
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
      <FolderSwitcher state={{ ...folderSwitch, select: pick }} testId="cm-folder" className="sb-cm-folder" />
      <span className="sb-cm-strip-file">.codebase-memory-dirty</span>
      {projects.map((project) => (
        <span key={project.id} className="sb-cm-chip" data-testid="cm-dirty" title={project.path ?? project.id}>
          <span className="sb-cm-chip-dot" />
          <span className="sb-cm-chip-name">{project.name}</span>
          {project.markedAt ? <span className="sb-cm-chip-time">{clock(project.markedAt)}</span> : null}
        </span>
      ))}
      {current && projects.length === 0 && !started ? <span data-testid="cm-clean">nothing to reindex</span> : null}
      <span className="sb-cm-strip-note" data-testid="cm-note" data-error={error ?? loadError ? 'true' : undefined}>
        {error ?? loadError ?? (indexed ? `${indexed.projects} projects indexed · ${indexed.mode} mode` : '')}
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
