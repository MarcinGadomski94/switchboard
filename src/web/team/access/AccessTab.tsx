import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { AccessTestResult, TeamAccessEntryView, TeamAccessView } from '../../../core/team-access.ts';
import { onDeviceOrigin } from '../../api/client.ts';
import { onHubEvent, onHubStatus } from '../../api/useHub.ts';
import { AccessApiError, type AccessSetupBody, type ShareableServer, accessApi } from './api.ts';
import './access.css';

/**
 * D100-T2 · a member's **Access tab** (`docs/team.md` → *Access requests*), built
 * from the member's requests: one section per data source with exactly the fields
 * the agent declared, the exact service and host, status, last use, who uses it,
 * Set up / Set up here too / Replace / Test connection / Revoke, an optional expiry
 * and the audit trail. T3 mounts it in the member's panel on the Team page.
 *
 * Values are typed here and sent once to the Switchboard of the computer the member
 * runs on (D146: over the paired connection when that is another computer; its OS
 * keychain), or to this computer's with "Set up here too"; they are never shown
 * again. On a paired phone (D73) the tab is read-only: "Set this up on a computer".
 */
export interface AccessTabProps {
  /** The member (`TeamMember.id`). */
  readonly memberId: string;
  /** Opens this access's setup form at mount (the Needs-you card's "Set up…"). */
  readonly focusAccessId?: string | null;
  /** The member's rhythm loops by label (shown as who uses an access: the member's session and these loops). */
  readonly loopLabels?: readonly string[];
  /** After a setup, replace, revoke, expiry change or test. */
  readonly onChanged?: () => void;
}

