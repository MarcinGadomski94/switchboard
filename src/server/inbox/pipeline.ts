import type { SessionActivity } from '../../core/api.ts';
import { mainAgentName } from '../../core/derive/agents.ts';
import type { UserMessageOrigin } from '../../core/event-payload.ts';
import type { AnswerDelivery, PermissionDecision } from '../../core/model.ts';
import { checkOwnAnswer } from '../../core/own-answer.ts';
import type { AnsweredOn } from '../../core/remote-control.ts';
import { SESSION_CLOSED_REASON, TURN_STOPPED_REASON } from '../../core/session-close.ts';
import type { ToolDecision } from '../../core/stdin.ts';
import type { PendingMessageRecord } from '../db/repos/pending-messages.ts';
import type { PermissionRequestRecord } from '../db/repos/permissions.ts';
import type { QuestionAnswer, QuestionCreate, QuestionOption, QuestionRecord } from '../db/repos/questions.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/table.ts';
import type { HubBus } from '../hub/bus.ts';
import { toSession } from '../sessions/wire.ts';
import { type CanUseToolContext, type ControlRequestHandler, SupervisorError } from '../supervisor/supervisor.ts';
import { inboxCount, isBatchWaiting, toQuestion } from './wire.ts';

/** The tool whose `can_use_tool` request is a question batch (M0.2). */
export const ASK_TOOL = 'AskUserQuestion';

/** The fixed Deny message (D6; the text recorded in `perm-deny.stdin.ndjson`). */
export const DENY_MESSAGE = 'The user denied this tool use in Switchboard.';

/** `pending_messages.kind` of a stale batch's answers waiting for the session's next run. */
export const STALE_ANSWERS_KIND = 'stale-answers';

/** The first line of the user message that carries a stale batch's answers. */
export const STALE_ANSWERS_HEADING = 'Answers to your earlier questions:';

/** The permission item actions of `POST /api/inbox/{id}/actions/{action}` (D6). */
export const PERMISSION_ACTION_IDS: readonly PermissionDecision[] = ['allow-once', 'deny'];

/** What the pipeline needs from the supervisor (structural, so tests can pass stand-ins). */
export interface QuestionSessions {
  /** Writes the one `control_response` to an open request; throws `request-not-open` otherwise. */
  respond(sessionId: string, requestId: string, decision: ToolDecision): Promise<void>;
  /** Sends a user message to a live process that is not being stopped; `false` = nothing written. */
  sendToLive(sessionId: string, text: string, origin?: UserMessageOrigin): Promise<boolean>;
  /** D19: the session's live activity, carried by the `sessionUpdated` the pipeline publishes (none = `null`). */
  activity?(sessionId: string): SessionActivity | null;
}

/**
 * Why the pipeline refused a call; `code` maps to an HTTP status in the routes.
 * `invalid-answer` (D39, 422) = an answer entry that names one question but holds
 * no usable answer: both or neither of `answerIndex` / `text`, or a `text` that is
 * not 1–2000 characters once trimmed.
 */
export type InboxErrorCode = 'not-found' | 'invalid' | 'invalid-answer' | 'already-answered' | 'not-open' | 'busy' | 'unknown-action';

/** D39: one refused answer of a 422 `invalid-answer`: the question and the field (`text`, or `answer` for both / neither). */
export interface AnswerFieldError {
  readonly questionId: string;
  readonly field: 'text' | 'answer';
  readonly message: string;
}

/** A refusal of the question pipeline. */
export class InboxError extends Error {
  override name = 'InboxError';
  readonly code: InboxErrorCode;
  /** D39: the refused answers of an `invalid-answer` (empty otherwise). */
  readonly errors: readonly AnswerFieldError[];
  constructor(code: InboxErrorCode, message: string, errors: readonly AnswerFieldError[] = []) {
    super(message);
    this.code = code;
    this.errors = errors;
  }
}

/** How a batch's answers left Switchboard: to the waiting request, as a user message now, or queued for the next run. */
export type AnswerOutcome = AnswerDelivery | 'queued';

/** Options for {@link QuestionPipeline}. */
export interface QuestionPipelineOptions {
  readonly store: Store;
  /** Where `questionBatch`, `inboxChanged` and `sessionUpdated` go (`/hub`). */
  readonly bus?: HubBus;
  /** Called when a hook fails (default: `console.error`). */
  readonly onError?: (error: unknown) => void;
}

