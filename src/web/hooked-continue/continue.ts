import { actionErrorText } from '../views/session/session-header.ts';

/**
 * D72: how the Continue-in-Switchboard dialog reads a refused call: 409
 * `terminal-running` asks for the confirmation (with the terminal's pid), anything
 * else is shown as the reason (nothing changed). No React, no network.
 */
export type ContinueRefusalView = { readonly kind: 'confirm'; readonly pid: number | null } | { readonly kind: 'error'; readonly text: string };

/** Reads a refusal (`status` 0 = not reachable). */
export function continueRefusal(status: number, body: unknown): ContinueRefusalView {
  const record = body && typeof body === 'object' ? (body as { error?: unknown; pid?: unknown }) : null;
  if (status === 409 && record?.error === 'terminal-running') return { kind: 'confirm', pid: typeof record.pid === 'number' ? record.pid : null };
  return { kind: 'error', text: actionErrorText(status, body) };
}

/** The dialog's title. */
export function continueTitle(machineName: string | null): string {
  return machineName ? `Continue in Switchboard (on ${machineName})` : 'Continue in Switchboard';
}
