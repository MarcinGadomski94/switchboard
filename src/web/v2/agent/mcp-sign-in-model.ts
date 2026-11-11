import type { Session } from '../../../core/api.ts';
import { signInNoticeText } from '../../../core/mcp-sign-in.ts';

/** D163: one "<server> needs you to sign in again" notice of the agent view. */
export interface SignInNoticeRow {
  readonly name: string;
  readonly text: string;
  /** A claude.ai connector: signed in on claude.ai (Open claude.ai connectors, then Reconnect). */
  readonly claudeAi: boolean;
  /** A paired computer's agent: its CLI listens for the sign-in on that computer, so the sign-in happens there (`null` = this one). */
  readonly elsewhere: string | null;
}

/** The notices of an agent: each server its running CLI needs a sign-in to, minus the dismissed ones. */
export function signInNoticeRows(session: Pick<Session, 'mcpSignIn' | 'machine' | 'closedAt'> | null, dismissed: ReadonlySet<string> = new Set()): SignInNoticeRow[] {
  if (!session || session.closedAt) return [];
  const elsewhere = session.machine?.name ?? null;
  return (session.mcpSignIn ?? [])
    .filter((need) => !dismissed.has(need.name))
    .map((need) => ({ name: need.name, text: signInNoticeText(need), claudeAi: need.claudeAi, elsewhere }));
}

/** What a notice shows while its sign-in runs. */
export type SignInPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

/** The line after a reconnect (`reconnected` / `failed` = how many agents). */
export function reconnectText(name: string, reconnected: number, failed: number): string {
  if (reconnected > 0 && failed === 0) return `Signed in. ${reconnected === 1 ? 'The agent' : `${reconnected} agents`} reconnected ${name}.`;
  if (reconnected > 0) return `Signed in. ${reconnected} reconnected ${name}; ${failed} could not be told (restart ${failed === 1 ? 'it' : 'them'}).`;
  if (failed > 0) return `Signed in, but the agent could not reconnect ${name}: restart it, or use /mcp in its terminal.`;
  return `Signed in to ${name}.`;
}
