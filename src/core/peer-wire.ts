/**
 * D48 (`docs/peers.md` → *Proxy*): a peer's API answers and `/hub` events as the
 * local UI sees them. Every id that addresses something through the API (a
 * session id, a question batch id, an Inbox item id) becomes a remote id,
 * `r~<machineId>~<id>` (`remoteId`), so it never collides with a local id and the
 * local service knows where to forward a request that names it. A peer's session
 * also carries `machine` (the tag, and whether it is reachable). Ids that only
 * matter inside one answer (question ids, agent ids, event ids) stay as they are.
 * Pure: no I/O.
 */
import type { Artifact, HubEventName, HubEvents, InboxItem, Loop, Question, Schedule, Session, SessionDetail, SessionEvent, SessionTodo, SessionTodoList, TerminalLoop, TodoGroup } from './api.ts';
import { type SessionMachine, parseRemoteId, remoteId } from './peers.ts';
import type { Review } from './reviews.ts';
import { DEFAULT_TODO_PRIORITY, TODO_NO_PLAN, checkTodoEstimate, isTodoPriority, todoStateOf } from './todos.ts';

/** The machine whose answers are mapped. */
export type PeerMachineRef = SessionMachine;

function ns(machine: PeerMachineRef, id: string): string {
  return remoteId(machine.id, id);
}