function when(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The tab. */
export function AccessTab({ memberId, focusAccessId = null, loopLabels = [], onChanged }: AccessTabProps) {
  const [view, setView] = useState<TeamAccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(focusAccessId);

  const load = useCallback(async () => {
    try {
      setView(await accessApi.view(memberId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [memberId]);

  useEffect(() => {
    void load();
    const offTeam = onHubEvent('teamChanged', () => void load());
    const offStatus = onHubStatus((status) => {
      if (status === 'open') void load();
    });
    return () => {
      offTeam();
      offStatus();
    };
  }, [load]);

  useEffect(() => {
    if (focusAccessId) setOpen(focusAccessId);
  }, [focusAccessId]);

  const changed = useCallback(() => {
    void load();
    onChanged?.();
  }, [load, onChanged]);

  if (error && !view) return <div className="sb-access sb-access-error" data-testid="access-tab-error">{error}</div>;
  if (!view) return <div className="sb-access sb-access-muted" data-testid="access-tab-loading">Loading access…</div>;
  const device = view.device || onDeviceOrigin();

  return (
    <div className="sb-access" data-testid="access-tab" data-member-id={memberId}>
      <div className="sb-access-intro">
        Data access {view.member.name} asked for.{' '}
        {view.member.local
          ? `Values go to the ${view.keychain.name} of this computer (${view.self.name}) and only to ${view.member.name}'s session; they are never shown again or synced.`
          : `${view.member.name} runs on ${view.member.machineName}: values are sent once to ${view.member.machineName} over the paired connection, kept in its keychain and given only to ${view.member.name}'s session; nothing is stored on ${view.self.name}, and they are never shown again or synced.`}
        {!view.keychain.available ? <div className="sb-access-warning" data-testid="access-keychain-problem">{view.keychain.problem ?? `${view.keychain.name} cannot be used here.`}</div> : null}
        {device ? <div className="sb-access-device" data-testid="access-device-note">Set this up on a computer: secrets are never typed on a phone. You can deny or postpone requests from Needs you.</div> : null}
      </div>
      {view.entries.length === 0 ? (
        <div className="sb-access-muted" data-testid="access-empty">
          No access yet. When {view.member.name} is blocked without data, it asks here (request_access).
        </div>
      ) : (
        view.entries.map((entry) => (
          <AccessSection
            key={entry.id}
            entry={entry}
            view={view}
            device={device}
            loopLabels={loopLabels}
            open={open === entry.id}
            onOpen={(on) => setOpen(on ? entry.id : null)}
            onChanged={changed}
          />
        ))
      )}
    </div>
  );
}

const STATUS_CLASS: Record<TeamAccessEntryView['status'], string> = {
  requested: 'is-need',
  ready: 'is-done',
  'needs-setup': 'is-need',
  denied: 'is-fail',
  'not-now': 'is-idle',
  revoked: 'is-fail',
  expired: 'is-fail',
};

function AccessSection(props: {
  readonly entry: TeamAccessEntryView;
  readonly view: TeamAccessView;
  readonly device: boolean;
  readonly loopLabels: readonly string[];
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly onChanged: () => void;
}) {
  const { entry, view, device, loopLabels, open, onOpen, onChanged } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tested, setTested] = useState<AccessTestResult | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  // D146: setup, test and revoke go to the computer the member runs on; "Set up here too" keeps a copy on this one.
  const [here, setHere] = useState(false);
  const local = entry.member.local;
  const onMember = entry.setUpOn.includes(entry.member.machineId);
  const setupLabel = local ? (entry.here ? 'Replace' : entry.setUpOnNames.length > 0 ? 'Set up here too' : 'Set up…') : onMember ? `Replace on ${entry.member.machineName}` : `Set up on ${entry.member.machineName}…`;
  const usedBy = loopLabels.length > 0 ? `${view.member.name}'s session and its loops: ${loopLabels.join(', ')}` : `${view.member.name}'s session (and its loops)`;

  const act = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(what);
    setProblem(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sb-access-entry" data-testid={`access-entry-${entry.id}`} data-status={entry.status} data-access-id={entry.id}>
      <div className="sb-access-head">
        <span className="sb-access-service" data-testid="access-service">
          {entry.service}
        </span>
        <span className="sb-access-chip">{entry.kind === 'mcp' ? 'MCP server' : 'API key'}</span>
        <span className={`sb-access-chip sb-access-status ${STATUS_CLASS[entry.status]}`} data-testid="access-status">
          {entry.statusText}
        </span>
      </div>
      <div className="sb-access-facts">
        <span>
          Host <code data-testid="access-host">{entry.host}</code>
        </span>
        <span>Scope: {entry.scope}</span>
        <span>
          Gives: <code>{entry.delivers}</code>
        </span>
      </div>
      {entry.warning ? (
        <div className="sb-access-warning" data-testid="access-warning">
          {entry.warning}
        </div>
      ) : null}
      <div className="sb-access-why">Why: {entry.why}</div>
      <div className="sb-access-facts sb-access-muted">
        <span data-testid="access-last-used">
          Last used: {when(entry.lastUsedAt)}
          {entry.lastUsedOn ? ` on ${entry.setUpOnNames.find((_, i) => entry.setUpOn[i] === entry.lastUsedOn) ?? entry.lastUsedOn}` : ''}
        </span>
        <span data-testid="access-used-by">Used by: {usedBy}</span>
        <span data-testid="access-expiry">{entry.expiresAt ? `Expires ${when(entry.expiresAt)}` : 'No expiry'}</span>
      </div>
      {problem ? (
        <div className="sb-access-error" data-testid="access-problem">
          {problem}
        </div>
      ) : null}
      {tested ? (
        <div className={tested.ok ? 'sb-access-ok' : 'sb-access-error'} data-testid="access-test-result">
          {tested.detail}
          {tested.tools.length > 0 ? `: ${tested.tools.slice(0, 12).join(', ')}${tested.tools.length > 12 ? '…' : ''}` : ''}
        </div>
      ) : null}
      {device ? null : (
        <div className="sb-access-actions">
          {entry.canSetUp && !open ? (
            <button
              type="button"
              className="sb-button sb-access-primary"
              data-testid="access-setup"
              disabled={busy !== null}
              onClick={() => {
                setHere(false);
                onOpen(true);
              }}
            >
              {setupLabel}
            </button>
          ) : null}
          {entry.canSetUp && !open && !local && onMember && !entry.here ? (
            <button
              type="button"
              className="sb-button sb-access-secondary"
              data-testid="access-setup-here"
              disabled={busy !== null}
              onClick={() => {
                setHere(true);
                onOpen(true);
              }}
            >
              Set up here too
            </button>
          ) : null}
          {(onMember || entry.here) && entry.status !== 'revoked' ? (
            <button type="button" className="sb-button sb-access-secondary" data-testid="access-test" disabled={busy !== null} onClick={() => void act('test', async () => setTested(await accessApi.test(entry.id, !onMember)))}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </button>
          ) : null}
          {entry.status !== 'revoked' && entry.status !== 'denied' && entry.status !== 'requested' && entry.status !== 'not-now' ? (
            <button
              type="button"
              className="sb-button sb-access-danger"
              data-testid="access-revoke"
              disabled={busy !== null}
              onClick={() => {
                if (globalThis.confirm?.(`Revoke ${entry.service}? Its values are removed from ${local ? "this computer's keychain" : `${entry.member.machineName}'s keychain`} (and from the others' when they sync), and ${view.member.name} restarts without it.`) === false) return;
                void act('revoke', () => accessApi.revoke(entry.id));
              }}
            >
              Revoke
            </button>
          ) : null}
          {entry.status === 'ready' || entry.status === 'expired' ? <ExpiryEditor entry={entry} busy={busy !== null} onSave={(iso) => act('expiry', () => accessApi.setExpiry(entry.id, iso))} /> : null}
        </div>
      )}
      {open && !device ? (
        <SetupForm
          entry={entry}
          view={view}
          here={here || local}
          onCancel={() => onOpen(false)}
          onSaved={() => {
            onOpen(false);
            onChanged();
          }}
        />
      ) : null}
      <button type="button" className="sb-button sb-access-link" data-testid="access-audit-toggle" onClick={() => setShowAudit((s) => !s)}>
        {showAudit ? 'Hide history' : `History (${entry.audit.length})`}
      </button>
      {showAudit ? (
        <ol className="sb-access-audit" data-testid="access-audit">
          {[...entry.audit].reverse().map((line, index) => (
            <li key={`${line.at}-${index}`} data-what={line.what}>
              <span className="sb-access-muted">{when(line.at)}</span> {line.text}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function ExpiryEditor({ entry, busy, onSave }: { readonly entry: TeamAccessEntryView; readonly busy: boolean; readonly onSave: (iso: string | null) => void }) {
  const [value, setValue] = useState(entry.expiresAt ? entry.expiresAt.slice(0, 10) : '');
  return (
    <span className="sb-access-expiry">
      <label>
        Expiry{' '}
        <input type="date" className="sb-access-input" data-testid="access-expiry-input" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="button" className="sb-button sb-access-secondary" data-testid="access-expiry-save" disabled={busy} onClick={() => onSave(value ? new Date(`${value}T23:59:59`).toISOString() : null)}>
        Save expiry
      </button>
    </span>
  );
}

/** The setup form: exactly the declared fields (secret ones as password fields), a custom server's command, or the MCP page server to share. */
function SetupForm({ entry, view, here, onCancel, onSaved }: { readonly entry: TeamAccessEntryView; readonly view: TeamAccessView; /** This computer's keychain (else the one of the computer the member runs on, D146). */ readonly here: boolean; readonly onCancel: () => void; readonly onSaved: () => void }) {
  const where = here ? view.self.name : entry.member.machineName;
  const replacing = here ? entry.here : entry.setUpOn.includes(entry.member.machineId);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(entry.fields.map((f) => [f.name, ''])));
  const customServer = entry.kind === 'mcp' && entry.source !== 'shared' && (entry.source === 'custom' || entry.mcp === null);
  const [transport, setTransport] = useState<'stdio' | 'http'>(entry.mcp?.transport ?? 'stdio');
  const [command, setCommand] = useState(entry.mcp?.command ?? '');
  const [args, setArgs] = useState((entry.mcp?.args ?? []).join('\n'));
  const [url, setUrl] = useState(entry.mcp?.url ?? '');
  const [shareable, setShareable] = useState<ShareableServer[] | null>(null);
  const [shared, setShared] = useState(entry.shared ? `${entry.shared.scope}:${entry.shared.name}` : '');
  const [expiry, setExpiry] = useState('');
  const [errors, setErrors] = useState<ReadonlyArray<{ readonly field: string; readonly message: string }>>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entry.kind === 'mcp' && entry.source === 'shared') void accessApi.shareable(view.member.id).then(setShareable, () => setShareable([]));
  }, [entry.kind, entry.source, view.member.id]);

  const fieldError = (name: string): string | null => errors.find((e) => e.field === name)?.message ?? null;
  const patternOk = useMemo(
    () =>
      Object.fromEntries(
        entry.fields.map((f) => {
          if (!f.pattern || values[f.name] === '') return [f.name, true];
          try {
            return [f.name, new RegExp(`^(?:${f.pattern})$`).test(values[f.name]?.trim() ?? '')];
          } catch {
            return [f.name, true];
          }
        }),
      ),
    [entry.fields, values],
  );

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setErrors([]);
    const body: AccessSetupBody = {
      values,
      ...(customServer ? { server: transport === 'stdio' ? { transport, command, args: args.split('\n').map((a) => a.trim()).filter(Boolean) } : { transport, url, headers: entry.mcp?.headers ?? {} } } : {}),
      ...(entry.kind === 'mcp' && entry.source === 'shared' && shared ? { shared: { scope: shared.split(':')[0] as 'local' | 'project' | 'user', name: shared.slice(shared.indexOf(':') + 1) } } : {}),
      ...(expiry ? { expiresAt: new Date(`${expiry}T23:59:59`).toISOString() } : {}),
      ...(here && !entry.member.local ? { here: true } : {}),
    };
    try {
      await accessApi.setUp(entry.id, body);
      setValues(Object.fromEntries(entry.fields.map((f) => [f.name, ''])));
      onSaved();
    } catch (e) {
      if (e instanceof AccessApiError) setErrors(e.errors);
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sb-access-form" data-testid="access-form" onSubmit={(e) => void submit(e)} autoComplete="off">
      <div className="sb-access-form-title">
        {replacing ? 'Replace' : 'Set up'} {entry.service} on {where}: talks to <code>{entry.host}</code>
      </div>
      {entry.fields.map((field) => (
        <label key={field.name} className="sb-access-field" data-testid={`access-field-${field.name}`}>
          <span className="sb-access-label">
            {field.label} <code className="sb-access-muted">{field.name}</code>
          </span>
          <input
            className="sb-access-input"
            type={field.secret ? 'password' : 'text'}
            autoComplete={field.secret ? 'new-password' : 'off'}
            spellCheck={false}
            data-testid={`access-input-${field.name}`}
            value={values[field.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
          />
          {field.help ? <span className="sb-access-muted">{field.help}</span> : null}
          {field.helpUrl ? (
            <a className="sb-access-muted" href={field.helpUrl} target="_blank" rel="noreferrer noopener">
              How to get it ({hostOf(field.helpUrl)})
            </a>
          ) : null}
          {!patternOk[field.name] ? <span className="sb-access-error">Does not have the expected format.</span> : null}
          {fieldError(field.name) ? <span className="sb-access-error">{fieldError(field.name)}</span> : null}
        </label>
      ))}
      {customServer ? (
        <fieldset className="sb-access-server" data-testid="access-server">
          <legend>The server to run (check it: the agent only suggested it)</legend>
          <label className="sb-access-field">
            <span className="sb-access-label">Transport</span>
            <select className="sb-access-input" value={transport} data-testid="access-server-transport" onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
              <option value="stdio">stdio (a command)</option>
              <option value="http">http (a URL)</option>
            </select>
          </label>
          {transport === 'stdio' ? (
            <>
              <label className="sb-access-field">
                <span className="sb-access-label">Command</span>
                <input className="sb-access-input sb-access-mono" data-testid="access-server-command" value={command} onChange={(e) => setCommand(e.target.value)} />
              </label>
              <label className="sb-access-field">
                <span className="sb-access-label">Arguments (one per line; values only as {'{FIELD}'})</span>
                <textarea className="sb-access-input sb-access-mono" rows={3} data-testid="access-server-args" value={args} onChange={(e) => setArgs(e.target.value)} />
              </label>
            </>
          ) : (
            <label className="sb-access-field">
              <span className="sb-access-label">URL (https)</span>
              <input className="sb-access-input sb-access-mono" data-testid="access-server-url" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          {fieldError('server') ? <span className="sb-access-error">{fieldError('server')}</span> : null}
        </fieldset>
      ) : null}
      {entry.kind === 'mcp' && entry.source === 'shared' ? (
        <label className="sb-access-field" data-testid="access-shared">
          <span className="sb-access-label">Share a server from the MCP page</span>
          <select className="sb-access-input" value={shared} data-testid="access-shared-select" onChange={(e) => setShared(e.target.value)}>
            <option value="">{shareable === null ? 'Loading…' : shareable.length === 0 ? 'No server on the MCP page for this folder' : 'Pick one'}</option>
            {(shareable ?? []).map((server) => (
              <option key={`${server.scope}:${server.name}`} value={`${server.scope}:${server.name}`} disabled={server.transport !== 'stdio'}>
                {server.name} ({server.scope}, {server.transport}
                {server.transport !== 'stdio' ? ': add it on the MCP page instead' : ''})
              </option>
            ))}
          </select>
          {fieldError('shared') ? <span className="sb-access-error">{fieldError('shared')}</span> : null}
        </label>
      ) : null}
      <label className="sb-access-field">
        <span className="sb-access-label">Expiry (optional)</span>
        <input type="date" className="sb-access-input" data-testid="access-form-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </label>
      {problem ? (
        <div className="sb-access-error" data-testid="access-form-problem">
          {problem}
        </div>
      ) : null}
      <div className="sb-access-actions">
        <button type="submit" className="sb-button sb-access-primary" data-testid="access-save" disabled={busy}>
          {busy ? 'Saving…' : here ? `Save to ${view.keychain.name}` : `Save on ${where}`}
        </button>
        <button type="button" className="sb-button sb-access-secondary" data-testid="access-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
