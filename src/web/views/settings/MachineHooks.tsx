import { useState } from 'react';
import type { HooksStatus, TerminalSession } from '../../../core/api.ts';
import { ApiError, machineApi } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useRouter } from '../../router.tsx';
import { hooksStateLabel, refusalText, terminalLine } from './machines.ts';

function errorText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? refusalText(caught.body, fallback) : fallback;
}

/**
 * D48 P4 (`docs/peers.md` → *Hooked terminal sessions*): one machine's terminal
 * hooks in Settings → Machines. Its hooks' state in the machine's user Claude
 * settings with **Install hooks** / **Remove hooks** (each makes a timestamped
 * backup first and touches only Switchboard's entries), and **Hook into…**: the
 * `claude` sessions started by hand in that machine's terminals, each with its
 * folder and status, and Hook (the session opens here, tagged with its machine).
 * `machine` = `null` for this machine.
 */
export function MachineHooks({ machine, name }: { readonly machine: string | null; readonly name: string }) {
  const { navigate } = useRouter();
  const client = machineApi(machine);
  const status = useApi(() => client.hooks(), [machine]);
  const [changed, setChanged] = useState<HooksStatus | null>(null);
  const [open, setOpen] = useState(false);
  const terminals = useApi((): Promise<TerminalSession[] | null> => (open ? client.terminalSessions() : Promise.resolve(null)), [machine, open]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = changed ?? status.data;

  const run = async (action: () => Promise<unknown>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
    }
  };

  const testMachine = machine ?? 'self';
  return (
    <div className="sb-mach-hooks" data-testid="machine-hooks" data-machine={testMachine}>
      <span data-testid="hooks-state" data-state={shown?.state ?? 'unknown'} title={shown?.settingsPath}>
        {shown ? hooksStateLabel(shown) : status.error ? 'Terminal hooks: unknown' : 'Terminal hooks: …'}
      </span>
      {shown && shown.state !== 'installed' && shown.state !== 'unreadable' ? (
        <button type="button" className="sb-set-action" data-testid="hooks-install" disabled={busy} onClick={() => void run(async () => setChanged(await client.installHooks()), 'The hooks could not be installed.')}>
          Install hooks
        </button>
      ) : null}
      {shown && (shown.state === 'installed' || shown.state === 'outdated') ? (
        <button type="button" className="sb-set-action" data-testid="hooks-remove" disabled={busy} onClick={() => void run(async () => setChanged(await client.removeHooks()), 'The hooks could not be removed.')}>
          Remove hooks
        </button>
      ) : null}
      <button type="button" className="sb-set-action" data-testid="hook-into" aria-expanded={open} disabled={busy} onClick={() => setOpen((value) => !value)}>
        Hook into…
      </button>
      {shown?.lastBackup ? (
        <span className="sb-mach-hooks-note" data-testid="hooks-backup">
          {`Backup: ${shown.lastBackup}`}
        </span>
      ) : null}
      {error ? (
        <span className="sb-mach-hooks-note sb-set-error" role="alert" data-testid="hooks-error">
          {error}
        </span>
      ) : null}
      {open ? (
        <div className="sb-mach-terminals" data-testid="terminal-sessions" aria-label={`Terminal sessions on ${name}`}>
          {terminals.data === null ? (
            <span className="sb-mach-hooks-note" data-testid="terminal-sessions-note">
              {terminals.error ? errorText(terminals.error, 'The terminal sessions could not be listed.') : 'Looking for terminal sessions…'}
            </span>
          ) : terminals.data.length === 0 ? (
            <span className="sb-mach-hooks-note" data-testid="terminal-sessions-note">
              {`No claude sessions are running in ${name}'s terminals.`}
            </span>
          ) : (
            terminals.data.map((terminal) => (
              <div key={terminal.id} className="sb-mach-terminal" data-testid="terminal-session" data-terminal-id={terminal.id} data-hooked={terminal.hooked ? 'true' : 'false'}>
                <span className="sb-mach-terminal-text">{terminalLine(terminal)}</span>
                {terminal.hooked && terminal.sessionId ? (
                  <span className="sb-mach-state">hooked</span>
                ) : (
                  <button
                    type="button"
                    className="sb-set-action"
                    data-testid="terminal-hook"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const session = await client.hookTerminal(terminal.id);
                        navigate({ view: 'session', id: session.id, tab: 'chat' });
                      }, 'Could not hook into that session.')
                    }
                  >
                    Hook
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
