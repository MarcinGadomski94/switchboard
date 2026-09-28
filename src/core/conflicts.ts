import type { ConflictSession } from './api.ts';
import { displayTitle } from './session-title.ts';

/**
 * Conflict detection (M6.3, `docs/solutions.md` → *Conflicts*). ARCHITECTURE →
 * *Workspace rules*: "Two sessions writing the same repo → each must have its own
 * worktree, or a conflict warning appears"; the router's rule behind it is
 * "for two or more agents mutating the SAME repo in parallel, pass
 * isolation: 'worktree'". Pure rules only: which sessions write a repo is
 * decided by the caller (`LiveSolutions`).
 */

/** The row flag of a solution with a conflict (prototype `SG` → `mobile`). */
export const CONFLICT_FLAG = '⚠ shared working tree';

/** One open session writing a repo, as the conflict rule sees it. */
export interface RepoWriter {
  readonly sessionId: string;
  readonly name: string;
  /** D22: the session's title (`null` / absent: none); the card names the session by it. */
  readonly title?: string | null;
  /** ISO time the session was created (orders the names in the card). */
  readonly createdAt: string;
  /** `true` when it writes in a worktree of its own, `false` in the main checkout. */
  readonly isolated: boolean;
  /** The `{repo}` to isolate it with: the solution as the session lists it. */
  readonly repo: string;
  readonly attached: boolean;
}

/** A repo's conflict state: the row's `conflict`, `flag` and `conflictSessions`. */
export interface RepoConflict {
  readonly conflict: boolean;
  readonly flag: string;
  readonly sessions: readonly ConflictSession[];
}

/** No conflict. */
export const NO_CONFLICT: RepoConflict = { conflict: false, flag: '', sessions: [] };

/**
 * The conflict of one repo from its writers: two or more distinct sessions write
 * it and at least one of them has no worktree of its own. The sessions come back
 * oldest first (then by name); a session listed twice counts once, isolated if
 * any of its entries is.
 */
export function repoConflict(writers: readonly RepoWriter[]): RepoConflict {
  const byId = new Map<string, RepoWriter>();
  for (const writer of writers) {
    const seen = byId.get(writer.sessionId);
    byId.set(writer.sessionId, seen ? { ...seen, isolated: seen.isolated || writer.isolated } : writer);
  }
  const distinct = [...byId.values()];
  if (distinct.length < 2 || distinct.every((writer) => writer.isolated)) return NO_CONFLICT;
  distinct.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.name.localeCompare(b.name)));
  return {
    conflict: true,
    flag: CONFLICT_FLAG,
    sessions: distinct.map((writer) => ({
      sessionId: writer.sessionId,
      name: writer.name,
      title: writer.title ?? null,
      isolated: writer.isolated,
      repo: writer.repo,
      attached: writer.attached,
    })),
  };
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The conflict card's text (prototype `sd.warn`): "free-talk-feature and
 * button-rollout both write to mobile/ in one working tree. Your AGENTS.md
 * requires isolation: 'worktree' for parallel writers in the same repo." Three
 * or more sessions read "… all write to …". `folder` is the solution's path from
 * the workspace root (`mobile`, `microfrontends/web-front`); a trailing `/` is
 * added. D22: each session is named by its display title (its title, else its name).
 */
export function conflictText(sessions: readonly Pick<ConflictSession, 'name' | 'title'>[], folder: string): string {
  const names = sessions.map((session) => displayTitle(session));
  const quantifier = names.length === 2 ? 'both' : 'all';
  const where = `${folder.replace(/\/+$/, '')}/`;
  return `${joinNames(names)} ${quantifier} write to ${where} in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.`;
}

/** The card's action for a session without a worktree (prototype: "Move button-rollout to worktree"); `name` is what the session is shown as (D22: its display title). */
export function moveLabel(name: string): string {
  return `Move ${name} to worktree`;
}
