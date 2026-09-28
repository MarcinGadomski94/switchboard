import { type ReactNode, useState } from 'react';
import type { AnswerBatch, Question } from '../../core/api.ts';
import { type QuestionPicks, answerBody, initialPicks, pick, questionCardView } from './question-card.ts';
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

/**
 * The shared question batch card (SPEC → Inbox → *Question batch card*; Session →
 * Chat's inline card; M3.1 owns it, M3.2 and M4.2 use it). Each question shows its
 * source in mono blue, the question verbatim in “…” and its options as pills; the
 * footer shows "k of n answered" and Send, which stays disabled (45% opacity) until
 * every question has an answer. Styles are the prototype's inline ones.
 */
export function QuestionCard({ questions, variant = 'inbox', onSend, busy = false, error = null, note }: QuestionCardProps) {
  const batchId = questions[0]?.batchId ?? '';
  const [state, setState] = useState<{ readonly batchId: string; readonly picks: QuestionPicks }>(() => ({
    batchId,
    picks: initialPicks(questions),
  }));
  // Another batch in the same card resets the picks.
  const picks = state.batchId === batchId ? state.picks : initialPicks(questions);
  const view = questionCardView(questions, picks);
  const body = answerBody(questions, picks);
  const readOnly = note !== undefined;
  const locked = busy || readOnly || questions.every((question) => question.answeredAt !== null);

  const choose = (questionId: string, index: number): void => {
    if (locked) return;
    setState({ batchId, picks: pick(picks, questionId, index) });
  };
  const send = (): void => {
    if (!body || locked) return;
    void onSend(body);
  };

  return (
    <div
      className={`sb-qcard sb-qcard--${variant}${readOnly ? ' sb-qcard--readonly' : ''}`}
      data-testid="question-card"
      data-batch-id={batchId}
      data-read-only={readOnly ? 'true' : undefined}
    >
      <div className="sb-qcard__head">{view.head}</div>
      {questions.map((question) => (
        <div key={question.id} className="sb-qcard__question" data-testid="question" data-question-id={question.id}>
          <div className="sb-qcard__source">{question.source}</div>
          <div className="sb-qcard__quote">“{question.text}”</div>
          <div className="sb-qcard__options" role="group" aria-label={question.text}>
            {question.options.map((option, index) => {
              const selected = picks[question.id] === index;
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
                  onClick={() => choose(question.id, index)}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
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
