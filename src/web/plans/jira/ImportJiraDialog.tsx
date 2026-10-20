import { useCallback, useEffect, useRef, useState } from 'react';
import type { Plan } from '../../../core/plans.ts';
import { DEFAULT_JIRA_DONE_ON_MERGE, DEFAULT_JIRA_TRANSITIONS, JIRA_SYNC_MODES, type JiraPreview, type JiraSyncMode } from '../../../core/plans-jira.ts';
import { jiraCountsText } from '../../../core/plans-jira-context.ts';
import { machineApi, onDeviceOrigin } from '../../api/client.ts';
import { useSessionListOf } from '../../api/session-list.ts';
import { JiraApiError, jiraApi } from './api.ts';
import { JiraCredentialsForm } from './JiraCredentialsForm.tsx';
import { type JiraImportPlace, loadLastPlace, saveLastPlace, sidebarChoiceKey } from './place.ts';
import { type ResolvedPlace, WhereItRuns } from './WhereItRuns.tsx';
import './jira.css';

/** Props of {@link ImportJiraDialog}. */
export interface ImportJiraDialogProps {
  /**
   * The session whose todo list the plan runs (a paired machine's `r~<machine>~<id>` imports on that machine).
   * D112: omitted = the plan gets a new session in a folder the dialog asks for (**Where it runs**).
   */
  readonly sourceSessionId?: string;
  /** D112: with no session, **Use an existing session instead** (the Plans list then asks for one). */
  readonly onUseSession?: () => void;
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
  write: 'Write: also move tickets to In Progress / In Review and comment',
};

/**
 * D99-Jira · the **Import from Jira…** dialog (`docs/plans.md` → *Jira import and status
 * sync*). Paste an epic key or link → **Preview** (nothing is created): the children as items,
 * the dependencies ("PROJ-12 waits on PROJ-11"), the items without links flagged, the links
 * outside the epic as notes and any link left out because of a cycle. Then the plan's title,
 * target and base branch and its Jira sync (`off` by default, the transition names for
 * `write`) → **Create plan**: a draft; the merge mode is chosen at Start. Without Jira set up it
 * says how (and, on this computer's own UI, offers the credentials form).
 *
 * D115: a workspace (a folder, or a session started without solutions, D38) needs no
 * repositories: the plan's agent picks each item's repositories after the import, and the Plan
 * section says so. An optional, collapsed **Limit to repositories…** lets the developer name them
 * instead (the workspace's solutions, read-only ones left out; every item then works in those).
 * Create plan never fails silently: while it cannot be pressed the footer says why, and a refused
 * create shows the server's reason next to it.
 *
 * D112: without a session it asks **Where it runs** instead (machine, folder, CLI and account,
 * model), pre-filled from the last import in this browser. Create plan then starts a new session "Plan · <plan title>" (the epic summary when the title
 * is empty) there that owns the plan
 * (`POST /api/plans/jira/import`, on that machine); **Use an existing session instead** goes back
 * to picking a session.
 */
