import type { BranchRef, InboxAction, InboxItem, NewSessionPrefill, Question } from '../../core/api.ts';
import { type CliProviderId, isCliProviderId } from '../../core/cli-providers.ts';
import { toolLabel } from '../../core/derive/event-kind.ts';
import { type QueuedReason, clipInput } from '../../core/event-payload.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { PermissionRequestRecord } from '../db/repos/permissions.ts';
import { type QuestionBatchRecord, type QuestionRecord, ownAnswerOf } from '../db/repos/questions.ts';
import type { SystemItemRecord } from '../db/repos/system-items.ts';
import type { Store } from '../db/store.ts';
// Team (D100) hook (docs/team-removal.md).
import { labelInboxItems } from '../team/hooks.ts';

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

/** D48 P4: a hooked terminal session's request: Allow once (primary), Always allow (when the CLI suggested rules), Deny. */
export function hookPermissionActions(alwaysAllow: boolean): readonly InboxAction[] {
  return alwaysAllow
    ? [{ id: 'allow-once', label: 'Allow once' }, { id: 'always-allow', label: 'Always allow' }, { id: 'deny', label: 'Deny' }]
    : PERMISSION_ACTIONS;
}

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
    // D128: every pick of a multi-select answer.
    answerIndexes: record.answerIndexes ?? null,
    // D39: the developer's own answer ("Other…"), verbatim.
    answerText: ownAnswerOf(record),
    // D24: answered on the phone (Remote Control) before Switchboard answered.
    answeredOn: batch.answeredOn,
    // D33: closed without answers (its session was closed).
    closedReason: batch.closedReason,
    // D44: the answers wait in the session's outbox until its next run.
    queued: batchQueued(batch),
  };
}

/**
 * D44: `resume` while a batch's answers wait in the session's outbox: a stale
 * batch answered but not delivered yet (`docs/questions.md`: answered while the
 * session had no live process, they go out with its next message); else `null`.
 */
export function batchQueued(batch: QuestionBatchRecord): QueuedReason | null {
  return batch.state === 'stale' && batch.answeredAt !== null && batch.deliveredVia === null && batch.closedReason === null ? 'resume' : null;
}

/**
 * `true` while a batch waits for the developer: open, or stale and still
 * unanswered (it stays answerable), and not closed with its session (D33).
 */
export function isBatchWaiting(batch: QuestionBatchRecord): boolean {
  return batch.answeredAt === null && batch.closedReason === null && (batch.state === 'open' || batch.state === 'stale');
}

/**
 * The name part of a question source (prototype: the part before the first
 * `" · "`, so `web · microfrontends/acme-web-front` → `web`); a source without it
 * is returned as it is.
 */
export function sourceName(source: string): string {
  const cut = source.indexOf(' · ');
  return cut === -1 ? source : source.slice(0, cut);
}

/**
 * The last folder of a workspace-relative path (`microfrontends/acme-web-front` →
 * `acme-web-front`, `mobile/` → `mobile`); the path itself when it has none.
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

/** D96: the longest question context an Inbox item carries (characters). */
export const QUESTION_CONTEXT_LIMIT = 2000;

/** What {@link callContext} needs of a waiting tool call. */
export interface WaitingCall {
  readonly sessionId: string;
  /** The call's `tool_use` id; `null` for a hooked terminal session's request (the hook does not name it). */
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly input: unknown;
}

/** The stored event of a waiting call: by its `tool_use` id, else (a hooked request) the newest open call of that tool, its input first. */
async function waitingCallEvent(store: Store, call: WaitingCall): Promise<EventRecord | null> {
  if (call.toolUseId) return store.events.findToolCall(call.sessionId, call.toolUseId);
  const open = (await store.events.toolCallsNewestFirst(call.sessionId, call.toolName, 10)).filter((event) => event.endTs === null);
  const input = JSON.stringify(clipInput(isRecord(call.input) ? call.input : {}).input);
  return open.find((event) => JSON.stringify((event.payload as { input?: unknown } | null)?.input ?? {}) === input) ?? open[0] ?? null;
}

