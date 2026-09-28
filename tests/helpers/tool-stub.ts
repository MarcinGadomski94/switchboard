import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Stub tools for the framing-proxy tests (D15): an HTTP server on 127.0.0.1 with
 * an OS-assigned port (so it never competes for the test port range), which
 * records every request (headers and body included) and can accept WebSocket
 * upgrades with a tiny echo server.
 */

/** One request the stub received. */
export interface StubRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** A running stub tool. */
export interface ToolStub {
  readonly port: number;
  /** `http://127.0.0.1:<port>` (no trailing slash). */
  readonly origin: string;
  /** Requests (and upgrade requests) in arrival order. */
  readonly requests: StubRequest[];
  close(): Promise<void>;
}

/** What the stub answers; `body` is the request body read in full. */
export type ToolStubHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** Options for {@link startToolStub}. */
export interface ToolStubOptions {
  /** Upgrade requests: `true` accepts WebSockets with {@link acceptEchoWebSocket}; default refuses with 426 via the handler. */
  readonly webSocketEcho?: boolean;
}

/** Starts a stub tool on 127.0.0.1 with an OS-assigned port. */
export async function startToolStub(handler: ToolStubHandler, options: ToolStubOptions = {}): Promise<ToolStub> {
  const requests: StubRequest[] = [];
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
    if (options.webSocketEcho) acceptEchoWebSocket(req, socket);
    else socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A small HTML page (`<h1 data-testid="stub">text</h1>`) with extra `headers`. */
export function htmlAnswer(text: string, headers: Record<string, string | string[]> = {}): ToolStubHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(`<!doctype html><html><head><title>${text}</title></head><body><h1 data-testid="stub">${text}</h1></body></html>`);
  };
}

/** One unmasked server → client text frame. */
function textFrame(text: string): Buffer {
  const data = Buffer.from(text, 'utf8');
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

/**
 * Completes a WebSocket handshake on `socket` (RFC 6455) and answers every text
 * message with `echo: <message>`; a close frame is answered and ends the socket.
 */
export function acceptEchoWebSocket(req: http.IncomingMessage, socket: Duplex): void {
  const key = String(req.headers['sec-websocket-key'] ?? '');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = buffer.subarray(offset, offset + maskLength);
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
      buffer = buffer.subarray(offset + maskLength + length);
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (opcode === 0x1) socket.write(textFrame(`echo: ${payload.toString('utf8')}`));
    }
  });
}
