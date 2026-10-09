import { type KeyboardEvent, useCallback, useMemo, useState } from 'react';
import type { DiffScope } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import {
  NOT_COMMITTED_NOTE,
  REPO_NOTE,
  SCOPE_LABELS,
  SCOPE_TITLES,
  type ScopeStorage,
  diffModel,
  emptyState,
  headerLine,
  loadScope,
  saveScope,
  scopeOptions,
  shownScope,
} from './diff.ts';
import { useSessionRefresh } from './useSessionRefresh.ts';
import './diff.css';

/** `window.localStorage`, or `null` where reading it throws (blocked site data). */
function browserStorage(): ScopeStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Diff tab (SPEC → Session → Diff; M4.5): a 300px file list (file, +/−,
 * solution · path) and the unified diff of the selected file, with the header
 * note "Not committed. Commit only when you approve." while that file still has
 * uncommitted changes. Real data only: `GET /api/sessions/{id}/diff` (gap #10,
 * the WorktreeManager), fetched again when an event of the session can have
 * changed files, when the session's status changes, when the hub stream reopens
 * and when the window regains focus (`docs/derivations.md` → *Diff tab*).
 *
 * D90: a bar above it says what is shown ("Since last commit · 4 files · +120 −8")
 * and offers the other views the session has (Whole branch with a worktree, All
 * uncommitted changes in this repo with an in-place solution); the pick is
 * remembered per session in this browser. Hunks are separated by their `@@` row.
 */
export function DiffTab({ sessionId }: { readonly sessionId: string }) {
  // Keyed by session: another session starts with no stale files and no selection.
  return <SessionDiff key={sessionId} sessionId={sessionId} />;
}

function SessionDiff({ sessionId }: { readonly sessionId: string }) {
  const [remembered, setRemembered] = useState<DiffScope | null>(() => loadScope(browserStorage(), sessionId));
  const targets = useApi(() => api.sessionDiffTargets(sessionId), [sessionId]);
  // A machine before D90 has no targets route: only the default view.
  const known = targets.data ?? (targets.error ? { worktrees: [], inPlace: [] } : null);
  const scope = shownScope(remembered, known);
  // Each answer carries its view, so a switch never shows one view's files under another's header.
  const diff = useApi(async () => ({ scope, files: await api.sessionDiff(sessionId, undefined, scope) }), [sessionId, scope]);
  const reloadDiff = diff.reload;
  const reloadTargets = targets.reload;
  const reload = useCallback(() => {
    reloadDiff();
    reloadTargets();
  }, [reloadDiff, reloadTargets]);
  // Changes made while the stream was down (or outside Switchboard) show up on reconnect / focus.
  useSessionRefresh(sessionId, reload);

  const [selected, setSelected] = useState<string | null>(null);
  const files = diff.data !== null && diff.data.scope === scope ? diff.data.files : null;
  const model = useMemo(() => diffModel(files ?? [], selected), [files, selected]);
  const state = files === null ? (diff.error ? 'error' : 'loading') : model.empty ? 'empty' : 'ready';
  const options = scopeOptions(known);
  const empty = emptyState(scope, known);

  const pick = (next: DiffScope) => {
    saveScope(browserStorage(), sessionId, next);
    setRemembered(next);
  };

  const onKey = (key: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(key);
    }
  };

  return (
    <div className="sb-diff-view" data-testid="diff-view" data-scope={scope}>
      <div className="sb-diff-scope" data-testid="diff-scope-bar" data-tour="diff-scope-bar">
        <span className="sb-diff-scope__summary" data-testid="diff-summary">
          {headerLine(scope, files ?? [], known)}
        </span>
        {options.length > 1 ? (
          <div className="sb-diff-scope__toggle" role="group" aria-label="Changes shown" data-testid="diff-scope" data-tour="diff-scope">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className="sb-diff-scope__button"
                data-testid={`diff-scope-${option}`}
                aria-pressed={option === scope}
                title={SCOPE_TITLES[option]}
                onClick={() => pick(option)}
              >
                {SCOPE_LABELS[option]}
              </button>
            ))}
          </div>
        ) : null}
        {scope === 'repo' ? (
          <span className="sb-diff-scope__note" data-testid="diff-scope-note">
            {REPO_NOTE}
          </span>
        ) : null}
      </div>
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
              <div data-testid="diff-empty-text">{empty.text}</div>
              {empty.hint ? (
                <div className="sb-diff__empty-hint" data-testid="diff-empty-hint">
                  {empty.hint}
                </div>
              ) : null}
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
    </div>
  );
}
