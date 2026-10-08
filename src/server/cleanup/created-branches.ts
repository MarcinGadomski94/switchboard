import type { SettingRepository } from '../db/repos/settings.ts';

/**
 * D84 (`docs/cleanup.md` → *What counts as Switchboard's*): the local branches
 * Switchboard itself created with `git worktree add -b` (a session's
 * `session/{name}`, a D40 task branch that did not exist yet), recorded so
 * Clean-up can tell them from branches that were only picked or reused. Kept
 * as one settings value (like the take-over leftovers): no migration.
 *
 * `kind`: `new` = the branch was new everywhere (cut from a base: whatever is on
 * a remote under that name was pushed from Switchboard's worktree); `tracking` =
 * a new local branch tracking a branch that was already on `origin` (the remote
 * branch is not Switchboard's).
 */
export const CREATED_BRANCHES_SETTING = 'cleanup.createdBranches';

/** One branch Switchboard created. */
export interface CreatedBranch {
  readonly repoPath: string;
  readonly branch: string;
  readonly kind: 'new' | 'tracking';
  readonly at: string;
}

/** At most this many are kept (oldest dropped first). */
const MAX_RECORDS = 5000;

function isCreated(value: unknown): value is CreatedBranch {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['repoPath'] === 'string' && typeof record['branch'] === 'string' && (record['kind'] === 'new' || record['kind'] === 'tracking') && typeof record['at'] === 'string';
}

/** The recorded branches. */
export async function createdBranches(settings: SettingRepository): Promise<CreatedBranch[]> {
  const stored = await settings.get(CREATED_BRANCHES_SETTING);
  return Array.isArray(stored) ? stored.filter(isCreated) : [];
}

/** Records a branch Switchboard just created (idempotent per repo + branch: the newest wins). */
export async function recordCreatedBranch(settings: SettingRepository, entry: Omit<CreatedBranch, 'at'>, now: Date = new Date()): Promise<void> {
  const others = (await createdBranches(settings)).filter((item) => !(item.repoPath === entry.repoPath && item.branch === entry.branch));
  await settings.set(CREATED_BRANCHES_SETTING, [...others, { ...entry, at: now.toISOString() }].slice(-MAX_RECORDS));
}

/** Forgets a branch (after Clean-up deleted it). */
export async function forgetCreatedBranch(settings: SettingRepository, repoPath: string, branch: string): Promise<void> {
  const all = await createdBranches(settings);
  const kept = all.filter((item) => !(item.repoPath === repoPath && item.branch === branch));
  if (kept.length !== all.length) await settings.set(CREATED_BRANCHES_SETTING, kept);
}
