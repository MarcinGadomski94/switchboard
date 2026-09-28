import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The default test ports: 127.0.0.1:4871–4879. */
const DEFAULT_TEST_PORTS: readonly number[] = [4871, 4872, 4873, 4874, 4875, 4876, 4877, 4878, 4879];

/**
 * `SWITCHBOARD_TEST_PORTS` (`<first>-<last>` or a comma list) moves the range, e.g.
 * for a parallel lane that owns 4910–4919 (docs/lanes.md). Never 4870, which the
 * developer may use for the real app; anything unreadable is an error.
 */
export function testPortsFrom(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return DEFAULT_TEST_PORTS;
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
  const ports = range
    ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, i) => Number(range[1]) + i)
    : value.split(',').map((part) => Number(part.trim()));
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || port === 4870)) {
    throw new Error(`SWITCHBOARD_TEST_PORTS must be a port range or list without 4870, got "${value}"`);
  }
  return ports;
}

/**
 * Ports tests may bind: 127.0.0.1:4871–4879, or `SWITCHBOARD_TEST_PORTS`. Never
 * 4870, which the developer may use for the real app.
 */
export const TEST_PORTS: readonly number[] = testPortsFrom(process.env['SWITCHBOARD_TEST_PORTS']);

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
