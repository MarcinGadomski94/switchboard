import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { SessionTodo, TodoFieldsInput, TodoPriority } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import {
  DEFAULT_TODO_PRIORITY,
  TODO_DESCRIPTION_MAX,
  TODO_NO_PLAN,
  TODO_PLAN_MAX,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABELS,
  TODO_TITLE_MAX,
  isTodoPriority,
  parseTodoEstimate,
  todoEstimateInput,
} from '../../../core/todos.ts';
import { ChatMarkdown } from '../../views/session/ChatMarkdown.tsx';
import { Button, Chip, Dialog, Field, Icon, MenuButton, type MenuItem, Select, TextArea } from '../components/index.ts';
import { TASKS_WORDS as W } from '../glossary.ts';
import { V2Link } from '../nav.tsx';
import { type TodoPlanLink, todoCardModel } from './todo-card-model.ts';
import './todo-card.css';

/** What a card does (the caller owns the API calls); `null` = not offered here. */
export interface TodoCardHandlers {
  /** ▶ Start: sends the task to its own agent (this chat) and marks it in progress (D75). */
  readonly start: (() => void) | null;
  /** ▸ Run in its own agent (D76): a new agent works on it. */
  readonly run: (() => void) | null;
  /** The check box: done ↔ open. */
  readonly check: () => void;
  /** Edit's Save: every field (D70); answers whether it worked (the dialog stays open when not). */
  readonly save: (fields: TodoFieldsInput) => Promise<boolean>;
  /** Mark in progress / Mark not started (nothing is sent). */
  readonly progress: ((state: 'open' | 'in_progress') => void) | null;
  /** Delete (the caller offers Undo). */
  readonly remove: () => void;
}

/** Props of {@link TodoCard}. */
export interface TodoCardProps {
  readonly todo: SessionTodo;
  /** The status of the agent working on it (Review once it stopped); `null` = unknown. */
  readonly workerStatus: SessionStatus | null;
  readonly now: number;
  /**
   * `strip`: a fixed-width card in the agent view's horizontal strip; `list`: full width (the side
   * panel, a phone); `board`: the Tasks page's column.
   */
  readonly layout: 'strip' | 'list' | 'board';
  readonly handlers: TodoCardHandlers;
  /** Why nothing can change (an unreachable computer), `null` when it can. */
  readonly blocked: string | null;
  /** A write is on its way (its buttons wait). */
  readonly busy?: boolean;
  /** Its agent is working now: an in-progress card's edge pulses (D75). */
  readonly working?: boolean;
  /** D99: the project step it is. */
  readonly planLink?: TodoPlanLink | null;
  /** D76: the name of its own agent (a run), when it has one. */
  readonly runTitle?: string | null;
  /** The Tasks page: the agent it belongs to (a link) under the meta line. */
  readonly owner?: ReactNode;
  /** Entries the page adds to ⋯ (the Tasks page: Details, Move to). */
  readonly extraMenu?: readonly MenuItem[];
  /** ▶ Start's tooltip (the Tasks page names the agent). */
  readonly startTitle?: string;
  /** The root's test id (`v2-todo-card`; the Tasks page keeps `v2-tasks-card`). */
  readonly testId?: string;
}

/**
 * Fix after 2.0 · ONE task card for v2, in classic's todo-card format (D68–D78, D99) with v2's
 * tokens: a check box (done / reopen), the title (a click opens the description and the handover
 * plan in place), the status as icon + word + colour (Open, In progress, Review, Done), the
 * priority, the estimate vs actual (and the tokens once done), the plan mark, ▶ Start (in this
 * agent) and ▸ Run (in its own agent), and ⋯ with Edit, Mark in progress / not started, Delete.
 * An in-progress card has a blue edge that pulses while its agent works. Used by the agent view's
 * strip and side panel, the peek, the phone and the Tasks page; rules in `todo-card-model.ts`.
 */