/**
 * D96 (`docs/chat.md` → *Progress notes*): the context of a waiting call (an
 * AskUserQuestion batch, D96-q1 a permission request): the text of the agent's
 * message directly above the call in the chat (the same agent's event right before
 * the call, when it is agent text: a progress note or ordinary text), cut at
 * {@link QUESTION_CONTEXT_LIMIT}; `''` when the call is not stored (yet) or
 * something else came right before it. A hooked terminal session's request names
 * no `tool_use` id: its call is the newest still-open call of that tool (the one
 * with the same input first), once the transcript sync stored it.
 */
export async function callContext(store: Store, waiting: WaitingCall): Promise<string> {
  const call = await waitingCallEvent(store, waiting);
  if (!call) return '';
  const [before] = await store.events.page(waiting.sessionId, {
    limit: 1,
    before: call,
    ...(call.agentId ? { agent: { id: call.agentId, toolUseId: null } } : {}),
  });
  const payload = before?.payload as { type?: unknown; text?: unknown } | null | undefined;
  if (!payload || payload.type !== 'assistant' || typeof payload.text !== 'string') return '';
  const text = payload.text.trim();
  return text.length > QUESTION_CONTEXT_LIMIT ? `${text.slice(0, QUESTION_CONTEXT_LIMIT - 1)}…` : text;
}

/** D96: a question batch's context ({@link callContext} of its AskUserQuestion call). */
export function questionContext(store: Store, batch: QuestionBatchRecord): Promise<string> {
  return callContext(store, { sessionId: batch.sessionId, toolUseId: batch.toolUseId, toolName: 'AskUserQuestion', input: batch.input });
}

