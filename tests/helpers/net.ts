import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '../../src/server/config.ts';
import { stopServersUnder } from './server-registry.ts';

/**
 * The default test port range: 127.0.0.1:24000–27999. Wide enough for one slice per
 * Vitest worker ({@link WORKER_TEST_PORTS}), below the ephemeral ports Linux (from
 * 32768) and macOS / Windows (from 49152) hand out to outgoing connections, and far
 * from the real app's ports (13001–13003) and the 49xx ranges parallel lanes use.
 */
export const DEFAULT_TEST_PORT_RANGE = '24000-27999';

/**
 * `SWITCHBOARD_TEST_PORTS` (`<first>-<last>` or a comma list) moves the range, e.g.
 * for a parallel lane that owns 4900–4999 (docs/lanes.md). Never the real app's
 * port ({@link DEFAULT_PORT}); anything unreadable is an error.
 */
export function testPortsFrom(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return testPortsFrom(DEFAULT_TEST_PORT_RANGE);
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
  const ports = range
    ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, i) => Number(range[1]) + i)
    : value.split(',').map((part) => Number(part.trim()));
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || port === DEFAULT_PORT)) {
    throw new Error(`SWITCHBOARD_TEST_PORTS must be a port range or list without ${DEFAULT_PORT}, got "${value}"`);
  }
  return ports;
}

/**
 * Ports tests may bind: 127.0.0.1:24000–27999 ({@link DEFAULT_TEST_PORT_RANGE}), or
 * `SWITCHBOARD_TEST_PORTS`. Never the real app's port ({@link DEFAULT_PORT}). A test
 * picks from its worker's slice ({@link WORKER_TEST_PORTS}, through {@link freeTestPorts}).
 */
export const TEST_PORTS: readonly number[] = testPortsFrom(process.env['SWITCHBOARD_TEST_PORTS']);

/** A slice is at least this many ports; a range narrower than two slices is one slice every worker shares. */
const MIN_SLICE_PORTS = 25;
/** At most this many slices (more workers than that share slices round-robin). */
const MAX_SLICES = 64;

/**
 * The 1-based index of this test worker among the ones running at the same time:
 * Vitest's `VITEST_POOL_ID` (1…maxWorkers, unique among concurrent workers), else
 * Playwright's `TEST_PARALLEL_INDEX` (0-based) + 1, else `null` (a main process).
 */
export function testWorkerIndex(env: NodeJS.ProcessEnv = process.env): number | null {
  const pool = Number(env['VITEST_POOL_ID']);
  if (Number.isInteger(pool) && pool >= 1) return pool;
  const parallel = Number(env['TEST_PARALLEL_INDEX']);
  if (env['TEST_PARALLEL_INDEX'] !== undefined && env['TEST_PARALLEL_INDEX'] !== '' && Number.isInteger(parallel) && parallel >= 0) return parallel + 1;
  return null;
}

/**
 * Worker `index`'s own slice of `ports`: the range cut into equal slices of at least
 * {@link MIN_SLICE_PORTS} (at most {@link MAX_SLICES}), worker _n_ taking slice
 * _(n − 1) mod slices_. So test files that run in parallel never pick the same port:
 * one file's server can never answer at a port another file's server just left (a
 * paired machine "refused this pairing", a stub that is someone else's). `null` (no
 * worker): the whole range.
 */
export function workerSlice(ports: readonly number[], index: number | null): readonly number[] {
  if (index === null) return ports;
  const slices = Math.max(1, Math.min(MAX_SLICES, Math.floor(ports.length / MIN_SLICE_PORTS)));
  const width = Math.floor(ports.length / slices);
  const slice = (index - 1) % slices;
  return ports.slice(slice * width, (slice + 1) * width);
}

/** This worker's ports ({@link workerSlice} of {@link TEST_PORTS}); hand them to a nested run as its `SWITCHBOARD_TEST_PORTS`. */
export const WORKER_TEST_PORTS: readonly number[] = workerSlice(TEST_PORTS, testWorkerIndex());

/** `SWITCHBOARD_TEST_PORTS` for a child run that must stay inside this worker's slice (a nested Vitest run). */
export function workerTestPortsEnv(): string {
  return WORKER_TEST_PORTS.join(',');
}

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

/** Where the next {@link freeTestPorts} list starts in {@link WORKER_TEST_PORTS}. */
let cursor = 0;

/**
 * This worker's test ports that are free right now ({@link WORKER_TEST_PORTS}), in
 * rotating order: the list starts after the first port the previous call returned, so
 * a port this file just used (a server it stopped and may start again there, a peer's
 * address another server still dials) comes last, and two starts in a row do not race
 * for the same port. Take ports from the front.
 */
export async function freeTestPorts(): Promise<number[]> {
  const ports = WORKER_TEST_PORTS;
  const start = cursor % ports.length;
  const free: number[] = [];
  for (let i = 0; i < ports.length; i++) {
    const port = ports[(start + i) % ports.length] as number;
    if (await isPortFree(port)) free.push(port);
  }
  const first = free[0];
  if (first !== undefined) cursor = ports.indexOf(first) + 1;
  return free;
}

/** Creates a temp folder (removed with {@link removeTempDir}). */
export function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `switchboard-${prefix}-`));
}

/**
 * Removes a temp folder made by {@link makeTempDir}. First stops every test server
 * whose data folder is inside it (also one a timed-out test was still starting) and
 * refuses new ones there (tests/helpers/server-registry.ts).
 */
export async function removeTempDir(dir: string): Promise<void> {
  await stopServersUnder(dir);
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
