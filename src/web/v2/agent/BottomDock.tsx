import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, machineApi } from '../../api/client.ts';
import { Button, Segmented } from '../components/index.ts';
import { DOCK_WORDS as W } from '../glossary.ts';
import { TerminalView } from '../terminals/TerminalView.tsx';
import '../terminals/terminals.css';
import { type DockMode, type DockSettings, clampDockHeight, dockModes, loadDock, saveDock, showsTerminal, shownDockMode, toggledDockMode } from './bottom-dock.ts';
import { browserStorage } from './useAgent.ts';

/** The terminal's state: none yet, starting, running (its id), or failed (why). */
type AgentTerminal = { readonly kind: 'none' } | { readonly kind: 'starting' } | { readonly kind: 'open'; readonly id: string } | { readonly kind: 'failed'; readonly message: string };

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (typeof body?.message === 'string') return body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * D182 · the bottom of an agent's conversation (`docs/terminals.md` → *The agent's terminal*): tabs
 * **Message | Terminal**, and **Both** on a wider screen (the terminal above the message box, its
 * height dragged and remembered). The terminal is a D170 terminal in the agent's folder, started the
 * first time it is shown, kept while you stay in the conversation (switching back to Message only
 * hides it) and closed when you leave it. Ctrl+` shows or hides it. `children` is the message box,
 * kept mounted (its draft stays) while the terminal fills the bottom.
 */
export function BottomDock({ sessionId, phone, refusal, children }: { readonly sessionId: string; readonly phone: boolean; readonly refusal: string | null; readonly children: ReactNode }) {
  const [settings, setSettings] = useState<DockSettings>(() => loadDock(browserStorage()));
  const update = useCallback((next: DockSettings): void => {
    setSettings(next);
    saveDock(browserStorage(), next);
  }, []);
  const shown = shownDockMode(settings.mode, { phone, terminalRefusal: refusal });
  const [terminal, setTerminal] = useState<AgentTerminal>({ kind: 'none' });
  const openId = useRef<string | null>(null);

  // Started the first time the terminal is shown; closed when this conversation is left (unmount).
  const start = useCallback((): void => {
    setTerminal({ kind: 'starting' });
    api.openAgentTerminal(sessionId, { cols: 120, rows: 24 }).then(
      (info) => {
        openId.current = info.id;
        setTerminal({ kind: 'open', id: info.id });
      },
      (caught: unknown) => setTerminal({ kind: 'failed', message: errorText(caught) }),
    );
  }, [sessionId]);
  useEffect(() => {
    if (showsTerminal(shown) && terminal.kind === 'none') start();
  }, [shown, terminal.kind, start]);
  useEffect(
    () => () => {
      const id = openId.current;
      openId.current = null;
      // The server closes it by itself shortly after its last tab anyway (AGENT_TERMINAL_GRACE_MS).
      if (id) void machineApi(null).closeTerminal(id).catch(() => undefined);
    },
    [],
  );

  // Ctrl+`: the terminal when it isn't shown, the message box when it is.
  const modeRef = useRef(shown);
  modeRef.current = shown;
  useEffect(() => {
    if (refusal !== null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.code !== 'Backquote') return;
      event.preventDefault();
      update({ ...settings, mode: toggledDockMode(modeRef.current) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refusal, settings, update]);

  // Both: the terminal's height, dragged on the line between it and the message box.
  const box = useRef<HTMLDivElement | null>(null);
  const room = (): number => Math.max(160, (box.current?.closest('.v2-ag-body')?.clientHeight ?? window.innerHeight) - 220);
  const drag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const top = event.clientY;
    const from = settings.height;
    let last = from;
    const move = (e: PointerEvent): void => {
      // The line is under the terminal: dragging it down makes the terminal taller.
      last = clampDockHeight(from + (e.clientY - top), room());
      setSettings((current) => ({ ...current, height: last }));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      update({ ...settings, height: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const options = dockModes(phone).map((mode: DockMode) => ({
    value: mode,
    label: mode === 'message' ? W.message : mode === 'terminal' ? W.terminal : W.both,
    icon: mode === 'message' ? 'chat' : mode === 'terminal' ? 'cmd' : 'sheet',
    title: mode === 'terminal' ? W.terminalTitle : mode === 'both' ? W.bothTitle : undefined,
  }));
  const terminalShown = showsTerminal(shown);
  const height = shown === 'both' ? clampDockHeight(settings.height, room()) : undefined;
  return (
    <div className="v2-ag-bottom" ref={box} data-mode={shown} data-testid="v2-agent-bottom">
      {refusal === null ? (
        <div className="v2-ag-bottom-bar">
          <Segmented<DockMode> options={options} value={shown} onChange={(mode) => update({ ...settings, mode })} label={W.label} size="s" testId="v2-agent-dock-modes" tour="v2-agent-dock-terminal" />
        </div>
      ) : null}
      {terminal.kind !== 'none' ? (
        <div className="v2-ag-bottom-term" hidden={!terminalShown} style={height !== undefined ? { height } : undefined} data-testid="v2-agent-terminal">
          {terminal.kind === 'open' ? <TerminalView machine={null} id={terminal.id} phone={phone} /> : null}
          {terminal.kind === 'starting' ? <div className="v2-ag-bottom-note" role="status">{W.starting}</div> : null}
          {terminal.kind === 'failed' ? (
            <div className="v2-ag-bottom-note" role="alert" data-testid="v2-agent-terminal-error">
              {W.failed(terminal.message)}{' '}
              <Button size="sm" onClick={start}>
                {W.tryAgain}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {shown === 'both' ? <div className="v2-ag-bottom-handle" role="separator" aria-orientation="horizontal" aria-label={W.resize} onPointerDown={drag} data-testid="v2-agent-dock-handle" /> : null}
      <div className="v2-ag-bottom-message" hidden={shown === 'terminal'}>
        {children}
      </div>
    </div>
  );
}
