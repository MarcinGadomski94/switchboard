import http from 'node:http';
import { freeTestPorts } from './net.ts';

/** A local HTTP server standing in for an embedded tool (M8.1 tests). */
export interface StubServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>/` */
  readonly url: string;
  /** Request paths received so far, in order. */
  readonly requests: string[];
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

/** What the stub does with a request. */
export type StubHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A tiny HTML page with `text` in its body. */
export function htmlPage(text: string): StubHandler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>${text}</title></head><body><h1 data-testid="stub">${text}</h1></body></html>`);
  };
}

/**
 * Starts a stub on 127.0.0.1 at the first free test port (tests/helpers/net.ts →
 * TEST_PORTS), or on `port` when given; retries the next port if a parallel test
 * took one.
 */
export async function startStubServer(handler: StubHandler, port?: number): Promise<StubServer> {
  const candidates = port === undefined ? await freeTestPorts() : [port];
  for (const candidate of candidates) {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      handler(req, res);
    });
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
      server.listen({ host: '127.0.0.1', port: candidate }, () => resolve(true));
    });
    if (!bound) continue;
    return {
      port: candidate,
      url: `http://127.0.0.1:${candidate}/`,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
  throw new Error(`no free test port for a stub server (${candidates.join(', ')})`);
}

/** A free test port nothing listens on right now (for "is not reachable"). */
export async function unusedTestPort(exclude: readonly number[] = []): Promise<number> {
  const port = (await freeTestPorts()).find((candidate) => !exclude.includes(candidate));
  if (port === undefined) throw new Error('no free test port');
  return port;
}
