import type { InboxAction, InboxItem, Question } from '../../core/api.ts';
import { toolLabel } from '../../core/derive/event-kind.ts';
import type { PermissionRequestRecord } from '../db/repos/permissions.ts';
import type { QuestionBatchRecord, QuestionRecord } from '../db/repos/questions.ts';
import type { Store } from '../db/store.ts';

/**
 * API shapes of the question pipeline (M3.1, `docs/questions.md`): `Question` rows
 * for `/hub` `questionBatch` and the Inbox, the Inbox items of a question batch and
 * of a permission request (D6), and the Inbox count behind `inboxChanged`.
 */

/** The Inbox actions of a permission item (D6): Allow once (primary), Deny. */
export const PERMISSION_ACTIONS: readonly InboxAction[] = [
  { id: 'allow-once', label: 'Allow once' },
  { id: 'deny', label: 'Deny' },
];

/** A stored question as the API and `/hub` return it; its state is its batch's state. */
export function toQuestion(record: QuestionRecord, batch: QuestionBatchRecord): Question {
  return {
    id: record.id,
    batchId: record.batchId,
    sessionId: record.sessionId,
    source: record.source,
    text: record.text,
    header: record.header,
    options: record.options,
    multiSelect: record.multiSelect,
    state: batch.state,
    answerIndex: record.answerIndex,
    answeredAt: record.answeredAt,
  };
}

/** `true` while a batch waits for the developer: open, or stale and still unanswered (it stays answerable). */
export function isBatchWaiting(batch: QuestionBatchRecord): boolean {
  return batch.answeredAt === null && (batch.state === 'open' || batch.state === 'stale');
}

/**
 * The Inbox item of a question batch (prototype copy): kind label `Question` or
 * `n questions`; title = the question verbatim, or `n questions from <sources>`.
 * `branches` stay empty here (M3.2 adds them from the session's agents/worktrees).
 */
export async function questionBatchItem(store: Store, batch: QuestionBatchRecord, questions?: readonly QuestionRecord[]): Promise<InboxItem> {
  const rows = questions ?? (await store.questions.questionsOf(batch.id));
  const session = await store.sessions.get(batch.sessionId);
  const sources = [...new Set(rows.map((question) => question.source))];
  const many = rows.length > 1;
  return {
    id: batch.id,
    kind: 'questions',
    sessionId: batch.sessionId,
    source: session?.name ?? batch.sessionId,
    status: 'need',
    title: many ? `${rows.length} questions from ${sources.join(', ')}` : (rows[0]?.text ?? ''),
    label: many ? `${rows.length} questions` : 'Question',
    detail: '',
    createdAt: batch.createdAt,
    branches: [],
    questions: rows.map((row) => toQuestion(row, batch)),
  };
}

/**
 * The Inbox item of a permission request (D6): title = the tool's one-line label,
 * detail = the model's own description (else the CLI's decision reason); the tool
 * name and its input are in `permission`, verbatim. The agent is the subagent whose
 * `task_started.task_id` equals the request's `agent_id`, else the main agent.
 */
export async function permissionItem(store: Store, record: PermissionRequestRecord): Promise<InboxItem> {
  const session = await store.sessions.get(record.sessionId);
  const input = isRecord(record.input) ? record.input : {};
  const agents = await store.agents.listBySession(record.sessionId);
  const agent = record.agentId
    ? (agents.find((a) => a.taskId === record.agentId) ?? null)
    : (agents.find((a) => a.kind === 'main') ?? null);
  return {
    id: record.id,
    kind: 'permission',
    sessionId: record.sessionId,
    source: session?.name ?? record.sessionId,
    status: 'need',
    title: toolLabel(record.toolName, input),
    label: 'Permission',
    detail: record.description ?? record.decisionReason ?? '',
    createdAt: record.createdAt,
    branches: [],
    actions: PERMISSION_ACTIONS,
    permission: {
      requestId: record.requestId,
      toolName: record.toolName,
      input: record.input,
      description: record.description,
      decisionReason: record.decisionReason,
      agentId: record.agentId,
      agent: agent?.name ?? null,
    },
  };
}

/**
 * How many items the Inbox lists (`inboxChanged.count`): waiting question batches
 * (open, or stale and unanswered), open permission requests and open system items.
 */
export async function inboxCount(store: Store): Promise<number> {
  const batches = (await store.questions.listBatches({ states: ['open', 'stale'] })).filter(isBatchWaiting).length;
  const permissions = (await store.permissions.list({ states: ['open'] })).length;
  const system = (await store.systemItems.list(['open'])).length;
  return batches + permissions + system;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
