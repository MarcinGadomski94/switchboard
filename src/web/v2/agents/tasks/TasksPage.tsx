import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionTodo, SessionTodoList, TodoFieldsInput, TodoGroup } from '../../../../core/api.ts';
import type { SessionStatus } from '../../../../core/model.ts';
import { displayTitle } from '../../../../core/session-title.ts';
import { captureTargets } from '../../../../core/todo-capture.ts';
import { todoHasPlan, todoStartMessage } from '../../../../core/todos.ts';
import { ApiError, api, withKeepalive } from '../../../api/client.ts';
import { useApi } from '../../../api/useApi.ts';
import { useHubEvent } from '../../../api/useHub.ts';
import { useLiveMachine } from '../../../api/useMachines.ts';
import { useSessionListOf } from '../../../api/session-list.ts';
import { useThrottled } from '../../../api/useThrottled.ts';
import { captureTodo } from '../../../capture/capture.ts';
import { usePlans } from '../../../plans/store.ts';
import { savePatch } from '../../../views/session/TodoStrip.tsx';
import { TodoCard } from '../../shared/TodoCard.tsx';
import { type TodoPlanLink, todoPlanLink } from '../../shared/todo-card-model.ts';
import { BottomSheet, Button, Checkbox, Chip, ComputerTag, Dialog, EmptyState, Field, Icon, type MenuItem, Popover, Segmented, Select, Skeleton, Switch, useToast } from '../../components/index.ts';
import { TASKS_WORDS as W, computerStateToV2 } from '../../glossary.ts';
import { openNew } from '../../new/index.tsx';
import { V2Link, useV2Router } from '../../nav.tsx';
import { usePref } from '../useAgentsData.ts';
import { ImportTasksDialog } from './ImportTasksDialog.tsx';
import { TASK_COLUMNS, TASK_COLUMN_LOOK, type TaskCard, type TaskColumn, addedTodo, blockedReason, boardOf, cardKey, estimateAccuracy, estimateText, movePatch, moveTargets, priorityLook, quickAddInput, workerOf } from './tasks-model.ts';
import { TASKS_AGENTS_KEY, TASKS_FOLDED_KEY, TASKS_GROUP_KEY, type TaskAgent, agentMatches, agentSections, agentsFromSearch, agentsSearch, filterGroups, liveFilter, readStoredAgents, taskAgents, toggleAgent } from './tasks-agents.ts';
import './tasks.css';

/** How long a deleted task waits before it is really deleted (the toast's Undo window). */
const DELETE_DELAY_MS = 5_600;

const COLUMN_WORD: Readonly<Record<TaskColumn, string>> = { open: W.colOpen, progress: W.colProgress, review: W.colReview, done: W.colDone };

function refusal(error: unknown): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === 'string') return message;
    if (error.unreachable) return 'Switchboard could not be reached.';
  }
  return 'That did not work. Try again.';
}

/**
 * D75 · Start here: the item goes in progress and its start message is sent to its own
 * agent. A paired computer still on 1.11 or earlier has no such route: the message goes as
 * a plain message (classic's `startTodo`, `src/web/views/session/TodoStrip.tsx`).
 */
async function startHere(sessionId: string, todo: SessionTodo): Promise<SessionTodoList> {
  try {
    return await api.startTodo(sessionId, todo.id);
  } catch (error) {
    const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : undefined;
    const olderPeer = error instanceof ApiError && sessionId.startsWith('r~') && (error.status === 403 || (error.status === 404 && code !== 'not-found'));
    if (!olderPeer) throw error;
    await api.sendMessage(sessionId, todoStartMessage({ id: todo.id, title: todo.title ?? todo.text, description: todo.description, plan: todo.plan }));
    return api.sessionTodos(sessionId);
  }
}

/** The current time, ticking every 30 s (the "so far" lines). */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** What a card can do (the page owns the writes). */
interface CardActions {
  readonly start: (card: TaskCard) => void;
  readonly run: (card: TaskCard) => void;
  readonly move: (card: TaskCard, to: TaskColumn) => void;
  readonly remove: (card: TaskCard) => void;
  readonly open: (card: TaskCard) => void;
  /** Edit's Save (every field, D70); answers whether it worked. */
  readonly save: (card: TaskCard, fields: TodoFieldsInput) => Promise<boolean>;
}

