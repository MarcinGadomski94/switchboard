import type { SessionStatus } from './model.ts';

/**
 * D52: a terminal session's status words (`claude agents --json`: `busy`,
 * `waiting`, `idle`) as a session status: the color of a terminal loop's open
 * iteration and of its card's dot. Pure (the server and the UI share it).
 */
export function terminalStatus(status: string | null): SessionStatus {
  if (status === 'busy') return 'run';
  if (status === 'waiting') return 'need';
  return 'idle';
}
