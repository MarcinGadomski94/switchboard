import type { Session } from '../../../core/api.ts';
import { CLI_LABELS } from '../../../core/cli-providers.ts';
import { CLI_MODE_WORDS } from '../glossary.ts';

/**
 * D171 · what the agent's CLI tab shows (`docs/terminals.md` → *CLI mode*):
 * - `cli`: the agent is in CLI mode, its terminal (`machine`: a paired computer's id, `null` here);
 * - `enter`: it can switch (`running`: a turn runs, so the tab offers Wait / Stop the turn instead of switching at once);
 * - `unavailable`: why it cannot (not Claude Code, a conversation, a terminal session of its own, archived, moved, offline).
 */
export type CliTabState =
  | { readonly kind: 'cli'; readonly terminalId: string; readonly machine: string | null }
  | { readonly kind: 'enter'; readonly running: boolean }
  | { readonly kind: 'unavailable'; readonly text: string };

/** The CLI tab's state for `session` (`null` while it loads). */
export function cliTabState(session: Session | null): CliTabState | null {
  if (!session) return null;
  const machine = session.machine?.id ?? null;
  if (session.cliMode) return { kind: 'cli', terminalId: session.cliMode.terminalId, machine };
  const provider = session.provider ?? 'claude';
  if (provider !== 'claude') return { kind: 'unavailable', text: CLI_MODE_WORDS.notClaude(CLI_LABELS[provider]) };
  if (session.kind === 'chat') return { kind: 'unavailable', text: CLI_MODE_WORDS.chat };
  if (session.hooked) return { kind: 'unavailable', text: CLI_MODE_WORDS.hooked };
  if (session.movedTo) return { kind: 'unavailable', text: CLI_MODE_WORDS.moved(session.movedTo.machineName) };
  if (session.closedAt) return { kind: 'unavailable', text: CLI_MODE_WORDS.archived };
  if (session.machine && session.machine.state !== 'online') return { kind: 'unavailable', text: CLI_MODE_WORDS.offline };
  return { kind: 'enter', running: session.status === 'run' };
}
