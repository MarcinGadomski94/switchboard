import { useEffect, useState } from 'react';
import type { CliMcpView } from '../../core/api.ts';
import { CLI_LABELS, type CliProviderId, unavailableText } from '../../core/cli-providers.ts';
import { ApiError, mcpApi } from '../api/client.ts';

type OtherCli = Exclude<CliProviderId, 'claude'>;

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * D62 P7: the MCP page's Codex CLI and OpenCode servers (`docs/providers.md` →
 * *MCP*), through their own CLIs: the list, and for Codex Add (a command or a
 * URL) and Remove. What a CLI cannot do here (OpenCode's interactive `mcp add`;
 * Check / Reconnect / sign-in, which are Claude Code's control requests) is said,
 * not hidden.
 */
export function CliMcpSection({ machine, folder }: { readonly machine: string | null; readonly folder: string | undefined }) {
  return (
    <div className="sb-mcp-group" data-testid="mcp-cli-section">
      <div className="sb-mcp-group-head">
        <span className="sb-mcp-group-title">Codex CLI and OpenCode</span>
        <span className="sb-mcp-muted">their own MCP config, through their CLIs · Check, Reconnect and sign-in are Claude Code&apos;s</span>
      </div>
      {(['codex', 'opencode'] as const).map((provider) => (
        <CliMcpBlock key={provider} provider={provider} machine={machine} folder={folder} />
      ))}
    </div>
  );
}

function CliMcpBlock({ provider, machine, folder }: { readonly provider: OtherCli; readonly machine: string | null; readonly folder: string | undefined }) {
  const [view, setView] = useState<CliMcpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const client = mcpApi(machine, folder);
  useEffect(() => {
    let live = true;
    setView(null);
    mcpApi(machine, folder)
      .cliView(provider)
      .then(
        (value) => live && setView(value),
        (caught: unknown) => live && setError(errorText(caught)),
      );
    return () => {
      live = false;
    };
  }, [provider, machine, folder]);
  const run = async (work: () => Promise<CliMcpView>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await work());
      setAdding(false);
      setName('');
      setTarget('');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const add = (): void => {
    const trimmed = target.trim();
    const url = /^https?:\/\//.test(trimmed);
    const [command, ...args] = trimmed.split(/\s+/);
    void run(() => client.cliAdd(provider, url ? { name: name.trim(), url: trimmed } : { name: name.trim(), command: command ?? '', args }));
  };
  return (
    <div className="sb-mcp-cli" data-testid="mcp-cli" data-provider={provider} data-available={view ? String(view.available) : undefined}>
      <div className="sb-mcp-cli-head">
        <span className="sb-mcp-cli-name">{CLI_LABELS[provider]}</span>
        {view?.command ? <span className="sb-mcp-muted sb-mcp-mono">{view.command}</span> : null}
        {view?.canEdit && view.available ? (
          <button type="button" className="sb-button" data-testid="mcp-cli-add" disabled={busy} onClick={() => setAdding((open) => !open)}>
            + Add server
          </button>
        ) : null}
      </div>
      {view && !view.available ? (
        <div className="sb-mcp-muted" data-testid="mcp-cli-unavailable">
          {view.reason}
        </div>
      ) : null}
      {view && view.available && view.servers.length === 0 ? <div className="sb-mcp-muted" data-testid="mcp-cli-empty">No MCP servers configured.</div> : null}
      {view?.servers.map((server) => (
        <div className="sb-mcp-row" key={server.name} data-testid="mcp-cli-server" data-name={server.name}>
          <span className="sb-mcp-cli-server-name">{server.name}</span>
          <span className="sb-mcp-muted">{server.transport}</span>
          <span className="sb-mcp-mono sb-mcp-cli-target" title={server.target}>
            {server.target}
          </span>
          {server.envNames.length > 0 ? <span className="sb-mcp-muted">env: {server.envNames.join(', ')}</span> : null}
          <span className="sb-mcp-muted">{server.enabled ? (server.status ?? 'enabled') : 'disabled'}</span>
          <button
            type="button"
            className="sb-button"
            data-testid="mcp-cli-remove"
            disabled={busy || !view.canEdit}
            title={view.canEdit ? undefined : (view.editReason ?? unavailableText(provider, 'mcp') ?? undefined)}
            onClick={() => void run(() => client.cliRemove(provider, server.name))}
          >
            Remove
          </button>
        </div>
      ))}
      {view && !view.canEdit && view.available ? (
        <div className="sb-mcp-muted" data-testid="mcp-cli-edit-note">
          {`Add / Remove: not available in ${CLI_LABELS[provider]} here: ${view.editReason ?? ''}`}
        </div>
      ) : null}
      {adding ? (
        <div className="sb-mcp-cli-form" data-testid="mcp-cli-form">
          <input className="sb-mcp-input" data-testid="mcp-cli-name" aria-label="Name" placeholder="name" value={name} onChange={(event) => setName(event.target.value)} />
          <input
            className="sb-mcp-input sb-mcp-mono"
            data-testid="mcp-cli-target"
            aria-label="Command or URL"
            placeholder="command and arguments, or an https:// URL"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <button type="button" className="sb-button" data-testid="mcp-cli-save" disabled={busy || name.trim() === '' || target.trim() === ''} onClick={add}>
            Add
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="sb-mcp-error" role="alert" data-testid="mcp-cli-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
