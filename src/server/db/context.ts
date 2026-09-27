import type { DatabaseSync } from 'node:sqlite';

/** What every repository gets from the store. */
export interface RepoContext {
  readonly db: DatabaseSync;
  /** Current time as an ISO 8601 UTC string (a fake clock in tests). */
  readonly now: () => string;
}

/**
 * Input of a `create` method: the `Required` fields, every other field optional
 * (the table default applies when omitted), minus the `Auto` fields the repository
 * always sets itself (timestamps).
 */
export type CreateInput<R, Required extends keyof R, Auto extends keyof R = never> = Pick<R, Required> &
  Partial<Omit<R, Required | Auto>>;

/** Input of an `update` method: any field except the `Fixed` ones. */
export type Patch<R, Fixed extends keyof R> = Partial<Omit<R, Fixed>>;

/** `?, ?, ?` for an `IN (…)` list of `count` values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
