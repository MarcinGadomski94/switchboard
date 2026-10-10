import type { Session, SessionListItem } from '../../core/api.ts';
import { CLI_LABELS, CLI_SHORT_LABELS, type CliProviderId, readCliProvider } from '../../core/cli-providers.ts';

/**
 * D62 P6 (`docs/providers.md` → *Sidebar*): the footer's default-CLI switcher,
 * the bulk "Switch running sessions…" and the rows' CLI badges. Pure.
 */

/** The footer label: the default CLI in the prototype's lower case (`claude code`, `codex cli`, `opencode`). */
export function footerLabel(provider: CliProviderId): string {
  return CLI_LABELS[provider].toLowerCase();
}

/**
 * The rows' CLI badge (`codex`, `claude`): shown on every row as soon as the
 * list holds a session on another CLI than Claude Code, so a list of Claude Code
 * sessions only looks exactly as before (ASSUMED D62-sidebar-badge).
 */
export function cliBadgeOf(sessions: readonly Pick<Session, 'provider'>[]): (session: Pick<Session, 'provider'>) => string | null {
  const mixed = sessions.some((session) => readCliProvider(session.provider) !== 'claude');
  return (session) => (mixed ? CLI_SHORT_LABELS[readCliProvider(session.provider)].toLowerCase() : null);
}

/** The live sessions a bulk switch offers: open, attached, a process running, not hooked. */
export function switchableSessions(sessions: readonly SessionListItem[]): SessionListItem[] {
  return sessions.filter((session) => session.live && session.attached && session.hooked !== true && (session.closedAt ?? null) === null);
}

/** One row's state in the bulk switch. */
export type BulkRowState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'already'; readonly text: string }
  | { readonly kind: 'switching'; readonly text: string }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

/**
 * A row's state from the session as it is now and what the bulk switch did with
 * it (`started`: its request was accepted; `refused`: the server's reason).
 */
export function bulkRowState(session: Session, target: CliProviderId, outcome: { readonly started: boolean; readonly refused: string | null } | null): BulkRowState {
  const provider = readCliProvider(session.provider);
  if (outcome?.refused) return { kind: 'failed', text: outcome.refused };
  if (session.providerSwitch) return { kind: 'switching', text: `switching to ${CLI_LABELS[session.providerSwitch.to]}…` };
  if (outcome?.started) {
    return provider === target ? { kind: 'done', text: `✓ on ${CLI_LABELS[target]}` } : { kind: 'failed', text: "the switch failed (its chat says why)" };
  }
  if (provider === target) return { kind: 'already', text: `already on ${CLI_LABELS[target]}` };
  return { kind: 'ready' };
}
