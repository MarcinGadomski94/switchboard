import { randomUUID } from 'node:crypto';
import type { AnswerDelivery, QuestionState } from '../../../core/model.ts';
import type { AnsweredOn } from '../../../core/remote-control.ts';
import { type RepoContext, placeholders } from '../context.ts';
import { transaction } from '../database.ts';
import { StoreError, Table, type TableSpec, defined } from '../table.ts';

/** One `AskUserQuestion` control request = one batch (ARCHITECTURE → *Questions and permission requests*). */
export interface QuestionBatchRecord {
  /** The batchId = the control_request's `request_id`. */
  readonly id: string;
  readonly sessionId: string;
  readonly toolUseId: string | null;
  /** The tool input verbatim; the answer is this input unchanged plus `answers`. */
  readonly input: unknown;
  /** `open` → `answered`; `stale` once the CLI can no longer take a control_response. */
  readonly state: QuestionState;
  readonly createdAt: string;
  /** Set when every question has an answer. */
  readonly answeredAt: string | null;
  readonly staleAt: string | null;
  /** How the answers reached the CLI; `null` until they did. */
  readonly deliveredVia: AnswerDelivery | null;
  readonly deliveredAt: string | null;
  /** D24 (0007): `claude.ai` when the phone answered first (Remote Control); the batch is `answered` without answers. */
  readonly answeredOn: AnsweredOn | null;
}

/** An option of a question, verbatim from `input.questions[i].options[j]`. */
export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

/** One question of a batch. Its state is its batch's state. */
export interface QuestionRecord {
  readonly id: string;
  readonly batchId: string;
  readonly sessionId: string;
  /** Index in `input.questions[]`. */
  readonly position: number;
  /** Who asks (attribution shown in mono blue). */
  readonly source: string;
  /** The question text verbatim. */
  readonly text: string;
  readonly header: string | null;
  readonly options: QuestionOption[];
  readonly multiSelect: boolean;
  readonly answerIndex: number | null;
  /** The chosen option's label, as written into `answers`. */
  readonly answerLabel: string | null;
  readonly answeredAt: string | null;
}

/** A new batch for {@link QuestionRepository.createBatch}. */
export interface QuestionBatchCreate {
  readonly id: string;
  readonly sessionId: string;
  readonly toolUseId?: string | null;
  readonly input: unknown;
  readonly createdAt?: string;
}

/** A new question for {@link QuestionRepository.createBatch}; `position` is its index in the list. */
export interface QuestionCreate {
  readonly id?: string;
  readonly source: string;
  readonly text: string;
  readonly header?: string | null;
  readonly options: QuestionOption[];
  readonly multiSelect?: boolean;
}

/** One answer for {@link QuestionRepository.answer}. */
export interface QuestionAnswer {
  readonly questionId: string;
  readonly answerIndex: number;
}

/** A batch with its questions in order. */
export interface QuestionBatchWithQuestions {
  readonly batch: QuestionBatchRecord;
  readonly questions: QuestionRecord[];
}

/** Filter of {@link QuestionRepository.listBatches}. */
export interface QuestionBatchFilter {
  readonly sessionId?: string;
  readonly states?: readonly QuestionState[];
}

const BATCH_SPEC: TableSpec<QuestionBatchRecord> = {
  table: 'question_batches',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    sessionId: ['session_id', 'text'],
    toolUseId: ['tool_use_id', 'text'],
    input: ['input', 'json'],
    state: ['state', 'text'],
    createdAt: ['created_at', 'text'],
    answeredAt: ['answered_at', 'text'],
    staleAt: ['stale_at', 'text'],
    deliveredVia: ['delivered_via', 'text'],
    deliveredAt: ['delivered_at', 'text'],
    answeredOn: ['answered_on', 'text'],
  },
};

const QUESTION_SPEC: TableSpec<QuestionRecord> = {
  table: 'questions',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    batchId: ['batch_id', 'text'],
    sessionId: ['session_id', 'text'],
    position: ['position', 'int'],
    source: ['source', 'text'],
    text: ['text', 'text'],
    header: ['header', 'text'],
    options: ['options', 'json'],
    multiSelect: ['multi_select', 'bool'],
    answerIndex: ['answer_index', 'int'],
    answerLabel: ['answer_label', 'text'],
    answeredAt: ['answered_at', 'text'],
  },
};

