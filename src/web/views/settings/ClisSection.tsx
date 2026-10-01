import { useEffect, useState } from 'react';
import type { CliInfo, CliOverview } from '../../../core/api.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import { ApiError, api } from '../../api/client.ts';
import { CliPicker } from '../../components/CliPicker.tsx';
import { Row, SectionTitle, Value } from './rows.tsx';
import { cliStateText, cliStateTone, commandSourceText, commandText, modelsText, parseCommandText } from './clis.ts';

const TONE_COLOR = { ok: 'var(--status-done)', warn: 'var(--status-need)', off: 'var(--muted-3)' } as const;

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && typeof caught.body === 'object' && caught.body !== null) {
    const body = caught.body as { errors?: Array<{ message?: string }>; message?: string };
    const message = body.errors?.[0]?.message ?? body.message;
    if (message) return message;
  }
  return caught instanceof Error ? caught.message : String(caught);
}

function CliCard({ cli, onChanged }: { readonly cli: CliInfo; readonly onChanged: (info: CliInfo) => void }) {
  const [text, setText] = useState(commandText(cli.command));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(commandText(cli.command)), [cli.command]);
  const run = async (work: () => Promise<CliInfo>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await work());
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = (): void => {
    const parsed = parseCommandText(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    void run(() => api.setCliCommand(cli.provider, parsed.command));
  };
  const editable = cli.provider !== 'claude';
  return (
    <div className="sb-set-cli" data-testid="settings-cli" data-provider={cli.provider} data-installed={String(cli.installed)} data-available={String(cli.available)}>
      <div className="sb-set-cli-head">
        <span className="sb-set-cli-name">{cli.label}</span>
        <span className="sb-set-cli-state" data-testid="settings-cli-state" style={{ color: TONE_COLOR[cliStateTone(cli)] }}>
          {cliStateText(cli)}
        </span>
        <button type="button" className="sb-set-button" data-testid="settings-cli-check" disabled={busy} onClick={() => void run(() => api.checkCli(cli.provider))}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      <Row id={`cli-${cli.provider}-command`} label="Command" description={commandSourceText(cli)}>
        {editable ? (
          <div className="sb-set-cli-command">
            <input
              className="sb-set-input"
              data-testid="settings-cli-command"
              aria-label={`${cli.label} command`}
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') save();
              }}
            />
            <button type="button" className="sb-set-button" data-testid="settings-cli-save" disabled={busy} onClick={save}>
              Save
            </button>
            {cli.commandSource === 'settings' ? (
              <button type="button" className="sb-set-button" data-testid="settings-cli-reset" disabled={busy} onClick={() => void run(() => api.setCliCommand(cli.provider, null))}>
                Reset
              </button>
            ) : null}
          </div>
        ) : (
          <Value>{commandText(cli.command)}</Value>
        )}
      </Row>
      {cli.path ? (
        <Row id={`cli-${cli.provider}-path`} label="Found at" description="The executable sessions start">
          <Value>{cli.path}</Value>
        </Row>
      ) : null}
      <Row id={`cli-${cli.provider}-account`} label="Sign-in" description="The CLI's own login, checked read-only. Switchboard stores no credentials.">
        <Value>{!cli.installed ? '—' : cli.signedIn === true ? 'signed in' : cli.signedIn === false ? 'signed out' : 'unknown'}</Value>
      </Row>
      <Row id={`cli-${cli.provider}-models`} label="Models" description="What the New-session forms and the header offer">
        <Value>{modelsText(cli)}</Value>
      </Row>
      {!cli.installed || cli.signedIn === false ? (
        <div className="sb-set-note" data-testid="settings-cli-install">
          {!cli.installed ? (
            <>
              {cli.label} is not installed: it can&apos;t be chosen for a session until it is. Install it (Switchboard never installs CLIs):{' '}
              {cli.install.commands.map((command) => (
                <code key={command} className="sb-set-cli-code">
                  {command}
                </code>
              ))}{' '}
              <a href={cli.install.docs} target="_blank" rel="noopener noreferrer">
                Install instructions
              </a>
              . Then {cli.install.signIn.charAt(0).toLowerCase()}
              {cli.install.signIn.slice(1)}
            </>
          ) : (
            cli.install.signIn
          )}
        </div>
      ) : null}
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="settings-cli-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/**
 * D62 · Settings → CLIs: each CLI Switchboard can run sessions on (Claude Code,
 * Codex CLI, OpenCode): its command (Codex / OpenCode can be overridden here),
 * version, sign-in, models, and the install help when it is missing; and the
 * default CLI for new sessions (the sidebar's switcher sets the same).
 */
export function ClisSection() {
  const [overview, setOverview] = useState<CliOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.clis().then(
      (value) => live && setOverview(value),
      (caught: unknown) => live && setError(errorText(caught)),
    );
    return () => {
      live = false;
    };
  }, []);
  const changed = (info: CliInfo): void => setOverview((current) => (current ? { ...current, clis: current.clis.map((cli) => (cli.provider === info.provider ? info : cli)) } : current));
  const pickDefault = (provider: CliProviderId): void => {
    setError(null);
    api.setDefaultCli(provider).then(setOverview, (caught: unknown) => setError(errorText(caught)));
  };
  return (
    <>
      <SectionTitle withLede>CLIs</SectionTitle>
      <div className="sb-set-lede">Sessions run on Claude Code, Codex CLI or OpenCode. A CLI that is missing or signed out simply can&apos;t be chosen.</div>
      <Row id="cli-default" label="Default CLI" description="What new sessions start on (also in the sidebar's footer)">
        {overview ? <CliPicker testId="settings-cli-default" value={overview.default} overview={overview} onPick={pickDefault} /> : <Value>…</Value>}
      </Row>
      {error ? (
        <div className="sb-set-note sb-set-error" role="alert" data-testid="settings-clis-error">
          {error}
        </div>
      ) : null}
      {overview ? overview.clis.map((cli) => <CliCard key={cli.provider} cli={cli} onChanged={changed} />) : <div className="sb-set-note">Checking the CLIs…</div>}
    </>
  );
}
