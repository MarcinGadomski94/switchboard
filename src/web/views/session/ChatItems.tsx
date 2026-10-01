import { Fragment, type ReactNode } from 'react';
import type { AnswerBatch } from '../../../core/api.ts';
import { closedBatchText } from '../../../core/session-close.ts';
import { MessageAttachments } from '../../components/Attachments.tsx';
import { QuestionCard } from '../../components/QuestionCard.tsx';
import { answeredLines } from '../../components/question-card.ts';
import { Link } from '../../router.tsx';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { CutNote, type FullTextControl } from './FullText.tsx';
import type { QueuedReason } from '../../../core/event-payload.ts';
import { ANSWERS_WRITTEN, type ChatItem, type ChatStep, QUEUED_TOOLTIPS, answeredOnText, batchQueued } from './chat.ts';
import { OPEN_SUBAGENT_CHAT } from './subagent-chat.ts';

/**
 * The chat's items as the main chat (M4.2) and, D36, a subagent's own chat show
 * them: user bubbles, agent blocks with their step lines, question batches.
 * Rules: `chat.ts`, `docs/chat.md`.
 */

/** An answer being sent from the inline card (per batch). */
export interface Answering {
  readonly batchId: string;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * One step line (mono, `<mark> <label>`). D36: an Agent / Task call whose subagent
 * has a chat is a link to it, in the same box, color and type (keyboard-focusable,
 * with a tooltip).
 */
function ChatStepLine({ sessionId, step }: { readonly sessionId: string; readonly step: ChatStep }) {
  const text = `${step.mark} ${step.label}`;
  if (step.subagentId) {
    return (
      <Link
        to={{ view: 'session', id: sessionId, tab: 'chat', agentId: step.subagentId }}
        className="sb-chat-step sb-chat-step--link"
        data-testid="chat-step"
        data-mark={step.mark}
        data-subagent-id={step.subagentId}
        title={OPEN_SUBAGENT_CHAT}
      >
        {text}
      </Link>
    );
  }
  return (
    <div className="sb-chat-step" data-testid="chat-step" data-mark={step.mark}>
      {text}
    </div>
  );
}

/**
 * D44: the clock beside a message the agent has not taken up yet (a user bubble,
 * or the answers bubble of a batch whose answers wait in the outbox), with its
 * reason as the tooltip. It sits outside the bubble, at its bottom left, and is
 * positioned absolutely, so the bubble keeps its size; muted like the step lines.
 */
function QueuedClock({ reason, note = null }: { readonly reason: QueuedReason; readonly note?: string | null }) {
  // D53: a hooked session's message says what it waits on instead.
  const tooltip = note ?? QUEUED_TOOLTIPS[reason];
  return (
    <span className="sb-chat-queued" data-testid="chat-queued" data-reason={reason} title={tooltip} role="img" aria-label={tooltip}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="4.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 3.4V6l1.8 1.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Props of {@link ChatItemView}. */
export interface ChatItemViewProps {
  readonly sessionId: string;
  readonly item: ChatItem;
  readonly answering: Answering | null;
  readonly onAnswer: (batchId: string, body: AnswerBatch) => Promise<void>;
  /** D36: a waiting batch shows read-only with this note (a subagent's chat); absent in the main chat. */
  readonly readOnlyNote?: (batchId: string) => ReactNode;
  /** D53: a hooked session's queued message: what it waits on (the clock's tooltip and a muted line under the bubble). */
  readonly queuedNote?: string | null;
  /** Fix · long messages: restores a cut bubble's whole text ("Show full message"); absent = no note (a Workflow agent's chat). */
  readonly fullText?: FullTextControl;
}

/** One chat item (a user bubble, an agent block with its step lines, a question batch); shared by the main and subagent chats. */
export function ChatItemView({ sessionId, item, answering, onAnswer, readOnlyNote, queuedNote = null, fullText }: ChatItemViewProps) {
  if (item.kind === 'user') {
    return (
      <div
        className="sb-chat-message"
        data-testid="chat-message"
        data-role="user"
        data-origin={item.origin}
        data-delivered={item.delivered ? 'true' : 'false'}
        data-queued={item.queued ?? undefined}
        data-queued-note={item.queued && queuedNote ? 'true' : undefined}
      >
        {item.text !== '' || item.attachments.length === 0 ? (
          <div className="sb-chat-bubble" data-testid="chat-text">
            <ChatMarkdown text={item.text} />
          </div>
        ) : null}
        {item.cut ? <CutNote cut={item.cut} control={fullText} /> : null}
        {/* D57: the images and files it carried, under the bubble. */}
        <MessageAttachments sessionId={sessionId} attachments={item.attachments} />
        {item.queued ? <QueuedClock reason={item.queued} note={queuedNote} /> : null}
        {item.queued && queuedNote ? (
          <div className="sb-chat-queued-note" data-testid="chat-queued-note">
            {queuedNote}
          </div>
        ) : null}
      </div>
    );
  }
  if (item.kind === 'agent') {
    return (
      <div className="sb-chat-message" data-testid="chat-message" data-role="agent">
        {item.text ? (
          <div className="sb-chat-bubble" data-testid="chat-text">
            <ChatMarkdown text={item.text} />
          </div>
        ) : null}
        {item.cut ? <CutNote cut={item.cut} control={fullText} /> : null}
        {item.steps.length > 0 ? (
          <div className="sb-chat-steps" data-testid="chat-steps">
            {item.steps.map((step) => (
              <ChatStepLine key={step.id} sessionId={sessionId} step={step} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (item.kind === 'divider') {
    // D62 P5: the session switched to another CLI here.
    return (
      <div className="sb-chat-divider" data-testid="chat-divider" data-from={item.from ?? undefined} data-to={item.to ?? undefined} role="separator">
        <span className="sb-chat-divider-text">{item.text}</span>
      </div>
    );
  }
  if (item.waiting && readOnlyNote) {
    return <QuestionCard questions={item.questions} variant="chat" note={readOnlyNote(item.batchId)} onSend={() => undefined} />;
  }
  if (item.waiting) {
    const mine = answering?.batchId === item.batchId ? answering : null;
    return (
      <QuestionCard
        questions={item.questions}
        variant="chat"
        busy={mine?.busy ?? false}
        error={mine?.error ?? null}
        onSend={(body) => onAnswer(item.batchId, body)}
      />
    );
  }
  // D33: closed with its session before it was answered: no answers, the label says why.
  const closedReason = item.questions.find((question) => question.closedReason)?.closedReason ?? null;
  if (closedReason) {
    return (
      <div className="sb-chat-answers" data-testid="chat-answers" data-batch-id={item.batchId} data-closed={closedReason}>
        <div className="sb-chat-answers-bubble">
          <div data-testid="chat-answer">{closedBatchText(closedReason)}</div>
        </div>
      </div>
    );
  }
  // D24: the phone answered it first (Remote Control): the CLI withdrew it, so Switchboard holds no answers.
  const answeredOn = item.questions.find((question) => question.answeredOn)?.answeredOn ?? null;
  if (answeredOn) {
    return (
      <div className="sb-chat-answers" data-testid="chat-answers" data-batch-id={item.batchId} data-answered-on={answeredOn}>
        <div className="sb-chat-answers-bubble">
          <div data-testid="chat-answer">{answeredOnText(answeredOn)}</div>
        </div>
      </div>
    );
  }
  // D44: answers of a stale batch that wait in the outbox until the session runs again.
  const queued = batchQueued(item.questions);
  return (
    <Fragment>
      <div className="sb-chat-answers" data-testid="chat-answers" data-batch-id={item.batchId} data-queued={queued ?? undefined}>
        <div className="sb-chat-answers-bubble">
          {answeredLines(item.questions).map((line, index) => (
            <div key={index} data-testid="chat-answer">
              {line}
            </div>
          ))}
        </div>
        {queued ? <QueuedClock reason={queued} /> : null}
      </div>
      <div className="sb-chat-answers-note" data-testid="chat-answers-note">
        {ANSWERS_WRITTEN}
      </div>
    </Fragment>
  );
}
