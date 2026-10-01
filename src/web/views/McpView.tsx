import { CliMcpSection } from './CliMcpSection.tsx';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder } from '../../core/api.ts';
import { MCP_EDITABLE_SCOPES, MCP_TRANSPORTS, type McpActionResult, type McpAuthState, type McpFieldError, type McpServerView, type McpView as McpViewData } from '../../core/mcp.ts';
import type { Machine } from '../../core/peers.ts';
import { ApiError, api, machineApi, mcpApi } from '../api/client.ts';
import { formatAge } from '../shell/format.ts';
import {
  KEPT_PLACEHOLDER,
  type McpFormState,
  type SecretRow,
  emptyForm,
  errorMessage,
  folderChoices,
  formErrors,
  formFromDefinition,
  formToInput,
  groupByScope,
  parseChoice,
  scopeTitle,
  statusLabel,
  targetText,
} from './mcp.ts';
import './mcp.css';

/** What the result strip shows after an action. */
interface Outcome {
  readonly ok: boolean;
  readonly text: string | null;
  readonly commands: readonly string[];
}

/** The open Add / Edit form. */
interface FormMode {
  readonly kind: 'add' | 'edit';
  /** Edit: the server's name and scope before the edit. */
  readonly original: { readonly name: string; readonly scope: string } | null;
  readonly state: McpFormState;
  readonly errors: readonly McpFieldError[];
  readonly saving: boolean;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function outcomeOf(error: unknown): Outcome {
  if (error instanceof ApiError) {
    const commands = (error.body as { commands?: unknown } | null)?.commands;
    return { ok: false, text: errorMessage(error.body, error.message), commands: Array.isArray(commands) ? (commands as string[]) : [] };
  }
  return { ok: false, text: String(error), commands: [] };
}

function fieldErrors(error: unknown): McpFieldError[] {
  if (!(error instanceof ApiError)) return [];
  const errors = (error.body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) ? (errors as McpFieldError[]) : [];
}

/** The peers' folders for the selector (online machines only; a failing one is skipped). */
async function peerFolders(): Promise<Array<{ machine: Machine; folders: Folder[] }>> {
  let machines: readonly Machine[] = [];
  try {
    machines = (await api.machines()).machines.filter((m) => m.state === 'online');
  } catch {
    return [];
  }
  const out: Array<{ machine: Machine; folders: Folder[] }> = [];
  for (const machine of machines) {
    try {
      out.push({ machine, folders: await machineApi(machine.id).savedFolders() });
    } catch {
      // unreachable right now: not offered
    }
  }
  return out;
}

function SecretRows({ label, rows, onChange, testId, fieldPrefix, errors }: { readonly label: string; readonly rows: readonly SecretRow[]; readonly onChange: (rows: SecretRow[]) => void; readonly testId: string; readonly fieldPrefix: string; readonly errors: readonly McpFieldError[] }) {
  const set = (index: number, patch: Partial<SecretRow>): void => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="sb-mcp-field" data-testid={testId}>
      <span className="sb-mcp-label">{label}</span>
      {rows.map((row, index) => {
        const error = errors.find((e) => e.field === `${fieldPrefix}.${index}`);
        return (
          <div className="sb-mcp-secret" key={index} data-testid={`${testId}-row`}>
            <input className="sb-mcp-input sb-mcp-mono" aria-label={`${label} name`} value={row.name} placeholder="NAME" onChange={(e) => set(index, { name: e.target.value })} />
            <input
              className="sb-mcp-input sb-mcp-mono"
              aria-label={`${label} value`}
              type="password"
              autoComplete="off"
              value={row.value}
              placeholder={row.keep ? KEPT_PLACEHOLDER : 'value'}
              onChange={(e) => set(index, { value: e.target.value })}
            />
            <button type="button" className="sb-button sb-mcp-link" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              ×
            </button>
            {error ? <span className="sb-mcp-error">{error.message}</span> : null}
          </div>
        );
      })}
      <button type="button" className="sb-button sb-mcp-link" data-testid={`${testId}-add`} onClick={() => onChange([...rows, { name: '', value: '', keep: false }])}>
        + {label === 'Environment' ? 'variable' : 'header'}
      </button>
    </div>
  );
}

