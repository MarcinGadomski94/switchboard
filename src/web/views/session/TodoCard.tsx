import { type KeyboardEvent, type MouseEvent, type TextareaHTMLAttributes, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionTodo, TodoFieldsInput, TodoPriority } from '../../../core/api.ts';
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
  todoEstimateLabel,
  todoHasPlan,
  todoRemovalLabel,
} from '../../../core/todos.ts';
import { formatAge } from '../../shell/format.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';

/** Who added an item, as the card shows it (subtle). */
export function authorLabel(todo: Pick<SessionTodo, 'addedBy'>): string {
  return todo.addedBy === 'agent' ? 'agent' : 'you';
}

/** `true` for ⌘ / Ctrl + Enter (the form's Save). */
function isSaveKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing;
}

/** A textarea that grows with its text (up to its CSS `max-height`, then it scrolls). */
function AutoTextarea({ value, onChange, ...rest }: { readonly value: string; readonly onChange: (value: string) => void } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} rows={2} value={value} onChange={(event) => onChange(event.target.value)} {...rest} />;
}

/**
 * D69 · the item form (`docs/todos.md` → *Cards*): title (required, one line),
 * description (Markdown, optional) and handover plan (Markdown). D70: the plan is
 * required (a new item's is prefilled `No plan`), a priority (prefilled medium) and
 * the estimate (optional: `45m`, `2h`, `1h 30m`). **Save** / **Cancel**; Esc cancels,
 * ⌘ / Ctrl + Enter saves (Enter too in the title). Used by **+ Add** and by **Edit**.
 */