/** The priority as icon + word + colour (the prototype's `.prio`). */
function Priority({ priority }: { readonly priority: string }) {
  const look = priorityLook(priority);
  return (
    <Chip tone={look.tone} icon={look.icon} size="s" className="v2-tasks-prio" title={`${W.priority}: ${look.label}`}>
      <span data-testid="v2-tasks-priority">{look.label}</span>
    </Chip>
  );
}

/** Start here / Run in its own agent, disabled with the reason when they cannot run. */
function OpenActions({ card, actions, busy, size = 'sm' }: { readonly card: TaskCard; readonly actions: CardActions; readonly busy: boolean; readonly size?: 'sm' | 'm' }) {
  const machine = useLiveMachine(card.group.machine ?? null);
  const blocked = blockedReason(machine, W);
  const running = card.todo.runState === 'active' && card.todo.runSessionId ? W.alreadyRunning : null;
  return (
    <div className="v2-tasks-actions">
      <Button size={size} icon="chat" disabled={busy || blocked !== null} title={blocked ?? W.startHereTitle(card.group.title)} onClick={() => actions.start(card)} data-testid="v2-tasks-start">
        {W.startHere}
      </Button>
      <Button size={size} variant="primary" icon="play" disabled={busy || blocked !== null || running !== null} title={blocked ?? running ?? W.runOwnTitle} onClick={() => actions.run(card)} data-testid="v2-tasks-run">
        {W.runOwn}
      </Button>
      {blocked ? (
        <span className="v2-tasks-why" data-testid="v2-tasks-blocked">
          {blocked}
        </span>
      ) : null}
    </div>
  );
}

/** The agent a task belongs to (a link to its chat) and, for a paired computer's, the computer. */
function Owner({ card, onNavigate }: { readonly card: TaskCard; readonly onNavigate?: () => void }) {
  const machine = useLiveMachine(card.group.machine ?? null);
  return (
    <div className="v2-tasks-owner">
      <V2Link to={{ area: 'agent', id: card.group.sessionId, tab: 'chat' }} className="v2-tasks-agent" onClick={onNavigate} data-testid="v2-tasks-agent">
        <Icon name="agents" size="s" />
        <span>{card.group.title}</span>
      </V2Link>
      {machine ? <ComputerTag name={machine.name} state={computerStateToV2(machine.state)} short /> : null}
    </div>
  );
}

/**
 * One task card: fix after 2.0, classic's todo card in v2's look (`shared/TodoCard.tsx`, shared with
 * the agent view): check box, details in place, Start here / Run in its own agent, Edit, Mark in
 * progress, Delete with Undo; plus the agent it belongs to, Details and Move to.
 */
function TaskCardView({ card, actions, busy, now, extras }: { readonly card: TaskCard; readonly actions: CardActions; readonly busy: boolean; readonly now: number; readonly extras: CardExtras }) {
  const { todo, group } = card;
  const machine = useLiveMachine(group.machine ?? null);
  const blocked = blockedReason(machine, W);
  const menu: MenuItem[] = [
    { id: 'details', label: W.details, icon: 'eye', onSelect: () => actions.open(card) },
    ...moveTargets(todo).map((to) => ({ id: `move-${to}`, label: W.moveTo(COLUMN_WORD[to]), icon: TASK_COLUMN_LOOK[to].icon, onSelect: () => actions.move(card, to) })),
  ];
  return (
    <TodoCard
      todo={todo}
      layout="board"
      testId="v2-tasks-card"
      workerStatus={extras.statusOf(workerOf(todo))}
      now={now}
      blocked={blocked}
      busy={busy}
      working={extras.statusOf(workerOf(todo)) === 'run'}
      planLink={extras.planLink(todo)}
      runTitle={extras.runTitle(todo.runSessionId)}
      owner={<Owner card={card} />}
      extraMenu={menu}
      startTitle={W.startHereTitle(group.title)}
      handlers={{
        start: () => actions.start(card),
        run: () => actions.run(card),
        check: () => actions.move(card, todo.state === 'done' ? 'open' : 'done'),
        save: (fields) => actions.save(card, fields),
        progress: (state) => actions.move(card, state === 'in_progress' ? 'progress' : 'open'),
        remove: () => actions.remove(card),
      }}
    />
  );
}

