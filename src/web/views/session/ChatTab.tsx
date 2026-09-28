import { Fragment, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AnswerBatch, SessionDetail, SessionEvent } from '../../../core/api.ts';
import { ApiError, api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { QuestionCard } from '../../components/QuestionCard.tsx';
import { answeredLines } from '../../components/question-card.ts';
import { refusalText } from '../inbox.ts';
import { ChatMarkdown } from './ChatMarkdown.tsx';
import {
  ANSWERS_WRITTEN,
  type ChatItem,
  QUICK_REPLIES,
  QUICK_REPLIES_LABEL,
  chatItems,
  composerPlaceholder,
  draftToSend,
  upsertEvent,
} from './chat.ts';

/** How close to the bottom (px) still counts as "at the bottom", so new items keep it scrolled down. */
const STICK_PX = 32;

function refusal(error: unknown): string {
  return error instanceof ApiError ? refusalText(error.status, error.body) : refusalText(0, null);
}

/** An answer being sent from the inline card (per batch). */
interface Answering {
  readonly batchId: string;
  readonly busy: boolean;
  readonly error: string | null;
}

/** Props of {@link ChatTab}. */
export interface ChatTabProps {
  readonly sessionId: string;
  /** `GET /api/sessions/{id}` (the main agent, the questions, the name); `null` while it loads. */
  readonly session: SessionDetail | null;
  /** Reloads the session detail (after an answer; the view also reloads on its `/hub` events). */
  readonly onChanged: () => void;
}

/**
 * Chat tab (SPEC → Session → Chat, M4.2; `docs/chat.md`): the main conversation
 * from `GET /api/sessions/{id}/events` + the `/hub` `event` stream (user bubbles
 * right, agent text left with its mono step lines), the question batches from the
 * session detail (the shared `QuestionCard` inline while a batch waits, answered
 * through `POST /api/questions/batch/{batchId}/answers`; the answers bubble once
 * answered), then the composer: quick-reply pills fill the draft, Enter or Send
 * posts it to `POST /api/sessions/{id}/messages`. It stays scrolled to the newest
 * item unless the developer scrolled up.
 */
export function ChatTab({ sessionId, session, onChanged }: ChatTabProps) {
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);
  const [answering, setAnswering] = useState<Answering | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    api.sessionEvents(sessionId).then(
      (loaded) => {
        if (cancelled) return;
        // Events the stream delivered while loading stay (merged by id).
        setEvents((current) => current.reduce(upsertEvent, [...loaded]));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId) setEvents((current) => upsertEvent(current, payload.event));
  });

  const mainAgentId = session?.agents.find((agent) => agent.kind === 'main')?.id ?? null;
  const items = session ? chatItems(events, session.questions, mainAgentId) : [];

  // Keep the newest item in view while the developer is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = (): void => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  const answer = async (batchId: string, body: AnswerBatch): Promise<void> => {
    setAnswering({ batchId, busy: true, error: null });
    stick.current = true;
    try {
      await api.answerBatch(batchId, body);
      // Stays busy until the reloaded detail shows the batch answered (the card turns into the answers bubble).
    } catch (error) {
      setAnswering({ batchId, busy: false, error: refusal(error) });
    }
    onChanged();
  };

  return (
    <>
      <div className="sb-chat" data-testid="session-chat" data-session-id={sessionId} ref={scroller} onScroll={onScroll}>
        {items.map((item) => (
          <ChatItemView key={item.key} item={item} answering={answering} onAnswer={answer} />
        ))}
      </div>
      <Composer
        sessionId={sessionId}
        placeholder={composerPlaceholder(session?.name ?? '')}
        onSent={() => {
          stick.current = true;
        }}
      />
    </>
  );
}

function ChatItemView({
  item,
  answering,
  onAnswer,
}: {
  readonly item: ChatItem;
  readonly answering: Answering | null;
  readonly onAnswer: (batchId: string, body: AnswerBatch) => Promise<void>;
}) {
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
              <div key={step.id} className="sb-chat-step" data-testid="chat-step" data-mark={step.mark}>
                {`${step.mark} ${step.label}`}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
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

/** The composer (prototype): quick replies, then the message field and Send. */
function Composer({ sessionId, placeholder, onSent }: { readonly sessionId: string; readonly placeholder: string; readonly onSent: () => void }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const send = async (): Promise<void> => {
    const text = draftToSend(draft);
    if (text === null || sending) return;
    const sent = draft;
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(sessionId, text);
      // The message shows once the service records it (`/hub` event); the draft clears unless it was edited meanwhile.
      setDraft((current) => (current === sent ? '' : current));
      onSent();
    } catch (caught) {
      setError(refusal(caught));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="sb-chat-composer" data-testid="chat-composer">
      <div className="sb-chat-quick">
        <span className="sb-chat-quick-label">{QUICK_REPLIES_LABEL}</span>
        {QUICK_REPLIES.map((reply) => (
          <button
            key={reply.label}
            type="button"
            className="sb-button sb-chat-quick-reply"
            data-testid="chat-quick-reply"
            onClick={() => {
              setDraft(reply.text);
              setError(null);
              input.current?.focus();
            }}
          >
            {reply.label}
          </button>
        ))}
      </div>
      <div className="sb-chat-compose">
        <input
          ref={input}
          className="sb-chat-input"
          data-testid="chat-input"
          aria-label="Message"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="sb-button sb-chat-send" data-testid="chat-send" disabled={sending} aria-busy={sending} onClick={() => void send()}>
          Send
        </button>
      </div>
      {error ? (
        <div className="sb-chat-error" data-testid="chat-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
