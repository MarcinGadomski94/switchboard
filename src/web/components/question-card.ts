import type { AnswerBatch, BatchAnswer, Question } from '../../core/api.ts';
import { checkOwnAnswer } from '../../core/own-answer.ts';

/**
 * The state of the shared question card (SPEC → Inbox → *Question batch card*,
 * Session → Chat; prototype `card()`), kept free of React so it can be unit-tested.
 * A pick is an option index per question id, or (D39) the developer's own answer
 * ("Other…"). D128: a `multiSelect` question's pick is a {@link MultiPick}: any
 * number of ticked options and, alongside them, an optional own answer
 * (docs/questions.md → *Multi-select answers*).
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

/**
 * D128: a multi-select question's pick: the ticked option indexes (ascending) and,
 * when Other… is ticked, its own answer (`null` otherwise).
 */
export interface MultiPick {
  readonly indexes: readonly number[];
  readonly own: OwnPick | null;
}

/** A question's pick: an option index, or (D39) its own answer, or (D128) a multi-select question's picks. */
export type QuestionPick = number | OwnPick | MultiPick;

/** Picks so far, by question id. */
export type QuestionPicks = Readonly<Record<string, QuestionPick>>;

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

/** D128: the hint under a multi-select question. */
export const MULTI_HINT = 'Choose any';

/** D39: the own-answer field's placeholder. */
export const OWN_ANSWER_PLACEHOLDER = 'Your answer · Enter confirms · Shift+Enter adds a line · Esc cancels';

/** `true` for an own-answer pick (D39) of a single-select question. */
export function isOwnPick(pick: QuestionPick | undefined): pick is OwnPick {
  return typeof pick === 'object' && pick !== null && 'text' in pick;
}

/** `true` for a multi-select question's pick (D128). */
export function isMultiPick(pick: QuestionPick | undefined): pick is MultiPick {
  return typeof pick === 'object' && pick !== null && 'indexes' in pick;
}

/** D128: a multi-select question's current pick, as a {@link MultiPick} (an older single pick converted; none = nothing ticked). */
export function multiPickOf(pick: QuestionPick | undefined): MultiPick {
  if (isMultiPick(pick)) return pick;
  if (isOwnPick(pick)) return { indexes: [], own: pick };
  if (typeof pick === 'number') return { indexes: [pick], own: null };
  return { indexes: [], own: null };
}

/**
 * The picks already stored on the questions (`answerIndex`, D39: `answerText`,
 * D128: a multi-select answer's `answerIndexes` with its `answerText`), e.g. for an
 * answered batch.
 */
export function initialPicks(questions: readonly Pick<Question, 'id' | 'answerIndex' | 'answerText' | 'answerIndexes' | 'multiSelect'>[]): QuestionPicks {
  const picks: Record<string, QuestionPick> = {};
  for (const question of questions) {
    const own = typeof question.answerText === 'string' ? { text: question.answerText, editing: false } : null;
    if (question.multiSelect) {
      const indexes = question.answerIndexes ?? (question.answerIndex !== null ? [question.answerIndex] : []);
      if (indexes.length > 0 || own) picks[question.id] = { indexes: [...indexes].sort((a, b) => a - b), own };
    } else if (question.answerIndex !== null) picks[question.id] = question.answerIndex;
    else if (own) picks[question.id] = own;
  }
  return picks;
}

/** D128: `picks` with option `index` of a multi-select question ticked, or unticked when it was. */
export function toggleOption(picks: QuestionPicks, questionId: string, index: number): QuestionPicks {
  const current = multiPickOf(picks[questionId]);
  const indexes = current.indexes.includes(index) ? current.indexes.filter((i) => i !== index) : [...current.indexes, index].sort((a, b) => a - b);
  return withMulti(picks, questionId, { indexes, own: current.own });
}

/**
 * D128: Other… of a multi-select question is a checkbox: ticking it opens its
 * field (the text typed before, if any, is gone: it was unticked); unticking it
 * drops the own answer and keeps the ticked options.
 */
export function toggleOther(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = multiPickOf(picks[questionId]);
  return withMulti(picks, questionId, { indexes: current.indexes, own: current.own ? null : { text: '', editing: true } });
}

/** D128: reopens a multi-select question's confirmed own answer for editing (a click on it). */
export function editOwn(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = picks[questionId];
  if (!isMultiPick(current) || !current.own) return pickOther(picks, questionId);
  return { ...picks, [questionId]: { indexes: current.indexes, own: { text: current.own.text, editing: true } } };
}

