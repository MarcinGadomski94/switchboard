import type { InboxItem } from '../../core/api.ts';
import type { SearchAnswer } from '../../core/search.ts';

/**
 * D100 · the seams Team plugs into the rest of Switchboard (`docs/team-removal.md`
 * lists every call site). Each is a no-op until a {@link TeamService} registers
 * itself for the store (`registerTeamHooks`), and answers "nothing" while Team is
 * off or `team.db` is unavailable, so the rest of Switchboard behaves exactly as
 * without Team. Keyed by the main `Store` object (one app, one store).
 */
export interface TeamHooks {
  /** The member's charter instruction for a session of this machine (`null` = not a member, or Team off). */
  charterFor(sessionId: string): Promise<string | null>;
  /** The role name of a session (this machine's id or `r~<machine>~<id>`), `null` when it is not a member's. */
  roleOf(sessionId: string): string | null;
  /**
   * A review card action on a member's session that its gates hold for the
   * developer's approval: the refusal's message (a Needs-you request was raised),
   * else `null` (go ahead).
   */
  reviewGate(input: { readonly reviewId: string; readonly sessionId: string; readonly action: string; readonly body: unknown; readonly bases: readonly (string | null)[] }): Promise<string | null>;
  /** Settings → Experimental → Team was switched (`PUT /api/settings`). */
  switchChanged(): Promise<void>;
}

const registry = new WeakMap<object, TeamHooks>();

/** Registers Team's hooks for `store`; returns the unregister function. */
export function registerTeamHooks(store: object, hooks: TeamHooks): () => void {
  registry.set(store, hooks);
  return () => {
    if (registry.get(store) === hooks) registry.delete(store);
  };
}

/** D64 seam: the standing instruction `base` with the session's charter appended (unchanged for a non-member or with Team off). */
export async function withTeamCharter(store: object, sessionId: string, base: string | null): Promise<string | null> {
  const charter = await registry.get(store)?.charterFor(sessionId).catch(() => null);
  if (!charter) return base;
  return base ? `${base}\n\n${charter}` : charter;
}

/** Inbox seam: member sessions' items are labelled with the role name (`teamRole`, and the role as `sourceTitle`). */
export function labelInboxItems(store: object, items: InboxItem[]): InboxItem[] {
  const hooks = registry.get(store);
  if (!hooks) return items;
  return items.map((item) => {
    const role = item.sessionId ? hooks.roleOf(item.sessionId) : null;
    return role ? { ...item, sourceTitle: role, teamRole: role } : item;
  });
}

/** Search seam (D97): a member session's results are labelled with the role name. */
export function labelSearchAnswer(store: object, answer: SearchAnswer): SearchAnswer {
  const hooks = registry.get(store);
  if (!hooks) return answer;
  return {
    ...answer,
    groups: answer.groups.map((group) => ({
      ...group,
      results: group.results.map((result) => {
        const sessionId = 'sessionId' in result.target ? result.target.sessionId : null;
        const role = sessionId ? hooks.roleOf(sessionId) : null;
        return role ? { ...result, sessionTitle: role, teamRole: role } : result;
      }),
    })),
  };
}

/** D79 seam: `null` = the review action may run; else the refusal's message (Team raised a gate request). */
export async function teamReviewGate(store: object, input: Parameters<TeamHooks['reviewGate']>[0]): Promise<string | null> {
  const hooks = registry.get(store);
  return hooks ? hooks.reviewGate(input) : null;
}

/** Settings seam: the Team switch changed. */
export async function teamSwitchChanged(store: object): Promise<void> {
  await registry.get(store)?.switchChanged();
}
