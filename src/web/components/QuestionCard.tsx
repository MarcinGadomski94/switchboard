import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react';
import type { AnswerBatch, Question } from '../../core/api.ts';
import { OWN_ANSWER_MAX } from '../../core/own-answer.ts';
import {
  OTHER_LABEL,
  OWN_ANSWER_PLACEHOLDER,
  type QuestionPicks,
  answerBody,
  cancelOwn,
  confirmOwn,
  initialPicks,
  isOwnPick,
  ownAnswerKeyAction,
  pick,
  pickOther,
  questionCardView,
  typeOwn,
} from './question-card.ts';
import { type QuestionDraft, draftField, rawDraftId } from '../../core/drafts.ts';
import { initialDraft, useDraft } from '../drafts/useDraft.ts';
import './question-card.css';

/** Where the card sits: the Inbox detail (max 760px) or the session chat (inline). */
export type QuestionCardVariant = 'inbox' | 'chat';

/** Props of {@link QuestionCard}. */
export interface QuestionCardProps {
  /** One batch's questions, in order (`Question.batchId` is the same for all). */
  readonly questions: readonly Question[];
  readonly variant?: QuestionCardVariant;
  /** Called with the contract body once every question has an answer and Send is clicked. */
  readonly onSend: (body: AnswerBatch) => void | Promise<void>;
  /** Disables the card (e.g. while the answers are being sent). */
  readonly busy?: boolean;
  /** Shown in place of the status line (e.g. the answers route refused them). */
  readonly error?: string | null;
  /**
   * D36: shows the card read-only (a subagent's own chat): the options cannot be
   * picked, there is no Send, and this note stands in the footer (where to answer).
   */
  readonly note?: ReactNode;
}

/** D39: moves focus to the Other… choice of the question that holds `from`, once its field has closed. */
function focusOther(from: HTMLElement): void {
  const other = from.closest('[data-testid="question"]')?.querySelector<HTMLElement>('[data-testid="question-other"]');
  if (other) requestAnimationFrame(() => other.focus());
}

/**
 * The shared question batch card (SPEC → Inbox → *Question batch card*; Session →
 * Chat's inline card; M3.1 owns it, M3.2 and M4.2 use it). Each question shows its
 * source in mono blue, the question verbatim in “…” and its options as pills, then
 * (D39) an **Other…** pill that opens a field for the developer's own answer
 * (autofocus; Enter confirms, Shift+Enter adds a line, Esc cancels back to no
 * pick); the footer shows "k of n answered" and Send, which stays disabled (45%
 * opacity) until every question has an answer (an option, or own words). Styles
 * are the prototype's inline ones.
 */