/** `picks` with a multi-select question's pick set; nothing ticked removes it. */
function withMulti(picks: QuestionPicks, questionId: string, next: MultiPick): QuestionPicks {
  const out: Record<string, QuestionPick> = { ...picks };
  if (next.indexes.length === 0 && next.own === null) delete out[questionId];
  else out[questionId] = next;
  return out;
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

/** D39: `picks` with the own answer's text of `questionId` replaced (its field stays open; D128: the ticked options stay). */
export function typeOwn(picks: QuestionPicks, questionId: string, text: string): QuestionPicks {
  const current = picks[questionId];
  if (isMultiPick(current)) return { ...picks, [questionId]: { indexes: current.indexes, own: { text, editing: true } } };
  return { ...picks, [questionId]: { text, editing: true } };
}

/**
 * D39: Enter in the own-answer field. With text that counts ({@link isAnswered}) the
 * field closes onto the answer; otherwise nothing changes.
 */
export function confirmOwn(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = picks[questionId];
  if (isMultiPick(current)) {
    if (!current.own || !checkOwnAnswer(current.own.text).ok) return picks;
    return { ...picks, [questionId]: { indexes: current.indexes, own: { text: current.own.text, editing: false } } };
  }
  if (!isOwnPick(current) || !checkOwnAnswer(current.text).ok) return picks;
  return { ...picks, [questionId]: { text: current.text, editing: false } };
}

/** D39: Esc in the own-answer field: back to no pick for `questionId` (D128: Other… unticked, the ticked options stay). */
export function cancelOwn(picks: QuestionPicks, questionId: string): QuestionPicks {
  const current = picks[questionId];
  if (isMultiPick(current)) return withMulti(picks, questionId, { indexes: current.indexes, own: null });
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
 * answer that is 1–2000 characters once trimmed. D128, a multi-select question: at
 * least one ticked option or own answer, and a ticked Other… needs its text.
 */
export function isAnswered(question: Pick<Question, 'id' | 'options'>, picks: QuestionPicks): boolean {
  const current = picks[question.id];
  if (isMultiPick(current)) {
    const optionsOk = current.indexes.every((index) => Number.isInteger(index) && index >= 0 && index < question.options.length);
    const ownOk = current.own === null || checkOwnAnswer(current.own.text).ok;
    return optionsOk && ownOk && (current.indexes.length > 0 || current.own !== null);
  }
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
 * `null` until every question is answered (Send stays disabled). D128: a
 * multi-select question with several choices sends `answerIndexes` (ascending)
 * and its own `text` alongside; one option alone, or own words alone, keep the
 * single shapes, so a paired machine from before D128 still takes them.
 */
export function answerBody(questions: readonly Pick<Question, 'id' | 'options'>[], picks: QuestionPicks): AnswerBatch | null {
  if (!questionCardView(questions, picks).allAnswered) return null;
  return {
    answers: questions.map((question): BatchAnswer => {
      const current = picks[question.id];
      if (isMultiPick(current)) {
        const text = current.own ? current.own.text.trim() : null;
        if (text === null && current.indexes.length === 1) return { questionId: question.id, answerIndex: current.indexes[0] as number };
        if (text !== null && current.indexes.length === 0) return { questionId: question.id, text };
        return text === null ? { questionId: question.id, answerIndexes: [...current.indexes] } : { questionId: question.id, answerIndexes: [...current.indexes], text };
      }
      return isOwnPick(current) ? { questionId: question.id, text: current.text.trim() } : { questionId: question.id, answerIndex: current as number };
    }),
  };
}

/**
 * The lines of the "answers" bubble once a batch is answered: `<source name>: <label>`
 * (prototype `ssAnswered`: the source's part before the first `" · "`, so
 * `web · microfrontends/acme-web-front` → `web`; M4.2), D39: the own answer's text
 * verbatim in place of the label. D128: a multi-select answer lists every picked
 * label and then its own text, joined with `", "`.
 */
export function answeredLines(questions: readonly Pick<Question, 'source' | 'options' | 'answerIndex' | 'answerText' | 'answerIndexes'>[]): string[] {
  return questions.map((question) => {
    const at = question.source.indexOf(' · ');
    const name = at < 0 ? question.source : question.source.slice(0, at);
    if (Array.isArray(question.answerIndexes)) {
      const items = question.answerIndexes.map((index) => question.options[index]?.label ?? '—');
      if (typeof question.answerText === 'string') items.push(question.answerText);
      return `${name}: ${items.length > 0 ? items.join(', ') : '—'}`;
    }
    if (question.answerIndex === null && typeof question.answerText === 'string') return `${name}: ${question.answerText}`;
    return `${name}: ${question.answerIndex === null ? '—' : (question.options[question.answerIndex]?.label ?? '—')}`;
  });
}
