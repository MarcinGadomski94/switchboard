import { sessionProfileId } from '../../core/accounts.ts';
import type { Agent, Artifact, FileDiff, HookStatus, Question, Session, SessionActivity, SessionContext, SessionDetail, SessionEvent, SessionFreshContinue, SessionLink, SessionModel, SessionProviderSwitch, SessionRemote } from '../../core/api.ts';
import { terminalResumeCommand } from '../../core/cli-providers.ts';
import { sessionChips } from '../../core/derive/chips.ts';
import { learnWindows, readContextState, resolveContext } from '../../core/context-meter.ts';
import type { AgentRecord } from '../db/repos/agents.ts';
import type { ArtifactRecord } from '../db/repos/artifacts.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { isBatchWaiting, toQuestion } from '../inbox/wire.ts';
import { toLoop } from '../loops/wire.ts';
import type { Providers } from '../providers.ts';
import { resumeCommand } from '../supervisor/argv.ts';
import { reportedTable } from './reported-table.ts';
import type { WorkflowSource } from '../workflows/service.ts';

/** How many recent events `GET /api/sessions/{id}` includes (the rest via `/events`). */
export const DETAIL_EVENT_LIMIT = 200;

/**
 * D51: where `toSession` finds a store's Workflow runs (the supervisor's
 * `WorkflowService`, registered when it is created). Keyed by the store, so every
 * app in a process (tests start many) has its own; a store without one has none.
 */
const workflowSources = new WeakMap<Store, WorkflowSource>();

/** D51: registers the Workflow runs `toSession` adds for this store's sessions. */
export function registerWorkflowSource(store: Store, source: WorkflowSource): void {
  workflowSources.set(store, source);
}

/**
 * D53: a hooked terminal session's live activity and delivery state (the
 * `HookService`, registered when it is created), keyed by the store like
 * {@link registerWorkflowSource}.
 */
export interface HookSource {
  /** The session's live activity (`null` while no turn runs). */
  activity(sessionId: string): SessionActivity | null;
  /** The session's delivery state (`null` for a closed one). */
  status(record: SessionRecord): Promise<HookStatus | null>;
}

const hookSources = new WeakMap<Store, HookSource>();

/** D53: registers the hooked sessions' activity and delivery state `toSession` adds for this store's sessions. */
export function registerHookSource(store: Store, source: HookSource): void {
  hookSources.set(store, source);
}

/**
 * D62 P5: a session's running CLI switch (the supervisor's, registered when it is
 * created), keyed by the store like {@link registerWorkflowSource}.
 */
export interface SwitchSource {
  /** The switch in progress for the session, `null` when none runs. */
  current(sessionId: string): SessionProviderSwitch | null;
  /** D63: an account switch of the session runs. */
  accountSwitching?(sessionId: string): boolean;
  /** D83: a continuation in a fresh session runs (its step), `null` when none. */
  fresh?(sessionId: string): SessionFreshContinue | null;
}

const switchSources = new WeakMap<Store, SwitchSource>();

/** D62 P5: registers where `toSession` reads a session's switch in progress. */
export function registerSwitchSource(store: Store, source: SwitchSource): void {
  switchSources.set(store, source);
}

/**
 * D62: the terminal command that continues the session: Claude Code's
 * `claude --resume <id>`, else the session's CLI's own (`codex resume <thread>`,
 * `opencode --session <id>`) once that CLI has an id for it, else Claude's.
 */
export async function sessionResumeCommand(store: Store, record: Pick<SessionRecord, 'id' | 'provider' | 'claudeSessionId'>): Promise<string> {
  if (record.provider === 'claude') return resumeCommand(record.claudeSessionId);
  const native = await store.providers.nativeId(record.id, record.provider);
  return terminalResumeCommand(record.provider, native) ?? resumeCommand(record.claudeSessionId);
}

/** An agent row as the API returns it. */
export function toAgent(record: AgentRecord): Agent {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    solutionPath: record.solutionPath,
    branch: record.branch,
    status: record.status,
    statusText: record.statusText,
    // D36: links the main agent's Agent / Task call to the subagent's chat.
    toolUseId: record.toolUseId,
    // D51: only a workflow's agents have one (they are not stored: `toSession` adds them).
    workflow: null,
  };
}

/** An event row as the API and `/hub` return it. */
export function toEvent(record: EventRecord): SessionEvent {
  return {
    id: record.id,
    sessionId: record.sessionId,
    agentId: record.agentId,
    ts: record.ts,
    endTs: record.endTs,
    kind: record.kind,
    label: record.label,
    payload: record.payload,
  };
}

