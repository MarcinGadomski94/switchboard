import { Fragment, type ReactNode } from 'react';
import type { AnswerBatch } from '../../../core/api.ts';
import { closedBatchText } from '../../../core/session-close.ts';
import { QuestionCard } from '../../components/QuestionCard.tsx';
import { answeredLines } from '../../components/question-card.ts';
import { Link } from '../../router.tsx';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import { ANSWERS_WRITTEN, type ChatItem, type ChatStep, answeredOnText } from './chat.ts';
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

/** Props of {@link ChatItemView}. */
export interface ChatItemViewProps {
  readonly sessionId: string;
  readonly item: ChatItem;
  readonly answering: Answering | null;
  readonly onAnswer: (batchId: string, body: AnswerBatch) => Promise<void>;
  /** D36: a waiting batch shows read-only with this note (a subagent's chat); absent in the main chat. */
  readonly readOnlyNote?: (batchId: string) => ReactNode;
}

/** One chat item (a user bubble, an agent block with its step lines, a question batch); shared by the main and subagent chats. */
export function ChatItemView({ sessionId, item, answering, onAnswer, readOnlyNote }: ChatItemViewProps) {
  if (item.kind === 'user') {
    return (
      <div className="sb-chat-message" data-testid="chat-message" data-role="user" data-origin={item.origin} data-delivered={item.delivered ? 'true' : 'false'}>
        <div className="sb-chat-bubble" data-testid="chat-text">
          <ChatMarkdown text={item.text} />
        </div>
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
  return (
    <Fragment>
      <div className="sb-chat-answers" data-testid="chat-answers" data-batch-id={item.batchId}>
        <div className="sb-chat-answers-bubble">
          {answeredLines(item.questions).map((line, index) => (
            <div key={index} data-testid="chat-answer">
              {line}
            </div>
          ))}
        </div>
      </div>
      <div className="sb-chat-answers-note" data-testid="chat-answers-note">
        {ANSWERS_WRITTEN}
      </div>
    </Fragment>
  );
}
