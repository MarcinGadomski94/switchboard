import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * D100: set (to `true`) while a Team request that came in through the peer API runs.
 * Team never forwards such a request again (no chains of machines): an operation on a
 * member that does not run here answers 409 `not-here` instead.
 */
export const peerCall = new AsyncLocalStorage<boolean>();
