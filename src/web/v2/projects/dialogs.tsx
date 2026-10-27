import { useEffect, useState } from 'react';
import type { SessionTodo } from '../../../core/api.ts';
import { planRunFolderDefault } from '../../../core/plan-run-folder.ts';
import type { Plan, PlanItem, PlanMergeMode } from '../../../core/plans.ts';
import type { JiraRelinkDiff, JiraSyncMode, PlanJiraState } from '../../../core/plans-jira.ts';
import { api } from '../../api/client.ts';
import { plansApi, refusalCode, refusalText } from '../../plans/api.ts';
import { jiraApi } from '../../plans/jira/api.ts';
import { Button, Checkbox, Dialog, Field, Icon, Select, Sheet, StatusBadge, TextArea, useToast } from '../components/index.ts';
import { ACCOUNT_CHOICE_WORDS, ANSWER, MODE_LABELS, PROJECT_WORDS } from '../glossary.ts';
import { type CliAccountChoice, useAccountChoices } from '../../api/account-choice.ts';
import { choiceOptions, useChooseAccount } from '../shared/AccountChoice.tsx';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { canStart, checkStepEdit, checkSubfolder, estimateLine, modeLabel, modeOptions, needsProtectedAck, protectedAckText, stepActions, stepLook, stepName } from './project-model.ts';

/**
 * D131 · lane P · the Projects dialogs: Start (approval mode, the protected-destination
 * acknowledgement, the D130 subfolder), a mode change that needs the acknowledgement, Send
 * back, Edit a pending step (D129), Delete (D117, stops running steps), Cancel, Re-read
 * dependencies from Jira (D117's diff), Jira sync (D116), and a step's details.
 */

/** The radio list of the four modes. */
function ModeRadios({ plan, mode, onChange }: { readonly plan: Plan; readonly mode: PlanMergeMode | null; readonly onChange: (mode: PlanMergeMode) => void }) {
  return (
    <div className="v2-p-pick" role="radiogroup" aria-label={PROJECT_WORDS.whoApproves}>
      {modeOptions(plan).map((option) => (
        <label key={option} className="v2-p-pick-row" data-testid="v2-mode-option" data-mode={option}>
          <input type="radio" name="v2-mode" value={option} checked={mode === option} onChange={() => onChange(option)} />
          <span className="v2-grow">{MODE_LABELS[option]}</span>
          {option === 'agents-with-holds' ? <span className="v2-muted v2-p-pick-hint">recommended</span> : null}
        </label>
      ))}
    </div>
  );
}