/** What the cards read from the page (live statuses, D99 plan links, run agents' names). */
interface CardExtras {
  readonly statusOf: (sessionId: string) => SessionStatus | null;
  readonly planLink: (todo: SessionTodo) => TodoPlanLink | null;
  readonly runTitle: (sessionId: string | null | undefined) => string | null;
}

/** One column (the prototype's `.col`). */
function Column({ column, cards, actions, busy, now, extras, footer, scope = '' }: { readonly column: TaskColumn; readonly cards: readonly TaskCard[]; readonly actions: CardActions; readonly busy: ReadonlySet<string>; readonly now: number; readonly extras: CardExtras; readonly footer?: string | null; readonly scope?: string }) {
  const look = TASK_COLUMN_LOOK[column];
  // D188: a section's columns (grouped by agent) get their own heading ids.
  const headingId = `v2-tasks-h-${scope}${column}`;
  return (
    <section className="v2-tasks-col" data-col={column} data-testid={`v2-tasks-col-${column}`} aria-labelledby={headingId}>
      <h2 id={headingId} className="v2-tasks-col-h" title={column === 'review' ? W.colReviewHint : undefined}>
        <span className="v2-tasks-col-icon" data-tone={look.tone ?? undefined}>
          <Icon name={look.icon} size="s" />
        </span>
        {COLUMN_WORD[column]}
        <span className="v2-tasks-count" data-testid="v2-tasks-count">
          {cards.length}
        </span>
      </h2>
      {cards.length === 0 ? <p className="v2-tasks-none">{column === 'review' ? W.colReviewHint : W.emptyColumn}</p> : null}
      {cards.map((card) => (
        <TaskCardView key={cardKey(card.group.sessionId, card.todo.id)} card={card} actions={actions} busy={busy.has(cardKey(card.group.sessionId, card.todo.id))} now={now} extras={extras} />
      ))}
      {footer ? (
        <p className="v2-tasks-accuracy" data-testid="v2-tasks-accuracy" data-tour="v2-tasks-accuracy">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // No storage: the choice lasts until the page closes.
  }
}

/** A phone-wide window (the filter opens as a bottom sheet there). */
function usePhoneWidth(): boolean {
  const query = '(max-width: 767px)';
  const [phone, setPhone] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const on = (): void => setPhone(list.matches);
    list.addEventListener('change', on);
    return () => list.removeEventListener('change', on);
  }, []);
  return phone;
}

