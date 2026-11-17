import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { TerminalInfo, TerminalServerFrame } from '../../../core/terminals.ts';
import { terminalSocketUrl } from '../../api/client.ts';
import { TERMINAL_WORDS as W } from '../glossary.ts';
import { ctrlOf, keySequence, type TerminalKey } from './terminal-keys.ts';

/** The socket's state as the page shows it. */
export type TerminalLink = 'connecting' | 'open' | 'reconnecting' | 'gone' | 'unreachable';

/**
 * D170 · one terminal in the browser (`docs/terminals.md` → *The page*): xterm.js fitted to its
 * box, the socket (reconnects after a drop; a closed terminal stays closed), the program's exit,
 * copy / paste (Ctrl+Shift+C / V, ⌘C / ⌘V on a Mac; plain Ctrl+C goes to the program), links
 * clickable, and on a phone a key bar (Esc, Tab, a sticky Ctrl, arrows, ^C).
 */
export function TerminalView({ machine, id, phone, onInfo, onLink }: { readonly machine: string | null; readonly id: string; readonly phone: boolean; readonly onInfo?: (info: TerminalInfo) => void; readonly onLink?: (link: TerminalLink) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const send = useRef<(data: string) => void>(() => undefined);
  const term = useRef<Terminal | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const styles = getComputedStyle(element);
    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: styles.getPropertyValue('--v2-mono').trim() || 'ui-monospace, monospace',
      fontSize: phone ? 12 : 13,
      scrollback: 5000,
      allowProposedApi: false,
      theme: { background: styles.getPropertyValue('--v2-term-bg').trim() || '#121214', foreground: styles.getPropertyValue('--v2-term-fg').trim() || '#cfd3dc' },
    });
    term.current = xterm;
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    xterm.open(element);
    const fitNow = (): void => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    };
    fitNow();

    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const frame = (value: unknown): void => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    send.current = (data) => frame({ t: 'in', d: data });
    const connect = (again: boolean): void => {
      onLink?.(again ? 'reconnecting' : 'connecting');
      socket = new WebSocket(terminalSocketUrl(machine, id));
      socket.addEventListener('open', () => {
        onLink?.('open');
        frame({ t: 'resize', cols: xterm.cols, rows: xterm.rows });
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        let message: TerminalServerFrame;
        try {
          message = JSON.parse(String(event.data)) as TerminalServerFrame;
        } catch {
          return;
        }
        if (message.t === 'hello') {
          xterm.reset();
          xterm.write(message.scrollback);
          onInfo?.(message.info);
        } else if (message.t === 'out') xterm.write(message.d);
        else if (message.t === 'exit') xterm.write(`\r\n\x1b[2m[${W.exited(message.code)}]\x1b[0m\r\n`);
        else if (message.t === 'closed') {
          stopped = true;
          onLink?.('gone');
        }
      });
      socket.addEventListener('close', (event: CloseEvent) => {
        if (stopped) return;
        // 1000 closed / 4404 not there: the terminal is gone; 4502 the paired computer is away; else a drop: try again.
        if (event.code === 1000 || event.code === 4404) {
          stopped = true;
          onLink?.('gone');
          return;
        }
        onLink?.(event.code === 4502 ? 'unreachable' : 'reconnecting');
        retry = setTimeout(() => connect(true), 1500);
      });
    };
    connect(false);

    const typed = xterm.onData((data) => {
      // A phone's sticky Ctrl turns the next letter into its control character.
      if (ctrlRef.current && data.length === 1) {
        setCtrl(false);
        send.current(ctrlOf(data));
        return;
      }
      send.current(data);
    });
    const resized = xterm.onResize(({ cols, rows }) => frame({ t: 'resize', cols, rows }));
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const copy = (event.ctrlKey && event.shiftKey && event.code === 'KeyC') || (event.metaKey && event.code === 'KeyC');
      const paste = (event.ctrlKey && event.shiftKey && event.code === 'KeyV') || (event.metaKey && event.code === 'KeyV');
      if (copy) {
        const selection = xterm.getSelection();
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
        return false;
      }
      if (paste) {
        void navigator.clipboard?.readText().then((text) => xterm.paste(text), () => undefined);
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(element);
    xterm.focus();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      socket?.close(1000);
      xterm.dispose();
      term.current = null;
    };
    // The terminal is created once per (machine, id); the callbacks are read when they fire.
  }, [machine, id]);

  const press = (key: TerminalKey): void => {
    if (key === 'ctrl') {
      setCtrl((on) => !on);
      return;
    }
    send.current(keySequence(key));
    term.current?.focus();
  };

  return (
    <div className="v2-terminal" data-testid="v2-terminal">
      <div ref={box} className="v2-terminal-screen" data-testid="v2-terminal-screen" />
      {phone ? (
        <div className="v2-terminal-keys" role="toolbar" aria-label="Terminal keys" data-testid="v2-terminal-keys">
          {(['esc', 'tab', 'ctrl', 'up', 'down', 'left', 'right', 'ctrlC'] as const).map((key) => (
            <button key={key} type="button" className="v2-terminal-key" aria-pressed={key === 'ctrl' ? ctrl : undefined} onPointerDown={(event) => event.preventDefault()} onClick={() => press(key)} data-testid={`v2-terminal-key-${key}`}>
              {W.keys[key]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