/** Start: who approves combining (required, none pre-selected unless only one is offered), the acknowledgement, the folder for its steps' agents. */
export function StartDialog({ plan, initialMode, onClose, onStarted }: { readonly plan: Plan; readonly initialMode: PlanMergeMode | null; readonly onClose: () => void; readonly onStarted: (plan: Plan) => void }) {
  const only = modeOptions(plan);
  const [mode, setMode] = useState<PlanMergeMode | null>(initialMode ?? (only.length === 1 ? (only[0] ?? null) : null));
  const [ack, setAck] = useState(false);
  const [refused, setRefused] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // D138: the project's account per engine (Automatic = the overall choice).
  const choices = useAccountChoices(true);
  const [accounts, setAccounts] = useState<Partial<Record<CliProviderId, string | null>>>({});
  useEffect(() => {
    let alive = true;
    api
      .sidebarLayout()
      .then((layout) => alive && setFolder((current) => current ?? planRunFolderDefault(layout, plan.sourceSessionId, plan.title)))
      .catch(() => alive && setFolder((current) => current ?? plan.title.slice(0, 60)));
    return () => {
      alive = false;
    };
  }, [plan.sourceSessionId, plan.title]);
  const check = canStart(plan, mode, ack, refused);
  const folderError = checkSubfolder(folder ?? '');
  const start = async (): Promise<void> => {
    if (!mode || !check.ok || folderError) return;
    setBusy(true);
    setError(null);
    try {
      const started = await plansApi.start(plan.id, mode, { ...(needsProtectedAck(plan, mode, refused) ? { allowProtectedTarget: ack } : {}), sidebarFolder: (folder ?? '').trim(), ...(Object.keys(accounts).length > 0 ? { accounts } : {}) });
      onStarted(started);
    } catch (e) {
      if (refusalCode(e) === 'target-forbidden') setRefused(true);
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Start “${plan.title}”`}
      icon="play"
      testId="v2-start-dialog"
      footer={
        <>
          <span className="v2-grow v2-muted v2-p-dialog-why">{check.ok ? '' : check.why}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="play" disabled={!check.ok || busy || folder === null || folderError !== null} onClick={() => void start()} data-testid="v2-start-go">
            {PROJECT_WORDS.start}
          </Button>
        </>
      }
    >
      <p className="v2-muted v2-p-dialog-p">{PROJECT_WORDS.whoApproves}: you have to choose — there is no default. You can change it while it runs.</p>
      <ModeRadios plan={plan} mode={mode} onChange={setMode} />
      {needsProtectedAck(plan, mode, refused) ? <Checkbox label={protectedAckText(plan)} checked={ack} onChange={(event) => setAck(event.currentTarget.checked)} data-testid="v2-start-ack" /> : null}
      <Field
        label={PROJECT_WORDS.sidebarSubfolder}
        value={folder ?? ''}
        maxLength={80}
        placeholder="None: its steps go next to the project’s agent"
        onChange={(event) => setFolder(event.currentTarget.value)}
        hint={PROJECT_WORDS.sidebarSubfolderHint}
        error={folderError}
        data-testid="v2-start-folder"
      />
      <ProjectAccountSelects plan={plan} rows={choices.rows} value={accounts} onChange={(cli, id) => setAccounts((current) => ({ ...current, [cli]: id }))} testId="v2-start-account" />
      {error ? (
        <p className="v2-field-error" role="alert" data-testid="v2-start-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** D138: one select per engine with several accounts: the project's account (Automatic = the overall choice). */
function ProjectAccountSelects({ plan, rows, value, onChange, disabled, testId }: { readonly plan: Plan; readonly rows: readonly CliAccountChoice[]; readonly value: Partial<Record<CliProviderId, string | null>>; readonly onChange: (cli: CliProviderId, id: string | null) => void; readonly disabled?: boolean; readonly testId: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="v2-p-accounts">
      {rows.map((row) => {
        const current = value[row.cli] !== undefined ? value[row.cli] : (plan.accounts?.[row.cli] ?? null);
        return (
          <Select
            key={row.cli}
            label={rows.length > 1 ? ACCOUNT_CHOICE_WORDS.picker(row.label) : ACCOUNT_CHOICE_WORDS.projectAccount}
            value={current ?? ''}
            disabled={disabled}
            options={choiceOptions(row, ACCOUNT_CHOICE_WORDS.projectAuto)}
            onChange={(event) => onChange(row.cli, event.target.value === '' ? null : event.target.value)}
            data-testid={testId}
            data-cli={row.cli}
          />
        );
      })}
      <p className="v2-muted v2-p-dialog-p" style={{ fontSize: 13 }}>
        {ACCOUNT_CHOICE_WORDS.projectAccountHint}
      </p>
    </div>
  );
}

/** D138: the project's ⋯ → Account…: its account per engine; a change moves its agents now (confirmed first). */
export function ProjectAccountDialog({ plan, onClose, onChanged }: { readonly plan: Plan; readonly onClose: () => void; readonly onChanged: (plan: Plan) => void }) {
  const choices = useAccountChoices(true);
  const chooser = useChooseAccount();
  return (
    <>
      <Dialog open onClose={onClose} title={ACCOUNT_CHOICE_WORDS.projectAccountTitle(plan.title)} icon="wallet" testId="v2-project-account-dialog" footer={<Button onClick={onClose}>Done</Button>}>
        {choices.rows.length === 0 ? <p className="v2-muted">Add a second account in Settings › Usage & accounts to choose one here.</p> : null}
        <ProjectAccountSelects plan={plan} rows={choices.rows} value={{}} disabled={chooser.busy} onChange={(cli, id) => void chooser.chooseForProject(plan, cli, id, onChanged)} testId="v2-project-account" />
      </Dialog>
      {chooser.dialog}
    </>
  );
}

/** A mode change on a running project that needs the acknowledgement first. */
export function ModeAckDialog({ plan, mode, onClose, onChanged }: { readonly plan: Plan; readonly mode: PlanMergeMode; readonly onClose: () => void; readonly onChanged: (plan: Plan) => void }) {
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async (): Promise<void> => {
    try {
      onChanged(await plansApi.setMode(plan.id, mode, { allowProtectedTarget: true }));
    } catch (e) {
      setError(refusalText(e));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={modeLabel(mode)}
      icon="alert"
      testId="v2-mode-ack"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ack} onClick={() => void apply()} data-testid="v2-mode-ack-apply">
            Apply
          </Button>
        </>
      }
    >
      <p className="v2-p-dialog-p">
        Agents will combine their own steps into <span className="v2-mono">{plan.targetBranch}</span>, a protected branch.
      </p>
      <Checkbox label={protectedAckText(plan)} checked={ack} onChange={(event) => setAck(event.currentTarget.checked)} data-testid="v2-mode-ack-check" />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Send back a step ready for approval, with a note for its agent. */
export function SendBackDialog({ item, onClose, onSend }: { readonly item: PlanItem; readonly onClose: () => void; readonly onSend: (comment: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = text.trim().length > 0 && text.length <= 4000;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Send back ${stepName(item)}`}
      icon="send-back"
      testId="v2-sendback-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="send-back"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              if (await onSend(text.trim())) onClose();
              setBusy(false);
            }}
            data-testid="v2-sendback-go"
          >
            {PROJECT_WORDS.sendBack}
          </Button>
        </>
      }
    >
      <TextArea label={ANSWER.sendBackPlaceholder} value={text} rows={4} maxLength={4000} onChange={(event) => setText(event.currentTarget.value)} autoFocus data-testid="v2-sendback-text" hint="Its agent gets this note and works on the step again." />
    </Dialog>
  );
}

