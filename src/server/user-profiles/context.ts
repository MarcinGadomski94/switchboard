import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProfileScope } from '../../core/user-profiles.ts';

/**
 * D165 · the profile scope of the work in progress (`docs/profiles.md` → *Scope*): set for each
 * request by the guard that follows the security hook (the browser's signed profile cookie, a
 * paired phone's profile, the agent's own session's profile, `'*'` for the peer API and the hook
 * script), and read where a list is filtered or a new agent is created without an explicit
 * profile. Work Switchboard does on its own (timers, schedulers) runs outside any request: no
 * scope (`undefined`), which creation reads as "Default unless the source says otherwise".
 */
const storage = new AsyncLocalStorage<{ readonly scope: ProfileScope }>();

/** Runs `work` with `scope` as the current profile scope. */
export function runInProfileScope<T>(scope: ProfileScope, work: () => T): T {
  return storage.run({ scope }, work);
}

/** The current profile scope; `undefined` outside any request (Switchboard's own work). */
export function currentProfileScope(): ProfileScope | undefined {
  return storage.getStore()?.scope;
}

/** The profile a new record takes from the current scope: the scope's profile, else `null` (no single profile). */
export function currentProfileForCreate(): string | null {
  const scope = currentProfileScope();
  return typeof scope === 'string' && scope !== '*' ? scope : null;
}

/**
 * D165: the sessions the current scope may count (Insights, the usage breakdown): `null` = every
 * session (outside a request, the peer API's own work, `'*'`); else a test of a session id against
 * `profileOf` (an unknown id, e.g. a folder's memory check, belongs to no profile: not counted).
 */
export function scopedSessionTest(profileOf: () => ReadonlyMap<string, string>): ((sessionId: string) => boolean) | null {
  const scope = currentProfileScope();
  if (scope === undefined || scope === '*') return null;
  if (scope === null) return () => false;
  const profiles = profileOf();
  return (sessionId) => profiles.get(sessionId) === scope;
}

/** D165: a cache key part for the current scope (answers differ per profile). */
export function scopeKey(): string {
  const scope = currentProfileScope();
  return scope === undefined ? '*' : scope === null ? '-' : scope;
}