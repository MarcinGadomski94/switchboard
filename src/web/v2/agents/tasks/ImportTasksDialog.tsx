import { useEffect, useState } from 'react';
import type { SessionListItem } from '../../../../core/api.ts';
import type { ImportableIssue, IssueImportSources } from '../../../../core/ci.ts';
import { displayTitle } from '../../../../core/session-title.ts';
import { ApiError, api } from '../../../api/client.ts';
import { type ImportForm, canPreview, emptyImportForm, importQuery, importable } from '../../../ci/import-issues.ts';
import { Button, Checkbox, Dialog, Field, Segmented, Select } from '../../components/index.ts';
import { TASKS_WORDS as W } from '../../glossary.ts';

function errorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    const body = caught.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string') return body.message;
    if (caught.unreachable) return 'Switchboard could not be reached.';
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * D131 · **Import from Jira or GitHub** on the Tasks page (the prototype's import dialog,
 * on D109's import API): pick the agent the tasks go to, the source (Jira: a project key
 * or JQL; GitHub: a repository, a label, assigned to me), Preview, tick, Import. Issues
 * imported before show ticked off and disabled. The pure parts are classic's
 * (`src/web/ci/import-issues.ts`).
 */
export function ImportTasksDialog({ open, onClose, agents, onImported }: { readonly open: boolean; readonly onClose: () => void; readonly agents: readonly SessionListItem[]; readonly onImported: (count: number, source: string, agentId: string, agentName: string) => void }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const chosen = agentId && agents.some((agent) => agent.id === agentId) ? agentId : (agents[0]?.id ?? null);
  const [sources, setSources] = useState<IssueImportSources | null>(null);
  const [form, setForm] = useState<ImportForm>({ ...emptyImportForm([]), source: 'jira' });
  const [issues, setIssues] = useState<readonly ImportableIssue[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setIssues(null);
      setTicked(new Set());
      setError(null);
      setBusy(false);
      return undefined;
    }
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
      (caught: unknown) => {
        if (live) setError(errorText(caught));
      },
    );
    return () => {
      live = false;
    };
  }, [open, chosen]);

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
      const agent = agents.find((item) => item.id === chosen);
      onImported(ticked.size, form.source === 'jira' ? 'Jira' : 'GitHub', chosen, agent ? displayTitle(agent) : chosen);
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
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
  const githubOff = form.source === 'github' && sources !== null && !sources.github.available;
  const fresh = issues ? importable(issues) : [];
  const footer = (
    <>
      <span className="v2-muted v2-grow" style={{ fontSize: 13 }}>
        {issues ? `${ticked.size} of ${fresh.length} ticked` : ''}
      </span>
      <Button onClick={onClose} data-testid="v2-tasks-import-cancel">
        {W.cancel}
      </Button>
      {issues && fresh.length > 0 ? (
        <Button variant="primary" icon="download" disabled={busy || ticked.size === 0} onClick={() => void run()} data-testid="v2-tasks-import-go">
          {W.importButton(ticked.size)}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy || chosen === null || jiraOff || !canPreview(form)} onClick={() => void preview()} data-testid="v2-tasks-import-preview">
          {W.importPreview}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title={W.importTitle} icon="download" width={560} testId="v2-tasks-import" footer={footer}>
      {agents.length === 0 ? (
        <p className="v2-muted" style={{ margin: 0 }} data-testid="v2-tasks-import-noagent">
          {W.importNoAgent}
        </p>
      ) : (
        <div className="v2-tasks-import">
          <Select label={W.importInto} value={chosen ?? ''} onChange={(event) => setAgentId(event.target.value)} options={agents.map((agent) => ({ value: agent.id, label: displayTitle(agent) }))} data-testid="v2-tasks-import-agent" />
          <Segmented
            label={W.importSource}
            value={form.source}
            onChange={(source) => change({ source })}
            options={[
              { value: 'jira', label: 'Jira', icon: 'jira' },
              { value: 'github', label: 'GitHub' },
            ]}
            testId="v2-tasks-import-source"
          />
          {form.source === 'github' ? (
            <div className="v2-tasks-import-row">
              <Field label={W.importRepo} placeholder="owner/repo" value={form.repo} onChange={(event) => change({ repo: event.target.value })} data-testid="v2-tasks-import-repo" />
              <Field label={W.importLabel} placeholder="any" value={form.label} onChange={(event) => change({ label: event.target.value })} data-testid="v2-tasks-import-label" />
              <Checkbox label={W.importMine} checked={form.mine} onChange={() => change({ mine: !form.mine })} data-testid="v2-tasks-import-mine" />
              {githubOff ? (
                <p className="v2-tasks-note" data-testid="v2-tasks-import-github-note">
                  {sources?.github.problem ?? 'GitHub is not signed in.'}
                </p>
              ) : null}
            </div>
          ) : (
            <Field
              label={W.importJira}
              placeholder='PROJ, or project = PROJ AND status = "To Do"'
              value={form.jira}
              disabled={jiraOff}
              hint={jiraOff ? (sources?.jira.problem ?? 'Jira is not connected (Settings › Jira).') : undefined}
              onChange={(event) => change({ jira: event.target.value })}
              data-testid="v2-tasks-import-jira"
            />
          )}
          {issues ? (
            <div className="v2-tasks-import-list" data-testid="v2-tasks-import-list">
              {issues.length === 0 ? <p className="v2-muted">{W.importNone}</p> : null}
              {issues.map((issue) => (
                <Checkbox
                  key={issue.key}
                  className="v2-tasks-import-issue"
                  data-testid="v2-tasks-import-check"
                  data-key={issue.key}
                  checked={issue.imported || ticked.has(issue.key)}
                  disabled={issue.imported || busy}
                  onChange={() => toggle(issue.key)}
                  label={
                    <span className="v2-tasks-import-text" data-testid="v2-tasks-import-issue" data-imported={issue.imported ? 'true' : undefined}>
                      <span className="v2-tasks-import-ttl">
                        {issue.key.includes('#') ? `#${issue.key.split('#').pop() ?? ''}` : issue.key} {issue.title}
                      </span>
                      <span className="v2-tasks-import-sub">{issue.imported ? W.importImported : [issue.labels.join(', '), issue.body ? W.importFull : ''].filter(Boolean).join(' · ')}</span>
                    </span>
                  }
                />
              ))}
              {truncated ? <p className="v2-muted">{W.importTruncated}</p> : null}
            </div>
          ) : null}
          {error ? (
            <p className="v2-tasks-error" role="alert" data-testid="v2-tasks-import-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
