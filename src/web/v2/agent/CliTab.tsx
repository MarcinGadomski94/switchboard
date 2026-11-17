import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client.ts';
import { Button, EmptyState, Icon, useToast } from '../components/index.ts';
import { CLI_MODE_WORDS as W } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import { TerminalView } from '../terminals/TerminalView.tsx';
import { cliTabState } from './cli-tab-model.ts';
import type { AgentData } from './useAgent.ts';

function errorText(error: unknown): string {
  const body = error instanceof ApiError ? (error.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' && body.message ? body.message : W.failed;
}

/**
 * D171 · the agent's **CLI** tab (`docs/terminals.md` → *CLI mode*): opening it switches the agent to
 * CLI mode (its conversation as the interactive `claude`, the native TUI, in a D170 terminal of its
 * computer); a running turn first asks Wait (it switches when the turn ends) or Stop the turn. In CLI
 * mode the terminal fills the tab, with **Back to chat mode** (the CLI ends; Switchboard runs the same
 * conversation again). Why it cannot switch (another CLI, a conversation, …) is said instead.
 */
export function CliTab({ data, phone }: { readonly data: AgentData; readonly phone: boolean }) {
  const { navigate } = useV2Router();
  const toast = useToast();
  const { session, sessionId } = data;
  const state = cliTabState(session);
  const [busy, setBusy] = useState<'enter' | 'back' | null>(null);
  const [waiting, setWaiting] = useState(false);
  const tried = useRef(false);

  const enter = (stopTurn: boolean): void => {
    setBusy('enter');
    api.enterCliMode(sessionId, stopTurn ? { stopTurn: true } : {}).then(
      () => setBusy(null),
      (caught: unknown) => {
        setBusy(null);
        setWaiting(false);
        const code = caught instanceof ApiError ? (caught.body as { error?: unknown } | null)?.error : null;
        // A turn began meanwhile: the tab shows Wait / Stop the turn (the session's status says so).
        if (code !== 'turn-running') toast({ text: errorText(caught), tone: 'error' });
      },
    );
  };

  // Opening the tab switches an idle agent at once (once per visit); a running one waits for the developer's choice.
  useEffect(() => {
    if (state?.kind !== 'enter' || busy) return;
    if (!state.running && (!tried.current || waiting)) {
      tried.current = true;
      setWaiting(false);
      enter(false);
    }
    // `enter` is recreated each render; the state decides.
  }, [state?.kind, state?.kind === 'enter' ? state.running : null, waiting, busy]);

  if (!state) return null;
  if (state.kind === 'unavailable') {
    return (
      <div className="v2-ag-scroll">
        <div className="v2-ag-col">
          <EmptyState icon="cmd" tone="grey" title={W.title} text={state.text} testId="v2-agent-cli-unavailable" />
        </div>
      </div>
    );
  }
  if (state.kind === 'enter') {
    return (
      <div className="v2-ag-scroll">
        <div className="v2-ag-col v2-ag-cli-start" data-testid="v2-agent-cli-start">
          <p className="v2-muted">{W.intro}</p>
          {state.running ? (
            <>
              <p data-testid="v2-agent-cli-running">{waiting ? W.waiting : W.turnRunning}</p>
              <div className="v2-row">
                <Button disabled={waiting || busy !== null} onClick={() => setWaiting(true)} data-testid="v2-agent-cli-wait">
                  {W.wait}
                </Button>
                <Button variant="primary" disabled={busy !== null} onClick={() => enter(true)} data-testid="v2-agent-cli-stop-turn">
                  {W.stopTurn}
                </Button>
              </div>
            </>
          ) : (
            <Button variant="primary" icon="cmd" disabled={busy !== null} onClick={() => enter(false)} data-testid="v2-agent-cli-enter">
              {busy === 'enter' ? W.entering : W.enter}
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="v2-ag-cli" data-testid="v2-agent-cli" data-tour="v2-agent-cli">
      <div className="v2-ag-cli-bar">
        <Icon name="cmd" size="s" />
        <span className="v2-grow v2-muted">{W.title}</span>
        <Button
          size="sm"
          icon="chat"
          title={W.backHint}
          disabled={busy !== null}
          data-testid="v2-agent-cli-back-tab"
          onClick={() => {
            setBusy('back');
            api.leaveCliMode(sessionId).then(
              () => {
                setBusy(null);
                navigate(`/agents/${encodeURIComponent(sessionId)}`);
              },
              (caught: unknown) => {
                setBusy(null);
                toast({ text: errorText(caught), tone: 'error' });
              },
            );
          }}
        >
          {busy === 'back' ? W.backing : W.back}
        </Button>
      </div>
      <TerminalView machine={state.machine} id={state.terminalId} phone={phone} />
    </div>
  );
}
