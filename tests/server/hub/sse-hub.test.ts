import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../../src/core/api.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { KEEPALIVE_FRAME, SseHub, type SseHubOptions, formatEvent } from '../../../src/server/hub/hub.ts';
import { forwardServiceEvents } from '../../../src/server/hub/wire.ts';
import { freeTestPorts, rawRequest } from '../../helpers/net.ts';
import { openHub } from '../../helpers/sse.ts';

/** Unit tests of the bus, the SSE framing and the hub's edge cases (the contract oracle is hub.test.ts). */

describe('HubBus', () => {
  it('delivers each publish to every subscriber in order; a throwing listener is reported, not propagated; unsubscribe stops delivery', () => {
    const errors: unknown[] = [];
    const bus = new HubBus({ onError: (error) => errors.push(error) });
    const a: HubMessage[] = [];
    const b: HubMessage[] = [];
    const offA = bus.subscribe((m) => a.push(m));
    bus.subscribe(() => {
      throw new Error('listener broke');
    });
    bus.subscribe((m) => b.push(m));
    expect(bus.listenerCount).toBe(3);

    bus.publish('inboxChanged', { count: 2 });
    bus.publish('scheduleRun', { scheduleId: 'x', result: 'ok' });
    expect(a).toEqual([
      { name: 'inboxChanged', payload: { count: 2 } },
      { name: 'scheduleRun', payload: { scheduleId: 'x', result: 'ok' } },
    ]);
    expect(b).toEqual(a);
    expect(errors).toHaveLength(2);

    offA();
    bus.publish('inboxChanged', { count: 0 });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
  });

  it('forwardServiceEvents: supervisor sessionUpdated/event and worktrees worktreeRemovable go to the bus unchanged, until stopped', () => {
    type Fn = (payload: never) => void;
    const listeners = new Map<string, Set<Fn>>();
    const on = (name: string, listener: Fn): (() => void) => {
      const set = listeners.get(name) ?? new Set<Fn>();
      listeners.set(name, set);
      set.add(listener);
      return () => set.delete(listener);
    };
    const emit = (name: string, payload: unknown): void => {
      for (const listener of listeners.get(name) ?? []) (listener as (p: unknown) => void)(payload);
    };
    const bus = new HubBus();
    const seen: HubMessage[] = [];
    bus.subscribe((m) => seen.push(m));
    const stop = forwardServiceEvents(bus, { supervisor: { on } as never, worktrees: { on } as never });
    emit('sessionUpdated', { id: 's' });
    emit('event', { sessionId: 's', event: { id: 1 } });
    emit('worktreeRemovable', { id: 'w' });
    expect(seen.map((m) => [m.name, m.payload])).toEqual([
      ['sessionUpdated', { id: 's' }],
      ['event', { sessionId: 's', event: { id: 1 } }],
      ['worktreeRemovable', { id: 'w' }],
    ]);
    stop();
    emit('sessionUpdated', { id: 's' });
    expect(seen).toHaveLength(3);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});

describe('SSE framing', () => {
  it('one event = `event:` line, one `data:` line of JSON, blank line; line breaks inside strings stay escaped', () => {
    expect(formatEvent('inboxChanged', { count: 4 })).toBe('event: inboxChanged\ndata: {"count":4}\n\n');
    const frame = formatEvent('questionBatch', { sessionId: 's', batchId: 'b', questions: [{ text: 'a\nb\r\nc d' }] });
    expect(frame.split('\n')).toHaveLength(4);
    expect(frame).not.toContain('\r');
    expect(JSON.parse(frame.split('\n')[1]!.slice('data: '.length))).toEqual({ sessionId: 's', batchId: 'b', questions: [{ text: 'a\nb\r\nc d' }] });
    expect(KEEPALIVE_FRAME).toBe(': keepalive\n\n');
  });
});

// ── the hub on a plain node:http server (no Fastify), on a 4871–4879 test port ──

const servers: http.Server[] = [];
const hubs: SseHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(options: Omit<SseHubOptions, 'bus'> = {}): Promise<{ hub: SseHub; bus: HubBus; port: number; errors: unknown[] }> {
  const errors: unknown[] = [];
  const bus = new HubBus();
  const hub = new SseHub({ bus, onError: (error) => errors.push(error), ...options });
  hubs.push(hub);
  const server = http.createServer((_req, res) => hub.attach(res));
  for (const port of await freeTestPorts()) {
    const bound = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
      server.listen({ host: '127.0.0.1', port }, () => resolve(true));
    });
    if (bound) {
      servers.push(server);
      return { hub, bus, port, errors };
    }
  }
  throw new Error('no free test port in 4871-4879');
}

const INFO: SystemInfo = { cli: null, cliVersion: null, signedIn: false, ghSignedIn: false, cpu: 1, ramUsed: 2, ramTotal: 3, processes: 0, usagePct: 40 };

describe('SseHub', () => {
  it('refuses new clients with 503 once closed', async () => {
    const { hub, port } = await serve();
    hub.close();
    const response = await rawRequest({ port, path: '/hub' });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: 'closing' });
    expect(hub.closed).toBe(true);
  });

  it('drops a client that stops reading once its unsent output passes the cap; others keep receiving', async () => {
    const { hub, bus, port } = await serve({ maxBufferedBytes: 256 * 1024, keepaliveMs: 60_000 });
    const reader = await openHub({ port });
    const stalled = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/hub', agent: false }, (res) => {
        res.pause();
        resolve(res);
      });
      req.once('error', reject);
      req.end();
    });
    expect(hub.clientCount).toBe(2);
    const big = 'x'.repeat(16 * 1024);
    const deadline = Date.now() + 10_000;
    let sent = 0;
    while (hub.clientCount === 2 && Date.now() < deadline) {
      bus.publish('scheduleRun', { scheduleId: big, result: 'ok' });
      sent += 1;
      await new Promise((r) => setImmediate(r));
    }
    expect(hub.clientCount).toBe(1);
    stalled.destroy();
    await reader.waitFor((p) => p.messages.length >= sent, `${sent} messages on the reading client`);
    reader.close();
  });

  it('system: a failing provider is reported and the stream stays open; a slow one is never asked twice at once', async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const { hub, port, errors } = await serve({
      systemIntervalMs: 40,
      keepaliveMs: 60_000,
      system: {
        async system() {
          calls += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 150));
          inFlight -= 1;
          if (calls === 1) throw new Error('metrics unavailable');
          return INFO;
        },
      },
    });
    expect(calls).toBe(0);
    const stream = await openHub({ port });
    await stream.waitFor((p) => p.messages.length >= 2, '2 system events', 5_000);
    expect(errors.map((e) => (e as Error).message)).toEqual(['metrics unavailable']);
    expect(maxInFlight).toBe(1);
    for (const payload of stream.payloads<SystemInfo>('system')) expect(payload).toEqual(INFO);
    expect(hub.clientCount).toBe(1);
    stream.close();
  });
});