/** Question batches and their questions. */
export class QuestionRepository {
  readonly #ctx: RepoContext;
  readonly #batches: Table<QuestionBatchRecord>;
  readonly #questions: Table<QuestionRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#batches = new Table(ctx.db, BATCH_SPEC);
    this.#questions = new Table(ctx.db, QUESTION_SPEC);
  }

  /** Stores a batch and its questions in one transaction. */
  async createBatch(batch: QuestionBatchCreate, questions: readonly QuestionCreate[]): Promise<QuestionBatchWithQuestions> {
    return transaction(this.#ctx.db, () => {
      const stored = this.#batches.insert({ ...defined(batch), createdAt: batch.createdAt ?? this.#ctx.now() });
      const rows = questions.map((question, position) =>
        this.#questions.insert({
          ...defined(question),
          id: question.id ?? randomUUID(),
          batchId: stored.id,
          sessionId: stored.sessionId,
          position,
        }),
      );
      return { batch: stored, questions: rows };
    });
  }

  async getBatch(id: string): Promise<QuestionBatchRecord | null> {
    return this.#batches.get(id);
  }

  /** The batch with its questions, or `null`. */
  async getBatchWithQuestions(id: string): Promise<QuestionBatchWithQuestions | null> {
    const batch = this.#batches.get(id);
    return batch ? { batch, questions: this.#questionsOf(id) } : null;
  }

  /** Batches, oldest first. */
  async listBatches(filter: QuestionBatchFilter = {}): Promise<QuestionBatchRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.states) {
      if (filter.states.length === 0) return [];
      where.push(`state IN (${placeholders(filter.states.length)})`);
      params.push(...filter.states);
    }
    return this.#batches.select(where.join(' AND '), params, 'created_at, rowid');
  }

  /** The batch's questions in order. */
  async questionsOf(batchId: string): Promise<QuestionRecord[]> {
    return this.#questionsOf(batchId);
  }

  #questionsOf(batchId: string): QuestionRecord[] {
    return this.#questions.select('batch_id = ?', [batchId], 'position');
  }

  async getQuestion(id: string): Promise<QuestionRecord | null> {
    return this.#questions.get(id);
  }

  /**
   * Records answers (index + the option's label). When every question of the batch
   * has an answer, the batch gets `answeredAt`, and an `open` batch becomes
   * `answered`; a `stale` batch stays `stale` (its answers go out as a user message).
   * @throws {StoreError} `not-found` for an unknown batch; `conflict` if the batch is
   * already answered; `invalid` for a question of another batch or an index out of range.
   */
  async answer(batchId: string, answers: readonly QuestionAnswer[]): Promise<QuestionBatchWithQuestions> {
    return transaction(this.#ctx.db, () => {
      const batch = this.#batches.get(batchId);
      if (!batch) throw new StoreError('not-found', `question batch ${batchId} not found`);
      if (batch.answeredAt !== null) throw new StoreError('conflict', `question batch ${batchId} is already answered`);
      const ts = this.#ctx.now();
      const byId = new Map(this.#questionsOf(batchId).map((question) => [question.id, question]));
      for (const { questionId, answerIndex } of answers) {
        const question = byId.get(questionId);
        if (!question) throw new StoreError('invalid', `question ${questionId} is not in batch ${batchId}`);
        const option = Number.isInteger(answerIndex) ? question.options[answerIndex] : undefined;
        if (!option) throw new StoreError('invalid', `answer index ${answerIndex} is out of range for question ${questionId}`);
        this.#questions.update(questionId, { answerIndex, answerLabel: option.label, answeredAt: ts });
      }
      const questions = this.#questionsOf(batchId);
      const complete = questions.every((question) => question.answerIndex !== null);
      const updated = complete
        ? this.#batches.update(batchId, { answeredAt: ts, state: batch.state === 'open' ? 'answered' : batch.state })
        : batch;
      return { batch: updated ?? batch, questions };
    });
  }

  /** Marks an `open` batch `stale`; other states are left alone. Returns the batch, or `null`. */
  async markStale(batchId: string): Promise<QuestionBatchRecord | null> {
    return transaction(this.#ctx.db, () => {
      const batch = this.#batches.get(batchId);
      if (!batch || batch.state !== 'open') return batch;
      return this.#batches.update(batchId, { state: 'stale', staleAt: this.#ctx.now() });
    });
  }

  /**
   * D24: the batch was answered outside Switchboard (`where`: `claude.ai`, the
   * phone through Remote Control) and the CLI withdrew its request. An `open`
   * batch becomes `answered` with `answeredAt` and `answeredOn` and no answers, so
   * it leaves the Inbox and can no longer be answered here; a batch in any other
   * state is left alone. Returns the batch, or `null`.
   */
  async closeAnsweredElsewhere(batchId: string, where: AnsweredOn): Promise<QuestionBatchRecord | null> {
    return transaction(this.#ctx.db, () => {
      const batch = this.#batches.get(batchId);
      if (!batch || batch.state !== 'open' || batch.answeredAt !== null) return batch;
      return this.#batches.update(batchId, { state: 'answered', answeredAt: this.#ctx.now(), answeredOn: where });
    });
  }

  /** Records how and when the answers reached the CLI. */
  async markDelivered(batchId: string, via: AnswerDelivery): Promise<QuestionBatchRecord | null> {
    return this.#batches.update(batchId, { deliveredVia: via, deliveredAt: this.#ctx.now() });
  }
}
