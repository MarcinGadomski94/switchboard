import { useEffect, useState } from 'react';
import type { CliOverview, Session, SessionListItem } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId, readCliProvider } from '../../core/cli-providers.ts';
import { ApiError, api } from '../api/client.ts';
import { CliPicker } from '../components/CliPicker.tsx';
import { cliChoices } from '../components/cli.ts';
import { type BulkRowState, bulkRowState, footerLabel, switchableSessions } from './cli-switch.ts';
import '../components/cli-picker.css';

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * D62 P6: the footer's CLI label is a button (its text the default CLI, in the
 * prototype's style): it opens a menu to set the **default CLI for new sessions**
 * and **Switch running sessions…** (a checklist of the live sessions, all ticked,
 * each handed over with D62's switch; progress per session, failures shown, the
 * others go on).
 */
export function CliSwitcher({ sessions }: { readonly sessions: readonly SessionListItem[] }) {
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.clis().then(
      (value) => live && setOverview(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open]);
  const current: CliProviderId = overview?.default ?? 'claude';
  // The menu closes on Esc and on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const away = (event: MouseEvent): void => {
      const target = event.target as Element | null;
      if (!target?.closest('[data-testid="footer-cli-menu"], [data-testid="footer-cli"]')) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', away);
    };
  }, [open]);
  const pick = (provider: CliProviderId): void => {
    setError(null);
    api.setDefaultCli(provider).then(
      (value) => {
        setOverview(value);
        setOpen(false);
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  return (
    <>
      <button
        type="button"
        className="sb-footer-label sb-footer-cli"
        data-testid="footer-cli"
        data-provider={current}
        aria-haspopup="menu"
        aria-expanded={open}
        title="The CLI new sessions start on · Switch running sessions…"
        onClick={() => setOpen((value) => !value)}
      >
        {footerLabel(current)}
      </button>
      {open ? (
        <div className="sb-footer-cli-menu" role="menu" data-testid="footer-cli-menu">
          <div className="sb-footer-cli-title">Default CLI for new sessions</div>
          {cliChoices(overview).map((choice) => (
            <button
              key={choice.provider}
              type="button"
              role="menuitemradio"
              aria-checked={choice.provider === current}
              className="sb-footer-cli-item"
              data-testid="footer-cli-option"
              data-provider={choice.provider}
              disabled={choice.disabled}
              title={choice.reason ?? undefined}
              onClick={() => pick(choice.provider)}
            >
              <span className="sb-footer-cli-check">{choice.provider === current ? '●' : '○'}</span>
              {choice.label}
            </button>
          ))}
          {error ? (
            <div className="sb-footer-cli-error" role="alert" data-testid="footer-cli-error">
              {error}
            </div>
          ) : null}
          <button
            type="button"
            className="sb-footer-cli-item sb-footer-cli-bulk"
            data-testid="footer-cli-bulk"
            onClick={() => {
              setOpen(false);
              setBulk(true);
            }}
          >
            Switch running sessions…
          </button>
        </div>
      ) : null}
      {bulk ? <BulkSwitchDialog sessions={sessions} overview={overview} initial={current} onClose={() => setBulk(false)} /> : null}
    </>
  );
}

/** D62 P6: "Switch running sessions…": the live sessions, all ticked; each switched with a handover. */
function BulkSwitchDialog({ sessions, overview, initial, onClose }: { readonly sessions: readonly SessionListItem[]; readonly overview: CliOverview | null; readonly initial: CliProviderId; readonly onClose: () => void }) {
  const [target, setTarget] = useState<CliProviderId>(initial);
  // The rows are fixed when the dialog opens (a session stays listed while it switches).
  const [ids] = useState(() => switchableSessions(sessions).map((session) => session.id));
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(ids));
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, { started: boolean; refused: string | null }>>(new Map());
  const [running, setRunning] = useState(false);
  const rows = ids.map((id) => sessions.find((session) => session.id === id)).filter((session): session is Session => session !== undefined);
  const states = new Map<string, BulkRowState>(rows.map((session) => [session.id, bulkRowState(session, target, outcomes.get(session.id) ?? null)]));
  const chosen = rows.filter((session) => ticked.has(session.id) && states.get(session.id)?.kind === 'ready');
  const started = outcomes.size > 0;
  const start = async (): Promise<void> => {
    setRunning(true);
    // Each switch on its own: a refusal is shown on its row and the others go on.
    await Promise.all(
      chosen.map(async (session) => {
        try {
          await api.switchProvider(session.id, target);
          setOutcomes((current) => new Map(current).set(session.id, { started: true, refused: null }));
        } catch (caught) {
          setOutcomes((current) => new Map(current).set(session.id, { started: false, refused: errorText(caught) }));
        }
      }),
    );
    setRunning(false);
  };
  return (
    <div className="sb-overlay" data-modal="bulk-switch" onClick={onClose}>
      <div className="sb-bulk-switch" role="dialog" aria-modal="true" aria-label="Switch running sessions" data-testid="bulk-switch" onClick={(event) => event.stopPropagation()}>
        <div className="sb-bulk-switch-title">Switch running sessions</div>
        <div className="sb-bulk-switch-row sb-bulk-switch-target">
          <span>to</span>
          <CliPicker testId="bulk-switch-target" value={target} overview={overview} disabled={running || started} onPick={setTarget} />
        </div>
        <div className="sb-bulk-switch-note">
          Each session&apos;s agent writes a handover first (or the incoming CLI reads its chat history), then {CLI_LABELS[target]} continues it in the same folder.
        </div>
        {rows.length === 0 ? (
          <div className="sb-bulk-switch-empty" data-testid="bulk-switch-empty">
            No session has a running process.
          </div>
        ) : (
          <ul className="sb-bulk-switch-list">
            {rows.map((session) => {
              const state = states.get(session.id) ?? { kind: 'ready' };
              return (
                <li key={session.id} className="sb-bulk-switch-item" data-testid="bulk-switch-item" data-session-id={session.id} data-state={state.kind}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid="bulk-switch-check"
                      checked={ticked.has(session.id) && state.kind === 'ready'}
                      disabled={state.kind !== 'ready' || running || started}
                      onChange={(event) =>
                        setTicked((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(session.id);
                          else next.delete(session.id);
                          return next;
                        })
                      }
                    />
                    <span className="sb-bulk-switch-name">{session.displayTitle ?? session.title ?? session.name}</span>
                    <span className="sb-cli-badge">{CLI_LABELS[readCliProvider(session.provider)]}</span>
                  </label>
                  {state.kind !== 'ready' ? (
                    <span className="sb-bulk-switch-state" data-testid="bulk-switch-state" data-kind={state.kind}>
                      {state.text}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="sb-bulk-switch-actions">
          <button type="button" className="sb-button sb-sv-outlined" data-testid="bulk-switch-close" onClick={onClose}>
            {started ? 'Close' : 'Cancel'}
          </button>
          {started ? null : (
            <button type="button" className="sb-button sb-sv-primary" data-testid="bulk-switch-start" disabled={chosen.length === 0 || running} onClick={() => void start()}>
              {`Switch ${chosen.length} session${chosen.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
