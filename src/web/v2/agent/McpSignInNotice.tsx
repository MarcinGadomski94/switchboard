import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../../core/api.ts';
import { CLAUDE_AI_CONNECTORS_URL } from '../../../core/mcp-sign-in.ts';
import { api } from '../../api/client.ts';
import { Button, Icon } from '../components/index.ts';
import { type SignInNoticeRow, type SignInPhase, reconnectText, signInNoticeRows } from './mcp-sign-in-model.ts';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'It didn’t work. Try again.';
}

/**
 * D163 (`docs/mcp.md` → *Sign-in where it happens*): above the composer, one notice per
 * MCP server the agent's running CLI needs a sign-in to. **Sign in** runs the D61
 * sign-in in the agent's folder (the browser tab opens at the click, then goes to the
 * sign-in page); when it is done Switchboard reconnects the server in every running
 * agent that needs it. A claude.ai connector: **Open claude.ai connectors**, then
 * **Reconnect**. A paired computer's agent: signed in on that computer.
 */
export function McpSignInNotice({ sessionId, session }: { readonly sessionId: string; readonly session: Pick<Session, 'mcpSignIn' | 'machine' | 'closedAt'> | null }) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [phases, setPhases] = useState<Readonly<Record<string, SignInPhase>>>({});
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);
  const rows = signInNoticeRows(session, dismissed);
  // A "done" line stays a moment after the server leaves the list.
  const shown = new Set(rows.map((row) => row.name));
  const lingering = Object.entries(phases).filter(([name, phase]) => !shown.has(name) && (phase.kind === 'done' || phase.kind === 'failed'));
  if (rows.length === 0 && lingering.length === 0) return null;

  const set = (name: string, phase: SignInPhase): void => setPhases((current) => ({ ...current, [name]: phase }));
  const later = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      fn();
    }, ms);
    timers.current.add(timer);
  };

  const poll = (name: string, authId: string, until: number): void => {
    later(() => {
      api.mcpAuthState(authId).then(
        (state) => {
          if (state.state === 'waiting') {
            if (Date.now() < until) poll(name, authId, until);
            else set(name, { kind: 'failed', text: 'The sign-in was not finished in time.' });
          } else if (state.state === 'done') set(name, { kind: 'done', text: `Signed in to ${name}. Reconnecting the agents…` });
          else set(name, { kind: 'failed', text: [state.error ?? 'The sign-in did not finish.', state.instructions].filter(Boolean).join(' ') });
        },
        (error: unknown) => set(name, { kind: 'failed', text: errorText(error) }),
      );
    }, 1_000);
  };

  const signIn = (row: SignInNoticeRow): void => {
    // Opened now (inside the click) so the browser does not block it; pointed at the sign-in page once it comes.
    const tab = window.open('about:blank', '_blank');
    set(row.name, { kind: 'starting' });
    api.mcpSignIn(sessionId, row.name).then(
      (state) => {
        if (state.state === 'waiting' && state.authUrl) {
          if (tab) {
            tab.opener = null;
            tab.location.href = state.authUrl;
          }
          set(row.name, { kind: 'waiting' });
          poll(row.name, state.id, Date.now() + 5 * 60_000);
        } else {
          tab?.close();
          if (state.state === 'done') set(row.name, { kind: 'done', text: `Signed in to ${row.name}. Reconnecting the agents…` });
          else set(row.name, { kind: 'failed', text: [state.error ?? 'The sign-in did not start.', state.instructions].filter(Boolean).join(' ') });
        }
      },
      (error: unknown) => {
        tab?.close();
        set(row.name, { kind: 'failed', text: errorText(error) });
      },
    );
  };

  const reconnect = (row: SignInNoticeRow): void => {
    set(row.name, { kind: 'reconnecting' });
    api.mcpSignInReconnect(sessionId, row.name).then(
      (result) => set(row.name, result.reconnected.length > 0 ? { kind: 'done', text: reconnectText(row.name, result.reconnected.length, result.failed.length) } : { kind: 'failed', text: reconnectText(row.name, 0, result.failed.length) }),
      (error: unknown) => set(row.name, { kind: 'failed', text: errorText(error) }),
    );
  };

  return (
    <div className="v2-ag-mcp-signin" data-testid="v2-agent-mcp-signin-list">
      {rows.map((row) => {
        const phase = phases[row.name] ?? { kind: 'idle' };
        const busy = phase.kind === 'starting' || phase.kind === 'waiting' || phase.kind === 'reconnecting';
        return (
          <div key={row.name} className="v2-ag-dock-note v2-ag-mcp-signin-row" role="alert" data-testid="v2-agent-mcp-signin" data-server={row.name} data-tour="v2-mcp-signin">
            <Icon name="shield" size="s" />
            <span className="v2-grow">
              {row.text}
              {phase.kind === 'waiting' ? <span className="v2-muted"> · finish it in the browser tab that opened</span> : null}
              {phase.kind === 'starting' ? <span className="v2-muted"> · starting the sign-in…</span> : null}
              {phase.kind === 'reconnecting' ? <span className="v2-muted"> · reconnecting…</span> : null}
              {phase.kind === 'done' || phase.kind === 'failed' ? (
                <span className={phase.kind === 'failed' ? 'v2-ag-dock-error' : 'v2-muted'} data-testid="v2-agent-mcp-signin-outcome">
                  {' '}
                  · {phase.text}
                </span>
              ) : null}
            </span>
            {row.elsewhere ? (
              <span className="v2-muted" data-testid="v2-agent-mcp-signin-elsewhere">
                Sign in on {row.elsewhere} (its Switchboard)
              </span>
            ) : row.claudeAi ? (
              <>
                <Button size="sm" icon="external" onClick={() => window.open(CLAUDE_AI_CONNECTORS_URL, '_blank', 'noopener')} data-testid="v2-agent-mcp-signin-claudeai">
                  Open claude.ai connectors
                </Button>
                <Button size="sm" icon="refresh" disabled={busy} onClick={() => reconnect(row)} data-testid="v2-agent-mcp-signin-reconnect">
                  Reconnect
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" icon="shield" disabled={busy} onClick={() => signIn(row)} data-testid="v2-agent-mcp-signin-go">
                {phase.kind === 'failed' ? 'Try again' : 'Sign in'}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setDismissed((current) => new Set([...current, row.name]))} data-testid="v2-agent-mcp-signin-dismiss">
              Dismiss
            </Button>
          </div>
        );
      })}
      {lingering.map(([name, phase]) => (
        <div key={name} className="v2-ag-dock-note v2-ag-mcp-signin-row" role="status" data-testid="v2-agent-mcp-signin-done" data-server={name}>
          <Icon name={phase.kind === 'done' ? 'check' : 'alert'} size="s" />
          <span className="v2-grow">{phase.kind === 'done' || phase.kind === 'failed' ? (phase.kind === 'done' ? `Signed in to ${name}: the agent uses it again.` : phase.text) : ''}</span>
          <Button size="sm" variant="ghost" onClick={() => setPhases(({ [name]: _gone, ...rest }) => rest)}>
            OK
          </Button>
        </div>
      ))}
    </div>
  );
}