function ServerForm({ mode, folderPath, onChange, onSave, onCancel }: { readonly mode: FormMode; readonly folderPath: string; readonly onChange: (state: McpFormState) => void; readonly onSave: () => void; readonly onCancel: () => void }) {
  const { state, errors } = mode;
  const errorOf = (field: string): ReactNode => {
    const found = errors.find((e) => e.field === field);
    return found ? <span className="sb-mcp-error" data-testid={`mcp-form-error-${field}`}>{found.message}</span> : null;
  };
  const patch = (p: Partial<McpFormState>): void => onChange({ ...state, ...p });
  return (
    <form
      className="sb-mcp-form"
      data-testid="mcp-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="sb-mcp-form-title">{mode.kind === 'add' ? 'Add an MCP server' : `Edit ${mode.original?.name ?? ''}`}</div>
      <label className="sb-mcp-field">
        <span className="sb-mcp-label">Name</span>
        <input className="sb-mcp-input sb-mcp-mono" data-testid="mcp-form-name" value={state.name} onChange={(e) => patch({ name: e.target.value })} />
        {errorOf('name')}
      </label>
      <div className="sb-mcp-form-row">
        <label className="sb-mcp-field">
          <span className="sb-mcp-label">Scope</span>
          <select className="sb-mcp-input" data-testid="mcp-form-scope" value={state.scope} onChange={(e) => patch({ scope: e.target.value as McpFormState['scope'] })}>
            {MCP_EDITABLE_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope} · {scopeTitle(scope).note}
              </option>
            ))}
          </select>
          {errorOf('scope')}
        </label>
        <label className="sb-mcp-field">
          <span className="sb-mcp-label">Transport</span>
          <select className="sb-mcp-input" data-testid="mcp-form-transport" value={state.transport} onChange={(e) => patch({ transport: e.target.value as McpFormState['transport'] })}>
            {MCP_TRANSPORTS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.scope === 'project' ? (
        <div className="sb-mcp-warn" data-testid="mcp-form-project-note">
          Project scope writes <code>.mcp.json</code> in {folderPath}: a file in your repo that may get committed and shared.
        </div>
      ) : null}
      {state.transport === 'stdio' ? (
        <>
          <label className="sb-mcp-field">
            <span className="sb-mcp-label">Command</span>
            <input className="sb-mcp-input sb-mcp-mono" data-testid="mcp-form-command" value={state.command} placeholder="npx" onChange={(e) => patch({ command: e.target.value })} />
            {errorOf('command')}
          </label>
          <label className="sb-mcp-field">
            <span className="sb-mcp-label">Arguments (one per line)</span>
            <textarea className="sb-mcp-input sb-mcp-mono" data-testid="mcp-form-args" rows={3} value={state.args} onChange={(e) => patch({ args: e.target.value })} />
            {errorOf('args')}
          </label>
          <SecretRows label="Environment" testId="mcp-form-env" fieldPrefix="env" rows={state.env} errors={errors} onChange={(env) => patch({ env })} />
        </>
      ) : (
        <>
          <label className="sb-mcp-field">
            <span className="sb-mcp-label">URL</span>
            <input className="sb-mcp-input sb-mcp-mono" data-testid="mcp-form-url" value={state.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => patch({ url: e.target.value })} />
            {errorOf('url')}
          </label>
          <SecretRows label="Headers" testId="mcp-form-headers" fieldPrefix="headers" rows={state.headers} errors={errors} onChange={(headers) => patch({ headers })} />
        </>
      )}
      {errorOf('env')}
      {errorOf('headers')}
      <div className="sb-mcp-form-actions">
        <button type="submit" className="sb-button sb-mcp-primary" data-testid="mcp-form-save" disabled={mode.saving}>
          {mode.saving ? 'Saving…' : mode.kind === 'add' ? 'Add server' : 'Save'}
        </button>
        <button type="button" className="sb-button sb-mcp-secondary" data-testid="mcp-form-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AuthPanel({ auth, onPaste, onCancel, onClose }: { readonly auth: McpAuthState; readonly onPaste: (url: string) => void; readonly onCancel: () => void; readonly onClose: () => void }) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  return (
    <div className="sb-mcp-auth" data-testid="mcp-auth" data-state={auth.state}>
      <div className="sb-mcp-form-title">Sign in to {auth.server}</div>
      {auth.state === 'waiting' ? (
        <>
          <div>
            Finish the sign-in in the tab that opened.{' '}
            {auth.authUrl ? (
              <a href={auth.authUrl} target="_blank" rel="noopener noreferrer" data-testid="mcp-auth-link">
                Open the sign-in page again
              </a>
            ) : null}
          </div>
          <div className="sb-mcp-muted">
            {auth.callbackExpected
              ? 'Claude Code waits for the browser on this machine’s localhost. If the browser runs on another machine, paste the address it ends on here:'
              : 'Paste the address the browser ends on here:'}
          </div>
          <div className="sb-mcp-secret">
            <input className="sb-mcp-input sb-mcp-mono" data-testid="mcp-auth-callback" value={pasted} placeholder="http://localhost:…/callback?code=…" onChange={(e) => setPasted(e.target.value)} />
            <button type="button" className="sb-button sb-mcp-secondary" data-testid="mcp-auth-submit" disabled={pasted.trim() === ''} onClick={() => onPaste(pasted)}>
              Submit
            </button>
            <button type="button" className="sb-button sb-mcp-secondary" data-testid="mcp-auth-cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
      {auth.state === 'done' ? <div data-testid="mcp-auth-done">Signed in: {auth.server} is authenticated.</div> : null}
      {auth.state === 'cancelled' ? <div>Sign-in cancelled.</div> : null}
      {auth.state === 'failed' ? (
        <>
          <div className="sb-mcp-error" data-testid="mcp-auth-error">
            {auth.error}
          </div>
          {auth.instructions ? (
            <div className="sb-mcp-secret">
              <code className="sb-mcp-mono" data-testid="mcp-auth-instructions">
                {auth.instructions}
              </code>
              <button
                type="button"
                className="sb-button sb-mcp-secondary"
                data-testid="mcp-auth-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(auth.instructions ?? '').then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {auth.state !== 'waiting' ? (
        <button type="button" className="sb-button sb-mcp-link" data-testid="mcp-auth-close" onClick={onClose}>
          Close
        </button>
      ) : null}
    </div>
  );
}

function ServerRow({ server, busy, now, onAction }: { readonly server: McpServerView; readonly busy: string | null; readonly now: number; readonly onAction: (action: string, server: McpServerView) => void }) {
  const label = statusLabel(server.status);
  const disabled = server.status === 'disabled';
  const act = (action: string, text: string, busyText: string, show = true): ReactNode =>
    show ? (
      <button type="button" className="sb-button sb-mcp-action" data-testid={`mcp-${action}`} disabled={busy !== null} onClick={() => onAction(action, server)}>
        {busy === action ? busyText : text}
      </button>
    ) : null;
  const details = [
    server.envNames.length > 0 ? `env ${server.envNames.join(', ')}` : '',
    server.headerNames.length > 0 ? `headers ${server.headerNames.join(', ')}` : '',
  ].filter(Boolean);
  return (
    <div className="sb-mcp-row" data-testid="mcp-server" data-name={server.name} data-scope={server.scope} data-status={server.status}>
      <span className="sb-mcp-dot" data-kind={label.kind} />
      <div className="sb-mcp-main">
        <div className="sb-mcp-name-line">
          <span className="sb-mcp-name">{server.name}</span>
          <span className="sb-mcp-tag">{server.transport}</span>
          {!server.editable ? <span className="sb-mcp-tag">read-only</span> : null}
        </div>
        <div className="sb-mcp-target sb-mcp-mono" data-testid="mcp-target" title={targetText(server)}>
          {targetText(server)}
        </div>
        {details.length > 0 ? <div className="sb-mcp-muted sb-mcp-mono">{details.join(' · ')}</div> : null}
        <div className="sb-mcp-status-line">
          <span className="sb-mcp-status" data-testid="mcp-status" data-kind={label.kind}>
            {busy === 'check' ? 'checking…' : label.text}
          </span>
          {server.tools !== null ? <span className="sb-mcp-muted" data-testid="mcp-tools">{`${server.tools} tool${server.tools === 1 ? '' : 's'}`}</span> : null}
          {server.checkedAt ? <span className="sb-mcp-muted" data-testid="mcp-checked">checked {formatAge(server.checkedAt, now) === 'now' ? 'just now' : `${formatAge(server.checkedAt, now)} ago`}</span> : null}
        </div>
        {server.error ? (
          <div className="sb-mcp-error" data-testid="mcp-error">
            {server.error}
          </div>
        ) : null}
        {server.status === 'pending-approval' ? <div className="sb-mcp-muted">Approve it by running `claude` in this folder (Claude Code asks about new .mcp.json servers).</div> : null}
      </div>
      <div className="sb-mcp-actions">
        {act('check', 'Check', 'Checking…', !disabled)}
        {act('reconnect', 'Reconnect', 'Reconnecting…', !disabled)}
        {act('auth', server.status === 'needs-auth' ? 'Authenticate' : 'Re-authenticate', 'Starting…', server.canAuthenticate && !disabled)}
        {act('toggle', disabled ? 'Enable' : 'Disable', disabled ? 'Enabling…' : 'Disabling…')}
        {act('edit', 'Edit', 'Opening…', server.editable)}
        {act('remove', 'Remove', 'Removing…', server.editable)}
      </div>
    </div>
  );
}

/**
 * D61: the MCP servers page (`/mcp`, `docs/mcp.md`). A folder selector (this
 * machine's saved folders, the default first, then a paired machine's); the
 * servers Claude Code would load there grouped by scope (local, project, user,
 * then read-only plugin / claude.ai ones a check found), each with its masked
 * command or URL, status, tools and last check; Check / Check all, Reconnect,
 * Authenticate, Enable / Disable, Add / Edit / Remove. Every action shows the CLI
 * command it ran and the CLI's own words on failure.
 */
export function McpView() {
  const now = useNow(30_000);
  const [choices, setChoices] = useState<ReturnType<typeof folderChoices> | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [view, setView] = useState<McpViewData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ readonly name: string; readonly action: string } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [form, setForm] = useState<FormMode | null>(null);
  const [auth, setAuth] = useState<McpAuthState | null>(null);
  const authTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let local: Folder[] = [];
      try {
        local = await api.savedFolders();
      } catch (error) {
        if (!cancelled) setLoadError(errorMessage(error instanceof ApiError ? error.body : null, 'Could not load the saved folders'));
      }
      const peers = await peerFolders();
      if (cancelled) return;
      const list = folderChoices(local, peers);
      setChoices(list);
      setChoice((current) => current ?? list[0]?.value ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const target = useMemo(() => (choice ? parseChoice(choice) : null), [choice]);
  const client = useMemo(() => (target ? mcpApi(target.machine, target.folderId) : null), [target]);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setView(await client.view());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error instanceof ApiError ? error.body : null, 'Could not load the MCP servers'));
    }
  }, [client]);

  useEffect(() => {
    setView(null);
    setOutcome(null);
    setForm(null);
    setAuth(null);
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (authTimer.current) clearTimeout(authTimer.current);
    },
    [],
  );

  const run = async (name: string, action: string, call: () => Promise<McpActionResult>): Promise<boolean> => {
    setBusy({ name, action });
    try {
      const result = await call();
      setView(result.view);
      setOutcome({ ok: true, text: result.message, commands: result.commands });
      return true;
    } catch (error) {
      setOutcome(outcomeOf(error));
      void load();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const pollAuth = (id: string): void => {
    if (!client) return;
    authTimer.current = setTimeout(() => {
      void client.authState(id).then(
        (state) => {
          setAuth(state);
          if (state.state === 'waiting') pollAuth(id);
          else void load();
        },
        () => pollAuth(id),
      );
    }, 1_000);
  };

  const onAction = (action: string, server: McpServerView): void => {
    if (!client) return;
    switch (action) {
      case 'check':
        void run(server.name, 'check', () => client.check(server.name));
        return;
      case 'reconnect':
        void run(server.name, 'reconnect', () => client.reconnect(server.name));
        return;
      case 'toggle':
        void run(server.name, 'toggle', () => client.toggle(server.name, server.status === 'disabled'));
        return;
      case 'remove': {
        const where = server.scope === 'project' ? ` from .mcp.json in ${view?.folder.path ?? 'this folder'}` : ` (${server.scope} scope)`;
        if (!window.confirm(`Remove the MCP server ${server.name}${where}? This runs claude mcp remove ${server.name} --scope ${server.scope}.`)) return;
        void run(server.name, 'remove', () => client.remove(server.name, server.scope));
        return;
      }
      case 'edit':
        setBusy({ name: server.name, action: 'edit' });
        client.definition(server.name, server.scope).then(
          (definition) => {
            setForm({ kind: 'edit', original: { name: server.name, scope: server.scope }, state: formFromDefinition(definition), errors: [], saving: false });
            setBusy(null);
          },
          (error: unknown) => {
            setOutcome(outcomeOf(error));
            setBusy(null);
          },
        );
        return;
      case 'auth': {
        // Opened now (inside the click) so the browser does not block it; pointed at the sign-in URL once it comes.
        const tab = window.open('about:blank', '_blank');
        setBusy({ name: server.name, action: 'auth' });
        client.startAuth(server.name, server.status !== 'needs-auth').then(
          (state) => {
            setBusy(null);
            setAuth(state);
            if (state.state === 'waiting' && state.authUrl) {
              if (tab) {
                tab.opener = null;
                tab.location.href = state.authUrl;
              }
              pollAuth(state.id);
            } else {
              tab?.close();
              void load();
            }
          },
          (error: unknown) => {
            tab?.close();
            setBusy(null);
            setOutcome(outcomeOf(error));
          },
        );
        return;
      }
    }
  };

  const saveForm = async (): Promise<void> => {
    if (!client || !form) return;
    const errors = formErrors(form.state);
    if (errors.length > 0) {
      setForm({ ...form, errors });
      return;
    }
    setForm({ ...form, errors: [], saving: true });
    const input = formToInput(form.state);
    try {
      const result = form.kind === 'add' ? await client.add(input) : await client.edit(form.original?.name ?? input.name, form.original?.scope ?? input.scope, input);
      setView(result.view);
      setOutcome({ ok: true, text: result.message, commands: result.commands });
      setForm(null);
    } catch (error) {
      const fields = fieldErrors(error);
      setForm({ ...form, saving: false, errors: fields });
      setOutcome(outcomeOf(error));
      void load();
    }
  };

  const current = choices?.find((c) => c.value === choice) ?? null;
  const groups = groupByScope(view?.servers ?? []);

  return (
    <section className="sb-view sb-mcp" data-view="mcp" data-testid="view-mcp">
      <div className="sb-mcp-head">
        <div className="sb-mcp-titlebar">
          <div className="sb-mcp-title">MCP servers</div>
          {choices && choices.length > 0 ? (
            <select className="sb-mcp-folder" data-testid="mcp-folder" aria-label="Folder" value={choice ?? ''} title={current?.path} onChange={(e) => setChoice(e.target.value)}>
              {choices.map((c) => (
                <option key={c.value} value={c.value} title={c.path}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : null}
          <span className="sb-mcp-muted" data-testid="mcp-checked-all">
            {view?.checkedAt ? `checked ${formatAge(view.checkedAt, now) === 'now' ? 'just now' : `${formatAge(view.checkedAt, now)} ago`}` : ''}
          </span>
          <div className="sb-mcp-head-actions">
            <button type="button" className="sb-button sb-mcp-secondary" data-testid="mcp-check-all" disabled={!client || busy !== null} onClick={() => void run('*', 'check-all', () => (client as ReturnType<typeof mcpApi>).check())}>
              {busy?.action === 'check-all' ? 'Checking…' : 'Check all'}
            </button>
            <button
              type="button"
              className="sb-button sb-mcp-primary"
              data-testid="mcp-add"
              disabled={!client}
              onClick={() => setForm({ kind: 'add', original: null, state: emptyForm(), errors: [], saving: false })}
            >
              + Add server
            </button>
          </div>
        </div>
        <div className="sb-mcp-muted sb-mcp-mono" data-testid="mcp-folder-path">
          {view?.folder.path ?? current?.path ?? ''}
        </div>
      </div>

      <div className="sb-mcp-body">
        {loadError ? (
          <div className="sb-mcp-error" data-testid="mcp-load-error">
            {loadError}
          </div>
        ) : null}
        {choices && choices.length === 0 ? <div className="sb-mcp-empty">Add a folder in Settings → Folders first.</div> : null}
        {view?.changedAt ? (
          <div className="sb-mcp-note" data-testid="mcp-restart-note">
            MCP servers changed: live sessions pick the change up on their next start.
          </div>
        ) : null}
        {outcome ? (
          <div className="sb-mcp-outcome" data-testid="mcp-outcome" data-ok={outcome.ok ? 'true' : 'false'}>
            {outcome.text ? <div className={outcome.ok ? undefined : 'sb-mcp-error'} data-testid="mcp-outcome-text">{outcome.text}</div> : null}
            {outcome.commands.map((command, i) => (
              <code className="sb-mcp-command sb-mcp-mono" key={i} data-testid="mcp-command">
                {command}
              </code>
            ))}
            <button type="button" className="sb-button sb-mcp-link" onClick={() => setOutcome(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {form ? (
          <ServerForm
            mode={form}
            folderPath={view?.folder.path ?? ''}
            onChange={(state) => setForm({ ...form, state })}
            onSave={() => void saveForm()}
            onCancel={() => setForm(null)}
          />
        ) : null}
        {auth ? (
          <AuthPanel
            auth={auth}
            onPaste={(url) => {
              if (!client) return;
              client.submitCallback(auth.id, url).then(setAuth, (error: unknown) => setOutcome(outcomeOf(error)));
            }}
            onCancel={() => {
              if (!client) return;
              if (authTimer.current) clearTimeout(authTimer.current);
              client.cancelAuth(auth.id).then(setAuth, (error: unknown) => setOutcome(outcomeOf(error)));
            }}
            onClose={() => setAuth(null)}
          />
        ) : null}
        {view && view.servers.length === 0 ? (
          <div className="sb-mcp-empty" data-testid="mcp-empty">
            No MCP servers for this folder. Add one, or run Check all to find plugin and claude.ai servers.
          </div>
        ) : null}
        {groups.map((group) => (
          <div className="sb-mcp-group" key={group.scope} data-testid="mcp-group" data-scope={group.scope}>
            <div className="sb-mcp-group-head">
              <span className="sb-mcp-group-title">{scopeTitle(group.scope).title}</span>
              <span className="sb-mcp-muted">{scopeTitle(group.scope).note}</span>
            </div>
            {group.servers.map((server) => (
              <ServerRow key={`${server.scope}:${server.name}`} server={server} now={now} busy={busy && busy.name === server.name ? busy.action : busy ? '…' : null} onAction={onAction} />
            ))}
          </div>
        ))}
        {/* D62 P7: the other CLIs' servers, under Claude Code's. */}
        {target ? <CliMcpSection machine={target.machine} folder={target.folderId} /> : null}
      </div>
    </section>
  );
}
