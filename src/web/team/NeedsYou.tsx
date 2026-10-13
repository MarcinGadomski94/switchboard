import { useState } from 'react';
import type { AnswerBatch, InboxAction, InboxItem } from '../../core/api.ts';
import type { TeamActivityRecord, TeamMember, TeamNeedsYouItem } from '../../core/team.ts';
import { api } from '../api/client.ts';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { useRouter } from '../router.tsx';
import { AccessRequestActions } from './access/index.ts';
import { refusalText, teamApi } from './api.ts';
import { activityTime, needsYouShape } from './model.ts';

/**
 * D100 · the Team page's left column: **Needs you (N)** (`GET /api/team/needs-you`),
 * answered in place: a question with its options (one question: a tap answers it;
 * several: the shared question card) plus **Reply…** (focuses the member's chat), a
 * permission request with its Inbox actions, (D102) a plan's "Ready to merge" item with
 * **Merge** and **Open plan**, a gate or budget request with **Approve** / **Decline**.
 * Then **Activity**: time, actor, text.
 */
export function NeedsYouList({
  items,
  onReply,
  onSetUp,
  onChanged,
  showTeam = false,
}: {
  readonly items: readonly TeamNeedsYouItem[];
  /** D100 follow-up 2026-10-14: the All teams tab labels every item with its team. */
  readonly showTeam?: boolean;
  /** Reply…: select the member and focus its chat's composer. */
  readonly onReply: (memberId: string) => void;
  /** T2's Set up… on an access request: select the member and open its Access tab at that access. */
  readonly onSetUp: (memberId: string, accessId: string) => void;
  readonly onChanged: () => void;
}) {
  return (
    <section className="sb-team-needs" data-testid="team-needs-you" data-tour="team-needs-you" aria-label="Needs you">
      <div className="sb-team-section-label">Needs you ({items.length})</div>
      {items.length === 0 ? (
        <div className="sb-team-muted" data-testid="team-needs-none">
          Nothing waits for you.
        </div>
      ) : null}
      {items.map((item) => (
        <NeedsYouCard key={`${item.source}:${item.id}`} item={item} showTeam={showTeam} onReply={() => onReply(item.memberId)} onSetUp={onSetUp} onChanged={onChanged} />
      ))}
    </section>
  );
}

function NeedsYouCard({ item, showTeam, onReply, onSetUp, onChanged }: { readonly item: TeamNeedsYouItem; readonly showTeam: boolean; readonly onReply: () => void; readonly onSetUp: (memberId: string, accessId: string) => void; readonly onChanged: () => void }) {
  const { navigate } = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shape = needsYouShape(item);
  const inbox = (item.inbox ?? null) as InboxItem | null;
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError(refusalText(caught));
    } finally {
      setBusy(false);
    }
  };
  const questions = inbox?.questions ?? [];
  const single = questions.length === 1 && !questions[0]?.multiSelect ? questions[0] : null;
  const answer = (body: AnswerBatch): Promise<void> => run(() => api.answerBatch(item.id, body));
  return (
    <div className="sb-team-need" data-testid="team-need" data-kind={item.kind} data-source={item.source} data-item-id={item.id}>
      <div className="sb-team-need__label">
        {showTeam && item.teamName ? (
          <span className="sb-team-need__team" data-testid="team-need-team">
            {item.teamName} ·{' '}
          </span>
        ) : null}
        {item.label}
      </div>
      {shape === 'access' ? null : (
        <div className="sb-team-need__title" data-testid="team-need-title">
          {single ? single.text : item.title}
        </div>
      )}
      {item.detail && shape !== 'question' && shape !== 'access' ? <div className="sb-team-need__detail">{item.detail}</div> : null}
      {shape === 'access' ? <AccessRequestActions item={item} onSetUp={onSetUp} onDecided={onChanged} /> : null}
      {shape === 'question' && single ? (
        <div className="sb-team-need__actions">
          {single.options.map((option, index) => (
            <button
              key={`${index}:${option.label}`}
              type="button"
              className="sb-button sb-team-btn"
              data-testid="team-need-option"
              disabled={busy}
              title={option.description || undefined}
              onClick={() => void answer({ answers: [{ questionId: single.id, answerIndex: index }] })}
            >
              {option.label}
            </button>
          ))}
          <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-need-reply" onClick={onReply}>
            Reply…
          </button>
        </div>
      ) : null}
      {shape === 'question' && !single ? (
        <>
          <QuestionCard key={item.id} questions={questions} variant="inbox" busy={busy} error={null} onSend={answer} />
          <div className="sb-team-need__actions">
            <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-need-reply" onClick={onReply}>
              Reply…
            </button>
          </div>
        </>
      ) : null}
      {shape === 'permission' ? (
        <div className="sb-team-need__actions">
          {(inbox?.actions ?? []).map((action: InboxAction, index) => (
            <button
              key={action.id}
              type="button"
              className={`sb-button sb-team-btn${index === 0 ? ' sb-team-btn--primary' : ''}`}
              data-testid="team-need-action"
              data-action={action.id}
              disabled={busy}
              onClick={() => void run(() => api.inboxAction(item.id, action.id))}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {shape === 'merge' && inbox ? (
        <div className="sb-team-need__actions">
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-need-merge" disabled={busy} onClick={() => void run(() => api.inboxAction(item.id, 'plan-merge'))}>
            Merge
          </button>
          {inbox.route ? (
            <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" data-testid="team-need-open-plan" onClick={() => navigate(inbox.route as string)}>
              Open plan
            </button>
          ) : null}
        </div>
      ) : null}
      {shape === 'request' ? (
        <div className="sb-team-need__actions">
          <button type="button" className="sb-button sb-team-btn sb-team-btn--primary" data-testid="team-need-approve" disabled={busy} onClick={() => void run(() => teamApi.decide(item.id, 'approve'))}>
            Approve
          </button>
          <button type="button" className="sb-button sb-team-btn" data-testid="team-need-decline" disabled={busy} onClick={() => void run(() => teamApi.decide(item.id, 'decline'))}>
            Decline
          </button>
        </div>
      ) : null}
      {shape === 'other' ? (
        <div className="sb-team-need__actions">
          <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost" onClick={() => navigate({ view: 'inbox' })}>
            Open in Inbox
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="sb-team-error" role="alert" data-testid="team-need-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The activity feed: time, actor (the member's role, else "You" / "Team"), text. */
export function ActivityFeed({ activity, members }: { readonly activity: readonly TeamActivityRecord[]; readonly members: readonly TeamMember[] }) {
  const now = new Date();
  const names = new Map(members.map((member) => [member.id, member.name]));
  return (
    <section className="sb-team-activity" data-testid="team-activity" aria-label="Activity">
      <div className="sb-team-section-label">Activity</div>
      {activity.length === 0 ? <div className="sb-team-muted">Nothing yet.</div> : null}
      {activity.slice(0, 50).map((entry) => (
        <div key={entry.id} className="sb-team-activity__row" data-testid="team-activity-row" data-kind={entry.kind}>
          <span className="sb-team-activity__time">{activityTime(entry.at, now)}</span>
          <span className="sb-team-activity__actor">{entry.memberId ? (names.get(entry.memberId) ?? 'Member') : 'Team'}</span>
          <span className="sb-team-activity__text">{entry.text}</span>
        </div>
      ))}
    </section>
  );
}
