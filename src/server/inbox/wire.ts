import type { BranchRef, InboxAction, InboxItem, Question } from '../../core/api.ts';
import { toolLabel } from '../../core/derive/event-kind.ts';
import type { PermissionRequestRecord } from '../db/repos/permissions.ts';
import type { QuestionBatchRecord, QuestionRecord } from '../db/repos/questions.ts';
import type { SystemItemRecord } from '../db/repos/system-items.ts';
import type { Store } from '../db/store.ts';

/**
 * API shapes of the Inbox (M3.1 + M3.2, `docs/questions.md`, `docs/inbox.md`):
 * `Question` rows for `/hub` `questionBatch` and the Inbox, the Inbox items of a
 * question batch, of a permission request (D6) and of a system item, the list of
 * `GET /api/inbox`, and the Inbox count behind `inboxChanged`.
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
 * The name part of a question source (prototype: the part before the first
 * `" · "`, so `web · microfrontends/acme-app-front` → `web`); a source without it
 * is returned as it is.
 */
export function sourceName(source: string): string {
  const cut = source.indexOf(' · ');
  return cut === -1 ? source : source.slice(0, cut);
}

/**
 * The last folder of a workspace-relative path (`microfrontends/acme-app-front` →
 * `acme-app-front`, `mobile/` → `mobile`); the path itself when it has none.
 */
function lastSegment(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/**
 * The branch chips of a session's Inbox items (prototype: `solution ⎇ branch` of
 * every agent that has a branch, in agent order), followed by the session's live
 * worktrees (`repo ⎇ branch`, M2.2) that no agent already names. Duplicates
 * (same solution and branch) are dropped.
 */
export async function sessionBranches(store: Store, sessionId: string): Promise<BranchRef[]> {
  const out: BranchRef[] = [];
  const seen = new Set<string>();
  const add = (solution: string, branch: string): void => {
    const key = `${solution}\u0000${branch}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ solution, branch });
  };
  for (const agent of await store.agents.listBySession(sessionId)) {
    if (agent.branch) add(lastSegment(agent.solutionPath ?? ''), agent.branch);
  }
  for (const worktree of await store.worktrees.list({ sessionId })) add(worktree.repo, worktree.branch);
  return out;
}

/**
 * The Inbox item of a question batch (prototype copy): kind label `Question` or
 * `n questions`; title = the question verbatim, or `n questions from <sources>`
 * (each source's name part, {@link sourceName}); branch chips from
 * {@link sessionBranches}.
 */
export async function questionBatchItem(store: Store, batch: QuestionBatchRecord, questions?: readonly QuestionRecord[]): Promise<InboxItem> {
  const rows = questions ?? (await store.questions.questionsOf(batch.id));
  const session = await store.sessions.get(batch.sessionId);
  const sources = [...new Set(rows.map((question) => sourceName(question.source)))];
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
    branches: await sessionBranches(store, batch.sessionId),
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
    branches: await sessionBranches(store, record.sessionId),
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
 * Kind labels of the system items the service raises (M3.3), prototype copy. A
 * kind without an entry is shown as it is stored.
 */
export const SYSTEM_ITEM_LABELS: Readonly<Record<string, string>> = {
  'schedule-run-failed': 'Scheduled run failed',
  'worktree-removable': 'PR merged',
};

/**
 * The Inbox item of a system item (M3.3 raises them): its stored source, status,
 * title, detail, branch chips and actions (the first is primary), and the kind
 * label from {@link SYSTEM_ITEM_LABELS}.
 */
export function systemItem(record: SystemItemRecord): InboxItem {
  return {
    id: record.id,
    kind: 'system',
    sessionId: record.sessionId,
    source: record.source,
    status: record.status,
    title: record.title,
    label: SYSTEM_ITEM_LABELS[record.kind] ?? record.kind,
    detail: record.detail,
    createdAt: record.createdAt,
    branches: record.branches.map((branch) => ({ solution: branch.solution, branch: branch.branch })),
    actions: record.actions.map((action) => ({ id: action.id, label: action.label })),
  };
}

/** Newest first by `createdAt`; ties keep the given order. */
function newestFirst<T extends { readonly createdAt: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * `GET /api/inbox` (M3.2, `docs/inbox.md`). The items that wait on a session come
 * first, newest first (the sidebar's session order): question batches that wait
 * for the developer (open, or stale and unanswered) and open permission requests.
 * Open system items follow in the order they were raised, oldest first (the
 * prototype's order). The same items {@link inboxCount} counts.
 */
export async function listInbox(store: Store): Promise<InboxItem[]> {
  const batches = (await store.questions.listBatches({ states: ['open', 'stale'] })).filter(isBatchWaiting).reverse();
  const permissions = (await store.permissions.list({ states: ['open'] })).reverse();
  const waiting = newestFirst<{ readonly createdAt: string; readonly item: () => Promise<InboxItem> }>([
    ...batches.map((batch) => ({ createdAt: batch.createdAt, item: () => questionBatchItem(store, batch) })),
    ...permissions.map((record) => ({ createdAt: record.createdAt, item: () => permissionItem(store, record) })),
  ]);
  const items: InboxItem[] = [];
  for (const entry of waiting) items.push(await entry.item());
  const system = (await store.systemItems.list(['open'])).reverse();
  for (const record of system) items.push(systemItem(record));
  return items;
}

/**
 * How many items the Inbox lists (`inboxChanged.count`): waiting question batches
 * (open, or stale and unanswered), open permission requests and open system items
 * (the items of {@link listInbox}).
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
