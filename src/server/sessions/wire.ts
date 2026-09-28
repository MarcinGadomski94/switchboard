import type { Agent, Artifact, FileDiff, Question, Session, SessionDetail, SessionEvent } from '../../core/api.ts';
import { sessionChips } from '../../core/derive/chips.ts';
import type { AgentRecord } from '../db/repos/agents.ts';
import type { ArtifactRecord } from '../db/repos/artifacts.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { toQuestion } from '../inbox/wire.ts';
import { toLoop } from '../loops/wire.ts';
import type { Providers } from '../providers.ts';
import { resumeCommand } from '../supervisor/argv.ts';

/** How many recent events `GET /api/sessions/{id}` includes (the rest via `/events`). */
export const DETAIL_EVENT_LIMIT = 200;

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

/** An artifact row as the API returns it. */
export function toArtifact(record: ArtifactRecord): Artifact {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    solution: record.solution,
    branch: record.branch,
    sessionId: record.sessionId,
    meta: record.meta,
    createdAt: record.createdAt,
  };
}

/**
 * Questions of the session's batches that still wait for the developer (M3.1,
 * docs/questions.md): open ones, and stale ones not answered yet (they stay
 * answerable; their answers go out as a user message).
 */
async function openQuestionCount(store: Store, sessionId: string): Promise<number> {
  const batches = await store.questions.listBatches({ sessionId, states: ['open', 'stale'] });
  let count = 0;
  for (const batch of batches) if (batch.answeredAt === null) count += (await store.questions.questionsOf(batch.id)).length;
  return count;
}

/**
 * `GET /api/sessions` item: the session with its agents and open question count,
 * plus the header's fields (M4.1): `cwd`, the session's folder (D14: `folder`
 * id, `folderPath`, `folderKind`), `live` (a supervised process is
 * running: its pid is recorded), the handoff command and the chips (session-start
 * answers + the session's observed loops, `src/core/derive/chips.ts`), and its loops
 * (M7.2, the Schedules & loops cards).
 */
export async function toSession(store: Store, record: SessionRecord): Promise<Session> {
  const agents = await store.agents.listBySession(record.id);
  const loops = await store.loops.list(record.id);
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
    agents: agents.map(toAgent),
    openQuestionCount: await openQuestionCount(store, record.id),
    cwd: record.cwd,
    folder: record.folderId,
    folderPath: record.root,
    folderKind: record.rootKind,
    live: record.pid !== null,
    resumeCommand: resumeCommand(record.claudeSessionId),
    chips: sessionChips(record, loops),
    loops: loops.map(toLoop),
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

/** `GET /api/sessions/{id}`: the session plus its task, recent events, changed files, artifacts and (M4.2) questions. */
export async function toSessionDetail(store: Store, providers: Providers, record: SessionRecord): Promise<SessionDetail> {
  const session = await toSession(store, record);
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
  };
}
