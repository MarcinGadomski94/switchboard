import type { Session, SessionProviderSwitch } from '../../../core/api.ts';
import { CLI_LABELS, type CliProviderId, readCliProvider } from '../../../core/cli-providers.ts';

/**
 * D62 P5 · the session header's CLI switcher (`docs/providers.md` → *Switching
 * CLIs*): the pure part.
 */

/** The session's CLI (`claude` for a payload without one: an older peer, the demo). */
export function sessionProvider(session: Pick<Session, 'provider'>): CliProviderId {
  return readCliProvider(session.provider);
}

/** `true` when the header offers the switcher: a session Switchboard runs (not hooked, not the demo's, not closed). */
export function offersSwitcher(session: Session): boolean {
  return session.hooked !== true && session.model !== null && session.model !== undefined && session.closedAt == null && session.attached;
}

/** What the confirmation says before a switch. */
export function switchConfirmText(from: CliProviderId, to: CliProviderId): string {
  return `Switch this session from ${CLI_LABELS[from]} to ${CLI_LABELS[to]}? ${CLI_LABELS[from]} writes a handover first (if it can't, ${CLI_LABELS[to]} reads the chat history itself); then ${CLI_LABELS[to]} continues here, in the same folder.`;
}

/** The running switch in words ("Switching to Codex CLI… asking Claude Code for a handover"). */
export function switchProgressText(running: SessionProviderSwitch): string {
  const step =
    running.step === 'handover'
      ? `asking ${CLI_LABELS[running.from]} for a handover`
      : running.step === 'export'
        ? `exporting the chat for ${CLI_LABELS[running.to]}`
        : running.step === 'stopping'
          ? `stopping ${CLI_LABELS[running.from]}`
          : `starting ${CLI_LABELS[running.to]}`;
  return `Switching to ${CLI_LABELS[running.to]}… ${step}`;
}
