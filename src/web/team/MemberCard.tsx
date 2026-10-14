import type { MouseEvent } from 'react';
import type { SessionActivity } from '../../core/api.ts';
import type { TeamMember, TeamMemberStatus, TeamNeedsYouItem } from '../../core/team.ts';
import { sessionActivityLabel } from '../activity/activity.ts';
import { STATUS_META, budgetLine, idleLine } from './model.ts';

/**
 * D100 · one member's card on the Team page: a top border coloured by its status
 * (working = run blue, needs you = amber, idle = grey, paused = dimmed, offline =
 * dimmed with ⌁), the status icon, the role, "from “<session title>”", the current
 * work line, its machine, its budget and a "needs you" badge. A click selects it;
 * a right click or ⋯ opens its menu.
 */
export function MemberCard({
  member,
  status,
  needs,
  firstNeed,
  activity,
  selected,
  showMachine,
  now,
  onSelect,
  onMenu,
}: {
  readonly member: TeamMember;
  /** The status the card is coloured by (`needs-you` also when only Needs-you items wait). */
  readonly status: TeamMemberStatus;
  readonly needs: number;
  readonly firstNeed: TeamNeedsYouItem | null;
  readonly activity: SessionActivity | null;
  readonly selected: boolean;
  /** Paired machines exist: every card names its machine. */
  readonly showMachine: boolean;
  readonly now: number;
  readonly onSelect: () => void;
  readonly onMenu: (anchor: { readonly x: number; readonly y: number }) => void;
}) {
  const meta = STATUS_META[status];
  const work = activity && member.status === 'working' ? sessionActivityLabel(activity, now).text : idleLine(member, firstNeed);
  const budget = budgetLine(member);
  const menu = (event: MouseEvent<HTMLElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    onMenu(event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.right, y: rect.bottom });
  };
  return (
    <div
      role="button"
      tabIndex={0}
      className="sb-team-card"
      data-testid="team-card"
      data-member-id={member.id}
      data-status={status}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        // The card's own keys only: Enter / Space on its ⋯ opens the menu (D100 follow-up 2026-10-14, keyboard).
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={menu}
    >
      <div className="sb-team-card__head">
        <span className="sb-team-card__icon" data-testid="team-card-status" title={meta.label} aria-label={meta.label}>
          {meta.icon}
        </span>
        <span className="sb-team-card__role" data-testid="team-card-role">
          {member.name}
        </span>
        {needs > 0 ? (
          <span className="sb-team-card__need" data-testid="team-card-need">
            needs you{needs > 1 ? ` · ${needs}` : ''}
          </span>
        ) : null}
        <button type="button" className="sb-button sb-team-card__more" data-testid="team-card-menu" aria-label={`${member.name}: more`} onClick={menu}>
          ⋯
        </button>
      </div>
      <div className="sb-team-card__from">from “{member.sessionTitle ?? member.sessionId}”</div>
      <div className="sb-team-card__work" data-testid="team-card-work" title={work}>
        {work}
      </div>
      <div className="sb-team-card__foot">
        {showMachine || !member.local ? (
          <span className="sb-team-chip" data-testid="team-card-machine">
            {member.status === 'offline' ? '⌁ ' : ''}
            {member.machineName}
          </span>
        ) : null}
        {budget ? (
          <span className="sb-team-card__budget" data-testid="team-card-budget">
            {budget}
          </span>
        ) : null}
      </div>
    </div>
  );
}
