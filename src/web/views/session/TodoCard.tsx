import { type KeyboardEvent, type MouseEvent, type TextareaHTMLAttributes, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { SessionTodo, TodoFieldsInput, TodoPriority, TodoState } from '../../../core/api.ts';
import type { SessionStatus } from '../../../core/model.ts';
import { todoActualsLabel } from '../../../core/todo-actuals.ts';
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
import { formatAge, statusColor } from '../../shell/format.ts';
import { Link } from '../../router.tsx';
import { EnrichWaiting } from '../../capture/EnrichWaiting.tsx';
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

/** The form's fields (each control's `name`). */
type TodoFormField = 'title' | 'description' | 'plan' | 'priority' | 'estimate';
const TODO_FORM_FIELDS: readonly string[] = ['title', 'description', 'plan', 'priority', 'estimate'] satisfies readonly TodoFormField[];
function isTodoFormField(name: string): name is TodoFormField {
  return TODO_FORM_FIELDS.includes(name);
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
  // How often each field was edited (its native `input` events, counted on the form by the control's `name`):
  // + Add clears after a save only the fields not edited while it was in flight. Comparing values instead wiped
  // a next item's field that equalled the saved one (the same estimate or priority); and React's onChange skips
  // an input event that leaves the value as it was (a paste of the same text), so the raw event is counted.
  const edits = useRef<Record<TodoFormField, number>>({ title: 0, description: 0, plan: 0, priority: 0, estimate: 0 });
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
    const before = { ...edits.current };
    setSaving(true);
    try {
      const ok = await onSave(sent);
      // D69 ruling: + Add stays open for the next item, cleared and on the title (unless the fields were edited meanwhile).
      if (ok && mode === 'add') {
        const untouched = (field: keyof typeof before): boolean => edits.current[field] === before[field];
        if (untouched('title')) setTitle('');
        if (untouched('description')) setDescription('');
        if (untouched('plan')) setPlan(TODO_NO_PLAN);
        if (untouched('priority')) setPriority(DEFAULT_TODO_PRIORITY);
        if (untouched('estimate')) setEstimate('');
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
      onInput={(event) => {
        const name = (event.target as HTMLInputElement).name;
        if (isTodoFormField(name)) edits.current[name] += 1;
      }}
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
        name="title"
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
          name="priority"
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
          name="estimate"
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
        name="description"
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
        name="plan"
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
  /** ▶ Start (open and in-progress items; D75: sends the start message and marks it in progress); `null` = not offered. */
  readonly onStart: (() => void) | null;
  /** D70: ⋯ → Priority (open items): sets the item's priority (the list re-sorts). */
  readonly onPriority: (priority: TodoPriority) => void;
  /** D75: ⋯ → Mark in progress (`in_progress`) / Mark not started (`open`). */
  readonly onProgress: (state: 'open' | 'in_progress') => void;
  /** D76: ⋯ → Run in new session (open and in-progress items without a running run); `null` = not offered. */
  readonly onRun?: (() => void) | null;
  /** D77: the board's ⋯ → Move to (the drag's keyboard alternative); `null` = not offered. */
  readonly onMoveTo?: ((state: TodoState) => void) | null;
}

/** D76: the run session as its card shows it (looked up live in the session list). */
export interface TodoRunSession {
  readonly title: string;
  readonly status: SessionStatus | null;
  readonly closed: boolean;
}

/** D76: a session status in words (the run link). */
const STATUS_WORDS: Readonly<Record<SessionStatus, string>> = { run: 'working', need: 'needs you', done: 'done', fail: 'failed', idle: 'idle', paused: 'paused' };

/** D77: the board's columns as ⋯ → Move to names them. */
export const TODO_STATE_LABELS: Readonly<Record<TodoState, string>> = { open: 'Open', in_progress: 'In progress', review: 'Review', done: 'Done' };

/** D78: a finished card's estimate and actuals: `est ~45m · took 32m · 41k tokens`; `''` when it has none. */
export function todoActualsLine(todo: SessionTodo): string {
  const actual = todoActualsLabel(todo);
  if (!actual) return '';
  const estimate = todoEstimateLabel(todo.estimateMinutes);
  return estimate ? `est ${estimate} · ${actual}` : actual;
}

/** One entry of a submenu (D70: ⋯ → Priority): a radio item, the current one checked. */
interface SubEntry {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly run: () => void;
}

/** One entry of the ⋯ menu; with `submenu` it opens one (→ / Enter / click) instead of running. */
interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
  readonly submenu?: readonly SubEntry[];
}

/**
 * The ⋯ menu: a `role="menu"` under its button; arrows move, Esc closes (focus back on ⋯), a click
 * outside closes. D70: an entry with a submenu (Priority) opens it with → / Enter / a click (focus on
 * the checked item); in the submenu ↑ ↓ move, ← or Esc close it (focus back on its entry), Enter picks.
 */
function CardMenu({ entries, label, onClose, anchor }: { readonly entries: readonly MenuEntry[]; readonly label: string; readonly onClose: () => void; readonly anchor: HTMLButtonElement | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  // Opens upwards when there is no room under the ⋯ inside the scrolling list (the last card above the composer).
  const [up, setUp] = useState(false);
  // D77: on a phone's swipeable board the columns strip clips both ways: the menu is placed in the window instead (fixed).
  const [fixed, setFixed] = useState<{ readonly top: number; readonly right: number } | null>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (anchor && menu.closest('.sb-board-columns[data-swipe="true"]')) {
      const a = anchor.getBoundingClientRect();
      const below = a.bottom + 4;
      setFixed({ top: below + rect.height <= window.innerHeight ? below : Math.max(4, a.top - 4 - rect.height), right: Math.max(4, window.innerWidth - a.right) });
      return;
    }
    // D77: a board card's menu stays within its column's list (where the column scrolls) and the window.
    const selector = '.sb-todos-body, .sb-todos-page-list, .sb-board-cards';
    let scroller = menu.parentElement?.closest(selector) ?? null;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement?.closest(selector) ?? null;
    const bottom = Math.min(scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight, window.innerHeight);
    const top = Math.max(scroller ? scroller.getBoundingClientRect().top : 0, 0);
    if (rect.bottom > bottom && (anchor?.getBoundingClientRect().top ?? 0) - top > rect.height) setUp(true);
  }, [anchor]);
  // A fixed menu does not follow a scroll: the scroll closes it.
  useEffect(() => {
    if (!fixed) return;
    const placed = anchor?.getBoundingClientRect().top ?? 0;
    const scrolled = (): void => {
      // Only a scroll that moved its ⋯ (the menu would float away from it).
      if (Math.abs((anchor?.getBoundingClientRect().top ?? 0) - placed) > 2) close.current();
    };
    window.addEventListener('scroll', scrolled, true);
    return () => window.removeEventListener('scroll', scrolled, true);
  }, [fixed, anchor]);
  // The first entry takes the focus once, when the menu opens. Not on later renders: the card re-renders
  // with a new `onClose` whenever the session or the list refreshes (a hub event), and re-focusing then
  // pulled the focus out of an open submenu back to the first entry.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button[data-level="1"]:not(:disabled)')?.focus({ preventScroll: true });
  }, []);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (event: globalThis.MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node)) close.current();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [anchor]);
  // The submenu takes the focus on its checked item when it opens.
  useEffect(() => {
    if (openSub === null) return;
    const sub = ref.current?.querySelector<HTMLElement>(`[data-submenu="${openSub}"]`);
    (sub?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ?? sub?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
  }, [openSub]);
  const focusEntry = (id: string): void => ref.current?.querySelector<HTMLButtonElement>(`button[data-level="1"][data-entry="${id}"]`)?.focus();
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-level="1"]:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpenSub(null);
      buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'ArrowRight') {
      const id = (document.activeElement as HTMLElement | null)?.dataset['entry'];
      if (id && entries.find((entry) => entry.id === id)?.submenu) {
        event.preventDefault();
        setOpenSub(id);
      }
    } else if (event.key === 'Tab') {
      onClose();
    }
  };
  const subKeys = (id: string) => (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      setOpenSub(null);
      focusEntry(id);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <div ref={ref} className="sb-todo-menu" role="menu" aria-label={label} data-testid="todo-menu" data-placement={fixed ? 'fixed' : up ? 'top' : 'bottom'} style={fixed ? { position: 'fixed', top: fixed.top, right: fixed.right, bottom: 'auto', left: 'auto' } : undefined} onKeyDown={keys}>
      {entries.map((entry) =>
        entry.submenu ? (
          <div key={entry.id} className="sb-todo-submenu-anchor" role="none">
            <button
              type="button"
              role="menuitem"
              className="sb-todo-menu-item sb-todo-menu-parent"
              data-level="1"
              data-entry={entry.id}
              data-testid={`todo-menu-${entry.id}`}
              disabled={entry.disabled}
              aria-haspopup="menu"
              aria-expanded={openSub === entry.id}
              onClick={() => setOpenSub((current) => (current === entry.id ? null : entry.id))}
            >
              {entry.label}
              <span className="sb-todo-menu-caret" aria-hidden="true">
                ▸
              </span>
            </button>
            {openSub === entry.id ? (
              <div className="sb-todo-menu sb-todo-submenu" role="menu" aria-label={entry.label} data-submenu={entry.id} data-testid={`todo-submenu-${entry.id}`} onKeyDown={subKeys(entry.id)}>
                {entry.submenu.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={item.checked}
                    className="sb-todo-menu-item"
                    data-testid={`todo-menu-${entry.id}-${item.id}`}
                    onClick={() => {
                      onClose();
                      anchor?.focus();
                      if (!item.checked) item.run();
                    }}
                  >
                    {/* The ✓ is drawn by CSS (aria-checked carries it for screen readers). */}
                    <span className="sb-todo-menu-check" aria-hidden="true" />
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="sb-todo-menu-item"
            data-level="1"
            data-entry={entry.id}
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
        ),
      )}
    </div>
  );
}

/**
 * D69 · one todo as a card (`docs/todos.md` → *Cards*): a round box to tick,
 * the bold title, D70 its priority label and estimate (an open card is tinted by its
 * priority: `data-priority`), the description (Markdown, two lines until the card is
 * opened), who added it and how long ago, a ⋯ menu (Edit, D70 Priority ▸, D75 Mark in progress /
 * Mark not started, Move up, Move down, Delete), **▸ Handover plan** when it has one, and **▶ Start**.
 * D75: an item in progress has a half-filled box (◐), an **In progress** label next to its
 * priority and, while the session works, a pulsing left edge; ticking it marks it done. A click on the
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
  working = false,
  runSession = null,
  selected = null,
  onSelect = null,
  sessionLabel = null,
  dragProps = null,
}: {
  readonly todo: SessionTodo;
  /** D76: its run session (title, live status), `null` when it has none or it is not known here. */
  readonly runSession?: TodoRunSession | null;
  /** D76: multi-select (Run N in new sessions): whether it is selected; `null` = not selecting. */
  readonly selected?: boolean | null;
  readonly onSelect?: ((selected: boolean) => void) | null;
  /** D77: the board's card names its session. */
  readonly sessionLabel?: string | null;
  /** D77: the board's drag handlers and state (pointer events on the card). */
  readonly dragProps?: Readonly<Record<string, unknown>> | null;
  /** Its place among the items it moves among (D70: the open items of its priority, or the done ones; for Move up / down). */
  readonly index: number;
  readonly count: number;
  /** Nothing can change (an unreachable machine's session). */
  readonly disabled: boolean;
  readonly actions: TodoCardActions;
  readonly now: number;
  /** D75: the session is working (its status `run`): an in-progress card's left edge pulses. */
  readonly working?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const ids = useId();
  const isDone = todo.state === 'done';
  // D75: started (◐, IN PROGRESS); a tick marks it done.
  const inProgress = todo.state === 'in_progress';
  // D76: its run finished it; a tick approves it (done).
  const inReview = todo.state === 'review';
  const runActive = todo.runState === 'active' && Boolean(todo.runSessionId);
  const actualsLine = todoActualsLine(todo);
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
    <button
      type="button"
      className="sb-todo-start"
      data-testid="todo-start"
      disabled={disabled}
      title={inProgress ? 'Send this item to the agent again' : 'Send this item to the agent and mark it in progress'}
      onClick={actions.onStart}
    >
      ▶ Start
    </button>
  ) : null;

  const entries: MenuEntry[] = [
    ...(isDone ? [] : [{ id: 'edit', label: 'Edit', disabled, run: () => setEditing(true) }]),
    // D70: one-click priority (open items); the list re-sorts after the change.
    ...(isDone
      ? []
      : [
          {
            id: 'priority',
            label: 'Priority',
            disabled,
            run: () => undefined,
            submenu: TODO_PRIORITIES.map((level) => ({ id: level, label: TODO_PRIORITY_LABELS[level], checked: level === priority, run: () => actions.onPriority(level) })),
          },
        ]),
    // D75: by hand, without sending anything (▶ Start sends the message too).
    ...(isDone || inReview
      ? []
      : [
          inProgress
            ? { id: 'not-started', label: 'Mark not started', disabled, run: () => actions.onProgress('open') }
            : { id: 'in-progress', label: 'Mark in progress', disabled, run: () => actions.onProgress('in_progress') },
        ]),
    { id: 'up', label: 'Move up', disabled: disabled || index <= 0, run: () => actions.onMove(-1) },
    { id: 'down', label: 'Move down', disabled: disabled || index >= count - 1, run: () => actions.onMove(1) },
    // D76: a new session works on it (its own worktree in a git repo).
    ...(actions.onRun && !isDone && !inReview && !runActive ? [{ id: 'run', label: 'Run in new session', disabled, run: actions.onRun }] : []),
    // D77: the board's columns without dragging (Review only for an item with a run).
    ...(actions.onMoveTo
      ? [
          {
            id: 'move',
            label: 'Move to',
            disabled,
            run: () => undefined,
            submenu: (['open', 'in_progress', 'review', 'done'] as const)
              .filter((state) => state !== 'review' || Boolean(todo.runSessionId))
              .map((state) => ({ id: state, label: TODO_STATE_LABELS[state], checked: state === todo.state, run: () => actions.onMoveTo?.(state) })),
          },
        ]
      : []),
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
      data-working={inProgress && working ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      onClick={onCardClick}
      {...(dragProps ?? {})}
    >
      {sessionLabel ? (
        <div className="sb-todo-session-label" data-testid="todo-session-label">
          {sessionLabel}
        </div>
      ) : null}
      <div className="sb-todo-card-row" ref={row}>
        {selected !== null && onSelect ? (
          <input
            type="checkbox"
            className="sb-todo-select"
            data-testid="todo-select"
            aria-label={`Select ${title}`}
            checked={selected}
            disabled={disabled || isDone || inReview || runActive}
            onChange={(event) => onSelect(event.target.checked)}
          />
        ) : null}
        <input
          type="checkbox"
          className="sb-todo-check"
          data-testid="todo-check"
          aria-label={isDone ? `Reopen ${title}` : inReview ? `Approve ${title} (mark it done)` : `Mark ${title} done${inProgress ? ' (in progress)' : ''}`}
          data-progress={inProgress ? 'true' : undefined}
          data-review={inReview ? 'true' : undefined}
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
            {inProgress ? (
              <span className="sb-todo-in-progress" data-testid="todo-in-progress" title={todo.startedAt ? `In progress since ${new Date(todo.startedAt).toLocaleString()}` : 'In progress'}>
                In progress
              </span>
            ) : null}
            {inReview ? (
              <span className="sb-todo-in-review" data-testid="todo-in-review" title="Its run session finished it: review the work, then tick it (or drag it to Done)">
                In review
              </span>
            ) : null}
            {inReview && actualsLine ? (
              <span className="sb-todo-actuals" data-testid="todo-actuals" title="Estimate, the time it spent in progress, and the tokens of the turns that worked on it (approximate)">
                {actualsLine}
              </span>
            ) : null}
            {estimate && !(inReview && actualsLine) ? (
              <span className="sb-todo-estimate" data-testid="todo-estimate" title={`Estimate: ${todo.estimateMinutes} minutes for an AI agent`}>
                {estimate}
              </span>
            ) : null}
            {/* D81: a captured item until its agent fills it in. */}
            {todo.needsEnrichment === true ? <EnrichWaiting /> : null}
          </span>
        )}
        <span className="sb-todo-meta" data-testid="todo-meta">
          {isDone ? (
            <>
              {actualsLine ? (
                <span className="sb-todo-actuals" data-testid="todo-actuals" title="Estimate, the time it spent in progress, and the tokens of the turns that worked on it (approximate)">
                  {actualsLine}
                  {' · '}
                </span>
              ) : null}
              <span data-testid="todo-removal">{todoRemovalLabel(todo.removeAt, Math.max(now, Date.now()))}</span>
            </>
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
            data-tour="todo-actions"
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
      {todo.runSessionId ? (
        <div className="sb-todo-run" data-testid="todo-run-session" data-run-state={todo.runState ?? undefined}>
          <span className="sb-todo-run-label">{todo.runState === 'discarded' ? 'Run (discarded)' : 'Run'}</span>
          <Link to={{ view: 'session', id: todo.runSessionId, tab: 'chat' }} className="sb-todo-run-link" data-testid="todo-run-link">
            {runSession && runSession.status ? <span className="sb-todo-run-dot" aria-hidden="true" style={{ background: statusColor(runSession.status) }} /> : null}
            {runSession?.title ?? 'its session'}
          </Link>
          {runSession ? (
            <span className="sb-todo-run-status" data-testid="todo-run-status">
              {runSession.closed ? 'closed' : runSession.status ? STATUS_WORDS[runSession.status] : ''}
            </span>
          ) : null}
        </div>
      ) : null}
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
