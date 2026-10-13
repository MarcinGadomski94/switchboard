import { useEffect, useRef, useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import { DEFAULT_JIRA_TRANSITIONS, JIRA_SYNC_MODES, type JiraPreview, type JiraSyncMode } from '../../../core/plans-jira.ts';
import { onDeviceOrigin } from '../../api/client.ts';
import { JiraApiError, jiraApi } from './api.ts';
import { JiraCredentialsForm } from './JiraCredentialsForm.tsx';
import './jira.css';

/** Props of {@link ImportJiraDialog}. */
export interface ImportJiraDialogProps {
  /** The session whose todo list the plan runs (a paired machine's `r~<machine>~<id>` imports on that machine). */
  readonly sourceSessionId: string;
  /** The plan repos (a workspace's solution names); omitted = the session's own solutions (the core's default). */
  readonly repos?: readonly string[];
  /** Pre-fills the epic field (e.g. a pasted link). */
  readonly initialEpic?: string;
  /** Called with the new draft plan (the page opens it: the merge mode is chosen at Start). */
  readonly onImported: (plan: Plan) => void;
  /** Cancel / ✕ / Escape. */
  readonly onClose: () => void;
}

const SYNC_LABELS: Readonly<Record<JiraSyncMode, string>> = {
  off: 'Off: import only',
  'read-only': 'Read-only: refresh title, status and description every 30 min while the plan runs',
  write: 'Write: also move tickets to In Progress / In Review and comment (never Done)',
};

/**
 * D99-Jira · the **Import from Jira…** dialog (`docs/plans.md` → *Jira import and status
 * sync*). Paste an epic key or link → **Preview** (nothing is created): the children as items,
 * the dependencies ("PROJ-12 waits on PROJ-11"), the items without links flagged, the links
 * outside the epic as notes and any link left out because of a cycle. Then the plan's title,
 * target and base branch and its Jira sync (`off` by default, the transition names for
 * `write`) → **Create plan**: a draft; the merge mode is chosen at Start. Without Jira set up it
 * says how (and, on this computer's own UI, offers the credentials form).
 */
export function ImportJiraDialog({ sourceSessionId, repos, initialEpic, onImported, onClose }: ImportJiraDialogProps) {
  const [epic, setEpic] = useState(initialEpic ?? '');
  const [preview, setPreview] = useState<JiraPreview | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState('dev');
  const [sync, setSync] = useState<JiraSyncMode>('off');
  const [inProgress, setInProgress] = useState(DEFAULT_JIRA_TRANSITIONS.inProgress);
  const [inReview, setInReview] = useState(DEFAULT_JIRA_TRANSITIONS.inReview);
  const [error, setError] = useState<JiraApiError | null>(null);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fail = (caught: unknown) => setError(caught instanceof JiraApiError ? caught : new JiraApiError(0, null, caught instanceof Error ? caught.message : 'failed'));

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const answer = await jiraApi.preview(sourceSessionId, epic);
      setPreview(answer);
      setTitle(answer.suggestedTitle);
      setTarget(answer.suggestedTargetBranch);
    } catch (caught) {
      setPreview(null);
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!preview) return;
    setBusy('create');
    setError(null);
    try {
      const answer = await jiraApi.importPlan(sourceSessionId, {
        epic: preview.epic.key,
        title,
        targetBranch: target,
        baseBranch: base,
        sync,
        ...(repos ? { repos } : {}),
        ...(sync === 'write' ? { transitions: { inProgress, inReview } } : {}),
      });
      onImported(answer.plan);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const notConfigured = error?.code === 'jira-not-configured';
  const unlinked = new Set(preview?.unlinked ?? []);

  return (
    <div className="sb-jira-overlay" data-testid="jira-import-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sb-jira-dialog" role="dialog" aria-modal="true" aria-labelledby="sb-jira-import-title" data-testid="jira-import">
        <header className="sb-jira-head">
          <h2 id="sb-jira-import-title">Import from Jira</h2>
          <button type="button" className="sb-jira-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="sb-jira-body">
          <form
            className="sb-jira-epic"
            onSubmit={(event) => {
              event.preventDefault();
              void runPreview();
            }}
          >
            <label className="sb-jira-field sb-jira-grow">
              <span>Epic key or link</span>
              <input ref={input} data-testid="jira-epic" value={epic} placeholder="PROJ-100 or https://acme.atlassian.net/browse/PROJ-100" onChange={(event) => setEpic(event.target.value)} />
            </label>
            <button type="submit" className="sb-jira-btn" data-testid="jira-preview" disabled={busy !== null || epic.trim() === ''}>
              {busy === 'preview' ? 'Reading…' : 'Preview'}
            </button>
          </form>
          {notConfigured ? (
            <div className="sb-jira-notice" data-testid="jira-not-configured">
              <p>{error.message}</p>
              {onDeviceOrigin() ? <p className="sb-jira-muted">Set it up on the computer that owns this session.</p> : <JiraCredentialsForm onChanged={(status) => status.configured && setError(null)} />}
            </div>
          ) : error && !error.fields['targetBranch'] && !error.fields['title'] ? (
            <div className="sb-jira-error" role="alert" data-testid="jira-error">
              {error.message}
            </div>
          ) : null}
          {preview ? (
            <div className="sb-jira-preview" data-testid="jira-preview-result">
              <div className="sb-jira-muted">
                <a href={preview.epic.url} target="_blank" rel="noreferrer noopener">
                  {preview.epic.key}
                </a>{' '}
                {preview.epic.summary} · {preview.items.length} items · {preview.edges.length} dependencies{preview.truncated ? ' · only the first 100 children were read' : ''}
              </div>
              <section>
                <h3>Items</h3>
                <ul className="sb-jira-items" data-testid="jira-items">
                  {preview.items.map((item) => (
                    <li key={item.key} data-testid={`jira-item-${item.key}`} data-unlinked={unlinked.has(item.key) ? 'true' : 'false'}>
                      <span className="sb-jira-key">{item.key}</span>
                      <span className="sb-jira-summary">{item.summary}</span>
                      <span className="sb-jira-chips">
                        {item.status ? <span className="sb-jira-chip">{item.status}</span> : null}
                        {item.components.map((component) => (
                          <span key={component} className="sb-jira-chip" title="Jira component (pick the item's solutions on the plan)">
                            {component}
                          </span>
                        ))}
                        {item.estimateMinutes !== null ? <span className="sb-jira-chip">{item.estimateMinutes} min</span> : null}
                        {item.acceptanceCriteria ? <span className="sb-jira-chip">acceptance criteria</span> : null}
                        {unlinked.has(item.key) ? (
                          <span className="sb-jira-chip sb-jira-flag" data-testid={`jira-unlinked-${item.key}`}>
                            no links
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>Order</h3>
                {preview.edges.length === 0 ? <p className="sb-jira-muted">No dependencies: every item can start at once.</p> : null}
                <ul className="sb-jira-lines" data-testid="jira-edges">
                  {preview.edges.map((edge) => (
                    <li key={`${edge.from}>${edge.to}`}>{edge.text}</li>
                  ))}
                </ul>
                {preview.cycles.length > 0 ? (
                  <ul className="sb-jira-lines sb-jira-warn" data-testid="jira-cycles">
                    {preview.cycles.map((cycle) => (
                      <li key={`${cycle.from}>${cycle.to}`}>{cycle.text}</li>
                    ))}
                  </ul>
                ) : null}
                {preview.externalLinks.length > 0 ? (
                  <ul className="sb-jira-lines sb-jira-muted" data-testid="jira-external">
                    {preview.externalLinks.map((link) => (
                      <li key={`${link.key}|${link.other}|${link.relation}`}>{link.text}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
              <section className="sb-jira-form">
                <h3>Plan</h3>
                <label className="sb-jira-field">
                  <span>Title</span>
                  <input data-testid="jira-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                  {error?.fields['title'] ? <em className="sb-jira-error">{error.fields['title']}</em> : null}
                </label>
                <div className="sb-jira-row">
                  <label className="sb-jira-field sb-jira-grow">
                    <span>Target branch (the epic's feature branch)</span>
                    <input data-testid="jira-target" value={target} onChange={(event) => setTarget(event.target.value)} />
                    {error?.fields['targetBranch'] ? (
                      <em className="sb-jira-error" data-testid="jira-target-error">
                        {error.fields['targetBranch']}
                      </em>
                    ) : null}
                  </label>
                  <label className="sb-jira-field">
                    <span>Base branch</span>
                    <input data-testid="jira-base" value={base} onChange={(event) => setBase(event.target.value)} />
                  </label>
                </div>
                <fieldset className="sb-jira-sync" data-testid="jira-sync">
                  <legend>Jira status sync</legend>
                  {JIRA_SYNC_MODES.map((mode) => (
                    <label key={mode}>
                      <input type="radio" name="sb-jira-sync" value={mode} checked={sync === mode} data-testid={`jira-sync-${mode}`} onChange={() => setSync(mode)} />
                      {SYNC_LABELS[mode]}
                    </label>
                  ))}
                </fieldset>
                {sync === 'write' ? (
                  <div className="sb-jira-row">
                    <label className="sb-jira-field sb-jira-grow">
                      <span>"In progress" transition</span>
                      <input data-testid="jira-transition-progress" value={inProgress} onChange={(event) => setInProgress(event.target.value)} />
                    </label>
                    <label className="sb-jira-field sb-jira-grow">
                      <span>"In review" transition</span>
                      <input data-testid="jira-transition-review" value={inReview} onChange={(event) => setInReview(event.target.value)} />
                    </label>
                  </div>
                ) : null}
                <p className="sb-jira-muted">The plan is created as a draft. You choose how its work is merged when you start it.</p>
              </section>
            </div>
          ) : null}
        </div>
        <footer className="sb-jira-foot">
          <button type="button" className="sb-jira-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="sb-jira-btn sb-jira-btn-primary" data-testid="jira-create" disabled={!preview || busy !== null || target.trim() === ''} onClick={() => void create()}>
            {busy === 'create' ? 'Creating…' : 'Create plan'}
          </button>
        </footer>
      </div>
    </div>
  );
}
