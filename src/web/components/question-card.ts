import type { AnswerBatch, Question } from '../../core/api.ts';

/**
 * The state of the shared question card (SPEC → Inbox → *Question batch card*,
 * Session → Chat; prototype `card()`), kept free of React so it can be unit-tested.
 * A pick is an option index per question id; the contract carries one index per
 * question, so a `multiSelect` question also takes one option (docs/questions.md).
 */

/** Option indexes picked so far, by question id. */
export type QuestionPicks = Readonly<Record<string, number>>;

/** What the card shows for the current picks. */
export interface QuestionCardView {
  /** `1 question · relayed verbatim` / `n questions · relayed verbatim`. */
  readonly head: string;
  /** `k of n answered`, or the all-answered line. */
  readonly status: string;
  /** `Send answer` (one question) / `Send all answers`. */
  readonly label: string;
  readonly answered: number;
  readonly allAnswered: boolean;
  /** The Send button's opacity: 1 when everything is answered, else 0.45. */
  readonly sendOpacity: number;
}

/** The status line once every question has an answer (prototype copy). */
export const ALL_ANSWERED = 'All answered. Each answer is written into the blocked brief word for word.';

/** The picks already stored on the questions (`answerIndex`), e.g. for an answered batch. */
export function initialPicks(questions: readonly Pick<Question, 'id' | 'answerIndex'>[]): QuestionPicks {
  const picks: Record<string, number> = {};
  for (const question of questions) if (question.answerIndex !== null) picks[question.id] = question.answerIndex;
  return picks;
}

/** `picks` with `index` chosen for `questionId` (one option per question). */
export function pick(picks: QuestionPicks, questionId: string, index: number): QuestionPicks {
  return { ...picks, [questionId]: index };
}

/** `true` when `picks` holds a valid option index for the question. */
export function isAnswered(question: Pick<Question, 'id' | 'options'>, picks: QuestionPicks): boolean {
  const index = picks[question.id];
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < question.options.length;
}

/** The card's copy and Send state for `picks`. */
export function questionCardView(questions: readonly Pick<Question, 'id' | 'options'>[], picks: QuestionPicks): QuestionCardView {
  const total = questions.length;
  const answered = questions.filter((question) => isAnswered(question, picks)).length;
  const allAnswered = total > 0 && answered === total;
  return {
    head: `${total}${total === 1 ? ' question' : ' questions'} · relayed verbatim`,
    status: allAnswered ? ALL_ANSWERED : `${answered} of ${total} answered`,
    label: total > 1 ? 'Send all answers' : 'Send answer',
    answered,
    allAnswered,
    sendOpacity: allAnswered ? 1 : 0.45,
  };
}

/**
 * The body of `POST /api/questions/batch/{batchId}/answers` for `picks`, in
 * question order, or `null` until every question is answered (Send stays disabled).
 */
export function answerBody(questions: readonly Pick<Question, 'id' | 'options'>[], picks: QuestionPicks): AnswerBatch | null {
  if (!questionCardView(questions, picks).allAnswered) return null;
  return { answers: questions.map((question) => ({ questionId: question.id, answerIndex: picks[question.id] as number })) };
}

/** The lines of the "answers" bubble once a batch is answered: `<source>: <label>` (prototype `ssAnswered`). */
export function answeredLines(questions: readonly Pick<Question, 'source' | 'options' | 'answerIndex'>[]): string[] {
  return questions.map((question) => `${question.source}: ${question.answerIndex === null ? '—' : (question.options[question.answerIndex]?.label ?? '—')}`);
}
