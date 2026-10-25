import { type MouseEvent, useEffect, useState } from 'react';
import type { ImportableIssue, IssueImportSources } from '../../core/ci.ts';
import { ApiError, api } from '../api/client.ts';
import { useSessionList } from '../folders/useFolders.ts';
import { useToasts } from '../toast/ToastHost.tsx';
import { type ImportForm, canPreview, emptyImportForm, importLabel, importQuery, importable, importedText } from './import-issues.ts';
import './import-issues.css';

/** D109: where the Import issues dialog imports to (`null` = the developer picks a session). */
export interface ImportTarget {
  readonly sessionId: string | null;
}

function errorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    const body = caught.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * D109 · **Import issues…** (the Todos page and a session's todo strip): GitHub issues of a
 * repository (`gh`: open, a label, assigned to me) or Jira issues (a project key or JQL, through
 * the Jira connection of Settings → Jira), a preview with checkboxes, then the
 * ticked ones become the session's todos with a link back. Issues imported before are shown
 * ticked off and cannot be imported twice.
 */
export function ImportIssuesDialog({ target, onClose }: { readonly target: ImportTarget; readonly onClose: () => void }) {
  const sessions = useSessionList();
  const { show } = useToasts();
  const choices = (sessions.data ?? []).filter((session) => session.kind !== 'chat' && !session.closedAt);
  const [sessionId, setSessionId] = useState<string | null>(target.sessionId);
  const chosen = sessionId ?? choices[0]?.id ?? null;
  const [sources, setSources] = useState<IssueImportSources | null>(null);
  const [form, setForm] = useState<ImportForm>(emptyImportForm([]));
  const [issues, setIssues] = useState<readonly ImportableIssue[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (chosen === null) return undefined;
    let live = true;
    setSources(null);
    setIssues(null);
    api.importSources(chosen).then(
      (answer) => {
        if (!live) return;
        setSources(answer);
        setForm((current) => (current.repo === '' ? { ...current, repo: answer.github.repos[0] ?? '' } : current));
      },
      (caught: unknown) => live && setError(errorText(caught)),
    );
    return () => {
      live = false;
    };
  }, [chosen]);

  const change = (patch: Partial<ImportForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setIssues(null);
    setTicked(new Set());
  };

  const preview = async (): Promise<void> => {
    if (chosen === null) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await api.previewImport(chosen, importQuery(form));
      setIssues(answer.issues);
      setTruncated(answer.truncated);
      setTicked(new Set(importable(answer.issues).map((issue) => issue.key)));
    } catch (caught) {
      setError(errorText(caught));
      setIssues(null);
    } finally {
      setBusy(false);
    }
  };

  const run = async (): Promise<void> => {
    if (chosen === null || ticked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.importIssues(chosen, { query: importQuery(form), keys: [...ticked] });
      const title = choices.find((session) => session.id === chosen);
      show({ id: `import-${chosen}-${Date.now()}`, title: 'Issues imported', sub: 'now', branch: '', text: importedText(ticked.size, title?.displayTitle ?? title?.title ?? title?.name ?? 'the session'), sessionId: chosen, jumpLabel: 'Open' });
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };

  const toggle = (key: string): void => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const jiraOff = form.source === 'jira' && sources !== null && !sources.jira.available;
  const open = issues ? importable(issues) : [];
  return (
    <div className="sb-overlay" data-modal="import-issues" onClick={onClose}>
      <div className="sb-modal-simple sb-ii" role="dialog" aria-modal="true" aria-label="Import issues" data-testid="modal-import-issues" onClick={(event: MouseEvent) => event.stopPropagation()}>
        <div className="sb-ns-simple">
          <div className="sb-ns-head sb-ns-simple-head">
            <div className="sb-ns-title">Import issues</div>
            <div className="sb-ns-sub">Open issues become todo items with a link back. Issues imported before are skipped.</div>
          </div>
          {target.sessionId === null ? (
            <label className="sb-ii-field">
              <span className="sb-ns-label">Into the todos of</span>
              <select className="sb-set-select sb-ii-select" data-testid="ii-session" value={chosen ?? ''} onChange={(event) => setSessionId(event.target.value)}>
                {choices.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.displayTitle ?? session.title ?? session.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="sb-ii-sources" role="radiogroup" aria-label="Source">
            {(['github', 'jira'] as const).map((source) => (
              <button key={source} type="button" role="radio" className="sb-ii-source" data-testid={`ii-source-${source}`} aria-checked={form.source === source} onClick={() => change({ source })}>
                {source === 'github' ? 'GitHub' : 'Jira'}
              </button>
            ))}
          </div>
          {form.source === 'github' ? (
            <div className="sb-ii-row">
              <label className="sb-ii-field sb-ii-grow">
                <span className="sb-ns-label">Repository</span>
                <input className="sb-ns-input" data-testid="ii-repo" list="sb-ii-repos" placeholder="owner/repo" value={form.repo} onChange={(event) => change({ repo: event.target.value })} />
                <datalist id="sb-ii-repos">
                  {(sources?.github.repos ?? []).map((repo) => (
                    <option key={repo} value={repo} />
                  ))}
                </datalist>
              </label>
              <label className="sb-ii-field">
                <span className="sb-ns-label">Label</span>
                <input className="sb-ns-input sb-ii-label" data-testid="ii-label" placeholder="any" value={form.label} onChange={(event) => change({ label: event.target.value })} />
              </label>
              <label className="sb-ii-mine">
                <input type="checkbox" data-testid="ii-mine" checked={form.mine} onChange={() => change({ mine: !form.mine })} />
                Assigned to me
              </label>
            </div>
          ) : (
            <label className="sb-ii-field">
              <span className="sb-ns-label">Project key or JQL</span>
              <input className="sb-ns-input" data-testid="ii-jira" placeholder="PROJ, or assignee = currentUser() AND statusCategory != Done" value={form.jira} disabled={jiraOff} onChange={(event) => change({ jira: event.target.value })} />
              {jiraOff ? (
                <span className="sb-ii-note" data-testid="ii-jira-note">
                  {sources?.jira.problem ?? 'Jira is not connected.'}
                </span>
              ) : null}
            </label>
          )}
          {issues ? (
            <div className="sb-ii-list" data-testid="ii-list">
              {issues.length === 0 ? <div className="sb-ii-note">No open issues match.</div> : null}
              {issues.map((issue) => (
                <label key={issue.key} className="sb-ii-issue" data-testid="ii-issue" data-key={issue.key} data-imported={issue.imported ? 'true' : undefined}>
                  <input type="checkbox" data-testid="ii-issue-check" checked={issue.imported || ticked.has(issue.key)} disabled={issue.imported || busy} onChange={() => toggle(issue.key)} />
                  <span className="sb-ii-key">{issue.key.includes('#') ? `#${issue.key.split('#').pop() ?? ''}` : issue.key}</span>
                  <span className="sb-ii-title">{issue.title}</span>
                  {issue.labels.length > 0 ? <span className="sb-ii-labels">{issue.labels.join(', ')}</span> : null}
                  {issue.imported ? <span className="sb-ii-done">imported</span> : null}
                </label>
              ))}
              {truncated ? <div className="sb-ii-note">Showing the first 100: narrow the filter to see the rest.</div> : null}
            </div>
          ) : null}
          {error ? (
            <div className="sb-ns-error sb-ns-simple-error" role="alert" data-testid="ii-error">
              {error}
            </div>
          ) : null}
          <div className="sb-ns-simple-actions">
            <span className="sb-ns-simple-waiting">{issues ? `${ticked.size} of ${open.length} ticked` : ''}</span>
            <button type="button" className="sb-button sb-ns-cancel" data-testid="ii-cancel" onClick={onClose}>
              Cancel
            </button>
            {issues && open.length > 0 ? (
              <button type="button" className="sb-button sb-ns-start sb-ns-simple-start" data-testid="ii-import" disabled={busy || ticked.size === 0} onClick={() => void run()}>
                {importLabel(ticked.size)}
              </button>
            ) : (
              <button type="button" className="sb-button sb-ns-start sb-ns-simple-start" data-testid="ii-preview" disabled={busy || chosen === null || jiraOff || !canPreview(form)} onClick={() => void preview()}>
                Preview
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