/** D96-q1: a permission request's context ({@link callContext} of the call it asks about). */
export function permissionContext(store: Store, record: PermissionRequestRecord): Promise<string> {
  return callContext(store, { sessionId: record.sessionId, toolUseId: record.toolUseId, toolName: record.toolName, input: record.input });
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
    // D22: the Inbox shows the session's title (else its name).
    sourceTitle: session ? (session.title ?? session.name) : batch.sessionId,
    status: 'need',
    title: many ? `${rows.length} questions from ${sources.join(', ')}` : (rows[0]?.text ?? ''),
    label: many ? `${rows.length} questions` : 'Question',
    // D96: the agent's message right above the question (often a progress note) is its context.
    detail: await questionContext(store, batch),
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
  const context = await permissionContext(store, record);
  return {
    id: record.id,
    kind: 'permission',
    sessionId: record.sessionId,
    source: session?.name ?? record.sessionId,
    sourceTitle: session ? (session.title ?? session.name) : record.sessionId,
    status: 'need',
    title: toolLabel(record.toolName, input),
    label: 'Permission',
    detail: record.description ?? record.decisionReason ?? '',
    createdAt: record.createdAt,
    branches: await sessionBranches(store, record.sessionId),
    // D96-q1: the agent's message right above the call, shown above the description.
    ...(context ? { context } : {}),
    actions: record.hookSuggestions === null ? PERMISSION_ACTIONS : hookPermissionActions(record.hookSuggestions.length > 0),
    permission: {
      requestId: record.requestId,
      toolName: record.toolName,
      input: record.input,
      description: record.description,
      decisionReason: record.decisionReason,
      agentId: record.agentId,
      agent: agent?.name ?? null,
      // D48 P4: a hooked terminal session's request (Deny with a message; Always allow when the CLI suggested rules).
      hook: record.hookSuggestions === null ? null : { denyMessage: true, alwaysAllow: record.hookSuggestions.length > 0 },
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
  // D47: a stacked task's parent PR merged.
  'parent-merged': 'Parent merged',
  // D47 ruling: a stacked task's parent PR closed without a merge.
  'parent-closed': 'Parent closed',
  // D55: a newer Switchboard release.
  'update-available': 'Update available',
  // D102: a plan item waits for the developer's Merge.
  'plan-ready-to-merge': 'Ready to merge',
  // D99 follow-up 2026-10-15: a held item of a plan without a merge step waits for the developer's confirmation.
  'plan-confirm': 'Confirm done',
  // D115 follow-ups 2026-10-20: a plan's items wait for its agent to pick their repositories.
  'plan-pick-repos': 'Pick repositories',
  // D120: a plan item's agent ended its turn without finishing its todo.
  'plan-stopped': 'Stopped',
  // D149: an agents-mode plan item was done with its work not merged into the target.
  'plan-done-unmerged': 'Done without merging',
  // D124: a session's turn ended waiting for the developer (its turn_status, or the text check: "· detected").
  'turn-waiting': 'Waiting for you',
  // D121: a plan item marked merged without its branch in the target was reopened.
  'plan-reopened': 'Reopened',
  // Project memory (D107) hook: a folder's open memory proposals (docs/memory-removal.md).
  'memory-proposals': 'Memory',
  // Project memory (D107) hook (follow-up 2026-10-16): a moved member's memory could not be copied.
  'memory-copy': 'Memory',
  // D109: the PR watcher.
  'ci-failing': 'CI keeps failing',
  'ci-ready': 'Ready to merge',
  // D139: an account the CLI refuses to run until the developer acts (new terms, signed out).
  'account-needs-you': 'Account needs you',
  // D142: this machine has a single usable account of a CLI, a paired machine one more.
  'account-hint': 'Accounts',
};

/**
 * The New-session values stored with a system item (`payload.prefill`, M3.3
 * "Open fix session"), or `null` when it has none.
 */
export function systemItemPrefill(record: SystemItemRecord): NewSessionPrefill | null {
  const payload = record.payload;
  if (!isRecord(payload) || !isRecord(payload['prefill'])) return null;
  return payload['prefill'] as NewSessionPrefill;
}

/**
 * The Inbox item of a system item (M3.3 raises them, `docs/system-items.md`): its
 * stored source, status, title, detail, branch chips and actions (the first is
 * primary), the kind label from {@link SYSTEM_ITEM_LABELS}, and `prefill` when it
 * stores one.
 */
export function systemItem(record: SystemItemRecord): InboxItem {
  const prefill = systemItemPrefill(record);
  // D102: the page an "open" action goes to (a plan's Ready-to-merge item: Open plan).
  const route = isRecord(record.payload) && typeof record.payload['route'] === 'string' ? record.payload['route'] : null;
  // D109: the PR an item is about (Open PR's link).
  const url = isRecord(record.payload) && typeof record.payload['url'] === 'string' && /^https:\/\//.test(record.payload['url']) ? record.payload['url'] : null;
  // D139: the terminal command an account's "needs you" item shows (copyable).
  const command = record.kind === 'account-needs-you' && isRecord(record.payload) && typeof record.payload['command'] === 'string' ? record.payload['command'] : null;
  // D142: what "Add it there" prefills (Settings › Accounts on the item's machine).
  const addAccount = record.kind === 'account-hint' ? addAccountOf(record.payload) : null;
  return {
    id: record.id,
    kind: 'system',
    sessionId: record.sessionId,
    source: record.source,
    status: record.status,
    title: record.title,
    label: `${SYSTEM_ITEM_LABELS[record.kind] ?? record.kind}${record.kind === 'turn-waiting' && isRecord(record.payload) && record.payload['detected'] === true ? ' · detected' : ''}`,
    // D124: a "Waiting for you" item says its kind (the push and Team read it).
    ...(record.kind === 'turn-waiting' || record.kind === 'account-needs-you' || record.kind === 'account-hint' ? { systemKind: record.kind } : {}),
    ...(command !== null ? { command } : {}),
    detail: record.detail,
    createdAt: record.createdAt,
    branches: record.branches.map((branch) => ({ solution: branch.solution, branch: branch.branch })),
    actions: record.actions.map((action) => ({ id: action.id, label: action.label })),
    ...(prefill ? { prefill } : {}),
    ...(route ? { route } : {}),
    ...(url ? { url } : {}),
    ...(addAccount ? { addAccount } : {}),
  };
}

/** D142: an account-hint item's `payload.addAccount` (`{ cli, name }`), `null` when it has none. */
function addAccountOf(payload: unknown): { readonly cli: CliProviderId; readonly name: string } | null {
  const add = isRecord(payload) && isRecord(payload['addAccount']) ? payload['addAccount'] : null;
  return add && isCliProviderId(add['cli']) && typeof add['name'] === 'string' && add['name'] !== '' ? { cli: add['cli'], name: add['name'] } : null;
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
 * prototype's order). The same
 * items {@link inboxCount} counts.
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
  // Team (D100) hook: member sessions' items carry the role name (docs/team-removal.md).
  return labelInboxItems(store, items);
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