function nsMaybe(machine: PeerMachineRef, id: string | null | undefined): string | null {
  return typeof id === 'string' && id !== '' ? ns(machine, id) : (id ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A peer's {@link Session}: its id and its loops' session ids namespaced, `machine`
 * added. D53: no live activity while the machine is not online (its last known
 * activity would read as a turn still running there).
 */
export function peerSession(machine: PeerMachineRef, session: Session): Session {
  return {
    ...session,
    id: ns(machine, session.id),
    activity: machine.state === 'online' ? (session.activity ?? null) : null,
    loops: (session.loops ?? []).map((loop: Loop) => ({ ...loop, sessionId: ns(machine, loop.sessionId) })),
    machine: { id: machine.id, name: machine.name, state: machine.state },
    // D76: a run session's source session is on the same machine.
    ...(session.todoLink ? { todoLink: { ...session.todoLink, sourceSessionId: ns(machine, session.todoLink.sourceSessionId) } } : {}),
  };
}

/** A peer's {@link SessionEvent}; an AskUserQuestion call's `payload.requestId` (its batch id) is namespaced too. */
export function peerEvent(machine: PeerMachineRef, event: SessionEvent): SessionEvent {
  const payload = event.payload;
  const mapped = isRecord(payload) && typeof payload['requestId'] === 'string' ? { ...payload, requestId: ns(machine, payload['requestId']) } : payload;
  return { ...event, sessionId: ns(machine, event.sessionId), payload: mapped };
}

/** A peer's {@link Question}: batch and session ids namespaced (the question id stays: answers name it). */
export function peerQuestion(machine: PeerMachineRef, question: Question): Question {
  return { ...question, batchId: ns(machine, question.batchId), sessionId: ns(machine, question.sessionId) };
}

function peerArtifact(machine: PeerMachineRef, artifact: Artifact): Artifact {
  return { ...artifact, sessionId: nsMaybe(machine, artifact.sessionId) };
}

/** A peer's {@link SessionDetail}. */
export function peerSessionDetail(machine: PeerMachineRef, detail: SessionDetail): SessionDetail {
  return {
    ...detail,
    ...peerSession(machine, detail),
    events: (detail.events ?? []).map((event) => peerEvent(machine, event)),
    artifacts: (detail.artifacts ?? []).map((artifact) => peerArtifact(machine, artifact)),
    questions: (detail.questions ?? []).map((question) => peerQuestion(machine, question)),
  };
}

/** A peer's {@link InboxItem}: its id (a batch id for questions), session and questions namespaced, `machine` added. */
export function peerInboxItem(machine: PeerMachineRef, item: InboxItem): InboxItem {
  return {
    ...item,
    id: ns(machine, item.id),
    sessionId: nsMaybe(machine, item.sessionId),
    ...(item.questions ? { questions: item.questions.map((question) => peerQuestion(machine, question)) } : {}),
    // D79: a review item's card is acted on through its (remote) id.
    ...(item.review ? { review: peerReview(machine, item.review) } : {}),
    machine: { id: machine.id, name: machine.name, state: machine.state },
  };
}

/** D79: a peer's review card: its id and session id namespaced, `machine` added. */
export function peerReview(machine: PeerMachineRef, review: Review): Review {
  // A peer before the D79 ruling sends no `handledByAgent`: false.
  return { ...review, id: ns(machine, review.id), sessionId: ns(machine, review.sessionId), handledByAgent: review.handledByAgent === true, machine: { id: machine.id, name: machine.name, state: machine.state } };
}

/**
 * D52: a peer's {@link Schedule}: its id and its runs' session ids namespaced,
 * `machine` added. `folder` and `template` stay as the peer sent them (its own
 * folder ids: an Edit loads that machine's folders).
 */
export function peerSchedule(machine: PeerMachineRef, schedule: Schedule): Schedule {
  return {
    ...schedule,
    id: ns(machine, schedule.id),
    runs: (schedule.runs ?? []).map((run) => ({ ...run, sessionId: nsMaybe(machine, run.sessionId) })),
    machine: { id: machine.id, name: machine.name, state: machine.state },
  };
}

/** D52: a peer's {@link TerminalLoop}: the loop id namespaced (the terminal's claude session id stays raw: it is hooked on that machine), `machine` added. */
export function peerTerminalLoop(machine: PeerMachineRef, entry: TerminalLoop): TerminalLoop {
  return { ...entry, loop: { ...entry.loop, id: ns(machine, entry.loop.id) }, machine: { id: machine.id, name: machine.name, state: machine.state } };
}

/** D68: a peer's todo item: its session id namespaced (the item id stays: the routes name it under its session). */
export function peerTodo(machine: PeerMachineRef, todo: SessionTodo): SessionTodo {
  // D69: a peer still on 1.7.0 sends `text` only: it is the title, with no description or plan.
  const title = typeof todo.title === 'string' ? todo.title : String(todo.text ?? '');
  // D70: a peer on 1.7.0 / 1.8.0 sends no priority or estimate, and maybe no plan: medium, none, No plan (like migration 0028).
  const raw = todo as Partial<SessionTodo>;
  const plan = typeof raw.plan === 'string' && raw.plan.trim() !== '' ? raw.plan : TODO_NO_PLAN;
  const estimate = checkTodoEstimate(raw.estimateMinutes);
  return {
    ...todo,
    sessionId: ns(machine, todo.sessionId),
    title,
    text: title,
    description: todo.description ?? null,
    plan,
    priority: isTodoPriority(raw.priority) ? raw.priority : DEFAULT_TODO_PRIORITY,
    estimateMinutes: estimate.ok ? estimate.value : null,
    // D75: a peer before 1.12 knows open / done only (and sends no start); anything unknown reads as open.
    state: todoStateOf(raw.state),
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    startedBy: raw.startedBy === 'start' || raw.startedBy === 'agent' || raw.startedBy === 'developer' || raw.startedBy === 'run' ? raw.startedBy : null,
    // D76: the run session is on the same machine.
    runSessionId: typeof raw.runSessionId === 'string' ? ns(machine, raw.runSessionId) : null,
  };
}

/** D68: a peer's session todo list (`GET /api/sessions/{id}/todos` and every write's answer). */
export function peerTodoList(machine: PeerMachineRef, list: SessionTodoList): SessionTodoList {
  return { ...list, sessionId: ns(machine, list.sessionId), todos: (list.todos ?? []).map((todo) => peerTodo(machine, todo)) };
}

/** D68: a peer's {@link TodoGroup} (the Todos page): its session id namespaced, `machine` added. */
export function peerTodoGroup(machine: PeerMachineRef, group: TodoGroup): TodoGroup {
  return {
    ...group,
    sessionId: ns(machine, group.sessionId),
    todos: (group.todos ?? []).map((todo) => peerTodo(machine, todo)),
    machine: { id: machine.id, name: machine.name, state: machine.state },
  };
}

/**
 * The `/hub` events a peer's stream forwards (the rest are the peer's own
 * business: worktrees, its machine). D52: `scheduleRun` and `schedulesChanged`, so
 * a paired machine refreshes the peer's schedules when one changes there.
 */
export const PEER_HUB_EVENTS: ReadonlySet<HubEventName> = new Set<HubEventName>(['sessionUpdated', 'event', 'questionBatch', 'inboxChanged', 'activity', 'scheduleRun', 'schedulesChanged', 'todosChanged', 'reviewsChanged']);

/**
 * A peer's `/hub` event as the local bus publishes it, or `null` for one that is
 * not forwarded. `inboxChanged` keeps the peer's count (the caller replaces it with
 * the local total).
 */
export function peerHubEvent<K extends HubEventName>(machine: PeerMachineRef, name: K, payload: HubEvents[K]): HubEvents[K] | null {
  if (!PEER_HUB_EVENTS.has(name)) return null;
  const value = payload as unknown;
  if (!isRecord(value)) return null;
  switch (name) {
    case 'sessionUpdated':
      return peerSession(machine, value as unknown as Session) as HubEvents[K];
    case 'event': {
      const event = value as unknown as HubEvents['event'];
      return { sessionId: ns(machine, event.sessionId), event: peerEvent(machine, event.event) } as HubEvents[K];
    }
    case 'questionBatch': {
      const batch = value as unknown as HubEvents['questionBatch'];
      return {
        sessionId: ns(machine, batch.sessionId),
        batchId: ns(machine, batch.batchId),
        questions: (batch.questions ?? []).map((question) => peerQuestion(machine, question)),
      } as unknown as HubEvents[K];
    }
    case 'activity': {
      const activity = value as unknown as HubEvents['activity'];
      return { sessionId: ns(machine, activity.sessionId), activity: activity.activity } as HubEvents[K];
    }
    case 'inboxChanged':
      return payload;
    case 'reviewsChanged': {
      // D79: a peer's review card changed: its session id namespaced.
      const changed = value as unknown as HubEvents['reviewsChanged'];
      return typeof changed.sessionId === 'string' ? ({ sessionId: ns(machine, changed.sessionId) } as HubEvents[K]) : null;
    }
    case 'todosChanged': {
      const changed = value as unknown as HubEvents['todosChanged'];
      return typeof changed.sessionId === 'string' ? ({ ...changed, sessionId: ns(machine, changed.sessionId) } as HubEvents[K]) : null;
    }
    case 'scheduleRun':
    case 'schedulesChanged': {
      const run = value as { scheduleId?: unknown };
      return typeof run.scheduleId === 'string' ? ({ ...value, scheduleId: ns(machine, run.scheduleId) } as unknown as HubEvents[K]) : null;
    }
    default:
      return null;
  }
}

/** Which mapping a forwarded answer gets, by the local API path it came from (method + path without the query). */
/** D50: `wrapped` = an answer that carries a Session under `session` (the Stop's `InterruptResult`, `StopBackgroundResult`). D51: `workflow-chat`. */
/** D52: `schedule` / `schedules` (a peer's schedules), `terminal-loops`. */
/** Fix · long messages: `full-event` (a cut event's whole text, `FullEventAnswer`). */
/** D68: `todo-list` (a session's todo list), `todo-groups` (the Todos page). */
/** D76: `todo-run` (a todo run's answer). D79: `review` (a review action's answer), `reviews` (`GET /api/reviews`). */
export type PeerAnswerKind = 'session' | 'sessions' | 'detail' | 'events' | 'workflow-chat' | 'full-event' | 'inbox' | 'wrapped' | 'schedule' | 'schedules' | 'terminal-loops' | 'todo-list' | 'todo-run' | 'todo-groups' | 'review' | 'reviews' | 'none';

/**
 * The mapping of a forwarded API answer (`docs/peers.md` → *Proxy*): the answer
 * of `path` (the peer's own path, ids already raw) with `method`.
 */
export function peerAnswerKind(method: string, path: string): PeerAnswerKind {
  const pathname = path.split('?')[0] as string;
  const upper = method.toUpperCase();
  if (pathname === '/api/sessions') return upper === 'GET' ? 'sessions' : upper === 'POST' ? 'session' : 'none';
  if (pathname === '/api/inbox') return upper === 'GET' ? 'inbox' : 'none';
  // D52: the schedules (the list, Save schedule, Run now, Pause, Resume; Delete answers 204) and the terminal sessions' loops.
  if (pathname === '/api/schedules') return upper === 'GET' ? 'schedules' : upper === 'POST' ? 'schedule' : 'none';
  if (upper === 'POST' && /^\/api\/schedules\/[^/]+\/(?:run|pause|resume)$/.test(pathname)) return 'schedule';
  if (pathname === '/api/terminal-loops') return upper === 'GET' ? 'terminal-loops' : 'none';
  // D68: a session's todo list (every route under it answers the whole list) and the Todos page's groups.
  // D75: also ▶ Start (`…/todos/{todoId}/start`).
  // D76: ▸ Run in new session answers the run session and the list.
  if (upper === 'POST' && /^\/api\/sessions\/[^/]+\/todos\/[^/]+\/run$/.test(pathname)) return 'todo-run';
  if (/^\/api\/sessions\/[^/]+\/todos(?:\/[^/]+(?:\/order|\/clear-done|\/start)?)?$/.test(pathname)) return 'todo-list';
  if (pathname === '/api/todos') return upper === 'GET' ? 'todo-groups' : 'none';
  // D79: the review cards and their actions (each answers the card).
  if (pathname === '/api/reviews') return upper === 'GET' ? 'reviews' : 'none';
  if (upper === 'POST' && /^\/api\/reviews\/[^/]+\/[a-z-]+$/.test(pathname)) return 'review';
  if (/^\/api\/terminal-sessions\/[^/]+\/hook$/.test(pathname)) return 'session';
  // D51: a Workflow agent's chat: its events carry the session id.
  if (upper === 'GET' && /^\/api\/sessions\/[^/]+\/workflow-agents\/[^/]+\/chat$/.test(pathname)) return 'workflow-chat';
  // Fix · long messages: a cut event's whole text carries the event under `event`.
  if (upper === 'GET' && /^\/api\/sessions\/[^/]+\/events\/[^/]+\/full$/.test(pathname)) return 'full-event';
  // D50: the Stop's and the background stop's answers carry the session under `session`.
  if (upper === 'POST' && /^\/api\/sessions\/[^/]+\/(?:interrupt|background\/stop)$/.test(pathname)) return 'wrapped';
  const match = /^\/api\/sessions\/[^/]+(?:\/([a-z-]+))?$/.exec(pathname);
  if (!match) return 'none';
  const tail = match[1];
  if (tail === undefined) return upper === 'GET' ? 'detail' : 'none';
  if (tail === 'events') return 'events';
  // D72: Continue in Switchboard answers the continued session.
  if (['pause', 'resume', 'close', 'reopen', 'title', 'remote', 'model', 'continue-in-switchboard'].includes(tail)) return 'session';
  return 'none';
}

/** Maps a forwarded 2xx answer body by its {@link PeerAnswerKind}; anything that does not have the expected shape is passed as is. */
export function mapPeerAnswer(machine: PeerMachineRef, kind: PeerAnswerKind, body: unknown): unknown {
  switch (kind) {
    case 'session':
      return isRecord(body) && typeof body['id'] === 'string' ? peerSession(machine, body as unknown as Session) : body;
    case 'sessions':
      return Array.isArray(body) ? body.filter(isRecord).map((session) => peerSession(machine, session as unknown as Session)) : body;
    case 'detail':
      return isRecord(body) && typeof body['id'] === 'string' ? peerSessionDetail(machine, body as unknown as SessionDetail) : body;
    case 'events':
      return Array.isArray(body) ? body.filter(isRecord).map((event) => peerEvent(machine, event as unknown as SessionEvent)) : body;
    case 'workflow-chat':
      return isRecord(body) && Array.isArray(body['events'])
        ? { ...body, events: body['events'].filter(isRecord).map((event) => peerEvent(machine, event as unknown as SessionEvent)) }
        : body;
    case 'full-event':
      return isRecord(body) && isRecord(body['event']) ? { ...body, event: peerEvent(machine, body['event'] as unknown as SessionEvent) } : body;
    case 'inbox':
      return Array.isArray(body) ? body.filter(isRecord).map((item) => peerInboxItem(machine, item as unknown as InboxItem)) : body;
    case 'wrapped':
      return isRecord(body) && isRecord(body['session']) && typeof body['session']['id'] === 'string'
        ? { ...body, session: peerSession(machine, body['session'] as unknown as Session) }
        : body;
    case 'schedule':
      return isRecord(body) && typeof body['id'] === 'string' ? peerSchedule(machine, body as unknown as Schedule) : body;
    case 'schedules':
      return Array.isArray(body) ? body.filter(isRecord).map((schedule) => peerSchedule(machine, schedule as unknown as Schedule)) : body;
    case 'terminal-loops':
      return Array.isArray(body)
        ? body.filter((entry) => isRecord(entry) && isRecord(entry['loop'])).map((entry) => peerTerminalLoop(machine, entry as unknown as TerminalLoop))
        : body;
    case 'todo-list':
      return isRecord(body) && typeof body['sessionId'] === 'string' ? peerTodoList(machine, body as unknown as SessionTodoList) : body;
    case 'todo-run':
      return isRecord(body) && isRecord(body['session']) && isRecord(body['list'])
        ? { ...body, session: peerSession(machine, body['session'] as unknown as Session), list: peerTodoList(machine, body['list'] as unknown as SessionTodoList) }
        : body;
    case 'todo-groups':
      return Array.isArray(body) ? body.filter(isRecord).map((group) => peerTodoGroup(machine, group as unknown as TodoGroup)) : body;
    case 'review':
      return isRecord(body) && typeof body['id'] === 'string' && typeof body['sessionId'] === 'string' ? peerReview(machine, body as unknown as Review) : body;
    case 'reviews':
      return Array.isArray(body) ? body.filter((entry) => isRecord(entry) && typeof entry['id'] === 'string').map((review) => peerReview(machine, review as unknown as Review)) : body;
    case 'none':
      return body;
  }
}

/** `true` when a local id (session, batch, item) belongs to a peer. */
export function isPeerId(id: unknown): boolean {
  return parseRemoteId(id) !== null;
}
