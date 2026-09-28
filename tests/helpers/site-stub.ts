import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { selfSignedCertificate } from './self-signed.ts';

/**
 * D28: an https server on 127.0.0.1 (OS-assigned port, so it never competes for the
 * test port range) standing in for signed-in sites such as Jira. Its certificate is
 * self-signed for `names`; a test browser reaches it by those names through
 * Chromium's `--host-resolver-rules` and ignores the certificate error.
 */
export interface SiteStub {
  readonly port: number;
  /** Requests in arrival order: the Host header, path and `Sec-Fetch-Dest`. */
  readonly requests: Array<{ readonly host: string; readonly url: string; readonly dest: string | undefined }>;
  close(): Promise<void>;
}

/** Starts a {@link SiteStub} answering with `handler`. */
export async function startSiteStub(names: readonly string[], handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<SiteStub> {
  const { cert, key } = selfSignedCertificate(names);
  const requests: Array<{ host: string; url: string; dest: string | undefined }> = [];
  const server = https.createServer({ cert, key }, (req, res) => {
    const dest = req.headers['sec-fetch-dest'];
    requests.push({ host: req.headers.host ?? '', url: req.url ?? '', dest: typeof dest === 'string' ? dest : undefined });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