export function ImportJiraDialog({ sourceSessionId, repos, initialEpic, onImported, onClose, onUseSession }: ImportJiraDialogProps) {
  const inFolder = sourceSessionId === undefined;
  const [place, setPlace] = useState<JiraImportPlace>(() => loadLastPlace());
  const [resolved, setResolved] = useState<ResolvedPlace | null>(null);
  const [epic, setEpic] = useState(initialEpic ?? '');
  const [preview, setPreview] = useState<JiraPreview | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState(() => (inFolder ? place.baseBranch : 'dev'));
  const [sync, setSync] = useState<JiraSyncMode>('off');
  const [inProgress, setInProgress] = useState(DEFAULT_JIRA_TRANSITIONS.inProgress);
  const [inReview, setInReview] = useState(DEFAULT_JIRA_TRANSITIONS.inReview);
  // D116: on by default for a new plan.
  const [doneOnMerge, setDoneOnMerge] = useState(DEFAULT_JIRA_DONE_ON_MERGE);
  const [doneName, setDoneName] = useState(DEFAULT_JIRA_TRANSITIONS.done);
  const [error, setError] = useState<JiraApiError | null>(null);
  /** Which call {@link error} came from: a create's refusal shows by the button, a preview's above the preview. */
  const [errorFrom, setErrorFrom] = useState<'preview' | 'create'>('preview');
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  // D115: empty = the plan's agent picks each item's repositories (never pre-filled from an earlier import).
  const [pickedRepos, setPickedRepos] = useState<readonly string[]>([]);
  const [reposOpen, setReposOpen] = useState(false);
  const [repoChoices, setRepoChoices] = useState<readonly string[] | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const sessions = useSessionListOf();
  const source = inFolder ? null : (sessions.data?.find((session) => session.id === sourceSessionId) ?? null);
  // D38: a workspace session may have no solutions yet; D112: a new session in a workspace folder.
  // D115: the plan's agent then picks each item's repositories; the developer may limit them here instead (optional).
  const askRepos = inFolder
    ? resolved?.folder?.kind === 'workspace' || error?.fields['repos'] !== undefined
    : repos === undefined && ((source !== null && source.folderKind === 'workspace' && source.solutions.length === 0) || error?.fields['repos'] !== undefined);
  const sourceMachine = inFolder ? place.machine : (source?.machine?.id ?? null);
  const sourceFolder = inFolder ? (resolved?.folder?.id ?? null) : (source?.folderPath ?? null);
  const changePlace = useCallback((patch: Partial<JiraImportPlace>) => {
    setPlace((current) => ({ ...current, ...patch }));
    if (patch.repos !== undefined) setPickedRepos(patch.repos);
    setError(null);
  }, []);
  const onResolved = useCallback((next: ResolvedPlace) => setResolved(next), []);
  // D119: the sidebar folder of the plan's own subfolder (kept apart: it settles after the folder does).
  const [sidebarFolderId, setSidebarFolderId] = useState<string | null>(null);
  const onSidebar = useCallback((next: string | null) => setSidebarFolderId(next), []);

  useEffect(() => {
    if (!askRepos) return;
    let cancelled = false;
    setRepoChoices(null);
    machineApi(sourceMachine)
      .solutions(sourceFolder ?? undefined)
      .then(
        (groups) => {
          if (cancelled) return;
          const names = [...new Set(groups.flatMap((group) => group.solutions.filter((solution) => solution.rule !== 'read-only').map((solution) => solution.name)))];
          setRepoChoices(names);
          // A remembered pick keeps only what this folder still has.
          setPickedRepos((picked) => picked.filter((name) => names.includes(name)));
        },
        () => {
          if (!cancelled) setRepoChoices([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [askRepos, sourceMachine, sourceFolder]);

  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fail = (caught: unknown, from: 'preview' | 'create') => {
    setErrorFrom(from);
    setError(caught instanceof JiraApiError ? caught : new JiraApiError(0, null, caught instanceof Error ? caught.message : 'failed'));
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      const answer = inFolder ? await jiraApi.previewForFolder(place.machine, epic) : await jiraApi.preview(sourceSessionId, epic);
      setPreview(answer);
      setTitle(answer.suggestedTitle);
      setTarget(answer.suggestedTargetBranch);
    } catch (caught) {
      setPreview(null);
      fail(caught, 'preview');
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!preview) return;
    setBusy('create');
    setError(null);
    const body = {
      epic: preview.epic.key,
      title,
      targetBranch: target,
      baseBranch: base,
      sync,
      ...(repos ? { repos } : askRepos && pickedRepos.length > 0 ? { repos: pickedRepos } : {}),
      ...(sync === 'write' ? { transitions: { inProgress, inReview, done: doneName }, doneOnMerge } : {}),
    };
    try {
      if (inFolder) {
        // D112: a new session in the chosen folder owns the plan (created on that machine; removed again if the import fails).
        const folder = resolved?.folder?.id ?? place.folder;
        const answer = await jiraApi.importIntoFolder(place.machine, {
          ...body,
          ...(folder ? { folder } : {}),
          ...(resolved ? { provider: resolved.provider } : {}),
          ...(resolved?.model ? { model: resolved.model.model, effort: resolved.model.effort } : {}),
          ...(place.profileId ? { profileId: place.profileId } : {}),
          // D119: the plan's own subfolder goes into this sidebar folder (null = the root).
          sidebarFolderId,
        });
        saveLastPlace({
          ...place,
          folder: folder ?? null,
          provider: resolved?.provider ?? place.provider,
          repos: [],
          baseBranch: base.trim() === '' ? place.baseBranch : base,
          sidebarFolders: folder ? { ...place.sidebarFolders, [sidebarChoiceKey(place.machine, folder)]: sidebarFolderId } : place.sidebarFolders,
        });
        onImported(answer.plan);
        return;
      }
      const answer = await jiraApi.importPlan(sourceSessionId, body);
      onImported(answer.plan);
    } catch (caught) {
      fail(caught, 'create');
    } finally {
      setBusy(null);
    }
  };

  const notConfigured = error?.code === 'jira-not-configured';
  // Why Create plan cannot be pressed now (shown by the button, so it never looks like a dead click).
  const placeBlocked = !inFolder
    ? null
    : resolved === null || !resolved.ready
      ? 'Reading the folders…'
      : resolved.folder === null
        ? 'Pick the folder the plan runs in.'
        : resolved.folder.kind === 'plain'
          ? 'Pick a git repository or a workspace: the target branch needs one.'
          : null;
  const blocked = !preview || busy !== null ? null : target.trim() === '' ? "Give the target branch (the epic's feature branch)." : placeBlocked;
  const createError = error !== null && errorFrom === 'create' && !notConfigured ? error : null;
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
              <input ref={input} data-testid="jira-epic" data-tour="plans-jira-epic" value={epic} placeholder="PROJ-100 or https://acme.atlassian.net/browse/PROJ-100" onChange={(event) => setEpic(event.target.value)} />
            </label>
            <button type="submit" className="sb-jira-btn" data-testid="jira-preview" disabled={busy !== null || epic.trim() === ''}>
              {busy === 'preview' ? 'Reading…' : 'Preview'}
            </button>
          </form>
          {inFolder ? <WhereItRuns place={place} onChange={changePlace} onResolved={onResolved} onSidebar={onSidebar} disabled={busy !== null} /> : null}
          {inFolder && onUseSession ? (
            <button type="button" className="sb-jira-link" data-testid="jira-use-session" disabled={busy !== null} onClick={onUseSession}>
              Use an existing session instead
            </button>
          ) : null}
          {notConfigured ? (
            <div className="sb-jira-notice" data-testid="jira-not-configured">
              <p>{error.message}</p>
              {onDeviceOrigin() ? <p className="sb-jira-muted">Set it up on the computer that owns this session.</p> : <JiraCredentialsForm onChanged={(status) => status.configured && setError(null)} />}
            </div>
          ) : error && errorFrom === 'preview' ? (
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
              {preview.epic.description || preview.epic.acceptanceCriteria || (preview.epic.counts && jiraCountsText(preview.epic.counts) !== '') ? (
                <details className="sb-jira-epic" data-testid="jira-epic-context">
                  <summary data-testid="jira-epic-context-toggle">
                    Epic description{preview.epic.counts && jiraCountsText(preview.epic.counts) !== '' ? ` · ${jiraCountsText(preview.epic.counts)}` : ''}
                  </summary>
                  <p className="sb-jira-muted">The plan's agent gets the epic in full; each item's run gets it shortened, with its own ticket's comments, sub-tasks and links, read from Jira when it starts.</p>
                  {preview.epic.acceptanceCriteria ? (
                    <>
                      <h4>Acceptance criteria</h4>
                      <pre className="sb-jira-epic-text" data-testid="jira-epic-acceptance">{preview.epic.acceptanceCriteria}</pre>
                    </>
                  ) : null}
                  {preview.epic.description ? <pre className="sb-jira-epic-text" data-testid="jira-epic-description">{preview.epic.description}</pre> : <p className="sb-jira-muted">No description.</p>}
                </details>
              ) : null}
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
                        {item.counts && jiraCountsText(item.counts) !== '' ? (
                          <span className="sb-jira-chip" data-testid={`jira-counts-${item.key}`} title="What the item's run also gets from Jira when it starts">
                            {jiraCountsText(item.counts)}
                          </span>
                        ) : null}
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
                {askRepos ? (
                  <p className="sb-jira-muted" data-testid="jira-repos-agent-note">
                    {pickedRepos.length === 0 ? "The plan's agent picks each item's repositories after the import; an item starts once it has them." : 'Every item works in the repositories picked below.'}
                  </p>
                ) : null}
                {askRepos ? (
                  <details className="sb-jira-sync sb-jira-repos" data-testid="jira-repos" open={reposOpen || error?.fields['repos'] !== undefined} onToggle={(event) => setReposOpen(event.currentTarget.open)}>
                    <summary data-testid="jira-repos-toggle">Limit to repositories… (optional)</summary>
                    {repoChoices === null ? <span className="sb-jira-muted">Reading the workspace's solutions…</span> : null}
                    {repoChoices !== null && repoChoices.length === 0 ? <span className="sb-jira-muted">{inFolder ? 'No solution repositories found in this workspace.' : "No solution repositories found in the session's workspace."}</span> : null}
                    {(repoChoices ?? []).map((name) => (
                      <label key={name}>
                        <input
                          type="checkbox"
                          data-testid={`jira-repo-${name}`}
                          checked={pickedRepos.includes(name)}
                          onChange={(event) => setPickedRepos(event.target.checked ? [...pickedRepos, name] : pickedRepos.filter((picked) => picked !== name))}
                        />
                        {name}
                      </label>
                    ))}
                    {error?.fields['repos'] ? <em className="sb-jira-error">{error.fields['repos']}</em> : null}
                  </details>
                ) : null}
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
                {sync === 'write' ? (
                  <div className="sb-jira-row sb-jira-done">
                    <label className="sb-jira-check">
                      <input type="checkbox" data-testid="jira-done-on-merge" checked={doneOnMerge} onChange={(event) => setDoneOnMerge(event.target.checked)} />
                      Move to Done when merged into the feature branch
                    </label>
                    {doneOnMerge ? (
                      <label className="sb-jira-field sb-jira-grow">
                        <span>"Done" transition</span>
                        <input data-testid="jira-transition-done" value={doneName} onChange={(event) => setDoneName(event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                <p className="sb-jira-muted">
                  {inFolder ? `The plan is created as a draft, owned by a new session "Plan · ${title.trim() || preview.epic.summary}". ` : 'The plan is created as a draft. '}
                  You choose how its work is merged when you start it.
                </p>
              </section>
            </div>
          ) : null}
        </div>
        <footer className="sb-jira-foot">
          {createError ? (
            <span className="sb-jira-error sb-jira-foot-note" role="alert" data-testid="jira-create-error">
              {createError.message}
            </span>
          ) : blocked ? (
            <span className="sb-jira-muted sb-jira-foot-note" data-testid="jira-create-blocked">
              {blocked}
            </span>
          ) : null}
          <button type="button" className="sb-jira-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="sb-jira-btn sb-jira-btn-primary" data-testid="jira-create" disabled={!preview || busy !== null || blocked !== null} onClick={() => void create()}>
            {busy === 'create' ? 'Creating…' : 'Create plan'}
          </button>
        </footer>
      </div>
    </div>
  );
}