export function QuestionCard({ questions, variant = 'inbox', onSend, busy = false, error = null, note }: QuestionCardProps) {
  const batchId = questions[0]?.batchId ?? '';
  const sessionId = questions[0]?.sessionId ?? '';
  const readOnly = note !== undefined;
  const answered = questions.every((question) => question.answeredAt !== null);
  // D88: the picks not yet sent are the session's draft (`question:<batchId>`), shared by the chat's card and the Inbox's.
  const field = readOnly || answered || batchId === '' || sessionId === '' ? null : draftField.question(batchId);
  const [state, setState] = useState<{ readonly batchId: string; readonly picks: QuestionPicks }>(() => ({
    batchId,
    picks: { ...initialPicks(questions), ...picksFromDraft(questions, initialDraft<QuestionDraft>(sessionId, field)) },
  }));
  // Another batch in the same card resets the picks.
  const picks = state.batchId === batchId ? state.picks : initialPicks(questions);
  const view = questionCardView(questions, picks);
  const body = answerBody(questions, picks);
  const locked = busy || readOnly || answered;
  const card = useRef<HTMLDivElement | null>(null);
  const draftValue = useMemo<QuestionDraft>(() => ({ picks: draftPicks(picks) }), [picks]);
  const kept = useDraft<QuestionDraft>({
    sessionId,
    field,
    value: draftValue,
    root: card,
    initial: Object.keys(draftValue.picks).length > 0 ? draftValue : null,
    apply: (value) => setState({ batchId, picks: { ...initialPicks(questions), ...picksFromDraft(questions, value) } }),
  });

  const update = (next: QuestionPicks): void => {
    if (locked) return;
    setState({ batchId, picks: next });
  };
  const send = (): void => {
    if (!body || locked) return;
    // D88: sent: the draft goes (a refused answer keeps the picks on screen).
    kept.clear();
    void onSend(body);
  };
  const onOwnKey = (questionId: string, event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = ownAnswerKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing });
    if (action === null) return;
    // Enter never adds a line here (Shift+Enter does); Esc stays in the card.
    event.preventDefault();
    event.stopPropagation();
    const next = action === 'confirm' ? confirmOwn(picks, questionId) : cancelOwn(picks, questionId);
    if (next === picks) return;
    focusOther(event.currentTarget);
    update(next);
  };

  return (
    <div
      ref={card}
      className={`sb-qcard sb-qcard--${variant}${readOnly ? ' sb-qcard--readonly' : ''}`}
      data-testid="question-card"
      data-batch-id={batchId}
      data-read-only={readOnly ? 'true' : undefined}
    >
      <div className="sb-qcard__head">{view.head}</div>
      {questions.map((question) => {
        const current = picks[question.id];
        const own = isOwnPick(current) ? current : null;
        return (
          <div key={question.id} className="sb-qcard__question" data-testid="question" data-question-id={question.id}>
            <div className="sb-qcard__source">{question.source}</div>
            <div className="sb-qcard__quote">“{question.text}”</div>
            <div className="sb-qcard__options" role="group" aria-label={question.text}>
              {question.options.map((option, index) => {
                const selected = current === index;
                return (
                  <button
                    key={`${index}:${option.label}`}
                    type="button"
                    className="sb-button sb-qcard__option"
                    data-testid="question-option"
                    data-selected={selected ? 'true' : 'false'}
                    aria-pressed={selected}
                    aria-disabled={readOnly ? true : undefined}
                    title={option.description}
                    onClick={() => update(pick(picks, question.id, index))}
                  >
                    {option.label}
                  </button>
                );
              })}
              <button
                type="button"
                className="sb-button sb-qcard__option sb-qcard__other"
                data-testid="question-other"
                data-selected={own ? 'true' : 'false'}
                aria-pressed={own !== null}
                aria-expanded={own?.editing === true}
                aria-disabled={readOnly ? true : undefined}
                title="Answer in your own words"
                onClick={() => update(pickOther(picks, question.id))}
              >
                {OTHER_LABEL}
              </button>
            </div>
            {own?.editing ? (
              <textarea
                className="sb-qcard__own-input"
                data-testid="question-own-input"
                aria-label={`Your answer to “${question.text}”`}
                placeholder={OWN_ANSWER_PLACEHOLDER}
                maxLength={OWN_ANSWER_MAX}
                rows={2}
                autoFocus
                disabled={locked}
                value={own.text}
                onChange={(event) => update(typeOwn(picks, question.id, event.target.value))}
                onKeyDown={(event) => onOwnKey(question.id, event)}
              />
            ) : own ? (
              <button
                type="button"
                className="sb-button sb-qcard__own-answer"
                data-testid="question-own-answer"
                title="Edit your answer"
                aria-disabled={readOnly ? true : undefined}
                onClick={() => update(pickOther(picks, question.id))}
              >
                {own.text}
              </button>
            ) : null}
          </div>
        );
      })}
      {readOnly ? (
        <div className="sb-qcard__foot">
          <span className="sb-qcard__status" data-testid="question-note">
            {note}
          </span>
        </div>
      ) : (
        <div className="sb-qcard__foot">
          <span className="sb-qcard__status" data-testid="question-status">{error ?? view.status}</span>
          <button
            type="button"
            className="sb-button sb-qcard__send"
            data-testid="question-send"
            disabled={!body || locked}
            style={{ opacity: view.sendOpacity }}
            onClick={send}
          >
            {view.label}
          </button>
        </div>
      )}
    </div>
  );
}

/** D88: the picks as the draft keeps them (by the question's raw id, so every machine's UI names them alike). */
function draftPicks(picks: QuestionPicks): QuestionDraft['picks'] {
  const out: Record<string, QuestionDraft['picks'][string]> = {};
  for (const [id, pick] of Object.entries(picks)) out[rawDraftId(id)] = typeof pick === 'number' ? pick : { text: pick.text, editing: pick.editing };
  return out;
}

/** D88: a draft's picks for these questions (an option index the question no longer has, or an empty own answer, is dropped). */
function picksFromDraft(questions: readonly Question[], draft: QuestionDraft | null): QuestionPicks {
  if (!draft) return {};
  const out: Record<string, QuestionPicks[string]> = {};
  for (const question of questions) {
    const pick = draft.picks[rawDraftId(question.id)];
    if (pick === undefined) continue;
    if (typeof pick === 'number') {
      if (pick < question.options.length) out[question.id] = pick;
    } else if (pick.text.trim() !== '') {
      // Restored closed (its text as the answer): an open field would take the focus from wherever the developer is.
      out[question.id] = { text: pick.text, editing: false };
    }
  }
  return out;
}
