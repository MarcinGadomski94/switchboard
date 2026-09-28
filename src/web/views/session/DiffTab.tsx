import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent, useHubStatus } from '../../api/useHub.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { NOT_COMMITTED_NOTE, NO_CHANGES, diffModel, refreshesDiff } from './diff.ts';
import './diff.css';

/** Bursts of `/hub` events fold into one diff fetch per this many ms. */
const REFRESH_MS = 500;

/**
 * Diff tab (SPEC → Session → Diff; M4.5): a 300px file list (file, +/−,
 * solution · path) and the unified diff of the selected file, with the header
 * note "Not committed. Commit only when you approve." while that file still has
 * uncommitted changes. Real data only: `GET /api/sessions/{id}/diff` (gap #10,
 * the WorktreeManager), fetched again when an event of the session can have
 * changed files, when the session's status changes, when the hub stream reopens
 * and when the window regains focus (`docs/derivations.md` → *Diff tab*).
 */
export function DiffTab({ sessionId }: { readonly sessionId: string }) {
  // Keyed by session: another session starts with no stale files and no selection.
  return <SessionDiff key={sessionId} sessionId={sessionId} />;
}

function SessionDiff({ sessionId }: { readonly sessionId: string }) {
  const diff = useApi(() => api.sessionDiff(sessionId), [sessionId]);
  const reload = diff.reload;
  const refresh = useThrottled(reload, REFRESH_MS);

  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId && refreshesDiff(payload.event.kind)) refresh();
  });
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) refresh();
  });

  // Changes made while the stream was down (or outside Switchboard) show up on reconnect / focus.
  const hub = useHubStatus();
  const wasOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (hub === 'open') {
      if (wasOpen.current === false) refresh();
      wasOpen.current = true;
    } else if (wasOpen.current === true) {
      wasOpen.current = false;
    }
  }, [hub, refresh]);
  useEffect(() => {
    const onFocus = (): void => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data;
  const model = useMemo(() => diffModel(files ?? [], selected), [files, selected]);
  const state = files === null ? (diff.error ? 'error' : 'loading') : model.empty ? 'empty' : 'ready';

  const onKey = (key: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(key);
    }
  };

  return (
    <div className="sb-diff" data-testid="session-diff" data-session-id={sessionId} data-state={state}>
      <div className="sb-diff__files" data-testid="diff-files">
        {model.rows.map((row) => (
          <div
            key={row.key}
            className="sb-diff__file"
            data-testid="diff-file"
            data-selected={row.selected ? 'true' : 'false'}
            role="button"
            tabIndex={0}
            aria-pressed={row.selected}
            title={row.sub}
            onClick={() => setSelected(row.key)}
            onKeyDown={onKey(row.key)}
          >
            <div className="sb-diff__file-top">
              <span className="sb-diff__file-name">{row.short}</span>
              <span className="sb-diff__file-delta">{row.delta}</span>
            </div>
            <div className="sb-diff__file-sub">{row.sub}</div>
          </div>
        ))}
        {state === 'empty' ? (
          <div className="sb-diff__empty" data-testid="diff-empty">
            {NO_CHANGES}
          </div>
        ) : null}
      </div>
      <div className="sb-diff__pane">
        <div className="sb-diff__head" data-testid="diff-head">
          <span data-testid="diff-name">{model.pane.name}</span>
          <span className="sb-diff__branch" data-testid="diff-branch">
            {model.pane.branch}
          </span>
          {model.pane.note ? (
            <span className="sb-diff__note" data-testid="diff-note">
              {NOT_COMMITTED_NOTE}
            </span>
          ) : null}
        </div>
        <div className="sb-diff__body" data-testid="diff-body">
          {model.pane.lines.map((line, index) => (
            <div key={index} className="sb-diff__line" data-testid="diff-line" data-tone={line.tone}>
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
