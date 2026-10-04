import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountProfile, AccountSettings } from '../../../core/accounts.ts';
import type { AccountsOverview } from '../../../core/api.ts';
import { CLI_LABELS, CLI_PROVIDERS, type CliProviderId } from '../../../core/cli-providers.ts';
import { type AccountSignIn, ApiError, accountsApi, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { Row, SectionTitle, ToggleValue } from './rows.tsx';
import { TERMINAL_HINT, droppedOrder, exhaustedText, movedOrder, signInStatusText, signInText, usageText } from './accounts.ts';
import './accounts.css';

type Client = ReturnType<typeof accountsApi>;

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

// ── sign in ──────────────────────────────────────────────────────────────────

/**
 * The sign-in of one profile (D63, `docs/accounts.md` → *Signing in*): the options
 * the CLI takes (Claude Code: an email; Codex: the device-code flow; OpenCode: the
 * provider, and an API key for providers that use keys), then the page the CLI printed in a new tab
 * (D61's pattern: the tab opens inside the click, on `about:blank`, and is pointed
 * at the URL once it is known), progress, the paste-back for a browser that runs on
 * another machine, and the terminal command as the fallback.
 */
function SignInPanel({ profile, client, onFinished, onClose }: { readonly profile: AccountProfile; readonly client: Client; readonly onFinished: () => void; readonly onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [device, setDevice] = useState(false);
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<AccountSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const tab = useRef<Window | null>(null);
  const finished = useRef(false);

  const pointTab = (url: string | null): void => {
    if (url && tab.current && !tab.current.closed && tab.current.location.href === 'about:blank') {
      tab.current.opener = null;
      tab.current.location.href = url;
    }
  };

  const start = (): void => {
    // Inside the click, so the browser does not block it.
    const keyed = profile.cli === 'opencode' && apiKey !== '';
    tab.current = keyed ? null : window.open('about:blank', '_blank');
    setBusy(true);
    setError(null);
    client
      .signIn(profile.id, {
        ...(profile.cli === 'claude' && email.trim() !== '' ? { email: email.trim() } : {}),
        ...(profile.cli === 'codex' && device ? { deviceCode: true } : {}),
        ...(profile.cli === 'opencode' ? { provider: provider.trim(), ...(keyed ? { apiKey } : {}) } : {}),
      })
      .then(
        (next) => {
          setApiKey('');
          setState(next);
          pointTab(next.url);
          if (next.state !== 'waiting' && next.state !== 'starting') tab.current?.close();
        },
        (caught: unknown) => {
          tab.current?.close();
          setError(errorText(caught));
        },
      )
      .finally(() => setBusy(false));
  };

  const live = state !== null && (state.state === 'waiting' || state.state === 'starting');
  useEffect(() => {
    if (!state || !live) return;
    const timer = setInterval(() => {
      client.signInState(state.id).then(
        (next) => {
          setState(next);
          pointTab(next.url);
        },
        () => undefined,
      );
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.id, live]);
  useEffect(() => {
    if (state?.state === 'done' && !finished.current) {
      finished.current = true;
      onFinished();
    }
  }, [state?.state, onFinished]);

  const paste = (): void => {
    if (!state) return;
    setError(null);
    client.pasteBack(state.id, pasted.trim()).then(
      (next) => {
        setState(next);
        setPasted('');
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const cancel = (): void => {
    tab.current?.close();
    if (state && live) void client.cancelSignIn(state.id).catch(() => undefined);
    onClose();
  };
  const copy = (command: string): void => {
    void navigator.clipboard?.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className="sb-acc-signin" data-testid="account-signin-panel" data-state={state?.state ?? 'form'}>
      {state === null ? (
        <div className="sb-acc-signin-form">
          {profile.cli === 'claude' ? (
            <label className="sb-acc-field">
              <span>Email (optional, pre-fills the sign-in page)</span>
              <input className="sb-set-input" data-testid="account-signin-email" value={email} placeholder="you@example.com" spellCheck={false} onChange={(event) => setEmail(event.target.value)} />
            </label>
          ) : null}
          {profile.cli === 'codex' ? (
            <label className="sb-acc-check">
              <input type="checkbox" data-testid="account-signin-device" checked={device} onChange={(event) => setDevice(event.target.checked)} /> Use a device code (no local callback: for a browser on another machine)
            </label>
          ) : null}
          {profile.cli === 'opencode' ? (
            <>
              <label className="sb-acc-field">
                <span>Provider</span>
                <input className="sb-set-input" data-testid="account-signin-provider" value={provider} placeholder="anthropic" spellCheck={false} onChange={(event) => setProvider(event.target.value)} />
              </label>
              <label className="sb-acc-field">
                <span>API key (only for providers that use keys; leave empty for the browser sign-in)</span>
                <input className="sb-set-input" type="password" autoComplete="off" data-testid="account-signin-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              </label>
            </>
          ) : null}
          <div className="sb-acc-actions">
            <button type="button" className="sb-set-button" data-testid="account-signin-start" disabled={busy} onClick={start}>
              {busy ? 'Starting…' : profile.cli === 'opencode' && apiKey !== '' ? 'Save the key' : 'Open the sign-in page'}
            </button>
            <button type="button" className="sb-set-button" data-testid="account-signin-cancel" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="sb-acc-signin-progress">
          <div data-testid="account-signin-status" role="status">
            {signInStatusText(state)}
          </div>
          {state.url && live ? (
            <div>
              <a href={state.url} target="_blank" rel="noopener noreferrer" data-testid="account-signin-link">
                Open the sign-in page again
              </a>
            </div>
          ) : null}
          {state.code && live ? (
            <div>
              One-time code: <code className="sb-set-cli-code" data-testid="account-signin-code">{state.code}</code>
            </div>
          ) : null}
          {state.instructions && live ? <div className="sb-acc-muted">{state.instructions}</div> : null}
          {live && state.canPasteBack ? (
            <div className="sb-acc-paste">
              <div className="sb-acc-muted">Browser on another machine, or the page can&apos;t reach this one? Paste the address it ends on (or the code):</div>
              <div className="sb-acc-actions">
                <input className="sb-set-input" data-testid="account-signin-paste" value={pasted} placeholder="http://localhost:…/callback?code=…" spellCheck={false} onChange={(event) => setPasted(event.target.value)} />
                <button type="button" className="sb-set-button" data-testid="account-signin-paste-submit" disabled={pasted.trim() === ''} onClick={paste}>
                  Submit
                </button>
              </div>
            </div>
          ) : null}
          {state.error && !live ? (
            <div className="sb-set-error" role="alert" data-testid="account-signin-error">
              {state.error}
            </div>
          ) : null}
          {state.state === 'timeout' || state.state === 'failed' ? <div className="sb-acc-muted">{TERMINAL_HINT}</div> : null}
          <div className="sb-acc-actions">
            <button type="button" className="sb-set-button" data-testid="account-signin-copy" onClick={() => copy(state.command)}>
              {copied ? 'Copied' : 'Copy terminal command'}
            </button>
            <code className="sb-set-cli-code" data-testid="account-signin-command">{state.command}</code>
            <button type="button" className="sb-set-button" data-testid="account-signin-cancel" onClick={cancel}>
              {live ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
      )}
      {error ? (
        <div className="sb-set-error" role="alert" data-testid="account-signin-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── one profile ──────────────────────────────────────────────────────────────

type Pending = null | 'signout' | 'delete';

function ProfileCard({
  profile,
  position,
  count,
  client,
  onChanged,
  onMove,
  onDropOn,
  builtinName,
}: {
  readonly profile: AccountProfile;
  /** The CLI's built-in account's current name (D67: it can be renamed). */
  readonly builtinName: string;
  readonly position: number;
  readonly count: number;
  readonly client: Client;
  readonly onChanged: () => void;
  readonly onMove: (delta: number) => void;
  readonly onDropOn: (draggedId: string) => void;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState(profile.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setName(profile.name), [profile.name]);
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
      onChanged();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const spent = exhaustedText(profile);
  const usage = usageText(profile.usage);
  return (
    <div
      className="sb-acc-profile"
      data-testid="account-profile"
      data-profile-id={profile.id}
      data-name={profile.name}
      data-enabled={String(profile.enabled)}
      data-sign-in={profile.signIn}
      data-spent={spent ? 'true' : 'false'}
      draggable
      onDragStart={(event: DragEvent) => event.dataTransfer.setData('text/plain', profile.id)}
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        const id = event.dataTransfer.getData('text/plain');
        if (id && id !== profile.id) onDropOn(id);
      }}
    >
      <div className="sb-acc-head">
        <span className="sb-acc-order">
          <button type="button" className="sb-acc-arrow" data-testid="account-up" aria-label={`Move ${profile.name} up`} disabled={busy || position === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" className="sb-acc-arrow" data-testid="account-down" aria-label={`Move ${profile.name} down`} disabled={busy || position === count - 1} onClick={() => onMove(1)}>
            ↓
          </button>
        </span>
        <span className="sb-acc-rank" data-testid="account-rank">
          {position + 1}
        </span>
        <input
          className="sb-set-input sb-acc-name-input"
          data-testid="account-name"
          aria-label={`${CLI_LABELS[profile.cli]} account name`}
          value={name}
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => name.trim() !== profile.name && void run(() => client.updateProfile(profile.id, { name }))}
          onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
        />
        <span className="sb-acc-status" data-testid="account-status" data-state={profile.signIn}>
          {signInText(profile)}
        </span>
        {usage ? (
          <span className="sb-acc-usage" data-testid="account-usage">
            {usage}
          </span>
        ) : null}
        <span className="sb-acc-sessions" data-testid="account-sessions">
          {profile.sessions === 1 ? '1 session' : `${profile.sessions} sessions`}
        </span>
      </div>
      {spent ? (
        <div className="sb-acc-spent" data-testid="account-spent">
          {spent}
        </div>
      ) : null}
      <div className="sb-acc-controls">
        <label className="sb-acc-toggle">
          <span>Enabled</span>
          <ToggleValue value={profile.enabled} label={`${profile.name} enabled`} disabled={busy} onToggle={() => void run(() => client.updateProfile(profile.id, { enabled: !profile.enabled }))} />
        </label>
        {profile.builtin ? (
          <span className="sb-acc-muted" data-testid="account-builtin-note">
            Your own login: sign in and out in a terminal. Other accounts can share its settings.
          </span>
        ) : (
          <>
            <label className="sb-acc-toggle" title={`Use ${builtinName}'s settings, instructions and MCP config`}>
              <span>Same settings as {builtinName}</span>
              <ToggleValue
                value={profile.shareSettings}
                label={`${profile.name} shares ${builtinName}'s settings`}
                disabled={busy}
                onToggle={() => void run(() => client.updateProfile(profile.id, { shareSettings: !profile.shareSettings }))}
              />
            </label>
            <button type="button" className="sb-set-button" data-testid="account-signin" disabled={busy || signingIn} onClick={() => setSigningIn(true)}>
              {profile.signIn === 'signed-in' ? 'Sign in again' : 'Sign in'}
            </button>
            <button type="button" className="sb-set-button" data-testid="account-signout" disabled={busy || profile.signIn === 'signed-out'} onClick={() => setPending('signout')}>
              Sign out
            </button>
          </>
        )}
        <button type="button" className="sb-set-button" data-testid="account-check" disabled={busy} onClick={() => void run(() => client.check(profile.id))}>
          Check
        </button>
        {profile.builtin ? null : (
          <button type="button" className="sb-set-button" data-testid="account-delete" disabled={busy} onClick={() => setPending('delete')}>
            Delete
          </button>
        )}
      </div>
      {signingIn ? <SignInPanel profile={profile} client={client} onFinished={onChanged} onClose={() => { setSigningIn(false); onChanged(); }} /> : null}
      {pending === 'signout' ? (
        <div className="sb-acc-confirm" role="alertdialog" aria-label="Sign out" data-testid="account-confirm">
          <div>Sign {profile.name} out of {CLI_LABELS[profile.cli]}? Its sessions stop working until it is signed in again.</div>
          <div className="sb-acc-actions">
            <button
              type="button"
              className="sb-set-button"
              data-testid="account-confirm-yes"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await client.signOut(profile.id);
                  setNote(result.message);
                  setPending(null);
                })
              }
            >
              Sign out
            </button>
            <button type="button" className="sb-set-button" data-testid="account-confirm-cancel" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {pending === 'delete' ? (
        <div className="sb-acc-confirm" role="alertdialog" aria-label="Delete account" data-testid="account-confirm">
          <div>
            Delete {profile.name}? Its sessions go back to {builtinName}. Its folder{profile.dir ? ` (${profile.dir})` : ''} stays unless you remove it too; its login is not signed out.
          </div>
          <div className="sb-acc-actions">
            <button type="button" className="sb-set-button" data-testid="account-confirm-yes" disabled={busy} onClick={() => void run(() => client.deleteProfile(profile.id, false))}>
              Delete
            </button>
            <button type="button" className="sb-set-button" data-testid="account-confirm-files" disabled={busy} onClick={() => void run(() => client.deleteProfile(profile.id, true))}>
              Delete and remove its folder
            </button>
            <button type="button" className="sb-set-button" data-testid="account-confirm-cancel" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className="sb-set-note" data-testid="account-note">
          {note}
        </div>
      ) : null}
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="account-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── add ──────────────────────────────────────────────────────────────────────

function AddProfile({ cli, client, onAdded, builtinName }: { readonly cli: CliProviderId; readonly client: Client; readonly onAdded: () => void; readonly builtinName: string }) {
  const [name, setName] = useState('');
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = (): void => {
    setBusy(true);
    setError(null);
    client.createProfile({ cli, name, shareSettings: share }).then(
      () => {
        setName('');
        onAdded();
      },
      (caught: unknown) => setError(errorText(caught)),
    ).finally(() => setBusy(false));
  };
  return (
    <div className="sb-acc-add" data-testid="account-add" data-cli={cli}>
      <input
        className="sb-set-input"
        data-testid="account-add-name"
        aria-label={`New ${CLI_LABELS[cli]} account name`}
        value={name}
        placeholder="Account name (e.g. Work)"
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && name.trim() !== '' && add()}
      />
      <label className="sb-acc-check" title={`Use ${builtinName}'s settings, instructions and MCP config in this account`}>
        <input type="checkbox" data-testid="account-add-share" checked={share} onChange={(event) => setShare(event.target.checked)} /> Same settings as {builtinName}
      </label>
      <button type="button" className="sb-set-button" data-testid="account-add-button" disabled={busy || name.trim() === ''} onClick={add}>
        Add account
      </button>
      {error ? (
        <span className="sb-set-error" role="alert" data-testid="account-add-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ── rules ────────────────────────────────────────────────────────────────────

function PercentInput({ testId, label, value, onCommit }: { readonly testId: string; readonly label: string; readonly value: number; readonly onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 && Math.round(parsed) !== value) onCommit(Math.round(parsed));
    else setText(String(value));
  };
  return (
    <input
      className="sb-set-input sb-acc-percent"
      type="number"
      min={1}
      max={100}
      data-testid={testId}
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
    />
  );
}

function Rules({ settings, profiles, save }: { readonly settings: AccountSettings; readonly profiles: readonly AccountProfile[]; readonly save: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="sb-acc-rules" data-testid="accounts-rules">
      <Row id="accounts-enabled" label="Switch accounts automatically" description="When a session hits its session or weekly limit, it continues on the next account with allowance.">
        <ToggleValue value={settings.enabled} label="Switch accounts automatically" onToggle={() => save({ enabled: !settings.enabled })} />
      </Row>
      <Row id="accounts-per-cli" label="For" description="Each CLI switches on its own.">
        <span className="sb-acc-inline">
          {CLI_PROVIDERS.map((cli) => (
            <label key={cli} className="sb-acc-toggle" data-testid={`accounts-cli-${cli}`}>
              <span>{CLI_LABELS[cli]}</span>
              <ToggleValue value={settings.perCli[cli]} label={`${CLI_LABELS[cli]} switches automatically`} disabled={!settings.enabled} onToggle={() => save({ perCli: { [cli]: !settings.perCli[cli] } })} />
            </label>
          ))}
        </span>
      </Row>
      <Row id="accounts-thresholds" label="Switch earlier, before the limit error" description="At these percentages of the 5-hour and the weekly allowance (needs the usage readings).">
        <span className="sb-acc-inline">
          <ToggleValue value={settings.thresholds.enabled} label="Switch at the thresholds" onToggle={() => save({ thresholds: { enabled: !settings.thresholds.enabled } })} />
          <label className="sb-acc-toggle">
            <span>5-hour</span>
            <PercentInput testId="accounts-threshold-five" label="5-hour threshold %" value={settings.thresholds.fiveHourPct} onCommit={(v) => save({ thresholds: { fiveHourPct: v } })} />
            <span>%</span>
          </label>
          <label className="sb-acc-toggle">
            <span>weekly</span>
            <PercentInput testId="accounts-threshold-week" label="Weekly threshold %" value={settings.thresholds.weeklyPct} onCommit={(v) => save({ thresholds: { weeklyPct: v } })} />
            <span>%</span>
          </label>
        </span>
      </Row>
      <Row id="accounts-after-reset" label="After the limit resets" description="Stay where the session is, or go back to the first account as soon as it has allowance (only when no turn runs).">
        <select className="sb-set-select" data-testid="accounts-after-reset" aria-label="After the limit resets" value={settings.afterReset} onChange={(event) => save({ afterReset: event.target.value })}>
          <option value="stay">Stay on the current account</option>
          <option value="back-to-first">Switch back to the first account</option>
        </select>
      </Row>
      <Row id="accounts-new" label="New sessions start on" description="The first account with allowance, or a fixed account per CLI.">
        <span className="sb-acc-inline">
          <select
            className="sb-set-select"
            data-testid="accounts-new-rule"
            aria-label="New sessions start on"
            value={settings.newSessions.rule}
            onChange={(event) => save({ newSessions: { rule: event.target.value } })}
          >
            <option value="first-with-allowance">The first account with allowance</option>
            <option value="fixed">A fixed account</option>
          </select>
          {settings.newSessions.rule === 'fixed'
            ? CLI_PROVIDERS.map((cli) => {
                const mine = profiles.filter((p) => p.cli === cli && p.enabled);
                if (mine.length < 2) return null;
                return (
                  <select
                    key={cli}
                    className="sb-set-select"
                    data-testid={`accounts-fixed-${cli}`}
                    aria-label={`Fixed ${CLI_LABELS[cli]} account`}
                    value={settings.newSessions.fixed[cli] ?? ''}
                    onChange={(event) => save({ newSessions: { fixed: { ...settings.newSessions.fixed, [cli]: event.target.value } } })}
                  >
                    <option value="">{CLI_LABELS[cli]}: the first with allowance</option>
                    {mine.map((p) => (
                      <option key={p.id} value={p.id}>
                        {CLI_LABELS[cli]}: {p.name}
                      </option>
                    ))}
                  </select>
                );
              })
            : null}
        </span>
      </Row>
      <Row id="accounts-exhausted" label="When every account of a CLI is out of usage" description="Stop and tell you in the Inbox, or hand the session over to another CLI with a handover summary.">
        <span className="sb-acc-inline">
          <select
            className="sb-set-select"
            data-testid="accounts-exhausted-action"
            aria-label="When every account is out of usage"
            value={settings.exhausted.action}
            onChange={(event) => save({ exhausted: { action: event.target.value, ...(event.target.value === 'switch-cli' && !settings.exhausted.cli ? { cli: 'codex' } : {}) } })}
          >
            <option value="notify">Stop and notify</option>
            <option value="switch-cli">Switch to another CLI</option>
          </select>
          {settings.exhausted.action === 'switch-cli' ? (
            <select className="sb-set-select" data-testid="accounts-exhausted-cli" aria-label="CLI to switch to" value={settings.exhausted.cli ?? 'codex'} onChange={(event) => save({ exhausted: { cli: event.target.value } })}>
              {CLI_PROVIDERS.map((cli) => (
                <option key={cli} value={cli}>
                  {CLI_LABELS[cli]}
                </option>
              ))}
            </select>
          ) : null}
        </span>
      </Row>
    </div>
  );
}

// ── the section ──────────────────────────────────────────────────────────────

/**
 * D63 · Settings → Accounts (`docs/accounts.md`): per CLI a priority-ordered list
 * of account profiles (Default = your own login; others Switchboard created, each
 * with its own folder), their sign-in status, usage and sign in / out; the rules
 * of the automatic switch; and which machine (this one, or a paired one through
 * its peer API) is being managed.
 */
export function AccountsSection() {
  const machines = useApi(() => api.machines().catch(() => null), []);
  const [machine, setMachine] = useState<string | null>(null);
  const client = useMemo(() => accountsApi(machine), [machine]);
  const [overview, setOverview] = useState<AccountsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (refresh = false): void => {
    client.overview(refresh).then(
      (value) => {
        setOverview(value);
        setError(null);
      },
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  useEffect(() => {
    setOverview(null);
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const saveRules = (patch: Record<string, unknown>): void => {
    setError(null);
    client.saveSettings(patch).then(
      (settings) => setOverview((current) => (current ? { ...current, settings } : current)),
      (caught: unknown) => setError(errorText(caught)),
    );
  };
  const reorder = (cli: CliProviderId, order: string[]): void => {
    client.order(cli, order).then(setOverview, (caught: unknown) => setError(errorText(caught)));
  };
  const peers = (machines.data?.machines ?? []).filter((entry) => entry.state === 'online');
  return (
    <>
      <SectionTitle withLede>Accounts</SectionTitle>
      <div className="sb-set-lede">
        Give each CLI more than one subscription login. When a session hits its limit, Switchboard moves it to the next account that still has allowance and it carries on. Switchboard never reads or stores a token: the sign-in is the CLI&apos;s own.
      </div>
      {peers.length > 0 ? (
        <Row id="accounts-machine" label="Machine" description="The accounts of this machine, or of a paired one">
          <select className="sb-set-select" data-testid="accounts-machine" aria-label="Machine" value={machine ?? ''} onChange={(event) => setMachine(event.target.value === '' ? null : event.target.value)}>
            <option value="">This machine</option>
            {peers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="accounts-error">
          {error}
        </div>
      ) : null}
      {overview ? (
        <>
          <Rules settings={overview.settings} profiles={overview.profiles} save={saveRules} />
          {CLI_PROVIDERS.map((cli) => {
            const mine = overview.profiles.filter((p) => p.cli === cli);
            const ids = mine.map((p) => p.id);
            const builtinName = mine.find((p) => p.builtin)?.name ?? 'Default';
            return (
              <div className="sb-set-cli sb-acc-cli" key={cli} data-testid="accounts-cli" data-cli={cli}>
                <div className="sb-set-cli-head">
                  <span className="sb-set-cli-name">{CLI_LABELS[cli]}</span>
                  <span className="sb-set-cli-state">{mine.length === 1 ? 'one account' : `${mine.length} accounts`} · the first with allowance is used</span>
                  <button type="button" className="sb-set-button" data-testid="accounts-refresh" onClick={() => load(true)}>
                    Check all
                  </button>
                </div>
                {mine.map((profile, index) => (
                  <ProfileCard
                    key={profile.id}
                    profile={profile}
                    position={index}
                    count={mine.length}
                    client={client}
                    onChanged={() => load(false)}
                    onMove={(delta) => reorder(cli, movedOrder(ids, profile.id, delta))}
                    onDropOn={(dragged) => reorder(cli, droppedOrder(ids, dragged, profile.id))}
                    builtinName={builtinName}
                  />
                ))}
                <AddProfile cli={cli} client={client} onAdded={() => load(false)} builtinName={builtinName} />
              </div>
            );
          })}
        </>
      ) : error ? null : (
        <div className="sb-set-note">Reading the accounts…</div>
      )}
    </>
  );
}