/** D129: edit the title and estimate of a step that hasn't started. */
export function EditStepDialog({ item, onClose, onSave }: { readonly item: PlanItem; readonly onClose: () => void; readonly onSave: (title: string, estimate: number | null) => Promise<string | null> }) {
  const [title, setTitle] = useState(item.title);
  const [estimate, setEstimate] = useState(item.estimateMinutes === null ? '' : String(item.estimateMinutes));
  const [error, setError] = useState<string | null>(null);
  const problem = checkStepEdit(title, estimate);
  const save = async (): Promise<void> => {
    if (problem) return;
    const answer = await onSave(title.trim(), estimate.trim() === '' ? null : Number(estimate));
    if (answer) setError(answer);
    else onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit step"
      icon="edit"
      testId="v2-edit-step"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={problem !== null} onClick={() => void save()} data-testid="v2-edit-step-save">
            Save
          </Button>
        </>
      }
    >
      <Field label="Title" value={title} maxLength={120} onChange={(event) => setTitle(event.currentTarget.value)} error={problem?.field === 'title' ? problem.message : null} data-testid="v2-edit-step-title" />
      <Field label="Estimate (minutes)" inputMode="numeric" value={estimate} onChange={(event) => setEstimate(event.currentTarget.value)} error={problem?.field === 'estimate' ? problem.message : null} data-testid="v2-edit-step-estimate" />
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Delete a project (D117: a running or paused one is cancelled first and its running steps stop). */
export function DeleteProjectDialog({ plan, onClose, onDeleted }: { readonly plan: Plan; readonly onClose: () => void; readonly onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = plan.items.filter((item) => item.state === 'running').length;
  const live = plan.state === 'running' || plan.state === 'paused';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete “${plan.title}”?`}
      icon="trash"
      testId="v2-delete-project"
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon="trash"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await plansApi.removeStopping(plan.id);
                onDeleted();
              } catch (e) {
                setError(refusalText(e));
                setBusy(false);
              }
            }}
            data-testid="v2-delete-project-go"
          >
            Delete project
          </Button>
        </>
      }
    >
      <p className="v2-p-dialog-p">Its steps’ tasks and agents stay; only the project goes. Nothing already combined is undone, and Jira tickets are left as they are.</p>
      {live ? (
        <p className="v2-p-dialog-p" data-testid="v2-delete-project-note">
          It is {plan.state === 'paused' ? 'on hold' : 'running'}: it is cancelled first{working > 0 ? ` and its ${working} running step${working === 1 ? '' : 's'} stop (their agents stay in Agents)` : ''}; then it is deleted.
        </p>
      ) : null}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Cancel a project: nothing new starts; running steps keep their agents. */
export function CancelProjectDialog({ plan, onClose, onCancelled }: { readonly plan: Plan; readonly onClose: () => void; readonly onCancelled: (plan: Plan) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancel “${plan.title}”?`}
      icon="stop"
      testId="v2-cancel-project"
      footer={
        <>
          <Button onClick={onClose} autoFocus>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              try {
                onCancelled(await plansApi.cancel(plan.id));
              } catch (e) {
                setError(refusalText(e));
              }
            }}
            data-testid="v2-cancel-project-go"
          >
            Cancel project
          </Button>
        </>
      }
    >
      <p className="v2-p-dialog-p">No new step starts. Steps already running keep their agents, which you can stop in Agents. A cancelled project can’t be started again.</p>
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** D117: Re-read dependencies from Jira: the change first (removed, added, kept, left out), then Apply. */
export function RereadDialog({ plan, onClose, onApplied }: { readonly plan: Plan; readonly onClose: () => void; readonly onApplied: () => void }) {
  const [diff, setDiff] = useState<JiraRelinkDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    jiraApi
      .rereadDependencies(plan.id)
      .then((answer) => alive && setDiff(answer))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [plan.id]);
  const changes = diff ? diff.removed.length + diff.added.length : 0;
  const apply = async (): Promise<void> => {
    if (!diff) return;
    setBusy(true);
    try {
      await jiraApi.rereadDependencies(plan.id, { apply: true, fingerprint: diff.fingerprint });
      toast({ text: `Dependencies updated from Jira: ${diff.removed.length} removed, ${diff.added.length} added.` });
      onApplied();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'changed') {
        setDiff(await jiraApi.rereadDependencies(plan.id).catch(() => null));
        setError('Jira or the project changed meanwhile. Here is the new change.');
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const list = (title: string, testId: string, rows: readonly { readonly text: string }[], tone: 'a' | 'd' | 'k') =>
    rows.length > 0 ? (
      <div className="v2-p-diff-block" data-testid={testId}>
        <div className="v2-p-diff-h">{title}</div>
        <ul>
          {rows.map((row) => (
            <li key={row.text} data-line={tone}>
              {tone === 'a' ? '+ ' : tone === 'd' ? '− ' : '· '}
              {row.text}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Re-read dependencies from Jira"
      icon="jira"
      width={680}
      testId="v2-reread-dialog"
      footer={
        <>
          <Button onClick={onClose} data-testid="v2-reread-cancel">
            {changes > 0 ? 'Cancel' : 'Close'}
          </Button>
          {changes > 0 ? (
            <Button variant="primary" disabled={busy} onClick={() => void apply()} data-testid="v2-reread-apply">
              Apply {changes} change{changes === 1 ? '' : 's'}
            </Button>
          ) : null}
        </>
      }
    >
      {!diff && !error ? <p className="v2-muted">Reading the epic’s links from Jira…</p> : null}
      {diff ? (
        changes === 0 ? (
          <p className="v2-p-dialog-p" data-testid="v2-reread-none">
            Jira and the project agree: nothing to change.
          </p>
        ) : (
          <>
            <p className="v2-p-dialog-p">Jira says the order differs. Apply these changes?</p>
            <div className="v2-p-diff">
              {list('Removed (the wrong way round)', 'v2-reread-removed', diff.removed, 'd')}
              {list('Added from Jira', 'v2-reread-added', diff.added, 'a')}
              {list('Kept (yours)', 'v2-reread-kept', diff.kept, 'k')}
              {list('Left out (would be a loop)', 'v2-reread-cycles', diff.cycles, 'k')}
            </div>
            <p className="v2-muted v2-p-dialog-p">Running steps keep running. Nothing is combined.</p>
          </>
        )
      ) : null}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

const SYNC_LABELS: Readonly<Record<JiraSyncMode, string>> = { off: 'Off · Jira is ignored', 'read-only': 'Read · read tickets, never change them', write: 'Update tickets · status and comments' };

/** D116: the project's Jira sync (Off / Read / Update tickets, and "Move to Done when combined"). */
export function JiraSyncDialog({ plan, state, onClose, onSaved }: { readonly plan: Plan; readonly state: PlanJiraState; readonly onClose: () => void; readonly onSaved: (state: PlanJiraState) => void }) {
  const [sync, setSync] = useState<JiraSyncMode>(state.sync);
  const [done, setDone] = useState(state.doneOnMerge);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Jira sync"
      icon="jira"
      testId="v2-jira-sync"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                onSaved(await jiraApi.update(plan.id, { sync, ...(sync === 'write' ? { doneOnMerge: done } : {}) }));
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
            data-testid="v2-jira-sync-save"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="v2-p-pick" role="radiogroup" aria-label="Jira sync">
        {(['off', 'read-only', 'write'] as const).map((mode) => (
          <label key={mode} className="v2-p-pick-row" data-testid="v2-jira-sync-option" data-sync={mode}>
            <input type="radio" name="v2-jira-sync" checked={sync === mode} onChange={() => setSync(mode)} />
            <span className="v2-grow">{SYNC_LABELS[mode]}</span>
          </label>
        ))}
      </div>
      {sync === 'write' ? <Checkbox label="Move tickets to Done when their work is combined" checked={done} onChange={(event) => setDone(event.currentTarget.checked)} data-testid="v2-jira-sync-done" /> : null}
      {error ? (
        <p className="v2-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** A step's details (the eye button; a click on a step without an agent): its state, what it waits on, its task's text, its change request. */
export function StepDetailSheet({
  plan,
  item,
  todo,
  onClose,
  onOpenAgent,
  onAction,
}: {
  readonly plan: Plan;
  readonly item: PlanItem;
  readonly todo: SessionTodo | null;
  readonly onClose: () => void;
  readonly onOpenAgent: () => void;
  /** D139: Try again / Restart from the details (a failed or stopped step's click opens them). */
  readonly onAction?: (action: 'retry' | 'restart') => void;
}) {
  const look = stepLook(item, plan.items);
  const estimate = estimateLine(item);
  // D139: what a failed (Try again) or a stopped step (Restart) offers first.
  const fix = onAction ? stepActions(plan, item).filter((action) => (action.id === 'retry' || action.id === 'restart') && !action.disabledReason) : [];
  return (
    <Sheet open onClose={onClose} title={stepName(item)} testId="v2-step-sheet">
      <div className="v2-p-step-detail" data-kind={look.kind}>
        <StatusBadge status={look.status} label={look.label} />
        {look.detail ? (
          <p className={`v2-p-step-detail-why${look.kind === 'stopped' || look.kind === 'blocked' ? ' is-red' : look.kind === 'needs' ? ' is-amber' : ''}`} data-testid="v2-step-sheet-detail">
            {look.kind === 'stopped' ? `Stopped: ${look.detail}` : look.kind === 'needs' ? `Needs you: ${look.detail}` : look.detail}
          </p>
        ) : null}
        {item.note ? <p className="v2-muted">{item.note}</p> : null}
        <dl className="v2-p-kv">
          {estimate ? (
            <>
              <dt>Time</dt>
              <dd>{estimate}</dd>
            </>
          ) : null}
          <dt>Code projects</dt>
          <dd>{item.solutions.length > 0 ? item.solutions.join(', ') : plan.reposPerItem ? 'not picked yet' : plan.repos.join(', ') || 'all'}</dd>
          {item.branch ? (
            <>
              <dt>Separate copy</dt>
              <dd className="v2-mono">{item.branch}</dd>
            </>
          ) : null}
          {item.prUrl ? (
            <>
              <dt>Change request</dt>
              <dd>
                <a href={item.prUrl} target="_blank" rel="noreferrer">
                  {item.prUrl.replace(/^https?:\/\//, '')}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        {fix.length > 0 ? (
          <div className="v2-row v2-p-wrap" style={{ gap: 8 }}>
            {fix.map((action) => (
              <Button key={action.id} variant="primary" icon="refresh" onClick={() => onAction?.(action.id as 'retry' | 'restart')} data-testid={`v2-step-sheet-${action.id}`}>
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
        {item.runSessionId ? (
          <Button variant={fix.length === 0 && (look.kind === 'stopped' || look.kind === 'needs') ? 'primary' : 'default'} icon="chat" onClick={onOpenAgent} data-testid="v2-step-sheet-open">
            {ANSWER.openChat}
          </Button>
        ) : null}
        {todo?.description ? (
          <details className="v2-p-fromjira" open={plan.external !== null}>
            <summary>
              <Icon name={plan.external ? 'jira' : 'task'} size="s" />
              {plan.external ? PROJECT_WORDS.fromJira : 'Task'}
            </summary>
            <pre className="v2-p-pre">{todo.description}</pre>
          </details>
        ) : null}
      </div>
    </Sheet>
  );
}