/**
 * The question pipeline (M3.1) on the stdio control protocol (M0.2,
 * `docs/spike-m0.md` → *Recommendation for M3.1*; `docs/questions.md`). As the
 * supervisor's {@link ControlRequestHandler} it turns each `can_use_tool` request
 * into a question batch (AskUserQuestion) or an Inbox permission item (any other
 * tool, D6) and marks them stale when the CLI withdraws them or the process ends.
 * It answers them through the supervisor: one `control_response` per open request;
 * a stale batch's answers go to the session as a normal user message.
 */
export class QuestionPipeline implements ControlRequestHandler {
  readonly #store: Store;
  readonly #bus: HubBus | null;
  readonly #onError: (error: unknown) => void;
  #sessions: QuestionSessions | null = null;
  /** Batch / item ids with an answer being written (a second call gets 409). */
  readonly #busy = new Set<string>();

  constructor(options: QuestionPipelineOptions) {
    this.#store = options.store;
    this.#bus = options.bus ?? null;
    this.#onError = options.onError ?? ((error) => console.error('switchboard questions:', error));
  }

  /**
   * Connects the supervisor the answers go through. The supervisor takes this
   * pipeline as its handler when it is built, so the two are joined afterwards.
   */
  bind(sessions: QuestionSessions): this {
    this.#sessions = sessions;
    return this;
  }

  get #supervisor(): QuestionSessions {
    if (!this.#sessions) throw new Error('QuestionPipeline is not bound to a supervisor');
    return this.#sessions;
  }

  // ── ControlRequestHandler ─────────────────────────────────────────────

