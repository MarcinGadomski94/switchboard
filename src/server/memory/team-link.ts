// Team (D100) hook: Project memory's member scope reads who a session is through Team's hooks (docs/team-removal.md).
import { type TeamMemberRef, teamMemberList, teamMemberOf } from '../team/hooks.ts';

/**
 * D107 follow-up 2026-10-15 · the one place Project memory reads Team (D100): the member a session
 * is (its member scope) and the members ("Draft memory for all members"). Both answer nothing while
 * Team is off; without Team (`docs/team-removal.md`) they become `() => null` / `() => []`.
 */
export type MemoryMember = TeamMemberRef;

/** The member a session of this machine is, `null` otherwise. */
export function memberOfSession(store: object, sessionId: string): MemoryMember | null {
  return teamMemberOf(store, sessionId);
}

/** Every member (every team), each with whether it runs here. */
export function members(store: object): readonly MemoryMember[] {
  return teamMemberList(store);
}
