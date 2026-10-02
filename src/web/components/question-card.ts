import type { AnswerBatch, BatchAnswer, Question } from '../../core/api.ts';
import { checkOwnAnswer } from '../../core/own-answer.ts';

/**
 * The state of the shared question card (SPEC → Inbox → *Question batch card*,
 * Session → Chat; prototype `card()`), kept free of React so it can be unit-tested.
 * A pick is an option index per question id, or (D39) the developer's own answer
 * ("Other…"); the contract carries one answer per question, so a `multiSelect`
 * question also takes one option or one own answer (docs/questions.md).
 */

/**
 * D39: a question's own answer ("Other…"): the text typed so far and whether its
 * field is open. Picking Other… opens the field; Enter with some text closes it
 * onto the answer as typed; Esc drops the pick.
 */
export interface OwnPick {
  readonly text: string;
  readonly editing: boolean;
}

/** A question's pick: an option index, or (D39) its own answer. */
export type QuestionPick = number | OwnPick;

/** Picks so far, by question id. */
export type QuestionPicks = Readonly<Record<string, QuestionPick>>;

/** An option as the card shows it: its label, the visible description and the optional preview. */
export interface OptionDetail {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

/**
 * Whether a question's options carry anything to show under their labels (a
 * description or a preview). Without any, the options stay the prototype's compact
 * pills; with some, they are listed one per row so each label has its description
 * under it, like the CLI's own list.
 */
export function hasOptionDetails(options: readonly OptionDetail[]): boolean {
  return options.some((option) => (option.description ?? '').trim() !== '' || (option.preview ?? '') !== '');
}

/**
 * The preview to show for a question, like the terminal: the option the pointer or
 * keyboard is on (`focused`), else the picked one; `null` when that option has no
 * preview (or nothing is focused or picked).
 */
export function shownPreview(options: readonly OptionDetail[], focused: number | null, picked: QuestionPick | undefined): string | null {
  const index = focused ?? (typeof picked === 'number' ? picked : null);
  if (index === null) return null;
  const preview = options[index]?.preview;
  return preview !== undefined && preview !== '' ? preview : null;
}

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

/** D39: the card's last choice of every question, after its options. */
export const OTHER_LABEL = 'Other…';

/** D39: the own-answer field's placeholder. */
export const OWN_ANSWER_PLACEHOLDER = 'Your answer · Enter confirms · Shift+Enter adds a line · Esc cancels';

/** `true` for an own-answer pick (D39). */
export function isOwnPick(pick: QuestionPick | undefined): pick is OwnPick {
  return typeof pick === 'object' && pick !== null;
}

/** The picks already stored on the questions (`answerIndex`, D39: `answerText`), e.g. for an answered batch. */
export function initialPicks(questions: readonly Pick<Question, 'id' | 'answerIndex' | 'answerText'>[]): QuestionPicks {
  const picks: Record<string, QuestionPick> = {};
  for (const question of questions) {
    if (question.answerIndex !== null) picks[question.id] = question.answerIndex;
    else if (typeof question.answerText === 'string') picks[question.id] = { text: question.answerText, editing: false };
  }
  return picks;
}

/** `picks` with `index` chosen for `questionId` (one option per question; an own answer is dropped). */
export function pick(picks: QuestionPicks, questionId: string, index: number): QuestionPicks {
  return { ...picks, [questionId]: index };
}

/**
 * D39: `picks` with Other… chosen for `questionId`: its field opens, keeping the
 * text already typed when the own answer was picked before.
 */
export function pickOther(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = picks[questionId];
  return { ...picks, [questionId]: { text: isOwnPick(current) ? current.text : '', editing: true } };
}

/** D39: `picks` with the own answer's text of `questionId` replaced (its field stays open). */
export function typeOwn(picks: QuestionPicks, questionId: string, text: string): QuestionPicks {
  return { ...picks, [questionId]: { text, editing: true } };
}

/**
 * D39: Enter in the own-answer field. With text that counts ({@link isAnswered}) the
 * field closes onto the answer; otherwise nothing changes.
 */
export function confirmOwn(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = picks[questionId];
  if (!isOwnPick(current) || !checkOwnAnswer(current.text).ok) return picks;
  return { ...picks, [questionId]: { text: current.text, editing: false } };
}

/** D39: Esc in the own-answer field: back to no pick for `questionId`. */
export function cancelOwn(picks: QuestionPicks, questionId: string): QuestionPicks {
  const next: Record<string, QuestionPick> = { ...picks };
  delete next[questionId];
  return next;
}

/** What a key press in the own-answer field does (D39): Enter confirms, Shift+Enter is a new line, Esc cancels. */
export function ownAnswerKeyAction(event: { readonly key: string; readonly shiftKey: boolean; readonly isComposing: boolean }): 'confirm' | 'cancel' | null {
  if (event.isComposing) return null;
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter' && !event.shiftKey) return 'confirm';
  return null;
}

/**
 * `true` when the question has an answer: a valid option index, or (D39) an own
 * answer that is 1–2000 characters once trimmed.
 */
export function isAnswered(question: Pick<Question, 'id' | 'options'>, picks: QuestionPicks): boolean {
  const current = picks[question.id];
  if (isOwnPick(current)) return checkOwnAnswer(current.text).ok;
  return current !== undefined && Number.isInteger(current) && current >= 0 && current < question.options.length;
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
 * question order (`answerIndex`, D39: or the own answer's trimmed `text`), or
 * `null` until every question is answered (Send stays disabled).
 */
export function answerBody(questions: readonly Pick<Question, 'id' | 'options'>[], picks: QuestionPicks): AnswerBatch | null {
  if (!questionCardView(questions, picks).allAnswered) return null;
  return {
    answers: questions.map((question): BatchAnswer => {
      const current = picks[question.id];
      return isOwnPick(current) ? { questionId: question.id, text: current.text.trim() } : { questionId: question.id, answerIndex: current as number };
    }),
  };
}

/**
 * The lines of the "answers" bubble once a batch is answered: `<source name>: <label>`
 * (prototype `ssAnswered`: the source's part before the first `" · "`, so
 * `web · microfrontends/acme-app-front` → `web`; M4.2), D39: the own answer's text
 * verbatim in place of the label.
 */
export function answeredLines(questions: readonly Pick<Question, 'source' | 'options' | 'answerIndex' | 'answerText'>[]): string[] {
  return questions.map((question) => {
    const at = question.source.indexOf(' · ');
    const name = at < 0 ? question.source : question.source.slice(0, at);
    if (question.answerIndex === null && typeof question.answerText === 'string') return `${name}: ${question.answerText}`;
    return `${name}: ${question.answerIndex === null ? '—' : (question.options[question.answerIndex]?.label ?? '—')}`;
  });
}
