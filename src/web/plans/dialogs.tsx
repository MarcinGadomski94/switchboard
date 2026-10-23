import { isChat } from '../../core/chats.ts';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { SessionTodo } from '../../core/api.ts';
import { DEFAULT_PLAN_BASE, type Plan, type PlanMergeMode } from '../../core/plans.ts';
import { displayTitle } from '../../core/session-title.ts';
import { openSessions } from '../../core/session-close.ts';
import { api } from '../api/client.ts';
import { useSessionListOf } from '../api/session-list.ts';
import { plansApi, refusalCode, refusalText } from './api.ts';
import { planRunFolderDefault } from '../../core/plan-run-folder.ts';
import { SIDEBAR_FOLDER_NAME_MAX } from '../../core/sidebar-layout.ts';
import { useSidebarLayout } from '../shell/SidebarSessions.tsx';
import { alwaysOnNote, isProtectedTargetName, mergeModeOptions, shortLabel } from './model.ts';

/**
 * D99 · the Plans page's dialogs (`docs/plans-ui.md`): the merge-mode dialog (Start and "Change
 * the merge mode"), ＋ New plan, Add items from todos and the limits.
 */

/** A dialog frame: a dimmed page, the card in the middle (a full-screen sheet on phones); Escape or a click outside closes it. */
export function PlanDialog({ label, testId, wide = false, onClose, children }: { readonly label: string; readonly testId: string; readonly wide?: boolean; readonly onClose: () => void; readonly children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sb-plan-overlay" onClick={onClose}>
      <div className={`sb-plan-dialog${wide ? ' sb-plan-dialog--wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} onClick={(event) => event.stopPropagation()}>
        <div className="sb-plan-dialog__title">{label}</div>
        {children}
      </div>
    </div>
  );
}

// ── merge mode ────────────────────────────────────────────────────────────

/**
 * "How should finished tickets be merged into the epic branch?": four options (D99 follow-up
 * 2026-10-15: the fourth, "No merging"), no default (Start stays disabled until one is picked);
 * "Agents merge, with hold points" carries the recommended tag and a hold checkbox per open item
 * (pre-ticked as the core marks them), as does "No merging" (the items you confirm). A plan without
 * a target branch offers only "No merging". An agent mode on a protected target (`dev`, `main`, …;
 * the server also knows the default and protected branches and refuses with `target-forbidden`)
 * shows the warning checkbox "Agents will merge straight into `dev`", which must be ticked. The
 * same dialog changes the mode of a started plan (Apply).
 */
export function MergeModeDialog({ plan, purpose, onDone, onClose }: { readonly plan: Plan; readonly purpose: 'start' | 'change'; readonly onDone: (plan: Plan) => void; readonly onClose: () => void }) {
  const options = mergeModeOptions(plan);
  const [mode, setMode] = useState<PlanMergeMode | null>(purpose === 'change' ? plan.mergeMode : options.length === 1 ? (options[0]?.mode ?? null) : null);
  const [holds, setHolds] = useState<Readonly<Record<string, boolean>>>(() => Object.fromEntries(plan.items.map((item) => [item.id, item.hold])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(plan.allowProtectedTarget);
  // The server knows protected / default branches the page cannot: its refusal shows the checkbox too.
  const [refusedTarget, setRefusedTarget] = useState(false);
  // D130: the runs' sidebar subfolder (Start only), prefilled with the plan's title (or the source's D119 "Plan · …" folder); empty = none.
  const { layout } = useSidebarLayout();
  const suggestedFolder = useMemo(() => planRunFolderDefault(layout, plan.sourceSessionId, plan.title), [layout, plan.sourceSessionId, plan.title]);
  const [folderName, setFolderName] = useState<string | null>(null);
  const sidebarFolder = folderName ?? suggestedFolder;
  const open = plan.items.filter((item) => item.state !== 'done');
  const agents = mode === 'agents' || mode === 'agents-with-holds';
  const needsAck = agents && (isProtectedTargetName(plan.targetBranch) || refusedTarget);
  const confirm = async (): Promise<void> => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      const changed = Object.fromEntries(Object.entries(holds).filter(([id, hold]) => plan.items.find((item) => item.id === id)?.hold !== hold && plan.items.find((item) => item.id === id)?.state !== 'done'));
      if ((mode === 'agents-with-holds' || mode === 'none') && Object.keys(changed).length > 0) await plansApi.setHolds(plan.id, changed);
      const extra = { ...(needsAck && ack ? { allowProtectedTarget: true } : {}), ...(purpose === 'start' ? { sidebarFolder: sidebarFolder.trim() } : {}) };
      const answer = purpose === 'start' ? await plansApi.start(plan.id, mode, extra) : await plansApi.setMode(plan.id, mode, extra);
      onDone(answer);
    } catch (caught) {
      if (refusalCode(caught) === 'target-forbidden') setRefusedTarget(true);
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlanDialog label={purpose === 'start' ? 'Start the plan' : 'Change the merge mode'} testId="plan-mode-dialog" onClose={onClose}>
      <div className="sb-plan-dialog__question">{plan.targetBranch === null ? 'This plan has no target branch: nothing is merged.' : 'How should finished tickets be merged into the epic branch?'}</div>
      <div className="sb-plan-muted">{plan.targetBranch === null ? 'An item is done when its agent marks it done.' : 'You have to choose — there is no default. You can change it while the plan runs.'}</div>
      <div className="sb-plan-choices" role="radiogroup" aria-label="Merge mode">
        {options.map((option) => (
          <div key={option.mode} className="sb-plan-choice" data-selected={mode === option.mode || undefined}>
            <label className="sb-plan-choice__head">
              <input type="radio" name="plan-merge-mode" data-testid="plan-mode-option" data-mode={option.mode} checked={mode === option.mode} onChange={() => setMode(option.mode)} />
              <span className="sb-plan-choice__title">{option.title}</span>
              {option.recommended ? <span className="sb-plan-tag">recommended</span> : null}
            </label>
            <div className="sb-plan-choice__text">{option.text}</div>
            {(option.mode === 'agents-with-holds' && mode === 'agents-with-holds') || (option.mode === 'none' && mode === 'none') ? (
              <div className="sb-plan-holds" data-testid="plan-mode-holds">
                {open.length === 0 ? <span className="sb-plan-muted">Every ticket is merged.</span> : null}
                {open.map((item) => (
                  <label key={item.id} className="sb-plan-hold">
                    <input type="checkbox" data-testid="plan-mode-hold" data-item-id={item.id} checked={holds[item.id] === true} onChange={(event) => setHolds({ ...holds, [item.id]: event.target.checked })} />
                    <span className="sb-plan-hold__key">{shortLabel(item, plan.items)}</span> <span className="sb-plan-hold__title">{item.title}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {needsAck ? (
        <label className="sb-plan-ack" data-testid="plan-mode-ack">
          <input type="checkbox" data-testid="plan-mode-ack-check" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          <span>
            ⚠ Agents will merge straight into <code>{plan.targetBranch}</code>
          </span>
        </label>
      ) : null}
      {purpose === 'start' ? (
        <label className="sb-plan-field" data-testid="plan-start-folder">
          <span>Sidebar subfolder</span>
          <input
            type="text"
            className="sb-plan-input"
            data-testid="plan-start-folder-input"
            maxLength={SIDEBAR_FOLDER_NAME_MAX}
            value={sidebarFolder}
            placeholder="None: runs go next to the plan's session"
            onChange={(event) => setFolderName(event.target.value)}
          />
          <span className="sb-plan-muted">The plan's sessions go into this folder, inside the plan's session's folder (an existing one with this name is reused). Clear it to keep them next to the session.</span>
        </label>
      ) : null}
      <div className="sb-plan-note" data-testid="plan-mode-note">
        {alwaysOnNote(plan, mode)}
      </div>
      {error ? (
        <div className="sb-plan-error" data-testid="plan-mode-error">
          {error}
        </div>
      ) : null}
      <div className="sb-plan-dialog__actions">
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-mode-confirm" disabled={busy || mode === null || (needsAck && !ack)} onClick={() => void confirm()}>
          {purpose === 'start' ? '▶ Start plan' : 'Apply'}
        </button>
      </div>
    </PlanDialog>
  );
}

// ── todos ─────────────────────────────────────────────────────────────────

/** A session's todos that may be planned (not done; not in the plan yet). */
function plannable(todos: readonly SessionTodo[], taken: ReadonlySet<string>): SessionTodo[] {
  return todos.filter((todo) => todo.state !== 'done' && !taken.has(todo.id));
}

/** The todo checkboxes of a session (the New-plan dialog and Add items). */
function TodoPicker({ sessionId, taken, picked, onPick }: { readonly sessionId: string; readonly taken: ReadonlySet<string>; readonly picked: ReadonlySet<string>; readonly onPick: (next: ReadonlySet<string>) => void }) {
  const [todos, setTodos] = useState<readonly SessionTodo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTodos(null);
    if (sessionId === '') return;
    api.sessionTodos(sessionId).then(
      (list) => {
        if (!cancelled) setTodos(list.todos);
      },
      () => {
        if (!cancelled) setTodos([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const list = plannable(todos ?? [], taken);
  if (todos === null) return <div className="sb-plan-muted">Reading the todos…</div>;
  if (list.length === 0) return <div className="sb-plan-muted" data-testid="plan-todos-empty">No open todos in this session.</div>;
  return (
    <div className="sb-plan-todos" data-testid="plan-todo-picker">
      {list.map((todo) => (
        <label key={todo.id} className="sb-plan-todo">
          <input
            type="checkbox"
            data-testid="plan-todo"
            data-todo-id={todo.id}
            checked={picked.has(todo.id)}
            onChange={(event) => {
              const next = new Set(picked);
              if (event.target.checked) next.add(todo.id);
              else next.delete(todo.id);
              onPick(next);
            }}
          />
          <span className="sb-plan-todo__title">{todo.title}</span>
          <span className="sb-plan-todo__meta">{todo.estimateMinutes ? `~${todo.estimateMinutes}m` : ''}</span>
        </label>
      ))}
    </div>
  );
}

/** ＋ New plan: the session whose todos it runs, a title, the target branch, the base, the items from its todos. */
export function NewPlanDialog({ initialSessionId, onCreated, onClose }: { readonly initialSessionId: string | null; readonly onCreated: (plan: Plan) => void; readonly onClose: () => void }) {
  const sessions = useSessionListOf();
  // D106: chats are no plan sources.
  // D99 follow-up 2026-10-15: a plan without a target branch may run in a plain folder too.
  const choices = useMemo(() => openSessions(sessions.data ?? []).filter((session) => session.machine == null && !isChat(session)), [sessions.data]);
  const [sessionId, setSessionId] = useState(initialSessionId ?? '');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState(DEFAULT_PLAN_BASE);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (sessionId === '' && choices[0]) setSessionId(choices[0].id);
  }, [choices, sessionId]);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let plan = await plansApi.create({ sourceSessionId: sessionId, title: title.trim(), targetBranch: target.trim() === '' ? null : target.trim(), baseBranch: base.trim() || DEFAULT_PLAN_BASE });
      for (const todoId of picked) plan = (await plansApi.addItem(plan.id, { todoId })).plan;
      onCreated(plan);
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlanDialog label="New plan" testId="plan-new-dialog" wide onClose={onClose}>
      <label className="sb-plan-field">
        <span>Session (its todos are the items)</span>
        <select className="sb-plan-input" data-testid="plan-new-session" value={sessionId} onChange={(event) => {
          setSessionId(event.target.value);
          setPicked(new Set());
        }}>
          {choices.map((session) => (
            <option key={session.id} value={session.id}>
              {displayTitle(session)}
            </option>
          ))}
        </select>
      </label>
      <label className="sb-plan-field">
        <span>Title</span>
        <input className="sb-plan-input" data-testid="plan-new-title" value={title} placeholder="PROJ-100 Acme checkout" onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="sb-plan-field-row">
        <label className="sb-plan-field">
          <span>Target branch (optional)</span>
          <input className="sb-plan-input sb-plan-input--mono" data-testid="plan-new-target" value={target} placeholder="feature/PROJ-100-acme-epic" onChange={(event) => setTarget(event.target.value)} />
          {target.trim() === '' ? (
            <span className="sb-plan-muted" data-testid="plan-new-no-target">
              No target — items finish when marked done
            </span>
          ) : null}
        </label>
        <label className="sb-plan-field">
          <span>Base (you merge into it at the end)</span>
          <input className="sb-plan-input sb-plan-input--mono" data-testid="plan-new-base" value={base} onChange={(event) => setBase(event.target.value)} />
        </label>
      </div>
      <div className="sb-plan-field">
        <span>Items from todos</span>
        <TodoPicker sessionId={sessionId} taken={new Set()} picked={picked} onPick={setPicked} />
      </div>
      {error ? (
        <div className="sb-plan-error" data-testid="plan-new-error">
          {error}
        </div>
      ) : null}
      <div className="sb-plan-dialog__actions">
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-new-create" disabled={busy || sessionId === '' || title.trim() === ''} onClick={() => void create()}>
          Create plan
        </button>
      </div>
    </PlanDialog>
  );
}

/** Add items from todos: the source session's open todos not in the plan yet. */
export function AddItemsDialog({ plan, onDone, onClose }: { readonly plan: Plan; readonly onDone: (plan: Plan) => void; readonly onClose: () => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useMemo(() => new Set(plan.items.map((item) => item.todoId)), [plan.items]);
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let answer = plan;
      for (const todoId of picked) answer = (await plansApi.addItem(plan.id, { todoId })).plan;
      onDone(answer);
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlanDialog label="Add items from todos" testId="plan-add-dialog" onClose={onClose}>
      <TodoPicker sessionId={plan.sourceSessionId} taken={taken} picked={picked} onPick={setPicked} />
      {error ? <div className="sb-plan-error">{error}</div> : null}
      <div className="sb-plan-dialog__actions">
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-add-confirm" disabled={busy || picked.size === 0} onClick={() => void add()}>
          Add {picked.size > 0 ? picked.size : ''}
        </button>
      </div>
    </PlanDialog>
  );
}

/** The limits: at most N at once, and the usage threshold (%). */
export function LimitsDialog({ plan, onDone, onClose }: { readonly plan: Plan; readonly onDone: (plan: Plan) => void; readonly onClose: () => void }) {
  const [concurrency, setConcurrency] = useState(String(plan.maxConcurrency));
  const [threshold, setThreshold] = useState(String(plan.usageThreshold));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onDone(await plansApi.update(plan.id, { maxConcurrency: Number(concurrency), usageThreshold: Number(threshold) }));
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PlanDialog label="Limits" testId="plan-limits-dialog" onClose={onClose}>
      <div className="sb-plan-field-row">
        <label className="sb-plan-field">
          <span>At most this many at once</span>
          <input className="sb-plan-input" type="number" min={1} max={16} data-testid="plan-limits-concurrency" value={concurrency} onChange={(event) => setConcurrency(event.target.value)} />
        </label>
        <label className="sb-plan-field">
          <span>No new start at or above (% of an account's limit)</span>
          <input className="sb-plan-input" type="number" min={1} max={100} data-testid="plan-limits-threshold" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
        </label>
      </div>
      {error ? <div className="sb-plan-error">{error}</div> : null}
      <div className="sb-plan-dialog__actions">
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-limits-save" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </PlanDialog>
  );
}

/**
 * Import from Jira… on the Plans list, **Use an existing session instead** (D112): the session whose todo list the plan
 * will run, then the Jira lane's dialog. **Pick a folder instead** goes back to the import into a new session.
 */
export function JiraSourceDialog({ onPick, onClose, onUseFolder }: { readonly onPick: (sessionId: string) => void; readonly onClose: () => void; readonly onUseFolder?: () => void }) {
  const sessions = useSessionListOf();
  const choices = useMemo(() => openSessions(sessions.data ?? []).filter((session) => session.folderKind !== 'plain' && !isChat(session)), [sessions.data]);
  const [sessionId, setSessionId] = useState('');
  useEffect(() => {
    if (sessionId === '' && choices[0]) setSessionId(choices[0].id);
  }, [choices, sessionId]);
  return (
    <PlanDialog label="Import from Jira" testId="plan-jira-source-dialog" onClose={onClose}>
      <label className="sb-plan-field">
        <span>Session (the epic's tickets become its todos)</span>
        <select className="sb-plan-input" data-testid="plan-jira-source-session" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
          {choices.map((session) => (
            <option key={session.id} value={session.id}>
              {displayTitle(session)}
            </option>
          ))}
        </select>
      </label>
      {choices.length === 0 ? <div className="sb-plan-muted">Start a session in the epic's repository first.</div> : null}
      <div className="sb-plan-dialog__actions">
        {onUseFolder ? (
          <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" data-testid="plan-jira-source-folder" onClick={onUseFolder}>
            Pick a folder instead
          </button>
        ) : null}
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-jira-source-continue" disabled={sessionId === ''} onClick={() => onPick(sessionId)}>
          Continue
        </button>
      </div>
    </PlanDialog>
  );
}
