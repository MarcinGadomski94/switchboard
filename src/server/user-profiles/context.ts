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
