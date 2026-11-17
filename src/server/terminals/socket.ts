import type { WebSocket as WsSocket } from 'ws';
import { parseClientFrame } from '../../core/terminals.ts';
import type { TerminalService } from './service.ts';

/**
 * D170 · the terminal socket (`docs/terminals.md` → *The socket*): JSON text frames, the
 * browser's checked by {@link parseClientFrame} (anything malformed is dropped). Close codes:
 * 4404 the terminal is not there (or not this profile's), 4502 a paired computer could not be
 * reached, 1000 the terminal was closed.
 */

/** Close code: no such terminal for this profile. */
export const CLOSE_NOT_FOUND = 4404;
/** Close code: the paired computer could not be reached. */
export const CLOSE_PEER_UNREACHABLE = 4502;

/** Serves one socket for terminal `id` of this computer in scope `scope`. */
export function serveTerminalSocket(service: TerminalService, scope: string | null, id: string, socket: WsSocket): void {
  let detach: (() => void) | null = null;
  try {
    detach = service.attach(scope, id, {
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      },
      close: () => socket.close(1000, 'closed'),
    });
  } catch {
    socket.close(CLOSE_NOT_FOUND, 'not found');
    return;
  }
  socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const frame = parseClientFrame(buffer.toString('utf8'));
    if (!frame) return;
    try {
      if (frame.t === 'in') service.input(scope, id, frame.d);
      else service.resize(scope, id, frame.cols, frame.rows);
    } catch {
      socket.close(CLOSE_NOT_FOUND, 'not found');
    }
  });
  socket.on('close', () => detach?.());
  socket.on('error', () => detach?.());
}

/**
 * Pipes a browser's socket to a paired computer's terminal socket (`peer`, already open): text
 * frames both ways, unchanged (the paired computer checks the browser's frames itself), and each
 * side's close closes the other.
 */
export function pipeToPeer(browser: WsSocket, peer: WebSocket): void {
  peer.addEventListener('message', (event: MessageEvent) => {
    if (browser.readyState !== browser.OPEN) return;
    const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8');
    browser.send(data);
  });
  peer.addEventListener('close', (event: CloseEvent) => {
    if (browser.readyState === browser.OPEN || browser.readyState === browser.CONNECTING) browser.close(event.code >= 4000 || event.code === 1000 ? event.code : CLOSE_PEER_UNREACHABLE, event.reason || 'closed');
  });
  peer.addEventListener('error', () => {
    if (browser.readyState === browser.OPEN) browser.close(CLOSE_PEER_UNREACHABLE, 'peer error');
  });
  browser.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (peer.readyState !== peer.OPEN) return;
    const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    peer.send(buffer.toString('utf8'));
  });
  browser.on('close', () => {
    if (peer.readyState === peer.OPEN || peer.readyState === peer.CONNECTING) peer.close(1000, 'closed');
  });
}
