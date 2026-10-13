import { useEffect, useState } from 'react';
import type { AnswerBatch, InboxItem, SessionEvent } from '../../core/api.ts';
import type { Plan, PlanItem } from '../../core/plans.ts';
import type { Review } from '../../core/reviews.ts';
import { api } from '../api/client.ts';
import { useHubEvent } from '../api/useHub.ts';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { Link } from '../router.tsx';
import { plansApi, refusalText } from './api.ts';
import { STATE_LOOK, doneText, statusLine, waitingText, worktreeName } from './model.ts';

/** The external ref the Jira lane may give a browse URL with (`url`); without one there is no ↗ link. */
function jiraLink(plan: Plan, item: PlanItem): string | null {
  const external = plan.external as (Plan['external'] & { readonly url?: unknown; readonly baseUrl?: unknown }) | null;
  if (!external || !item.key) return null;
  const base = typeof external.baseUrl === 'string' ? external.baseUrl : typeof external.url === 'string' ? new URL(external.url).origin : null;
  return base ? `${base.replace(/\/$/, '')}/browse/${encodeURIComponent(item.key)}` : null;
}

/** The newest text of the item's main agent (a running item's "latest message"). */
function useLatestMessage(sessionId: string | null): string | null {
  const [text, setText] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useHubEvent('event', (payload) => {
    if (sessionId && payload.sessionId === sessionId) setTick((n) => n + 1);
  });
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api
      .sessionEventsPage(sessionId, { limit: 40 })
      .then((events: SessionEvent[]) => {
        if (cancelled) return;
        const last = [...events].reverse().find((event) => {
          const payload = event.payload as { readonly type?: string; readonly note?: boolean } | null;
          return payload?.type === 'assistant' && payload.note !== true;
        });
        setText(last ? String((last.payload as { text?: string }).text ?? '') : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);
  return text;
}

/**
 * D99 · the detail of the selected item (`docs/plans.md` → *Detail*), under every view (full
 * screen on a phone): the state icon, key, title and status; its worktree, Open session, the
 * Jira ↗ link when the plan is external, the "⚑ I merge this one" hold; then by state: the
 * real QuestionCard with Reply… (a question), Merge / Send back / Open diff (a review), the
 * reason on a red rule (blocked, with Retry for a failed item), the agent's latest message
 * (running), "Starts by itself when …" (waiting), "Merged into <target> · checks ✔" (done).
 */
export function PlanDetail({
  plan,
  item,
  inbox,
  reviews,
  onChanged,
  onBack,
}: {
  readonly plan: Plan;
  readonly item: PlanItem;
  readonly inbox: readonly InboxItem[];
  readonly reviews: readonly Review[];
  readonly onChanged: (plan?: Plan) => void;
  readonly onBack: (() => void) | null;
}) {
  const look = STATE_LOOK[item.state];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const latest = useLatestMessage(item.state === 'running' ? item.runSessionId : null);
  const question = item.runSessionId ? inbox.find((entry) => entry.kind === 'questions' && entry.sessionId === item.runSessionId) : undefined;
  const permission = item.runSessionId ? inbox.find((entry) => entry.kind === 'permission' && entry.sessionId === item.runSessionId) : undefined;
  const review = item.runSessionId ? reviews.find((entry) => entry.sessionId === item.runSessionId && entry.state === 'pending') : undefined;
  const jira = jiraLink(plan, item);
  const remote = plan.machine !== null;

  useEffect(() => {
    setError(null);
    setComment(null);
  }, [item.id]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const answer = await action();
      onChanged(answer && typeof answer === 'object' && 'items' in answer ? (answer as Plan) : undefined);
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  const setHold = (hold: boolean): Promise<void> => run(() => plansApi.setHolds(plan.id, { [item.id]: hold }));

  return (
    <section className="sb-plan-detail" data-testid="plan-detail" data-item-id={item.id} data-state={item.state} aria-label={`${item.key ?? ''} ${item.title}`}>
      {onBack ? (
        <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost sb-plan-detail__back" data-testid="plan-detail-back" onClick={onBack}>
          ‹ {plan.title}
        </button>
      ) : null}
      <div className="sb-plan-detail__head" style={{ borderLeftColor: look.color }}>
        <span className="sb-plan-detail__icon" style={{ color: look.color }} aria-hidden="true">
          {look.icon}
        </span>
        {item.key ? <span className="sb-plan-detail__key">{item.key}</span> : null}
        <span className="sb-plan-detail__title" data-testid="plan-detail-title">
          {item.title}
        </span>
        <span className="sb-plan-detail__status" data-testid="plan-detail-status" style={{ color: look.color }}>
          {statusLine(item, plan.items)}
        </span>
      </div>
      <div className="sb-plan-detail__meta">
        <span className="sb-plan-detail__worktree" title="Its worktree branch">
          ⎇ {worktreeName(item)}
        </span>
        {item.runSessionId && !remote ? (
          <Link to={{ view: 'session', id: item.runSessionId, tab: 'chat' }} className="sb-plan-link" data-testid="plan-detail-open-session">
            Open session
          </Link>
        ) : null}
        {jira ? (
          <a href={jira} target="_blank" rel="noreferrer noopener" className="sb-plan-link" data-testid="plan-detail-jira">
            Jira ↗
          </a>
        ) : null}
        {item.prUrl ? (
          <a href={item.prUrl} target="_blank" rel="noreferrer noopener" className="sb-plan-link" data-testid="plan-detail-pr">
            PR ↗
          </a>
        ) : null}
        <label className="sb-plan-detail__hold" title={plan.mergeMode === 'agents-with-holds' || plan.mergeMode === null ? 'In "Agents merge, with hold points" this ticket waits for your Merge' : 'Counts in the "Agents merge, with hold points" mode'}>
          <input type="checkbox" data-testid="plan-detail-hold" checked={item.hold} disabled={busy || remote || item.state === 'done' || plan.state === 'done' || plan.state === 'cancelled'} onChange={(event) => void setHold(event.target.checked)} /> ⚑ I merge this one
        </label>
      </div>
      {item.note ? <div className="sb-plan-detail__note">{item.note}</div> : null}

      {item.state === 'question' ? (
        <div className="sb-plan-detail__body" data-testid="plan-detail-question">
          {question ? (
            <QuestionCard key={question.id} questions={question.questions ?? []} variant="inbox" busy={busy} error={error} onSend={(body: AnswerBatch) => run(() => api.answerBatch(question.id, body))} />
          ) : permission ? (
            <div className="sb-plan-detail__actions">
              <span className="sb-plan-detail__text">{permission.title}</span>
              {(permission.actions ?? []).map((action, index) => (
                <button key={action.id} type="button" className={`sb-button sb-plan-btn${index === 0 ? ' sb-plan-btn--primary' : ''}`} data-testid="plan-detail-permission" disabled={busy} onClick={() => void run(() => api.inboxAction(permission.id, action.id))}>
                  {action.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="sb-plan-detail__text">{item.reason ?? 'Its session waits for your answer in the Inbox.'}</div>
          )}
          {item.runSessionId ? (
            <div className="sb-plan-detail__actions">
              <Link to={{ view: 'session', id: item.runSessionId, tab: 'chat' }} className="sb-button sb-plan-btn sb-plan-btn--ghost" data-testid="plan-detail-reply">
                Reply…
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {item.state === 'review' ? (
        <div className="sb-plan-detail__body" data-testid="plan-detail-review">
          {review?.summary ? <div className="sb-plan-detail__message">{review.summary}</div> : null}
          {comment === null ? (
            <div className="sb-plan-detail__actions">
              <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-detail-merge" disabled={busy || !review || !review.actions.includes('merge')} onClick={() => review && void run(() => api.reviewAction(review.id, 'merge'))}>
                Merge
              </button>
              <button type="button" className="sb-button sb-plan-btn" data-testid="plan-detail-send-back" disabled={busy || !review || !review.actions.includes('send-back')} onClick={() => setComment('')}>
                Send back
              </button>
              {item.runSessionId ? (
                <Link to={{ view: 'session', id: item.runSessionId, tab: 'diff' }} className="sb-button sb-plan-btn sb-plan-btn--ghost" data-testid="plan-detail-diff">
                  Open diff
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="sb-plan-detail__sendback">
              <textarea className="sb-plan-input" data-testid="plan-detail-comment" rows={3} placeholder="What should the agent change?" value={comment} onChange={(event) => setComment(event.target.value)} />
              <div className="sb-plan-detail__actions">
                <button type="button" className="sb-button sb-plan-btn sb-plan-btn--primary" data-testid="plan-detail-send" disabled={busy || comment.trim() === '' || !review} onClick={() => review && void run(() => api.reviewAction(review.id, 'send-back', { comment }).then(() => setComment(null)))}>
                  Send back
                </button>
                <button type="button" className="sb-button sb-plan-btn sb-plan-btn--ghost" onClick={() => setComment(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!review ? <div className="sb-plan-detail__text">Its Review card is being read…</div> : null}
          {review?.note ? <div className="sb-plan-detail__text">{review.note}</div> : null}
        </div>
      ) : null}

      {item.state === 'blocked' ? (
        <div className="sb-plan-detail__body">
          <div className="sb-plan-detail__reason" data-testid="plan-detail-reason">
            {item.reason ?? 'blocked'}
          </div>
          {item.storedState === 'failed' && !remote ? (
            <div className="sb-plan-detail__actions">
              <button type="button" className="sb-button sb-plan-btn" data-testid="plan-detail-retry" disabled={busy} onClick={() => void run(() => plansApi.retryItem(plan.id, item.id))}>
                Retry
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {item.state === 'running' ? (
        <div className="sb-plan-detail__body">
          <div className="sb-plan-detail__message" data-testid="plan-detail-latest">
            {latest ?? 'The agent is working…'}
          </div>
        </div>
      ) : null}

      {item.state === 'waiting' || item.state === 'ready' ? (
        <div className="sb-plan-detail__body">
          <div className="sb-plan-detail__text" data-testid="plan-detail-waiting">
            {item.state === 'ready' && plan.state === 'draft' ? 'Starts when the plan starts.' : waitingText(item, plan.items)}
          </div>
        </div>
      ) : null}

      {item.state === 'done' ? (
        <div className="sb-plan-detail__body">
          <div className="sb-plan-detail__text" data-testid="plan-detail-done">
            {doneText(item, plan)}
          </div>
        </div>
      ) : null}

      {error && item.state !== 'question' ? (
        <div className="sb-plan-error" data-testid="plan-detail-error">
          {error}
        </div>
      ) : null}
    </section>
  );
}
