import { useEffect, useState } from 'react';
import type { JiraConnectionStatus } from '../../../core/plans-jira.ts';
import { JiraApiError, jiraApi } from './api.ts';
import './jira.css';

/** Props of {@link JiraCredentialsForm}. */
export interface JiraCredentialsFormProps {
  /** Called with the new status after a save or a removal. */
  readonly onChanged?: (status: JiraConnectionStatus) => void;
}

/**
 * D99-Jira · Settings → Integrations → Jira: the Jira site, the account's email and an API
 * token, saved to this computer's OS keychain (never shown again; a phone never sees this form:
 * the routes are local-only). Shows where the current credentials come from (Settings or the
 * `ATL_*` environment). Renders nothing while Plans is off (the routes answer `plans-off`).
 */
export function JiraCredentialsForm({ onChanged }: JiraCredentialsFormProps) {
  const [status, setStatus] = useState<JiraConnectionStatus | null>(null);
  const [off, setOff] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<JiraApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    jiraApi
      .status()
      .then((answer) => {
        setStatus(answer);
        setBaseUrl(answer.baseUrl ?? '');
        setEmail(answer.email ?? '');
      })
      .catch((caught: unknown) => {
        if (caught instanceof JiraApiError && caught.code === 'plans-off') setOff(true);
        else setError(caught instanceof JiraApiError ? caught : new JiraApiError(0, null, 'failed'));
      });
  }, []);

  if (off) return null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await jiraApi.saveCredentials({ baseUrl, email, token });
      setStatus(answer);
      setToken('');
      onChanged?.(answer);
    } catch (caught) {
      setError(caught instanceof JiraApiError ? caught : new JiraApiError(0, null, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const answer = await jiraApi.clearCredentials();
      setStatus(answer);
      onChanged?.(answer);
    } catch (caught) {
      setError(caught instanceof JiraApiError ? caught : new JiraApiError(0, null, 'failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sb-jira-creds" data-testid="jira-credentials">
      <div className="sb-jira-muted" data-testid="jira-credentials-source">
        {status === null ? 'Reading…' : status.configured ? `Connected to ${status.baseUrl} as ${status.email} (from ${status.source === 'settings' ? 'Settings, in the OS keychain' : 'the ATL_* environment'}).` : 'Not set up. Enter your Jira site, email and an API token, or set ATL_BASE_URL, ATL_USER and ATL_TOKEN in the environment.'}
      </div>
      {status !== null && !status.keychain ? <div className="sb-jira-muted">This computer has no OS keychain Switchboard can use: only the environment works here.</div> : null}
      {status?.keychain ? (
        <>
          <label className="sb-jira-field">
            <span>Jira site</span>
            <input data-testid="jira-credentials-base" value={baseUrl} placeholder="https://acme.atlassian.net" onChange={(event) => setBaseUrl(event.target.value)} />
            {error?.fields['baseUrl'] ? <em className="sb-jira-error">{error.fields['baseUrl']}</em> : null}
          </label>
          <label className="sb-jira-field">
            <span>Email</span>
            <input data-testid="jira-credentials-email" value={email} placeholder="you@acme.example" onChange={(event) => setEmail(event.target.value)} />
            {error?.fields['email'] ? <em className="sb-jira-error">{error.fields['email']}</em> : null}
          </label>
          <label className="sb-jira-field">
            <span>API token</span>
            <input data-testid="jira-credentials-token" type="password" autoComplete="off" value={token} placeholder={status.source === 'settings' ? '•••••• (saved; enter a new one to replace it)' : 'id.atlassian.com → Security → API tokens'} onChange={(event) => setToken(event.target.value)} />
            {error?.fields['token'] ? <em className="sb-jira-error">{error.fields['token']}</em> : null}
          </label>
          <div className="sb-jira-actions">
            {status.source === 'settings' ? (
              <button type="button" className="sb-jira-btn" disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            ) : null}
            <button type="button" className="sb-jira-btn sb-jira-btn-primary" data-testid="jira-credentials-save" disabled={busy || token.trim() === ''} onClick={() => void save()}>
              Save
            </button>
          </div>
        </>
      ) : null}
      {error && Object.keys(error.fields).length === 0 ? <div className="sb-jira-error">{error.message}</div> : null}
    </div>
  );
}