/** D188: the filter's list: a search, then every agent with tasks as a check box (name · computer · counts). */
function AgentPicker({ agents, picked, onChange }: { readonly agents: readonly TaskAgent[]; readonly picked: readonly string[]; readonly onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState('');
  const shown = agents.filter((agent) => agentMatches(agent, query));
  return (
    <div className="v2-tasks-picker" data-testid="v2-tasks-agents-list">
      <Field autoFocus placeholder={W.agentsSearch} aria-label={W.agentsSearch} value={query} onChange={(event) => setQuery(event.target.value)} data-testid="v2-tasks-agents-search" />
      <div className="v2-tasks-picker-rows" role="group" aria-label={W.agentsLabel}>
        {shown.length === 0 ? <p className="v2-muted">{W.agentsNone}</p> : null}
        {shown.map((agent) => (
          <Checkbox
            key={agent.sessionId}
            checked={picked.includes(agent.sessionId)}
            onChange={() => onChange(toggleAgent(picked, agent.sessionId))}
            data-testid="v2-tasks-agents-option"
            data-session={agent.sessionId}
            label={
              <span className="v2-tasks-picker-row">
                <span className="v2-tasks-picker-name">{agent.title}</span>
                {agent.computer ? <span className="v2-muted"> · {agent.computer}</span> : null}
                <span className="v2-muted v2-tasks-picker-count">{W.agentsCount(agent.count, agent.open)}</span>
              </span>
            }
          />
        ))}
      </div>
      {picked.length > 0 ? (
        <Button size="sm" variant="ghost" icon="x" onClick={() => onChange([])} data-testid="v2-tasks-agents-clear">
          {W.agentsClear}
        </Button>
      ) : null}
    </div>
  );
}

/** D188: the agent filter's button (a popover; a bottom sheet on a phone). */
function AgentFilter({ agents, picked, onChange }: { readonly agents: readonly TaskAgent[]; readonly picked: readonly string[]; readonly onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const phone = usePhoneWidth();
  const label = picked.length === 0 ? W.agentsAll : picked.length === 1 ? (agents.find((agent) => agent.sessionId === picked[0])?.title ?? W.agentsSome(1)) : W.agentsSome(picked.length);
  const picker = <AgentPicker agents={agents} picked={picked} onChange={onChange} />;
  return (
    <>
      <span ref={(element) => setAnchor(element?.querySelector('button') ?? null)} className="v2-tasks-agents" data-tour="v2-tasks-agents">
        <Button size="sm" icon="agents" aria-haspopup="dialog" aria-expanded={open} title={W.agentsLabel} onClick={() => setOpen((on) => !on)} data-testid="v2-tasks-agents">
          {label}
        </Button>
      </span>
      {phone ? (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={W.agentsLabel} testId="v2-tasks-agents-sheet">
          {picker}
        </BottomSheet>
      ) : (
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={W.agentsLabel} align="start" width={360} testId="v2-tasks-agents-popover">
          {picker}
        </Popover>
      )}
    </>
  );
}

/** D188: one agent's section of the grouped board: its header (fold), then its own columns. */
function AgentSectionView({ section, folded, onFold, phoneColumn, actions, busy, now, extras }: { readonly section: ReturnType<typeof agentSections>[number]; readonly folded: boolean; readonly onFold: () => void; readonly phoneColumn: TaskColumn; readonly actions: CardActions; readonly busy: ReadonlySet<string>; readonly now: number; readonly extras: CardExtras }) {
  const { group } = section;
  const machine = useLiveMachine(group.machine ?? null);
  const id = `v2-tasks-sec-${group.sessionId}`;
  return (
    <section className="v2-tasks-section" data-folded={folded ? 'true' : undefined} data-testid="v2-tasks-section" data-session={group.sessionId} aria-labelledby={id}>
      <h2 className="v2-tasks-section-h" id={id}>
        <button type="button" className="v2-tasks-section-fold" aria-expanded={!folded} aria-label={folded ? W.sectionUnfold(group.title) : W.sectionFold(group.title)} onClick={onFold} data-testid="v2-tasks-section-fold">
          <Icon name={folded ? 'chev' : 'chev-down'} size="s" />
        </button>
        <V2Link to={{ area: 'agent', id: group.sessionId, tab: 'chat' }} className="v2-tasks-section-name">
          {group.title}
        </V2Link>
        {machine ? <ComputerTag name={machine.name} state={computerStateToV2(machine.state)} short /> : null}
        <span className="v2-muted v2-tasks-section-counts">{W.sectionCounts(section.total, section.open)}</span>
      </h2>
      {folded ? null : (
        <div className="v2-tasks-board" data-show={phoneColumn}>
          {TASK_COLUMNS.map((column) => (
            <Column key={column} column={column} cards={section.board[column]} actions={actions} busy={busy} now={now} extras={extras} scope={`${group.sessionId}-`} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A task in full: its description, its handover plan, its agent, and what can be done with it. */
function TaskDetail({ card, onClose, actions, busy, now }: { readonly card: TaskCard | null; readonly onClose: () => void; readonly actions: CardActions; readonly busy: boolean; readonly now: number }) {
  if (!card) return null;
  const { todo } = card;
  const estimate = estimateText(todo, now);
  const look = TASK_COLUMN_LOOK[card.column];
  const footer = (
    <>
      <Button
        variant="danger"
        icon="trash"
        onClick={() => {
          onClose();
          actions.remove(card);
        }}
        data-testid="v2-tasks-detail-delete"
      >
        {W.delete}
      </Button>
      <span className="v2-grow" />
      {todo.state === 'open' ? <OpenActions card={card} actions={actions} busy={busy} size="m" /> : <Button onClick={onClose}>{W.close}</Button>}
    </>
  );
  return (
    <Dialog open onClose={onClose} title={todo.title} icon="task" width={620} testId="v2-tasks-detail" footer={footer}>
      <div className="v2-tasks-detail">
        <div className="v2-tasks-meta">
          <Chip tone={look.tone ?? undefined} icon={look.icon} size="s">
            {COLUMN_WORD[card.column]}
          </Chip>
          <Priority priority={todo.priority} />
          {estimate ? <span className="v2-tasks-est">{estimate}</span> : null}
        </div>
        <Owner card={card} onNavigate={onClose} />
        <h3>{W.description}</h3>
        <div className="v2-tasks-text" data-testid="v2-tasks-description">
          {todo.description ?? <span className="v2-muted">{todo.needsEnrichment ? W.waitingFill : W.noDescription}</span>}
        </div>
        <h3>
          {W.plan} <span className="v2-muted">· {W.planSub}</span>
        </h3>
        <div className="v2-tasks-text" data-testid="v2-tasks-plan">
          {todoHasPlan(todo.plan) ? todo.plan : <span className="v2-muted">{todo.plan && todo.plan.trim() !== 'No plan' ? todo.plan : W.noPlan}</span>}
        </div>
        {moveTargets(todo).length > 0 ? (
          <div className="v2-tasks-actions v2-tasks-moves">
            {moveTargets(todo).map((to) => (
              <Button
                key={to}
                size="sm"
                icon={TASK_COLUMN_LOOK[to].icon}
                onClick={() => {
                  onClose();
                  actions.move(card, to);
                }}
                data-testid={`v2-tasks-detail-move-${to}`}
              >
                {W.moveTo(COLUMN_WORD[to])}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * D131 · Tasks (`/tasks`), lane A: every agent's todo items (`GET /api/todos`, this
 * computer's and the paired ones') on a board Open · In progress · Review · Done with
 * estimate vs actual; quick add (a capture into the chosen agent), Task with details
 * (+ New), Import from Jira or GitHub; Start here / Run in its own agent on open tasks;
 * live from `/hub` (`todosChanged`, the session list). Rules in `tasks-model.ts`.
 */
export function TasksPage() {
  const groups = useApi(api.todos);
  const sessions = useSessionListOf('open');
  const plans = usePlans();
  const toast = useToast();
  const { navigate, search } = useV2Router();
  const now = useClock();
  const reload = useThrottled(groups.reload, 300);
  useHubEvent('todosChanged', () => reload());
  const reloadNow = groups.reload;

  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<{ readonly sessionId: string; readonly todoId: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [phoneColumn, setPhoneColumn] = useState<TaskColumn>('open');
  const [quick, setQuick] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const pending = useRef(new Map<string, { readonly timer: number; readonly send: () => void }>());
  const quickRef = useRef<HTMLInputElement | null>(null);

  const list = sessions.data;
  const statusOf = useMemo(() => {
    const byId = new Map<string, SessionStatus>((list ?? []).map((session) => [session.id, session.status]));
    return (id: string): SessionStatus | null => byId.get(id) ?? null;
  }, [list]);
  const targets = useMemo(() => captureTargets(list ?? []), [list]);
  const chosenTarget = target && targets.some((session) => session.id === target) ? target : (targets[0]?.id ?? null);
  const importAgents = useMemo(() => targets.filter((session) => session.kind !== 'chat'), [targets]);

  const all: readonly TodoGroup[] = useMemo(() => groups.data ?? [], [groups.data]);
  // D188: which agents' tasks the board shows: the address's `?agent=` (a link from an agent), else this browser's remembered pick.
  const [stored, setStored] = useState<readonly string[]>(() => readStoredAgents(readStorage(TASKS_AGENTS_KEY)));
  const fromAddress = useMemo(() => agentsFromSearch(search), [search]);
  const agents = useMemo(() => taskAgents(all), [all]);
  const asked = fromAddress ?? stored;
  // An agent that no longer has tasks never hides the whole board (only once the list is in).
  const picked = useMemo(() => (groups.data ? liveFilter(asked, agents) : [...asked]), [groups.data, asked, agents]);
  const setPicked = useCallback(
    (ids: string[]) => {
      setStored(ids);
      writeStorage(TASKS_AGENTS_KEY, JSON.stringify(ids));
      navigate(`/tasks${agentsSearch(ids)}`, { replace: true });
    },
    [navigate],
  );
  const [grouping, setGrouping] = usePref<'on' | 'off'>(TASKS_GROUP_KEY, 'off', (value): value is 'on' | 'off' => value === 'on' || value === 'off');
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(readStoredAgents(readStorage(TASKS_FOLDED_KEY))));
  const fold = (sessionId: string): void =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      writeStorage(TASKS_FOLDED_KEY, JSON.stringify([...next]));
      return next;
    });
  const shown = useMemo(() => filterGroups(all, picked), [all, picked]);
  const board = useMemo(() => boardOf(shown, statusOf, hidden), [shown, statusOf, hidden]);
  const sections = useMemo(() => (grouping === 'on' ? agentSections(shown, statusOf, hidden) : []), [grouping, shown, statusOf, hidden]);
  const total = TASK_COLUMNS.reduce((sum, column) => sum + board[column].length, 0);
  const anyTask = all.some((group) => group.todos.length > 0);
  const accuracy = estimateAccuracy(shown.map((group) => group.actuals));

  const unhide = useCallback((key: string) => {
    setHidden((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  // A delete still in its Undo window is sent when the page goes (or the tab closes).
  useEffect(() => {
    const map = pending.current;
    const flush = (): void => {
      for (const [key, entry] of map) {
        window.clearTimeout(entry.timer);
        map.delete(key);
        withKeepalive(() => entry.send());
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const mark = (key: string, on: boolean): void =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const write = useCallback(
    async <T,>(key: string, action: () => Promise<T>): Promise<T | null> => {
      mark(key, true);
      try {
        const result = await action();
        reloadNow();
        return result;
      } catch (error) {
        toast({ text: refusal(error), tone: 'error' });
        return null;
      } finally {
        mark(key, false);
      }
    },
    [reloadNow, toast],
  );

  const actions: CardActions = {
    start: (card) => {
      const key = cardKey(card.group.sessionId, card.todo.id);
      const working = statusOf(card.group.sessionId) === 'run';
      void write(key, () => startHere(card.group.sessionId, card.todo)).then((ok) => {
        if (ok === null) return;
        toast({
          text: working ? W.started(card.todo.title, card.group.title) : W.startedNow(card.todo.title, card.group.title),
          actionLabel: W.open,
          undo: () => navigate({ area: 'agent', id: card.group.sessionId, tab: 'chat' }),
        });
      });
    },
    run: (card) => {
      const key = cardKey(card.group.sessionId, card.todo.id);
      void write(key, () => api.runTodo(card.group.sessionId, card.todo.id)).then((result) => {
        if (result === null) return;
        toast({ text: W.ran(card.todo.title), actionLabel: W.open, undo: () => navigate({ area: 'agent', id: result.session.id, tab: 'chat' }) });
      });
    },
    move: (card, to) => {
      const patch = movePatch(card.todo, to);
      if (!patch) return;
      const key = cardKey(card.group.sessionId, card.todo.id);
      const before = card.todo.state;
      void write(key, () => api.updateTodo(card.group.sessionId, card.todo.id, patch)).then((ok) => {
        if (ok === null) return;
        toast({ text: W.moved(card.todo.title, COLUMN_WORD[to]), undo: () => write(key, () => api.updateTodo(card.group.sessionId, card.todo.id, { state: before })) });
      });
    },
    remove: (card) => {
      const key = cardKey(card.group.sessionId, card.todo.id);
      if (pending.current.has(key)) return;
      setHidden((current) => new Set(current).add(key));
      const send = (): void => {
        void api.deleteTodo(card.group.sessionId, card.todo.id).then(
          () => {
            reloadNow();
            unhide(key);
          },
          (error: unknown) => {
            unhide(key);
            toast({ text: refusal(error), tone: 'error' });
          },
        );
      };
      const timer = window.setTimeout(() => {
        pending.current.delete(key);
        send();
      }, DELETE_DELAY_MS);
      pending.current.set(key, { timer, send });
      toast({
        text: W.deleted(card.todo.title),
        ms: DELETE_DELAY_MS,
        undo: () => {
          const entry = pending.current.get(key);
          if (!entry) return;
          window.clearTimeout(entry.timer);
          pending.current.delete(key);
          unhide(key);
        },
      });
    },
    open: (card) => setDetail({ sessionId: card.group.sessionId, todoId: card.todo.id }),
    save: async (card, fields) => (await write(cardKey(card.group.sessionId, card.todo.id), () => api.updateTodo(card.group.sessionId, card.todo.id, savePatch(fields)))) !== null,
  };
  const extras: CardExtras = {
    statusOf,
    planLink: (todo) => (plans.on ? todoPlanLink(plans.plans, todo) : null),
    runTitle: (id) => {
      const session = id ? (list ?? []).find((candidate) => candidate.id === id) : undefined;
      return session ? displayTitle(session) : null;
    },
  };

  const detailCard = useMemo(() => {
    if (!detail) return null;
    for (const column of TASK_COLUMNS) {
      const found = board[column].find((card) => card.group.sessionId === detail.sessionId && card.todo.id === detail.todoId);
      if (found) return found;
    }
    return null;
  }, [board, detail]);

  const addQuick = async (): Promise<void> => {
    const input = quickAddInput(quick);
    if (!input || chosenTarget === null || quickBusy) return;
    const agent = targets.find((session) => session.id === chosenTarget);
    const agentName = agent ? displayTitle(agent) : chosenTarget;
    const sessionId = chosenTarget;
    setQuickBusy(true);
    try {
      const before = new Set((await api.sessionTodos(sessionId).catch(() => null))?.todos.map((todo) => todo.id) ?? all.find((group) => group.sessionId === sessionId)?.todos.map((todo) => todo.id) ?? []);
      const answer = await captureTodo(sessionId, { title: input.title, note: input.note, from: 'palette' });
      setQuick('');
      reloadNow();
      const added = addedTodo(before, answer.todos);
      toast({ text: W.added(input.title, agentName), undo: added ? () => write(cardKey(sessionId, added.id), () => api.deleteTodo(sessionId, added.id)) : undefined });
    } catch (error) {
      toast({ text: refusal(error), tone: 'error' });
    } finally {
      setQuickBusy(false);
      window.setTimeout(() => quickRef.current?.focus(), 0);
    }
  };

  const onQuickKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void addQuick();
  };

  const loading = groups.data === null && groups.error === null;
  return (
    <div className="v2-page v2-tasks" data-wide="" data-testid="v2-page-tasks" data-area="tasks">
      <h1>{W.title}</h1>
      <p className="v2-page-sub">{W.sub}</p>
      <div className="v2-tasks-bar">
        <div className="v2-tasks-quick">
          <Field
            ref={quickRef}
            className="v2-tasks-quick-input"
            placeholder={W.quickAdd}
            aria-label={W.quickAddLabel}
            value={quick}
            disabled={chosenTarget === null}
            readOnly={quickBusy}
            title={chosenTarget === null ? W.noAgentToAdd : undefined}
            onChange={(event) => setQuick(event.target.value)}
            onKeyDown={onQuickKey}
            data-testid="v2-tasks-quick"
          />
          {targets.length > 0 ? (
            <Select className="v2-tasks-target" aria-label={W.addToLabel} value={chosenTarget ?? ''} onChange={(event) => setTarget(event.target.value)} options={targets.map((session) => ({ value: session.id, label: `${W.addTo} ${displayTitle(session)}` }))} data-testid="v2-tasks-target" />
          ) : null}
        </div>
        <Button size="sm" icon="plus" onClick={() => openNew({ kind: 'task' })} data-testid="v2-tasks-new">
          {W.withDetails}
        </Button>
        <span className="v2-grow" />
        {agents.length > 0 ? <AgentFilter agents={agents} picked={picked} onChange={setPicked} /> : null}
        {agents.length > 0 ? (
          <span className="v2-tasks-group">
            <Switch checked={grouping === 'on'} onChange={(on) => setGrouping(on ? 'on' : 'off')} label={W.groupByAgent} testId="v2-tasks-group" />
            <span className="v2-tasks-group-word" aria-hidden="true" onClick={() => setGrouping(grouping === 'on' ? 'off' : 'on')}>
              {W.groupByAgent}
            </span>
          </span>
        ) : null}
        <Button size="sm" icon="download" onClick={() => setImportOpen(true)} data-testid="v2-tasks-import-open">
          {W.import}
        </Button>
      </div>
      {picked.length > 0 ? (
        <div className="v2-tasks-chips" data-testid="v2-tasks-agent-chips">
          {picked.map((id) => {
            const agent = agents.find((candidate) => candidate.sessionId === id);
            const name = agent?.title ?? id;
            return (
              <span key={id} className="v2-tasks-chip" data-testid="v2-tasks-agent-chip">
                <Icon name="agents" size="s" />
                <span className="v2-tasks-chip-name">{name}</span>
                {agent?.computer ? <span className="v2-muted"> · {agent.computer}</span> : null}
                <button type="button" className="v2-tasks-chip-x" aria-label={W.agentRemove(name)} onClick={() => setPicked(picked.filter((other) => other !== id))} data-testid="v2-tasks-agent-chip-x">
                  <Icon name="x" size="s" />
                </button>
              </span>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setPicked([])} data-testid="v2-tasks-agent-chips-clear">
            {W.agentsClear}
          </Button>
        </div>
      ) : null}
      {targets.length === 0 && list !== null ? (
        <p className="v2-tasks-note" data-testid="v2-tasks-noagent">
          {W.noAgentToAdd}
        </p>
      ) : null}
      {loading ? (
        <div className="v2-tasks-board" data-testid="v2-tasks-skeleton" aria-busy="true">
          {TASK_COLUMNS.map((column) => (
            <div key={column} className="v2-tasks-col" data-col={column}>
              <Skeleton width="50%" height={14} />
              <div style={{ height: 12 }} />
              <Skeleton lines={2} height={72} />
            </div>
          ))}
        </div>
      ) : groups.error && groups.data === null ? (
        <EmptyState icon="alert" tone="grey" title={W.loadError} text={refusal(groups.error)} action={<Button onClick={reloadNow}>Try again</Button>} />
      ) : total === 0 && !anyTask ? (
        <EmptyState icon="task" tone="grey" title={W.emptyTitle} text={W.emptyText} testId="v2-tasks-empty" />
      ) : total === 0 ? (
        <EmptyState icon="task" tone="grey" title={W.filteredEmpty} action={<Button onClick={() => setPicked([])}>{W.agentsClear}</Button>} testId="v2-tasks-filtered-empty" />
      ) : (
        <>
          <div className="v2-tasks-switch">
            <Segmented label={W.columns} size="s" value={phoneColumn} onChange={setPhoneColumn} options={TASK_COLUMNS.map((column) => ({ value: column, label: COLUMN_WORD[column], hint: String(board[column].length) }))} testId="v2-tasks-switch" />
          </div>
          {grouping === 'on' ? (
            <div className="v2-tasks-sections" data-testid="v2-tasks-sections">
              {sections.map((section) => (
                <AgentSectionView key={section.group.sessionId} section={section} folded={folded.has(section.group.sessionId)} onFold={() => fold(section.group.sessionId)} phoneColumn={phoneColumn} actions={actions} busy={busy} now={now} extras={extras} />
              ))}
              {accuracy ? (
                <p className="v2-tasks-accuracy" data-testid="v2-tasks-accuracy" data-tour="v2-tasks-accuracy">
                  {W.accuracy(accuracy.percent, accuracy.count)}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="v2-tasks-board" data-show={phoneColumn} data-testid="v2-tasks-board">
              {TASK_COLUMNS.map((column) => (
                <Column key={column} column={column} cards={board[column]} actions={actions} busy={busy} now={now} extras={extras} footer={column === 'done' && accuracy ? W.accuracy(accuracy.percent, accuracy.count) : null} />
              ))}
            </div>
          )}
        </>
      )}
      <TaskDetail card={detailCard} onClose={() => setDetail(null)} actions={actions} busy={detailCard ? busy.has(cardKey(detailCard.group.sessionId, detailCard.todo.id)) : false} now={now} />
      <ImportTasksDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        agents={importAgents}
        onImported={(count, source, agentId, agentName) => {
          reloadNow();
          toast({ text: W.importDone(count, source, agentName), actionLabel: W.open, undo: () => navigate({ area: 'agent', id: agentId, tab: 'chat' }) });
        }}
      />
    </div>
  );
}