export function TodoCard({ todo, workerStatus, now, layout, handlers, blocked, busy = false, working = false, planLink = null, runTitle = null, owner = null, extraMenu = [], startTitle, testId = 'v2-todo-card' }: TodoCardProps) {
  const model = todoCardModel(todo, workerStatus, now);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const ids = useId();
  const off = blocked !== null || busy;
  const short = layout !== 'board';
  const canOpen = model.hasDetails && !model.done;

  const menu: MenuItem[] = [
    ...extraMenu,
    ...(extraMenu.length > 0 ? [{ separator: true as const, id: 'sep-own' }] : []),
    ...(model.actions.edit ? [{ id: 'edit', label: W.edit, icon: 'edit', onSelect: () => setEditing(true), ...(blocked ? { disabledReason: blocked } : {}) }] : []),
    ...(model.actions.progress && handlers.progress
      ? [
          {
            id: 'progress',
            label: model.actions.progress === 'in_progress' ? W.markInProgress : W.markNotStarted,
            icon: model.actions.progress === 'in_progress' ? 'dot' : 'circle',
            onSelect: () => handlers.progress?.(model.actions.progress ?? 'open'),
            ...(blocked ? { disabledReason: blocked } : {}),
          },
        ]
      : []),
    { separator: true, id: 'sep-delete' },
    { id: 'delete', label: W.delete, icon: 'trash', danger: true, onSelect: handlers.remove, ...(blocked ? { disabledReason: blocked } : {}) },
  ];

  // A click on the card's free space opens / closes it (its buttons and links keep their own clicks).
  const onCardClick = (event: MouseEvent<HTMLElement>): void => {
    if (!canOpen) return;
    const target = event.target as HTMLElement;
    // A portal's click (the menu, the Edit dialog) bubbles here through React, not through the DOM.
    if (!event.currentTarget.contains(target)) return;
    if (target.closest('button, a, input, textarea, select, [role="menu"], .v2-todo-details')) return;
    if (window.getSelection()?.toString()) return;
    setOpen((value) => !value);
  };

  const start = handlers.start && model.actions.start ? (
    <Button size="sm" icon="play" disabled={off} title={blocked ?? startTitle ?? (model.inProgress ? W.startAgainTitle : W.startTitle)} onClick={handlers.start} data-testid="v2-todo-start">
      {short ? W.startShort : W.startHere}
    </Button>
  ) : null;
  const run = handlers.run && !model.done ? (
    <Button size="sm" variant={layout === 'board' ? 'primary' : 'default'} icon="agents" disabled={off || !model.actions.run} title={blocked ?? model.actions.runWhy ?? W.runOwnTitle} onClick={handlers.run} data-testid="v2-todo-run">
      {short ? W.runShort : W.runOwn}
    </Button>
  ) : null;

  return (
    <article
      className="v2-todo"
      data-layout={layout}
      data-status={model.status.key}
      data-column={model.status.key}
      data-state={todo.state}
      data-priority={model.priority.key}
      data-working={model.inProgress && working ? 'true' : undefined}
      data-expanded={open ? 'true' : 'false'}
      data-todo={todo.id}
      data-session={todo.sessionId}
      data-testid={testId}
      aria-label={model.title}
      onClick={onCardClick}
    >
      <div className="v2-todo-top">
        <button
          type="button"
          className="v2-todo-check"
          role="checkbox"
          aria-checked={model.done}
          aria-label={model.done ? W.reopen(model.title) : W.markDone(model.title)}
          title={blocked ?? (model.done ? W.reopen(model.title) : W.markDone(model.title))}
          data-tone={model.status.tone ?? undefined}
          disabled={off}
          onClick={handlers.check}
          data-testid="v2-todo-check"
        >
          <Icon name={model.done ? 'check-circle' : model.inProgress ? 'half' : 'circle'} size="s" />
        </button>
        <button
          type="button"
          className="v2-todo-title"
          aria-expanded={canOpen ? open : undefined}
          aria-controls={canOpen ? `${ids}-details` : undefined}
          title={canOpen ? (open ? W.hideDetails : W.showDetails) : model.title}
          onClick={() => canOpen && setOpen((value) => !value)}
          data-testid="v2-todo-title"
        >
          {model.title}
        </button>
        <MenuButton items={menu} label={W.more} testId="v2-todo-menu" />
      </div>
      <div className="v2-todo-meta">
        <Chip tone={model.status.tone ?? undefined} icon={model.status.icon} size="s" className="v2-todo-status" title={model.status.key === 'review' ? W.colReviewHint : undefined}>
          <span data-testid="v2-todo-status">{model.status.label}</span>
        </Chip>
        {model.done ? null : (
          <Chip tone={model.priority.tone} icon={model.priority.icon} size="s" className="v2-todo-prio" title={`${W.priority}: ${model.priority.label}`}>
            <span data-testid="v2-todo-priority">{model.priority.label}</span>
          </Chip>
        )}
        {model.estimate ? (
          <span className="v2-todo-est" data-over={model.over ? 'true' : undefined} data-testid="v2-todo-estimate" data-tour="v2-todo-estimate">
            {model.over ? <Icon name="clock" size="s" /> : null}
            {model.estimate}
          </span>
        ) : null}
        {model.tokens ? (
          <span className="v2-todo-est" data-testid="v2-todo-tokens">
            {model.tokens}
          </span>
        ) : null}
        {model.hasPlan && !model.done ? (
          <span className="v2-todo-plan-mark" title={W.planMarkTitle} data-testid="v2-todo-plan-mark">
            <Icon name="rules" size="s" />
            {W.planMark}
          </span>
        ) : null}
        {model.waitingFill ? (
          <span className="v2-todo-fill" title={W.waitingFill}>
            <Icon name="edit" size="s" />
            <span className="v2-sr">{W.waitingFill}</span>
          </span>
        ) : null}
      </div>
      {owner}
      {planLink ? (
        <V2Link to={planLink.href} className="v2-todo-link" data-testid="v2-todo-plan-link" title={W.projectStep(planLink.title, planLink.step)}>
          <Icon name="projects" size="s" />
          <span>{W.projectStep(planLink.title, planLink.step)}</span>
        </V2Link>
      ) : null}
      {todo.runSessionId ? (
        <V2Link to={{ area: 'agent', id: todo.runSessionId, tab: 'chat' }} className="v2-todo-link" data-testid="v2-todo-run-link" data-run-state={todo.runState ?? undefined}>
          <Icon name="agents" size="s" />
          <span>
            {W.ownAgent}: {runTitle ?? '…'}
          </span>
        </V2Link>
      ) : null}
      {open && canOpen ? (
        <div className="v2-todo-details" id={`${ids}-details`} data-testid="v2-todo-details">
          {todo.description ? (
            <div className="v2-todo-text" data-testid="v2-todo-description">
              <ChatMarkdown text={todo.description} testId="v2-todo-description-md" />
            </div>
          ) : null}
          {model.hasPlan ? (
            <section className="v2-todo-text" aria-label={`${W.plan}: ${model.title}`} data-testid="v2-todo-plan">
              <b className="v2-todo-text-h">{W.plan}</b>
              <ChatMarkdown text={todo.plan} testId="v2-todo-plan-md" />
            </section>
          ) : null}
        </div>
      ) : null}
      {start || run ? (
        <div className="v2-todo-actions">
          {start}
          {run}
        </div>
      ) : null}
      {editing ? (
        <TodoEditDialog
          todo={todo}
          disabled={blocked !== null}
          onClose={() => setEditing(false)}
          onSave={async (fields) => {
            const ok = await handlers.save(fields);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : null}
    </article>
  );
}

/**
 * Edit (classic's item form, D69 / D70, in a v2 dialog): title (required, one line),
 * priority, estimate (`45m`, `2h`, optional), description (Markdown, optional) and the
 * handover plan (Markdown, required: `No plan` when there is none). ⌘ / Ctrl + Enter saves.
 */
export function TodoEditDialog({ todo, disabled, onClose, onSave }: { readonly todo: SessionTodo; readonly disabled: boolean; readonly onClose: () => void; readonly onSave: (fields: TodoFieldsInput) => Promise<boolean> }) {
  const [title, setTitle] = useState(todo.title ?? todo.text);
  const [description, setDescription] = useState(todo.description ?? '');
  const [plan, setPlan] = useState(todo.plan ?? TODO_NO_PLAN);
  const [priority, setPriority] = useState<TodoPriority>(isTodoPriority(todo.priority) ? todo.priority : DEFAULT_TODO_PRIORITY);
  const [estimate, setEstimate] = useState(todoEstimateInput(todo.estimateMinutes));
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const parsed = parseTodoEstimate(estimate);
  const canSave = title.trim() !== '' && plan.trim() !== '' && parsed.ok && !saving && !disabled;
  const save = async (): Promise<void> => {
    if (!canSave || !parsed.ok) return;
    setSaving(true);
    try {
      await onSave({ title: title.trim(), description: description.trim() === '' ? null : description.trim(), plan: plan.trim(), priority, estimateMinutes: parsed.value });
    } finally {
      setSaving(false);
    }
  };
  const footer = (
    <>
      <span className="v2-grow" />
      <Button onClick={onClose} data-testid="v2-todo-edit-cancel">
        {W.cancel}
      </Button>
      <Button variant="primary" icon="check" disabled={!canSave} aria-busy={saving} onClick={() => void save()} data-testid="v2-todo-edit-save">
        {W.save}
      </Button>
    </>
  );
  return (
    <Dialog open onClose={onClose} title={W.editTitle} icon="edit" width={560} testId="v2-todo-edit" footer={footer}>
      <form
        className="v2-todo-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <Field ref={titleRef} label={W.fieldTitle} hint={W.fieldTitleHint} value={title} maxLength={TODO_TITLE_MAX} required onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, ' '))} data-testid="v2-todo-edit-title" />
        <div className="v2-todo-form-row">
          <Select label={W.fieldPriority} value={priority} onChange={(event) => setPriority(isTodoPriority(event.target.value) ? event.target.value : DEFAULT_TODO_PRIORITY)} options={TODO_PRIORITIES.map((level) => ({ value: level, label: TODO_PRIORITY_LABELS[level] }))} data-testid="v2-todo-edit-priority" />
          <Field label={W.fieldEstimate} hint={parsed.ok ? W.fieldEstimateHint : undefined} error={parsed.ok ? undefined : parsed.message} value={estimate} maxLength={16} placeholder="45m" onChange={(event) => setEstimate(event.target.value)} data-testid="v2-todo-edit-estimate" />
        </div>
        <TextArea label={W.fieldDescription} hint={W.fieldDescriptionHint} rows={3} value={description} maxLength={TODO_DESCRIPTION_MAX} onChange={(event) => setDescription(event.target.value)} data-testid="v2-todo-edit-description" />
        <TextArea label={W.fieldPlan} hint={W.fieldPlanHint} rows={5} value={plan} maxLength={TODO_PLAN_MAX} required onChange={(event) => setPlan(event.target.value)} data-testid="v2-todo-edit-plan" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
