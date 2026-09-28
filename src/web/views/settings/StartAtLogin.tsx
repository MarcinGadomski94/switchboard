import { useState } from 'react';
import type { LoginServiceStatus } from '../../../core/login-service.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { START_AT_LOGIN_DESCRIPTION, START_AT_LOGIN_LABEL, changeErrorText, toggleView } from './start-at-login.ts';
import './start-at-login.css';

/**
 * The "Start at login" control (M9.1, `docs/service.md`): the value `on` / `off`
 * in the prototype's value style; a click registers or removes the per-user
 * background service (`PUT /api/service`). A refusal (no Node ≥ 24 on PATH, a
 * failed service-manager command) shows the service's message under the value.
 * Self-contained, so any settings row can hold it (M8.2's Claude Code section).
 */
export function StartAtLoginToggle() {
  const loaded = useApi(api.loginService);
  const [changed, setChanged] = useState<LoginServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = changed ?? loaded.data;
  const view = toggleView({ status, loadError: status ? null : (loaded.error?.status ?? null), busy });

  const flip = async (): Promise<void> => {
    if (!status || view.disabled) return;
    setBusy(true);
    try {
      setChanged(await api.setStartAtLogin(!status.startAtLogin));
      setError(null);
    } catch (caught) {
      setError(changeErrorText(caught instanceof ApiError ? caught.body : null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="sb-login-control">
      <button
        type="button"
        className="sb-login-toggle"
        data-testid="start-at-login"
        role="switch"
        aria-checked={view.checked}
        aria-label={START_AT_LOGIN_LABEL}
        aria-busy={busy}
        title={view.title}
        disabled={view.disabled}
        onClick={() => void flip()}
      >
        {view.text}
      </button>
      {error ? (
        <span className="sb-login-error" role="alert" data-testid="start-at-login-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** The whole settings row (prototype `rowsClaude` → "Start at login"): label + description, the toggle on the right. */
export function StartAtLoginRow() {
  return (
    <div className="sb-login-row" data-row="start-at-login">
      <div className="sb-login-text">
        <div className="sb-login-label">{START_AT_LOGIN_LABEL}</div>
        <div className="sb-login-desc">{START_AT_LOGIN_DESCRIPTION}</div>
      </div>
      <StartAtLoginToggle />
    </div>
  );
}
