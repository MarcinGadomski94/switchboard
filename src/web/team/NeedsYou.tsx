import { useEffect, useState } from 'react';
import type { AnswerBatch, InboxAction, InboxItem } from '../../core/api.ts';
import type { TeamActivityRecord, TeamMember, TeamNeedsYouItem } from '../../core/team.ts';
import { api } from '../api/client.ts';
import { QuestionCard } from '../components/QuestionCard.tsx';
import { useRouter } from '../router.tsx';
import { AccessRequestActions } from './access/index.ts';
import { refusalText, teamApi } from './api.ts';
import { CharterProposal } from './CharterProposal.tsx';
import { ACTIVITY_ICON, ACTIVITY_PAGE, type ActivityRow, activityClock, chipNames, clockRange, groupActivity, groupLabel, newSince, newestAt, stripActor } from './activity.ts';
import { activitySeenAt, addKnownNeeds, knownNeeds, sectionCollapsed, setActivitySeenAt, setSectionCollapsed } from './local.ts';
import { needsYouShape } from './model.ts';

/**
 * D100 · the Team page's left column: **Needs you (N)** (`GET /api/team/needs-you`),
 * answered in place: a question with its options (one question: a tap answers it;
 * several: the shared question card) plus **Reply…** (focuses the member's chat), a
 * permission request with its Inbox actions, (D102) a plan's "Ready to merge" item with
 * **Merge** and **Open plan**, a gate or budget request with **Approve** / **Decline**,
 * (D105) a charter proposal with its before → after and **Accept** / **Edit…** / **Dismiss**.
 * Then **Activity** (`ActivityFeed`). D100 follow-up 2026-10-14: both sections collapse
 * (▾ / ▸, remembered in this browser); an empty Needs you is one muted line on its header,
 * and a new item expands a collapsed Needs you.
 */