  /** A `can_use_tool` request: a question batch for AskUserQuestion, else a permission item. */
  async canUseTool({ session, request }: CanUseToolContext): Promise<void> {
    if (request.toolName === ASK_TOOL) {
      const questions = parseQuestions(request.input);
      if (questions) {
        if (await this.#store.questions.getBatch(request.requestId)) return;
        const source = await this.#mainAgent(session);
        const stored = await this.#store.questions.createBatch(
          { id: request.requestId, sessionId: session.id, toolUseId: request.toolUseId, input: request.input },
          questions.map((question) => ({ ...question, source })),
        );
        this.#bus?.publish('questionBatch', {
          sessionId: session.id,
          batchId: stored.batch.id,
          questions: stored.questions.map((question) => toQuestion(question, stored.batch)),
        });
        await this.#publishInbox();
        return;
      }
      // An input without readable questions is never answered for the developer: it becomes a permission item.
    }
    if (await this.#store.permissions.getByRequestId(session.id, request.requestId)) return;
    await this.#store.permissions.create({
      sessionId: session.id,
      requestId: request.requestId,
      toolUseId: request.toolUseId,
      toolName: request.toolName,
      input: request.input,
      description: request.description,
      decisionReason: request.decisionReason,
      agentId: request.agentId,
    });
    await this.#publishInbox();
  }

  /**
   * The CLI withdrew the request (`control_cancel_request`): stale, never answered
   * over the control protocol. D24: with `answeredOn` (`claude.ai`: the phone
   * answered first while Remote Control was on) a question batch is closed as
   * answered there instead (it leaves the Inbox and can no longer be answered
   * here); a permission item closes as stale, as before.
   */
  async cancelled(sessionId: string, requestId: string, answeredOn?: AnsweredOn | null): Promise<void> {
    const batch = answeredOn ? await this.#store.questions.getBatch(requestId) : null;
    if (answeredOn && batch && batch.sessionId === sessionId) {
      await this.#store.questions.closeAnsweredElsewhere(requestId, answeredOn);
      await this.#publishInbox();
      await this.#publishSession(sessionId);
      return;
    }
    await this.#markStale(sessionId, requestId);
    await this.#publishInbox();
  }

  /** The process ended with these requests open: stale. */
  async orphaned(sessionId: string, requestIds: readonly string[]): Promise<void> {
    for (const requestId of requestIds) await this.#markStale(sessionId, requestId);
    await this.#publishInbox();
  }

  /**
   * D50: the developer stopped the turn these requests belonged to (the CLI
   * withdrew them): a question batch closes without answers with the label
   * {@link TURN_STOPPED_REASON} (`closeUnanswered`), a permission request goes
   * stale; both leave the Inbox, and the chat's card shows the batch as closed.
   * Publishes `inboxChanged` and the session.
   */
  async stopped(sessionId: string, requestIds: readonly string[]): Promise<void> {
    for (const requestId of requestIds) {
      const batch = await this.#store.questions.getBatch(requestId);
      if (batch && batch.sessionId === sessionId) {
        await this.#store.questions.closeUnanswered(requestId, TURN_STOPPED_REASON);
        continue;
      }
      const permission = await this.#store.permissions.getByRequestId(sessionId, requestId);
      if (permission && permission.state === 'open') await this.#store.permissions.markStale(permission.id);
    }
    await this.#publishInbox();
    await this.#publishSession(sessionId);
  }

  /**
   * D33: the session was closed. Its question batches that still wait for the
   * developer (open, or stale and unanswered) are closed without answers with the
   * label `reason` (`session closed`; `closeUnanswered`: stale + `closedReason`),
   * and its open permission requests go stale (the stale path): all of them leave
   * the Inbox, and a closed batch can no longer be answered. Publishes
   * `inboxChanged` when anything closed. Stale answers already queued for the
   * session's next run stay queued (they were given before the close).
   */
  async closeSession(sessionId: string, reason: string = SESSION_CLOSED_REASON): Promise<void> {
    let changed = false;
    for (const batch of await this.#store.questions.listBatches({ sessionId, states: ['open', 'stale'] })) {
      if (!isBatchWaiting(batch)) continue;
      await this.#store.questions.closeUnanswered(batch.id, reason);
      changed = true;
    }
    for (const request of await this.#store.permissions.list({ sessionId, states: ['open'] })) {
      await this.#store.permissions.markStale(request.id);
      changed = true;
    }
    if (changed) await this.#publishInbox();
  }

  /**
   * Queued stale answers went out with a stdin message: record the batch as
   * delivered. D44: its answers no longer wait in the outbox (`Question.queued`),
   * so the session is published (`sessionUpdated`) and its chat reloads the batch.
   */
  async pendingDelivered(sessionId: string, messages: readonly PendingMessageRecord[]): Promise<void> {
    let delivered = false;
    for (const message of messages) {
      if (message.kind === STALE_ANSWERS_KIND && message.batchId) {
        await this.#store.questions.markDelivered(message.batchId, 'user_message');
        delivered = true;
      }
    }
    if (delivered) await this.#publishSession(sessionId);
  }

  // ── actions ───────────────────────────────────────────────────────────

  /**
   * `POST /api/questions/batch/{batchId}/answers`. Every question of the batch must
   * get exactly one answer: a valid `answerIndex` (`invalid` otherwise) or, D39, an
   * own answer `text` (`invalid-answer` when it is empty or too long, or when both
   * or neither are given); a `multiSelect` question takes one of them, because the
   * contract carries one index. An open batch is answered with one
   * `control_response`: `allow` + the input unchanged + `answers{<question text>:
   * <option label or own text>}`. A stale batch (or one whose request is gone) keeps
   * its answers and sends them, questions and answers verbatim, as a user message:
   * now when the session has a live process, else with its next run.
   * @throws {InboxError} `not-found`, `invalid`, `invalid-answer`, `already-answered`, `busy`.
   */
  async answerBatch(batchId: string, body: unknown): Promise<AnswerOutcome> {
    const found = await this.#store.questions.getBatchWithQuestions(batchId);
    if (!found) throw new InboxError('not-found', `no question batch ${batchId}`);
    // D33: closed without answers (its session was closed).
    if (found.batch.closedReason !== null) throw new InboxError('not-open', `question batch ${batchId} was closed (${found.batch.closedReason})`);
    if (found.batch.answeredAt !== null) {
      // D24: the phone answered it first (Remote Control).
      const where = found.batch.answeredOn ? ` on ${found.batch.answeredOn}` : '';
      throw new InboxError('already-answered', `question batch ${batchId} is already answered${where}`);
    }
    const answers = validateAnswers(body, found.questions);
    if (this.#busy.has(batchId)) throw new InboxError('busy', `question batch ${batchId} is being answered`);
    this.#busy.add(batchId);
    try {
      const { sessionId } = found.batch;
      let outcome: AnswerOutcome | null = null;
      if (found.batch.state === 'open') {
        const updatedInput = { ...asRecord(found.batch.input), answers: answersByText(found.questions, answers) };
        try {
          await this.#supervisor.respond(sessionId, batchId, { behavior: 'allow', updatedInput });
          outcome = 'control_response';
        } catch (error) {
          if (!(error instanceof SupervisorError && error.code === 'request-not-open')) throw error;
          // The request ended before the answer (cancelled, or its process is gone): answer it as a stale batch.
          await this.#store.questions.markStale(batchId);
        }
      }
      const stored = await this.#store.questions.answer(batchId, answers);
      if (outcome === 'control_response') {
        await this.#store.questions.markDelivered(batchId, 'control_response');
      } else {
        outcome = await this.#deliverStale(sessionId, batchId, staleAnswersText(stored.questions));
      }
      await this.#publishInbox();
      await this.#publishSession(sessionId);
      return outcome;
    } finally {
      this.#busy.delete(batchId);
    }
  }

  /** `true` if `id` is a permission item (the actions route also serves M3.3's system items). */
  async isPermissionItem(id: string): Promise<boolean> {
    return (await this.#store.permissions.get(id)) !== null;
  }

  /**
   * `POST /api/inbox/{id}/actions/{action}` for a permission item (D6): `allow-once`
   * = `allow` + the input unchanged (never `updatedPermissions`), `deny` = `deny` +
   * {@link DENY_MESSAGE}. A request that is no longer open closes as stale.
   * @throws {InboxError} `not-found`, `unknown-action`, `not-open`, `busy`.
   */
  async decide(id: string, action: string): Promise<PermissionRequestRecord> {
    const request = await this.#store.permissions.get(id);
    if (!request) throw new InboxError('not-found', `no Inbox item ${id}`);
    const decision = PERMISSION_ACTION_IDS.find((known) => known === action);
    if (!decision) throw new InboxError('unknown-action', `a permission item has no action "${action}"`);
    if (request.state !== 'open') throw new InboxError('not-open', `the permission request is ${request.state}`);
    if (this.#busy.has(id)) throw new InboxError('busy', `the permission request is being decided`);
    this.#busy.add(id);
    try {
      const reply: ToolDecision = decision === 'allow-once'
        ? { behavior: 'allow', updatedInput: asRecord(request.input) }
        : { behavior: 'deny', message: DENY_MESSAGE };
      try {
        await this.#supervisor.respond(request.sessionId, request.requestId, reply);
      } catch (error) {
        if (!(error instanceof SupervisorError && error.code === 'request-not-open')) throw error;
        await this.#store.permissions.markStale(id);
        await this.#publishInbox();
        throw new InboxError('not-open', 'the permission request is no longer open (its process ended or the CLI withdrew it)');
      }
      let decided: PermissionRequestRecord;
      try {
        decided = await this.#store.permissions.decide(id, decision);
      } catch (error) {
        // The reply is written; the process ended right after it and the item went stale meanwhile.
        if (!(error instanceof StoreError && error.code === 'conflict')) throw error;
        decided = (await this.#store.permissions.get(id)) ?? request;
      }
      await this.#publishInbox();
      return decided;
    } finally {
      this.#busy.delete(id);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  async #mainAgent(session: SessionRecord): Promise<string> {
    const main = (await this.#store.agents.listBySession(session.id)).find((agent) => agent.kind === 'main');
    return main?.name ?? mainAgentName(session.mode, session.solutions);
  }

  async #markStale(sessionId: string, requestId: string): Promise<void> {
    const batch = await this.#store.questions.getBatch(requestId);
    if (batch && batch.sessionId === sessionId) {
      await this.#store.questions.markStale(requestId);
      return;
    }
    const permission = await this.#store.permissions.getByRequestId(sessionId, requestId);
    if (permission) await this.#store.permissions.markStale(permission.id);
  }

  /** Sends a stale batch's answers now if the session runs, else queues them for its next run. */
  async #deliverStale(sessionId: string, batchId: string, text: string): Promise<AnswerOutcome> {
    let sent = false;
    try {
      sent = await this.#supervisor.sendToLive(sessionId, text, 'service');
    } catch (error) {
      this.#onError(error);
    }
    if (sent) {
      await this.#store.questions.markDelivered(batchId, 'user_message');
      return 'user_message';
    }
    await this.#store.pendingMessages.enqueue({ sessionId, kind: STALE_ANSWERS_KIND, text, batchId });
    return 'queued';
  }

  async #publishInbox(): Promise<void> {
    if (!this.#bus) return;
    this.#bus.publish('inboxChanged', { count: await inboxCount(this.#store) });
  }

  async #publishSession(sessionId: string): Promise<void> {
    if (!this.#bus) return;
    const record = await this.#store.sessions.get(sessionId);
    if (record) this.#bus.publish('sessionUpdated', await toSession(this.#store, record, this.#sessions?.activity?.(sessionId) ?? null));
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────

/**
 * `input.questions[]` → the stored questions, verbatim (`question`, `header`,
 * option `label` + `description`, `multiSelect`), or `null` when the input has no
 * readable questions (not a non-empty array, a question without text, or no options).
 */
export function parseQuestions(input: unknown): Array<Omit<QuestionCreate, 'source'>> | null {
  const list = asRecord(input)['questions'];
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: Array<Omit<QuestionCreate, 'source'>> = [];
  for (const item of list) {
    const question = asRecord(item);
    const text = question['question'];
    const rawOptions = question['options'];
    if (typeof text !== 'string' || !Array.isArray(rawOptions) || rawOptions.length === 0) return null;
    const options: QuestionOption[] = [];
    for (const raw of rawOptions) {
      const option = asRecord(raw);
      if (typeof option['label'] !== 'string') return null;
      options.push(typeof option['description'] === 'string' ? { label: option['label'], description: option['description'] } : { label: option['label'] });
    }
    out.push({
      text,
      header: typeof question['header'] === 'string' ? question['header'] : null,
      options,
      multiSelect: question['multiSelect'] === true,
    });
  }
  return out;
}

/**
 * The body of `POST /api/questions/batch/{batchId}/answers` checked against the
 * batch: `{ answers: [{ questionId, answerIndex } | { questionId, text }] }` with
 * exactly one entry per question and, per entry, exactly one of an integer index of
 * one of its options or (D39) an own answer `text`, 1–2000 characters once trimmed
 * (`checkOwnAnswer`; returned trimmed). A `null` `answerIndex` / `text` counts as
 * not given.
 * @throws {InboxError} `invalid` (HTTP 400) for a body that is not that shape, an
 * unknown or repeated question, an index that is not an option, or a question
 * without an entry; then `invalid-answer` (HTTP 422, every refused entry in
 * `errors`) for an entry with both or neither, or an own answer out of bounds.
 */
export function validateAnswers(body: unknown, questions: readonly QuestionRecord[]): QuestionAnswer[] {
  const list = typeof body === 'object' && body !== null ? (body as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(list)) throw new InboxError('invalid', 'the body must be { answers: [{ questionId, answerIndex } or { questionId, text }] }');
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const answers: QuestionAnswer[] = [];
  const refused: AnswerFieldError[] = [];
  for (const entry of list as unknown[]) {
    const { questionId, answerIndex, text } = asRecord(entry);
    if (typeof questionId !== 'string' || !byId.has(questionId)) throw new InboxError('invalid', `unknown questionId ${String(questionId)}`);
    if (seen.has(questionId)) throw new InboxError('invalid', `question ${questionId} is answered twice`);
    seen.add(questionId);
    const question = byId.get(questionId) as QuestionRecord;
    const hasIndex = answerIndex !== undefined && answerIndex !== null;
    const hasText = text !== undefined && text !== null;
    if (hasIndex === hasText) {
      refused.push({ questionId, field: 'answer', message: `question ${questionId} needs exactly one of answerIndex and text` });
      continue;
    }
    if (hasText) {
      const own = checkOwnAnswer(text);
      if (own.ok) answers.push({ questionId, text: own.text });
      else refused.push({ questionId, field: 'text', message: `question ${questionId}: ${own.message}` });
      continue;
    }
    if (typeof answerIndex !== 'number' || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= question.options.length) {
      throw new InboxError('invalid', `answerIndex ${String(answerIndex)} is not an option of question ${questionId}`);
    }
    answers.push({ questionId, answerIndex });
  }
  const missing = questions.filter((question) => !seen.has(question.id)).length;
  if (missing > 0) throw new InboxError('invalid', `${seen.size} of ${questions.length} answered: every question needs an answer`);
  if (refused.length > 0) throw new InboxError('invalid-answer', refused.map((error) => error.message).join('; '), refused);
  return answers;
}

/**
 * `answers` of the `control_response`: question text (verbatim) → the chosen
 * option's label or (D39) the own answer's text, verbatim (trimmed), in question
 * order. That is what the CLI's own "Other" sends: the typed text as the answer
 * string. Two questions with the same text (the CLI keys answers by text) get their
 * distinct answers joined with ", ", the CLI's own multi-value format.
 */
export function answersByText(questions: readonly QuestionRecord[], answers: readonly QuestionAnswer[]): Record<string, string> {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  const labels = new Map<string, string[]>();
  for (const question of [...questions].sort((a, b) => a.position - b.position)) {
    const answer = byId.get(question.id);
    const label = answer === undefined ? undefined : answer.text !== undefined ? answer.text : question.options[answer.answerIndex]?.label;
    if (label === undefined) continue;
    const list = labels.get(question.text) ?? [];
    if (!list.includes(label)) list.push(label);
    labels.set(question.text, list);
  }
  const out: Record<string, string> = {};
  for (const [text, list] of labels) out[text] = list.join(', ');
  return out;
}

/**
 * The user message for a stale batch's answers: a heading, then
 * `"<question>" = "<label>"` per question, verbatim (D39: an own answer's text in
 * place of the label).
 */
export function staleAnswersText(questions: readonly QuestionRecord[]): string {
  const lines = [...questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => `"${question.text}" = "${question.answerLabel ?? ''}"`);
  return [STALE_ANSWERS_HEADING, ...lines].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
