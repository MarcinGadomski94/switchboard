import type { SessionListItem } from '../../../core/api.ts';
import type { TeamSummary } from '../../../core/team.ts';

/**
 * Fix after 2.0 · the name an agent shows everywhere in v2 (pure; unit-tested in
 * `tests/web/v2-teammates.test.ts`). An agent turned into a crew's teammate (D100)
 * shows its **teammate's name** (the member's role, e.g. "Reviewer/QA") with its
 * crew as a subtle tag, not its session's own name or title; after "Return to
 * agents" it is not in a roster any more and its own name shows again. Every v2
 * place that names an agent (the agent header, the peek, the browser tab, the
 * breadcrumbs, Needs you's agent tags, Home's Working now, Search, ⌘K) goes
 * through {@link agentDisplayName}, so they all agree.
 */

/** A session's teammate: its member, the member's name and its crew. */
export interface TeamMemberRef {
  readonly memberId: string;
  /** The member's name (its role, "Reviewer/QA"). */
  readonly name: string;
  readonly crewId: string;
  readonly crewName: string;
}

/** Every crew's teammates by session id (the roster's `sessionRef`). */
export type TeamMembers = ReadonlyMap<string, TeamMemberRef>;

/** No teammates (Team is off, or not read yet). */
export const NO_TEAM_MEMBERS: TeamMembers = new Map();

/** The teammates of `teams` by session id. */
export function teamMembersOf(teams: readonly Pick<TeamSummary, 'id' | 'name' | 'roster'>[]): TeamMembers {
  const out = new Map<string, TeamMemberRef>();
  for (const team of teams) for (const member of team.roster ?? []) out.set(member.sessionRef, { memberId: member.id, name: member.name, crewId: team.id, crewName: team.name });
  return out;
}

/** The session's teammate, or `null` when it is not in a crew. */
export function teammateOf(sessionId: string | null | undefined, members: TeamMembers): TeamMemberRef | null {
  return sessionId ? (members.get(sessionId) ?? null) : null;
}

/** The session's own name (its display title, its title, else its name). */
export function sessionOwnName(session: Pick<SessionListItem, 'displayTitle' | 'title' | 'name'>): string {
  return session.displayTitle ?? session.title ?? session.name;
}

/** The name the agent shows: its teammate's name while it is in a crew (a blank member name falls back), else its own. */
export function agentDisplayName(session: Pick<SessionListItem, 'id' | 'displayTitle' | 'title' | 'name'>, members: TeamMembers): string {
  const mate = members.get(session.id);
  return mate && mate.name.trim() ? mate.name.trim() : sessionOwnName(session);
}

/** The name for an item that only has a session id and a fallback name (Needs you's agent tags). */
export function displayNameById(sessionId: string | null | undefined, fallback: string, members: TeamMembers): string {
  const mate = teammateOf(sessionId, members);
  return mate && mate.name.trim() ? mate.name.trim() : fallback;
}