/** D89: a saved artifact as the API returns it (no content). */
export function toArtifact(record: ArtifactRecord): Artifact {
  return {
    id: record.id,
    sessionId: record.sessionId,
    title: record.title,
    kind: record.kind,
    language: record.language,
    createdBy: record.createdBy,
    versions: record.versions,
    size: record.size,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Questions of the session's batches that still wait for the developer (M3.1,
 * docs/questions.md): open ones, and stale ones not answered yet (they stay
 * answerable; their answers go out as a user message). D33: batches closed with
 * the session do not wait.
 */
async function openQuestionCount(store: Store, sessionId: string): Promise<number> {
  const batches = await store.questions.listBatches({ sessionId, states: ['open', 'stale'] });
  let count = 0;
  for (const batch of batches) if (isBatchWaiting(batch)) count += (await store.questions.questionsOf(batch.id)).length;
  return count;
}

/**
 * `GET /api/sessions` item: the session with its agents and open question count,
 * plus the header's fields (M4.1): `cwd`, the session's folder (D14: `folder`
 * id, `folderPath`, `folderKind`), `live` (a supervised process is
 * running: its pid is recorded), the handoff command and the chips (session-start
 * answers + the session's observed loops, `src/core/derive/chips.ts`), and its loops
 * (M7.2, the Schedules & loops cards). `activity` (D19) is the live activity the
 * supervisor holds in memory (`SessionSupervisor.activity`); `null` when not given.
 * D22: its `title` (`null` when none) and `displayTitle` (the title, else the name),
 * what the UI shows. D24: its `remote` state ({@link toSessionRemote}). D25:
 * `remoteSource`, the remote session a teleported session is a local copy of
 * (`null` otherwise). D31: its `model` ({@link toSessionModel}). D33: `closedAt`,
 * when the developer closed it (`null` while open). D48: `machine` is `null` (a
 * session of this machine).
 */
export async function toSession(store: Store, record: SessionRecord, activity: SessionActivity | null = null): Promise<Session> {
  const agents = await store.agents.listBySession(record.id);
  const loops = await store.loops.list(record.id);
  // D51: the session's Workflow runs and their agents (after the stored agents, in run order).
  const workflows = (await workflowSources.get(store)?.forSession(record)) ?? { runs: [], agents: [] };
  // D53: a hooked session's activity comes from its transcript and hooks (it has no process), with its delivery state.
  const hookSource = record.hooked ? hookSources.get(store) : undefined;
  const live = activity ?? (hookSource && record.closedAt === null ? hookSource.activity(record.id) : null);
  const hookStatus = hookSource ? await hookSource.status(record) : null;
  return {
    id: record.id,
    name: record.name,
    claudeSessionId: record.claudeSessionId,
    status: record.status,
    workType: record.workType,
    mode: record.mode,
    phase: record.phase,
    coordination: record.coordination,
    qaStack: record.qaStack,
    ultracode: record.ultracode,
    worktrees: record.worktrees,
    solutions: record.solutions,
    attached: record.attached,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    agents: [...agents.map(toAgent), ...workflows.agents],
    workflows: workflows.runs,
    openQuestionCount: await openQuestionCount(store, record.id),
    cwd: record.cwd,
    folder: record.folderId,
    folderPath: record.root,
    folderKind: record.rootKind,
    origin: record.origin,
    live: record.pid !== null,
    activity: live,
    resumeCommand: await sessionResumeCommand(store, record),
    chips: sessionChips(record, loops),
    loops: loops.map(toLoop),
    title: record.title,
    displayTitle: record.title ?? record.name,
    remoteSource: record.remoteSource,
    remote: toSessionRemote(record),
    model: toSessionModel(record),
    closedAt: record.closedAt,
    context: toSessionContext(record),
    // D48: this machine's own session (a peer's carries its machine, core/peer-wire.ts).
    machine: null,
    // D48 P4: a hand-started terminal session Switchboard hooked into.
    hooked: record.hooked,
    // D53: what a message to it waits on (hooked sessions only).
    ...(record.hooked ? { hookStatus } : {}),
    // D62: the session's CLI and a switch in progress.
    provider: record.provider,
    providerSwitch: switchSources.get(store)?.current(record.id) ?? null,
    // D63: the account profile (its name for the header), the pin, a profile switch in progress.
    profileId: sessionProfileId(record),
    profileName: (await store.profiles.get(sessionProfileId(record)))?.name ?? 'Default',
    profilePinned: record.profilePinned,
    accountSwitching: switchSources.get(store)?.accountSwitching?.(record.id) ?? false,
    // D65: taken over to / from another machine.
    movedTo: record.movedTo,
    movedFrom: record.movedFrom,
    // D76: a todo's run session: the item it works on.
    todoLink: record.todoLink,
    // D68: the open items of its todo list (the sidebar badge, the Todos nav count).
    openTodoCount: await store.todos.openCount(record.id),
    // D83: continued in / from a fresh session (linked both ways), a continuation in progress.
    continuedTo: await sessionLink(store, record.continuedTo),
    continuedFrom: await sessionLink(store, record.continuedFrom),
    freshContinue: switchSources.get(store)?.fresh?.(record.id) ?? null,
  };
}

/** D83: the other session of a continuation, with its display title now (`null` when it is gone); `null` without a link. */
async function sessionLink(store: Store, id: string | null): Promise<SessionLink | null> {
  if (id === null) return null;
  const other = await store.sessions.get(id);
  return { sessionId: id, title: other ? (other.title ?? other.name) : null };
}

/**
 * D49 (`docs/chat.md` → *Context bar*): `Session.context`, the stored meter
 * resolved against the session's model choice (the window follows D31 / D42
 * changes). `null` when Switchboard never ran a process for the session
 * (`remoteAvailable` is `null`, as for {@link toSessionModel}) and nothing is
 * stored, i.e. the demo seed, whose composer shows no bar.
 */
export function toSessionContext(record: Pick<SessionRecord, 'remoteAvailable' | 'context' | 'model'>): SessionContext | null {
  if (record.remoteAvailable === null && record.context === null) return null;
  const state = readContextState(record.context);
  learnWindows(state.windows);
  return resolveContext(state, record.model);
}

/**
 * D31 (`docs/model-effort.md`): `Session.model`: the stored model and effort
 * (`null` = the CLI's default) and the models the session's last process
 * reported (`null` until one did). `null` when there is no model information at
 * all: Switchboard never ran a process for the session (`remoteAvailable` is
 * `null`, set at every spawn since 0007) and nothing is stored, i.e. the demo seed,
 * whose header shows no pickers.
 */
export function toSessionModel(record: Pick<SessionRecord, 'remoteAvailable' | 'model' | 'effort' | 'modelOptions'>): SessionModel | null {
  if (record.remoteAvailable === null && record.model === null && record.effort === null && record.modelOptions === null) return null;
  return { current: record.model, effort: record.effort, available: record.modelOptions };
}

/**
 * D24 (`docs/remote-control.md`): `Session.remote`. `null` when Switchboard never
 * ran a process for the session (`remoteAvailable` is `null`: the demo seed);
 * else `available` = a live process (a recorded pid) whose `initialize` reported
 * `remote_control_available: true`, `enabled` = the stored flag (on across a
 * pause: the next process reattaches), `url` = the last bridge's link.
 */
export function toSessionRemote(record: Pick<SessionRecord, 'pid' | 'remoteAvailable' | 'remoteEnabled' | 'remoteSessionUrl'>): SessionRemote | null {
  if (record.remoteAvailable === null) return null;
  return {
    available: record.remoteAvailable && record.pid !== null,
    enabled: record.remoteEnabled,
    url: record.remoteSessionUrl,
  };
}

/**
 * Every question the session asked (M4.2, the chat's inline card and answers
 * bubble): its batches oldest first, each batch's questions in order, in the
 * contract's `Question` shape (state = the batch's state).
 */
export async function sessionQuestions(store: Store, sessionId: string): Promise<Question[]> {
  const out: Question[] = [];
  for (const batch of await store.questions.listBatches({ sessionId })) {
    for (const question of await store.questions.questionsOf(batch.id)) out.push(toQuestion(question, batch));
  }
  return out;
}

/**
 * `GET /api/sessions/{id}`: the session plus its task, recent events, changed
 * files, artifacts, (M4.2) questions and (D21) the newest status table the agent
 * printed in the chat.
 */
export async function toSessionDetail(
  store: Store,
  providers: Providers,
  record: SessionRecord,
  activity: SessionActivity | null = null,
): Promise<SessionDetail> {
  const session = await toSession(store, record, activity);
  const events = await store.events.latest(record.id, DETAIL_EVENT_LIMIT);
  const artifacts = await store.artifacts.list({ sessionId: record.id });
  let files: FileDiff[] = [];
  if (providers.diff) {
    try {
      files = await providers.diff.diff(record.id);
    } catch {
      files = [];
    }
  }
  return {
    ...session,
    task: record.task,
    events: events.map(toEvent),
    files,
    artifacts: artifacts.map(toArtifact),
    questions: await sessionQuestions(store, record.id),
    reportedTable: await reportedTable(store, record.id, session.agents.find((agent) => agent.kind === 'main')?.id ?? null),
  };
}