export function NeedsYouList({
  items,
  onReply,
  onSetUp,
  onEditCharter,
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
  /** D105 Edit… on a charter proposal: select the member and open its Settings with the proposal filled in. */
  readonly onEditCharter: (memberId: string) => void;
  readonly onChanged: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => sectionCollapsed('needs'));
  const keys = items.map((item) => `${item.source}:${item.id}`).join('\n');
  useEffect(() => {
    if (keys === '') return;
    const current = keys.split('\n');
    const known = knownNeeds();
    const fresh = current.some((key) => !known.has(key));
    addKnownNeeds(current);
    // A new item arrives: a collapsed Needs you opens again.
    if (fresh) {
      setCollapsed(false);
      setSectionCollapsed('needs', false);
    }
  }, [keys]);
  const toggle = (): void => {
    setCollapsed((was) => {
      setSectionCollapsed('needs', !was);
      return !was;
    });
  };
  const empty = items.length === 0;
  return (
    <section className="sb-team-needs" data-testid="team-needs-you" data-tour="team-needs-you" aria-label="Needs you" data-collapsed={!empty && collapsed ? 'true' : undefined}>
      {empty ? (
        <div className="sb-team-section-head sb-team-section-head--inline">
          <span className="sb-team-section-label">Needs you (0)</span>
          <span className="sb-team-muted sb-team-needs-none" data-testid="team-needs-none">
            Nothing waits for you ✓
          </span>
        </div>
      ) : (
        <div className="sb-team-section-head">
          <button type="button" className="sb-team-section-toggle" data-testid="team-needs-toggle" aria-expanded={!collapsed} onClick={toggle}>
            <span className="sb-team-section-chevron" aria-hidden="true">
              {collapsed ? '▸' : '▾'}
            </span>
            Needs you ({items.length})
          </button>
        </div>
      )}
      {!empty && !collapsed ? (
        <div className="sb-team-needs__list">
          {items.map((item) => (
            <NeedsYouCard key={`${item.source}:${item.id}`} item={item} showTeam={showTeam} onReply={() => onReply(item.memberId)} onSetUp={onSetUp} onEditCharter={() => onEditCharter(item.memberId)} onChanged={onChanged} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function NeedsYouCard({
  item,
  showTeam,
  onReply,
  onSetUp,
  onEditCharter,
  onChanged,
}: {
  readonly item: TeamNeedsYouItem;
  readonly showTeam: boolean;
  readonly onReply: () => void;
  readonly onSetUp: (memberId: string, accessId: string) => void;
  readonly onEditCharter: () => void;
  readonly onChanged: () => void;
}) {
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
      {item.detail && shape !== 'question' && shape !== 'access' && shape !== 'charter' ? <div className="sb-team-need__detail">{item.detail}</div> : null}
      {shape === 'charter' && item.charter ? <CharterProposal requestId={item.id} before={item.charter.before} after={item.charter.after} notes={item.charter.notes} onEdit={onEditCharter} onDecided={onChanged} /> : null}
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

/**
 * D100 follow-up 2026-10-14 (activity redesign): the activity feed. Each entry is two
 * lines (kind icon · actor · time, then its text without the actor); a run of the same
 * event by different members collapses into one group row that expands on a click; the
 * header collapses the feed (▾ / ▸, remembered in this browser) and, collapsed, counts
 * the entries that arrived since it was last open ("· 3 new"). {@link ACTIVITY_PAGE}
 * rows, then **Show more**.
 */
export function ActivityFeed({ activity, members }: { readonly activity: readonly TeamActivityRecord[]; readonly members: readonly TeamMember[] }) {
  const now = new Date();
  const names = new Map(members.map((member) => [member.id, member.name]));
  const actorOf = (entry: TeamActivityRecord): string => (entry.memberId ? (names.get(entry.memberId) ?? 'Member') : 'Team');
  const [collapsed, setCollapsed] = useState(() => sectionCollapsed('activity'));
  const [seenAt, setSeenAt] = useState(() => activitySeenAt());
  const [limit, setLimit] = useState(ACTIVITY_PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const newest = newestAt(activity);
  useEffect(() => {
    // Open: everything in view counts as seen.
    if (collapsed || newest === null) return;
    setActivitySeenAt(newest);
    setSeenAt(activitySeenAt());
  }, [collapsed, newest]);
  const fresh = collapsed ? newSince(activity, seenAt) : 0;
  const rows = groupActivity(activity);
  const toggle = (): void => {
    setCollapsed((was) => {
      setSectionCollapsed('activity', !was);
      return !was;
    });
  };
  const toggleGroup = (id: string): void =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section className="sb-team-activity" data-testid="team-activity" aria-label="Activity" data-collapsed={collapsed ? 'true' : undefined}>
      <div className="sb-team-section-head">
        <button type="button" className="sb-team-section-toggle" data-testid="team-activity-toggle" aria-expanded={!collapsed} onClick={toggle}>
          <span className="sb-team-section-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          Activity
          {fresh > 0 ? (
            <span className="sb-team-section-new" data-testid="team-activity-new">
              · {fresh} new
            </span>
          ) : null}
        </button>
      </div>
      {collapsed ? null : (
        <div className="sb-team-activity__list" data-testid="team-activity-list">
          {activity.length === 0 ? <div className="sb-team-muted">Nothing yet.</div> : null}
          {rows.slice(0, limit).map((row) =>
            row.type === 'entry' ? (
              <ActivityEntry key={row.entry.id} row={row} actor={actorOf(row.entry)} now={now} />
            ) : (
              <ActivityGroup key={row.id} row={row} actorOf={actorOf} now={now} expanded={open.has(row.id)} onToggle={() => toggleGroup(row.id)} />
            ),
          )}
          {rows.length > limit ? (
            <button type="button" className="sb-button sb-team-btn sb-team-btn--ghost sb-team-activity__more" data-testid="team-activity-more" onClick={() => setLimit((was) => was + ACTIVITY_PAGE)}>
              Show more
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ActivityEntry({ row, actor, now }: { readonly row: Extract<ActivityRow, { type: 'entry' }>; readonly actor: string; readonly now: Date }) {
  const { entry, variant } = row;
  return (
    <div className="sb-team-act" data-testid="team-activity-row" data-kind={entry.kind} data-variant={variant}>
      <div className="sb-team-act__head">
        <span className="sb-team-act__icon" aria-hidden="true">
          {ACTIVITY_ICON[variant]}
        </span>
        <span className="sb-team-act__actor" data-testid="team-activity-actor">
          {actor}
        </span>
        <span className="sb-team-act__time" data-testid="team-activity-time">
          {activityClock(entry.at, now)}
        </span>
      </div>
      <div className="sb-team-act__text" data-testid="team-activity-text">
        {stripActor(entry.text, actor)}
      </div>
    </div>
  );
}

function ActivityGroup({
  row,
  actorOf,
  now,
  expanded,
  onToggle,
}: {
  readonly row: Extract<ActivityRow, { type: 'group' }>;
  readonly actorOf: (entry: TeamActivityRecord) => string;
  readonly now: Date;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const newestEntry = row.entries[0] as TeamActivityRecord;
  const oldestEntry = row.entries[row.entries.length - 1] as TeamActivityRecord;
  const chips = chipNames(row.entries.map(actorOf));
  return (
    <div className="sb-team-act sb-team-act--group" data-testid="team-activity-group" data-variant={row.variant} data-count={row.entries.length} data-expanded={expanded ? 'true' : undefined}>
      <button type="button" className="sb-team-act__group-toggle" data-testid="team-activity-group-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span className="sb-team-act__head">
          <span className="sb-team-act__icon" aria-hidden="true">
            {ACTIVITY_ICON[row.variant]}
          </span>
          <span className="sb-team-act__label" data-testid="team-activity-group-label">
            {groupLabel(row.variant, row.entries.length)}
          </span>
          <span className="sb-team-act__time" data-testid="team-activity-time">
            {clockRange(oldestEntry.at, newestEntry.at, now)}
          </span>
        </span>
        <span className="sb-team-act__chips" data-testid="team-activity-chips">
          {chips.names.map((name, index) => (
            <span key={`${index}:${name}`} className="sb-team-act__chip">
              {name}
            </span>
          ))}
          {chips.more > 0 ? <span className="sb-team-act__chip sb-team-act__chip--more">+{chips.more}</span> : null}
          <span className="sb-team-act__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="sb-team-act__children" data-testid="team-activity-group-rows">
          {row.entries.map((entry) => (
            <ActivityEntry key={entry.id} row={{ type: 'entry', entry, variant: row.variant }} actor={actorOf(entry)} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
