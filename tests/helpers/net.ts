import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Ports tests may bind: 127.0.0.1:4871–4879. Never 4870, which the developer may
 * use for the real app.
 */
export const TEST_PORTS: readonly number[] = [4871, 4872, 4873, 4874, 4875, 4876, 4877, 4878, 4879];

/** Absolute repo root. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** `true` if nothing listens on 127.0.0.1:`port` right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** The test ports that are free right now, in order. */
export async function freeTestPorts(): Promise<number[]> {
  const free: number[] = [];
  for (const port of TEST_PORTS) {
    if (await isPortFree(port)) free.push(port);
  }
  return free;
}

/** Creates a temp folder (removed with {@link removeTempDir}). */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `switchboard-${prefix}-`));
}

/** Removes a temp folder made by {@link makeTempDir}. */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** A raw HTTP response. */
export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Options for {@link rawRequest}. */
export interface RawRequestOptions {
  port: number;
  path: string;
  method?: string;
  /** Sent verbatim, `host` included. */
  headers?: Record<string, string>;
  /** `false` sends no Host header at all. */
  setHost?: boolean;
  /** Connect to this address instead of 127.0.0.1. */
  connectHost?: string;
}

/** An HTTP/1.1 request over a real socket, with full control of the Host header. */
export function rawRequest(options: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: options.connectHost ?? '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        setHost: options.setHost ?? true,
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}
