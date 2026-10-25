import type { SessionListItem } from '../../../core/api.ts';
import { useLiveActivities, useTick } from '../../activity/useActivity.ts';
import { Button, Chip, Icon, Skeleton } from '../components/index.ts';
import { HOME_WORDS, computerStateToV2 } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { AgentCard, AgentRow } from '../shared/agent-row.tsx';
import type { NeedsItem } from '../shared/needs-you-model.ts';
import { clock } from '../shared/time.ts';
import { helpersOf } from './home-model.ts';

/**
 * D131 · Home's "Working now" (lane H; the prototype's `#working`): a live card
 * per agent whose turn runs, on every computer, newest activity first. The
 * activity line ticks (`useTick`), the helpers count follows the live activity,
 * the computer tag says where it runs; an offline computer's card is greyed with
 * the reason. A click opens the agent (`/agents/:id`: lane S exports no peek sheet
 * yet, see `docs/design/v2-decisions.md` → Lane H). A start from the box shows a
 * skeleton card until its agent is in the list.
 */

/** The agent a start from the box is making (its skeleton card). */
export interface PendingStart {
  readonly title: string;
  /** Set once `POST /api/sessions` answered. */
  readonly sessionId: string | null;
}

export function WorkingNow({ working, loaded, pending, items, phone }: { readonly working: readonly SessionListItem[]; readonly loaded: boolean; readonly pending: PendingStart | null; readonly items: readonly NeedsItem[]; readonly phone: boolean }) {
  const { navigate } = useV2Router();
  const activityOf = useLiveActivities(working as SessionListItem[]);
  const now = useTick(1000);
  const open = (id: string): void => navigate(`/agents/${encodeURIComponent(id)}`);
  const showPending = pending !== null && !working.some((session) => session.id === pending.sessionId);
  const approvalOf = (id: string): boolean => items.some((item) => item.agent?.sessionId === id && item.kind === 'approval');

  if (!loaded) {
    return (
      <div className={phone ? 'v2-home-plist' : 'v2-home-grid'} data-testid="v2-working-loading">
        {[0, 1].map((n) => (
          <div key={n} className="v2-card v2-wcard" aria-hidden="true">
            <Skeleton width="40%" height={14} />
            <Skeleton height={44} />
          </div>
        ))}
      </div>
    );
  }

  const skeleton = showPending ? (
    <div className="v2-card v2-wcard" data-testid="v2-working-pending" aria-busy="true">
      <div className="v2-row">
        <h3 className="v2-grow">{pending.title}</h3>
        <span className="v2-muted" style={{ fontSize: 13 }}>
          {HOME_WORDS.justNow}
        </span>
      </div>
      <div className="v2-activity">
        <Skeleton width="60%" />
      </div>
    </div>
  ) : null;

  if (working.length === 0 && !skeleton) {
    return (
      <div className="v2-home-empty" data-testid="v2-working-empty">
        {phone ? HOME_WORDS.nothingRunningPhone : HOME_WORDS.nothingRunning}
      </div>
    );
  }

  if (phone) {
    return (
      <div className="v2-home-plist" data-testid="v2-working">
        {skeleton}
        {working.map((session) => (
          <AgentRow key={session.id} session={session} activity={activityOf(session.id)} onOpen={() => open(session.id)} now={now} />
        ))}
      </div>
    );
  }

  return (
    <div className="v2-home-grid" data-testid="v2-working">
      {skeleton}
      {working.map((session) => {
        const activity = activityOf(session.id);
        const helpers = helpersOf(activity);
        const state = session.machine ? computerStateToV2(session.machine.state) : 'online';
        const off = state !== 'online';
        return (
          <div key={session.id} className="v2-home-wcard" {...(off ? { 'data-off': '' } : {})} data-testid="v2-working-card" data-session={session.id}>
            <AgentCard
              session={session}
              activity={off ? null : activity}
              now={now}
              onOpen={() => open(session.id)}
              footer={
                <>
                  {helpers > 0 ? (
                    <span className="v2-row" style={{ gap: 6 }} data-testid="v2-working-helpers">
                      <Icon name="agents" size="s" />
                      {HOME_WORDS.helpers(helpers)}
                    </span>
                  ) : null}
                  <span>{HOME_WORDS.startedAt(clock(activity?.turnStartedAt ?? session.createdAt))}</span>
                  {approvalOf(session.id) ? (
                    <Chip tone="amber" icon="shield" size="s">
                      {HOME_WORDS.approvalWaiting}
                    </Chip>
                  ) : null}
                  <span className="v2-grow" />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      open(session.id);
                    }}
                  >
                    {HOME_WORDS.open} <Icon name="arrow-r" size="s" />
                  </Button>
                  {off && session.machine ? (
                    <div className="v2-offline-note v2-home-offline" data-testid="v2-working-offline">
                      <Icon name="offline" size="s" />
                      {state === 'reconnecting' ? HOME_WORDS.reconnectingCard(session.machine.name) : HOME_WORDS.offlineCard(session.machine.name)}
                    </div>
                  ) : null}
                </>
              }
            />
          </div>
        );
      })}
    </div>
  );
}