export function TodoForm({
  initial,
  mode,
  disabled,
  onSave,
  onCancel,
}: {
  readonly initial: TodoFieldsInput | null;
  readonly mode: 'add' | 'edit';
  readonly disabled: boolean;
  /** Saves; answers whether it worked (the form stays open with its text when not). */
  readonly onSave: (fields: TodoFieldsInput) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // D70: the plan is required; a new item's starts as "No plan" so adding stays quick.
  const [plan, setPlan] = useState(initial?.plan ?? TODO_NO_PLAN);
  const [priority, setPriority] = useState<TodoPriority>(initial?.priority ?? DEFAULT_TODO_PRIORITY);
  const [estimate, setEstimate] = useState(todoEstimateInput(initial?.estimateMinutes));
  const [saving, setSaving] = useState(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const ids = useId();

  useEffect(() => {
    titleInput.current?.focus();
  }, []);

  const parsedEstimate = parseTodoEstimate(estimate);
  const canSave = title.trim() !== '' && plan.trim() !== '' && parsedEstimate.ok && !saving && !disabled;
  const save = async (): Promise<void> => {
    if (!canSave || !parsedEstimate.ok) return;
    const sent: TodoFieldsInput = {
      title: title.trim(),
      description: description.trim() === '' ? null : description.trim(),
      plan: plan.trim(),
      priority,
      estimateMinutes: parsedEstimate.value,
    };
    const typed = { title, description, plan, priority, estimate };
    setSaving(true);
    try {
      const ok = await onSave(sent);
      // D69 ruling: + Add stays open for the next item, cleared and on the title (unless the fields were edited meanwhile).
      if (ok && mode === 'add') {
        const reset = <T,>(before: T, empty: T) => (current: T): T => (current === before ? empty : current);
        setTitle(reset(typed.title, ''));
        setDescription(reset(typed.description, ''));
        setPlan(reset(typed.plan, TODO_NO_PLAN));
        setPriority(reset<TodoPriority>(typed.priority, DEFAULT_TODO_PRIORITY));
        setEstimate(reset(typed.estimate, ''));
        titleInput.current?.focus();
      }
    } finally {
      setSaving(false);
    }
  };

  const keys = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (isSaveKey(event)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form
      className="sb-todo-form"
      data-testid="todo-form"
      data-mode={mode}
      aria-label={mode === 'add' ? 'New todo' : 'Edit todo'}
      onKeyDown={keys}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="sb-todo-form-label" htmlFor={`${ids}-title`}>
        Title
      </label>
      <input
        ref={titleInput}
        id={`${ids}-title`}
        className="sb-todo-form-title"
        data-testid="todo-form-title"
        placeholder="What still needs doing (one line)"
        value={title}
        maxLength={TODO_TITLE_MAX}
        required
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, ' '))}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && !isSaveKey(event)) {
            event.preventDefault();
            void save();
          }
        }}
      />
      <div className="sb-todo-form-row">
        <label className="sb-todo-form-label" htmlFor={`${ids}-priority`}>
          Priority
        </label>
        <select
          id={`${ids}-priority`}
          className="sb-todo-form-select"
          data-testid="todo-form-priority"
          value={priority}
          disabled={disabled}
          onChange={(event) => setPriority(isTodoPriority(event.target.value) ? event.target.value : DEFAULT_TODO_PRIORITY)}
        >
          {TODO_PRIORITIES.map((level) => (
            <option key={level} value={level}>
              {TODO_PRIORITY_LABELS[level]}
            </option>
          ))}
        </select>
        <label className="sb-todo-form-label" htmlFor={`${ids}-estimate`}>
          Estimate <span className="sb-todo-form-hint">AI agent · optional</span>
        </label>
        <input
          id={`${ids}-estimate`}
          className="sb-todo-form-estimate"
          data-testid="todo-form-estimate"
          placeholder="e.g. 45m, 2h"
          value={estimate}
          maxLength={16}
          disabled={disabled}
          aria-invalid={!parsedEstimate.ok}
          aria-describedby={parsedEstimate.ok ? undefined : `${ids}-estimate-error`}
          onChange={(event) => setEstimate(event.target.value)}
        />
      </div>
      {!parsedEstimate.ok ? (
        <div className="sb-todo-form-error" id={`${ids}-estimate-error`} data-testid="todo-form-estimate-error" role="alert">
          {parsedEstimate.message}
        </div>
      ) : null}
      <label className="sb-todo-form-label" htmlFor={`${ids}-description`}>
        Description <span className="sb-todo-form-hint">for you · Markdown · optional</span>
      </label>
      <AutoTextarea
        id={`${ids}-description`}
        className="sb-todo-form-area"
        data-testid="todo-form-description"
        placeholder="Plain and brief: what and why"
        value={description}
        maxLength={TODO_DESCRIPTION_MAX}
        disabled={disabled}
        onChange={setDescription}
      />
      <label className="sb-todo-form-label" htmlFor={`${ids}-plan`}>
        Handover plan <span className="sb-todo-form-hint">for an agent · Markdown · required (“{TODO_NO_PLAN}” when there is none)</span>
      </label>
      <AutoTextarea
        id={`${ids}-plan`}
        className="sb-todo-form-area sb-todo-form-plan"
        data-testid="todo-form-plan"
        placeholder={'Context, relevant files, steps, acceptance criteria: enough for an agent to pick it up cold'}
        value={plan}
        maxLength={TODO_PLAN_MAX}
        required
        disabled={disabled}
        onChange={setPlan}
      />
      <div className="sb-todo-form-actions">
        <span className="sb-todo-form-keys">Esc cancels · ⌘/Ctrl+Enter saves</span>
        <button type="button" className="sb-todo-form-cancel" data-testid="todo-form-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="sb-todo-form-save" data-testid="todo-form-save" disabled={!canSave} aria-busy={saving}>
          {mode === 'add' ? 'Add' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** What a card can do (each through the caller's API calls). */
export interface TodoCardActions {
  readonly onToggleDone: () => void;
  readonly onSave: (fields: TodoFieldsInput) => Promise<boolean>;
  readonly onMove: (step: -1 | 1) => void;
  readonly onDelete: () => void;
  /** ▶ Start (open items); `null` = not offered. */
  readonly onStart: (() => void) | null;
}

/** One entry of the ⋯ menu. */
interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

/** The ⋯ menu: a `role="menu"` under its button; arrows move, Esc closes (focus back on ⋯), a click outside closes. */
function CardMenu({ entries, label, onClose, anchor }: { readonly entries: readonly MenuEntry[]; readonly label: string; readonly onClose: () => void; readonly anchor: HTMLButtonElement | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Opens upwards when there is no room under the ⋯ inside the scrolling list (the last card above the composer).
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const scroller = menu.parentElement?.closest('.sb-todos-body, .sb-todos-page-list');
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    const top = scroller ? scroller.getBoundingClientRect().top : 0;
    if (rect.bottom > bottom && (anchor?.getBoundingClientRect().top ?? 0) - top > rect.height) setUp(true);
  }, [anchor]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [anchor, onClose]);
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Tab') {
      onClose();
    }
  };
  return (
    <div ref={ref} className="sb-todo-menu" role="menu" aria-label={label} data-testid="todo-menu" data-placement={up ? 'top' : 'bottom'} onKeyDown={keys}>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className="sb-todo-menu-item"
          data-testid={`todo-menu-${entry.id}`}
          disabled={entry.disabled}
          data-danger={entry.id === 'delete' ? 'true' : undefined}
          onClick={() => {
            onClose();
            entry.run();
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/**
 * D69 · one todo as a card (`docs/todos.md` → *Cards*): a round box to tick,
 * the bold title, D70 its priority label and estimate (an open card is tinted by its
 * priority: `data-priority`), the description (Markdown, two lines until the card is
 * opened), who added it and how long ago, a ⋯ menu (Edit, Move up, Move down,
 * Delete), **▸ Handover plan** when it has one, and **▶ Start**. A click on the
 * card (or its title) opens it in place: the full description and the plan.
 * A done item: the box filled, the title struck through, no description, and
 * when it goes (`removed in 42m`).
 */
export function TodoCard({
  todo,
  index,
  count,
  disabled,
  actions,
  now,
}: {
  readonly todo: SessionTodo;
  /** Its place among the items it moves among (D70: the open items of its priority, or the done ones; for Move up / down). */
  readonly index: number;
  readonly count: number;
  /** Nothing can change (an unreachable machine's session). */
  readonly disabled: boolean;
  readonly actions: TodoCardActions;
  readonly now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const ids = useId();
  const isDone = todo.state === 'done';
  const title = todo.title ?? todo.text;
  // D70: "No plan" (or "No plan: <reason>") is not offered as a handover plan.
  const hasPlan = todoHasPlan(todo.plan);
  const showPlan = hasPlan && !isDone && (planOpen || expanded);
  const priority = isTodoPriority(todo.priority) ? todo.priority : DEFAULT_TODO_PRIORITY;
  const estimate = todoEstimateLabel(todo.estimateMinutes);
  // D69 review: opening the card or its plan keeps its title row in view (the list scrolls, the row stays).
  const row = useRef<HTMLDivElement | null>(null);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    if (expanded || showPlan) row.current?.scrollIntoView({ block: 'nearest' });
  }, [expanded, showPlan]);

  if (editing) {
    return (
      <li className="sb-todo-card" data-testid="todo-item" data-todo-id={todo.id} data-state={todo.state} data-added-by={todo.addedBy} data-editing="true">
        <TodoForm
          mode="edit"
          initial={{ title, description: todo.description, plan: todo.plan, priority, estimateMinutes: todo.estimateMinutes }}
          disabled={disabled}
          onCancel={() => setEditing(false)}
          onSave={async (fields) => {
            const ok = await actions.onSave(fields);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      </li>
    );
  }

  // A click on the card's free space opens / closes it (its buttons, links and the plan's text keep their own clicks).
  const onCardClick = (event: MouseEvent<HTMLLIElement>): void => {
    if (isDone) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea, [role="menu"], .sb-todo-plan')) return;
    if (window.getSelection()?.toString()) return;
    setExpanded((value) => !value);
  };

  const startButton = actions.onStart ? (
    <button type="button" className="sb-todo-start" data-testid="todo-start" disabled={disabled} title="Put this item into the message box (not sent)" onClick={actions.onStart}>
      ▶ Start
    </button>
  ) : null;

  const entries: MenuEntry[] = [
    ...(isDone ? [] : [{ id: 'edit', label: 'Edit', disabled, run: () => setEditing(true) }]),
    { id: 'up', label: 'Move up', disabled: disabled || index <= 0, run: () => actions.onMove(-1) },
    { id: 'down', label: 'Move down', disabled: disabled || index >= count - 1, run: () => actions.onMove(1) },
    { id: 'delete', label: 'Delete', disabled, run: actions.onDelete },
  ];

  return (
    <li
      className="sb-todo-card"
      data-testid="todo-item"
      data-todo-id={todo.id}
      data-state={todo.state}
      data-added-by={todo.addedBy}
      data-priority={priority}
      data-expanded={expanded ? 'true' : 'false'}
      onClick={onCardClick}
    >
      <div className="sb-todo-card-row" ref={row}>
        <input
          type="checkbox"
          className="sb-todo-check"
          data-testid="todo-check"
          aria-label={isDone ? `Reopen ${title}` : `Mark ${title} done`}
          checked={isDone}
          disabled={disabled}
          onChange={actions.onToggleDone}
        />
        <button
          type="button"
          className="sb-todo-title"
          data-testid="todo-title"
          aria-expanded={isDone ? undefined : expanded}
          aria-controls={isDone ? undefined : `${ids}-body`}
          disabled={isDone}
          onClick={() => setExpanded((value) => !value)}
        >
          {title}
        </button>
        {isDone ? null : (
          <span className="sb-todo-tags">
            <span className="sb-todo-priority" data-testid="todo-priority" data-priority={priority} title={`Priority: ${TODO_PRIORITY_LABELS[priority]}`}>
              {TODO_PRIORITY_LABELS[priority]}
            </span>
            {estimate ? (
              <span className="sb-todo-estimate" data-testid="todo-estimate" title={`Estimate: ${todo.estimateMinutes} minutes for an AI agent`}>
                {estimate}
              </span>
            ) : null}
          </span>
        )}
        <span className="sb-todo-meta" data-testid="todo-meta">
          {isDone ? (
            <span data-testid="todo-removal">{todoRemovalLabel(todo.removeAt, Math.max(now, Date.now()))}</span>
          ) : (
            <>
              <span className="sb-todo-by" data-testid="todo-by" title={todo.addedBy === 'agent' ? 'Added by the agent' : 'Added by you'}>
                {authorLabel(todo)}
              </span>
              {' · '}
              <span title={new Date(todo.createdAt).toLocaleString()}>{formatAge(todo.createdAt, Math.max(now, Date.now()))}</span>
            </>
          )}
        </span>
        {/* D69 review: without a plan, ▶ Start sits on the title row (no row of its own). */}
        {hasPlan ? null : startButton}
        <span className="sb-todo-menu-anchor">
          <button
            ref={menuButton}
            type="button"
            className="sb-todo-more"
            data-testid="todo-menu-button"
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            ⋯
          </button>
          {menuOpen ? <CardMenu entries={entries} label={`Actions for ${title}`} anchor={menuButton.current} onClose={() => setMenuOpen(false)} /> : null}
        </span>
      </div>
      {!isDone && (todo.description || hasPlan) ? (
        <div className="sb-todo-card-body" id={`${ids}-body`}>
          {todo.description ? (
            <div className="sb-todo-description" data-testid="todo-description" data-clamped={expanded ? 'false' : 'true'}>
              <ChatMarkdown text={todo.description} testId="todo-description-markdown" />
            </div>
          ) : null}
          {hasPlan ? (
            <div className="sb-todo-card-foot">
              <button
                type="button"
                className="sb-todo-plan-toggle"
                data-testid="todo-plan-toggle"
                aria-expanded={showPlan}
                aria-controls={`${ids}-plan`}
                onClick={() => {
                  if (showPlan) {
                    setPlanOpen(false);
                    setExpanded(false);
                  } else setPlanOpen(true);
                }}
              >
                <span aria-hidden="true">{showPlan ? '▾' : '▸'}</span> Handover plan
              </button>
              {startButton}
            </div>
          ) : null}
          {showPlan ? (
            <div className="sb-todo-plan" id={`${ids}-plan`} data-testid="todo-plan" role="region" aria-label={`Handover plan for ${title}`}>
              <ChatMarkdown text={todo.plan ?? ''} testId="todo-plan-markdown" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
