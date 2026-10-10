import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, HubEventName, Session } from '../../../src/core/api.ts';
import type { MachineState } from '../../../src/core/peers.ts';
import { PeerConnection, type PeerConnectionOptions, RECONNECT_MAX_MS, classifyFailure, reconnectDelay } from '../../../src/server/peers/client.ts';

/**
 * Fix · peer reconnects (`docs/peers.md` → *Connection states*): the connection's
 * state machine against a fake peer (a fetch that answers the hello, the session
 * list and an event stream the test controls): a drop → reconnecting → online, the
 * grace period → offline, a stalled stream, the backoff schedule and its cap,
 * wake / Reconnect now cutting the wait, and never two attempts at once.
 */

type Mode = 'up' | 'refused' | 'timeout' | 'unauthorized' | 'hang';

interface FakeStream {
  send(text: string): void;
  close(): void;
}

class FakePeer {
  mode: Mode = 'up';
  readonly hellos: number[] = [];
  readonly streams: FakeStream[] = [];
  /** The query of each `/peer/v1/events` request. */
  readonly streamQueries: string[] = [];
  #hung: Array<() => void> = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const signal = init?.signal ?? undefined;
    if (url.pathname === '/peer/v1/hello') {
      this.hellos.push(Date.now());
      if (this.mode === 'refused') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 100.64.0.7:13002'), { code: 'ECONNREFUSED' }) });
      if (this.mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (this.mode === 'unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (this.mode === 'hang') {
        await new Promise<void>((resolve) => this.#hung.push(resolve));
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      return Response.json({ id: 'abcdefghijkl', name: 'studio-pc', version: 'test' });
    }
    if (url.pathname === '/peer/v1/events') {
      this.streamQueries.push(url.search);
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const encoder = new TextEncoder();
      let open = true;
      this.streams.push({
        send: (text) => {
          if (open) controller.enqueue(encoder.encode(text));
        },
        close: () => {
          if (!open) return;
          open = false;
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.pathname === '/peer/v1/api/sessions' || url.pathname === '/peer/v1/api/inbox') return Response.json([]);
    return Response.json({ error: 'not-found' }, { status: 404 });
  }) as typeof fetch;

  /** Lets the hung hellos answer. */
  release(): void {
    for (const resolve of this.#hung.splice(0)) resolve();
  }

  get lastStream(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('no stream yet');
    return stream;
  }
}

const open: PeerConnection[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

function connect(peer: FakePeer, options: Partial<PeerConnectionOptions> = {}): { connection: PeerConnection; states: MachineState[] } {
  const states: MachineState[] = [];
  const connection = new PeerConnection({
    target: async () => ({ id: 'abcdefghijkl', address: '100.64.0.7:13002', token: 'token' }),
    ownAddress: () => null,
    onEvent: () => undefined,
    onState: (state) => states.push(state),
    onCache: () => undefined,
    onSeen: () => undefined,
    fetch: peer.fetch,
    jitter: 0,
    graceMs: 2_000,
    stallMs: 5_000,
    ...options,
  });
  open.push(connection);
  connection.start();
  return { connection, states };
}

async function until(what: string, check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('reconnectDelay: the backoff schedule', () => {
  it('waits 0 s, 1 s, 2 s, 5 s, 10 s, then 15 s for ever', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((failures) => reconnectDelay(failures, { jitter: 0 }))).toEqual([0, 1_000, 2_000, 5_000, 10_000, 15_000, 15_000, 15_000]);
    expect(RECONNECT_MAX_MS).toBe(15_000);
  });

  it('adds ±20 % jitter, never on the immediate attempt and never past the cap', () => {
    expect(reconnectDelay(0, { random: () => 1 })).toBe(0);
    expect(reconnectDelay(3, { random: () => 0 })).toBe(4_000);
    expect(reconnectDelay(3, { random: () => 1 })).toBe(6_000);
    expect(reconnectDelay(9, { random: () => 1 })).toBe(15_000);
    expect(reconnectDelay(9, { random: () => 0 })).toBe(12_000);
  });

  it('caps a custom schedule at its maximum', () => {
    expect([0, 1, 2, 3].map((failures) => reconnectDelay(failures, { schedule: [0, 50, 500], maxMs: 100, jitter: 0 }))).toEqual([0, 50, 100, 100]);
  });
});

describe('classifyFailure', () => {
  it('names refused, timeout, route and reset from the error or its cause', () => {
    const cause = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    expect(classifyFailure(cause('ECONNREFUSED'))).toBe('refused');
    expect(classifyFailure(cause('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout');
    expect(classifyFailure(new DOMException('timeout', 'TimeoutError'))).toBe('timeout');
    expect(classifyFailure(cause('EHOSTUNREACH'))).toBe('route');
    expect(classifyFailure(cause('ENOTFOUND'))).toBe('route');
    expect(classifyFailure(cause('ECONNRESET'))).toBe('reset');
    expect(classifyFailure(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))).toBe('reset');
    expect(classifyFailure(new Error('something else'))).toBe('other');
  });
});

describe('PeerConnection: connection states', () => {
  it('a new connection is reconnecting until its first attempt reaches the peer', async () => {
    const peer = new FakePeer();
    const { connection } = connect(peer);
    expect(connection.state).toBe('reconnecting');
    await until('online', () => connection.state === 'online');
    expect(connection.status).toMatchObject({ attempt: 0, trying: false, graceUntil: null });
  });

  it('a dropped stream: reconnecting at once (not offline), then online again with an immediate retry', async () => {
    const peer = new FakePeer();
    const { connection, states } = connect(peer);
    await until('online', () => connection.state === 'online');
    const dropped = Date.now();
    peer.lastStream.close();
    await until('reconnected', () => peer.streams.length === 2 && connection.state === 'online');
    expect(Date.now() - dropped).toBeLessThan(500);
    expect(states).toEqual(['online', 'reconnecting', 'online']);
    expect(states).not.toContain('offline');
    expect(connection.status.lastFailure?.kind).toBe('ended');
  });

  it('within the grace period failed attempts keep it reconnecting; after it, offline with the reason and the attempt count', async () => {
    const peer = new FakePeer();
    const { connection, states } = connect(peer, { graceMs: 300, schedule: [0, 40, 40], maxBackoffMs: 40 });
    await until('online', () => connection.state === 'online');
    peer.mode = 'refused';
    peer.lastStream.close();
    await until('reconnecting', () => connection.state === 'reconnecting');
    const since = Date.now();
    await until('a failed attempt', () => connection.status.attempt >= 2);
    expect(connection.state).toBe('reconnecting');
    expect(connection.status.graceUntil).not.toBeNull();
    expect(connection.status.lastFailure).toMatchObject({ kind: 'refused', message: expect.stringMatching(/^connection refused/) });
    await until('offline', () => connection.state === 'offline');
    expect(Date.now() - since).toBeGreaterThanOrEqual(200);
    expect(states).toEqual(['online', 'reconnecting', 'offline']);
    expect(connection.status.attempt).toBeGreaterThanOrEqual(3);
    expect(connection.lastError).toMatch(/connection refused/);
    // It keeps trying on the schedule: back as soon as the peer is.
    peer.mode = 'up';
    await until('online again', () => connection.state === 'online');
    expect(connection.status.attempt).toBe(0);
  });

  it('recovers within the grace period: never offline', async () => {
    const peer = new FakePeer();
    const { connection, states } = connect(peer, { graceMs: 1_000, schedule: [0, 50], maxBackoffMs: 50 });
    await until('online', () => connection.state === 'online');
    peer.mode = 'refused';
    peer.lastStream.close();
    await until('two failures', () => connection.status.attempt >= 2);
    peer.mode = 'up';
    await until('online again', () => connection.state === 'online' && peer.streams.length === 2);
    expect(states).toEqual(['online', 'reconnecting', 'online']);
  });

  it('a stalled stream (no event, no keepalive) is cut and reconnected; keepalives keep it open', async () => {
    const peer = new FakePeer();
    const { connection, states } = connect(peer, { stallMs: 150 });
    await until('online', () => connection.state === 'online');
    // Keepalives every 50 ms for 400 ms: no stall.
    for (let i = 0; i < 8; i++) {
      peer.lastStream.send(': keepalive\n\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(peer.streams).toHaveLength(1);
    expect(connection.state).toBe('online');
    // Then nothing: cut after 150 ms and reconnected (a new stream).
    await until('a second stream', () => peer.streams.length === 2, 2_000);
    await until('online', () => connection.state === 'online');
    expect(states).toEqual(['online', 'reconnecting', 'online']);
    expect(connection.status.lastFailure).toMatchObject({ kind: 'stalled' });
  });

  it('the waits between failed attempts follow the schedule up to its cap', async () => {
    const peer = new FakePeer();
    peer.mode = 'refused';
    connect(peer, { schedule: [0, 60, 120], maxBackoffMs: 180, graceMs: 10_000 });
    await until('five attempts', () => peer.hellos.length >= 5, 4_000);
    const gaps = peer.hellos.slice(1, 5).map((at, index) => at - (peer.hellos[index] as number));
    const expected = [60, 120, 180, 180];
    gaps.forEach((gap, index) => {
      expect(gap, `gap ${index}`).toBeGreaterThanOrEqual((expected[index] as number) - 5);
      expect(gap, `gap ${index}`).toBeLessThan((expected[index] as number) + 120);
    });
  });

  it('a 401 is auth failed at once (no grace)', async () => {
    const peer = new FakePeer();
    peer.mode = 'unauthorized';
    const { connection } = connect(peer);
    await until('auth failed', () => connection.state === 'auth-failed');
    expect(connection.status.lastFailure?.kind).toBe('auth');
  });

  it('every recent failure a timeout: the status keeps them for the hint', async () => {
    const peer = new FakePeer();
    peer.mode = 'timeout';
    const { connection } = connect(peer, { schedule: [0, 10], maxBackoffMs: 10, graceMs: 100 });
    await until('offline', () => connection.state === 'offline' && connection.status.recentFailures.length >= 3);
    expect(new Set(connection.status.recentFailures)).toEqual(new Set(['timeout']));
  });
});

describe('PeerConnection: wake and Reconnect now', () => {
  it('wake() cuts the wait before the next attempt', async () => {
    const peer = new FakePeer();
    peer.mode = 'refused';
    const { connection } = connect(peer, { schedule: [0, 60_000], maxBackoffMs: 60_000, graceMs: 100 });
    await until('the first attempt failed', () => peer.hellos.length === 1 && !connection.status.trying && connection.status.nextAttemptAt !== null);
    expect((connection.status.nextAttemptAt as number) - Date.now()).toBeGreaterThan(50_000);
    connection.wake();
    await until('a second attempt', () => peer.hellos.length === 2, 1_000);
  });

  it('Reconnect now from offline: tries at once and answers online once the peer is back', async () => {
    const peer = new FakePeer();
    const { connection } = connect(peer, { schedule: [0, 60_000], maxBackoffMs: 60_000, graceMs: 100 });
    await until('online', () => connection.state === 'online');
    peer.mode = 'refused';
    peer.lastStream.close();
    await until('offline', () => connection.state === 'offline' && !connection.status.trying);
    // Still down: the attempt runs and answers offline with the reason.
    expect(await connection.reconnectNow()).toBe('offline');
    expect(connection.status.lastFailure?.kind).toBe('refused');
    peer.mode = 'up';
    const asked = Date.now();
    expect(await connection.reconnectNow()).toBe('online');
    expect(Date.now() - asked).toBeLessThan(1_000);
  });

  it('never runs two attempts at once: Reconnect now joins the attempt in flight', async () => {
    const peer = new FakePeer();
    peer.mode = 'hang';
    const { connection } = connect(peer, { graceMs: 10_000 });
    await until('the attempt runs', () => peer.hellos.length === 1 && connection.status.trying);
    const answers = Promise.all([connection.reconnectNow(), connection.reconnectNow(), connection.reconnectNow()]);
    connection.wake();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(peer.hellos).toHaveLength(1);
    peer.mode = 'up';
    peer.release();
    expect(await answers).toEqual(['online', 'online', 'online']);
    expect(peer.hellos).toHaveLength(1);
  });

  it('whenSettled holds while reconnecting and resolves when it is back', async () => {
    const peer = new FakePeer();
    const { connection } = connect(peer, { schedule: [0, 100], maxBackoffMs: 100, graceMs: 5_000 });
    await until('online', () => connection.state === 'online');
    peer.mode = 'refused';
    peer.lastStream.close();
    await until('reconnecting', () => connection.state === 'reconnecting');
    const held = connection.whenSettled(3_000);
    setTimeout(() => {
      peer.mode = 'up';
    }, 150);
    expect(await held).toBe('online');
    // Settled states answer at once; a hold never outlasts its limit.
    expect(await connection.whenSettled(10)).toBe('online');
  });
});

describe('PeerConnection: agent deltas (D95 follow-up, docs/performance.md → Agent deltas)', () => {
  const agent = (id: string, status: Agent['status']): Agent => ({ id, kind: id === 'main' ? 'main' : 'subagent', name: id, description: null, solutionPath: null, branch: null, status, statusText: null, toolUseId: null, workflow: null });
  const frame = (session: unknown): string => `event: sessionUpdated\ndata: ${JSON.stringify(session)}\n\n`;

  it('asks for deltas and hands on whole lists; a new stream starts over; an older peer\'s whole lists pass as they are', async () => {
    const peer = new FakePeer();
    const seen: Session[] = [];
    const { connection } = connect(peer, {
      onEvent: (name: HubEventName, payload: unknown) => {
        if (name === 'sessionUpdated') seen.push(payload as Session);
      },
    });
    await until('online', () => connection.state === 'online');
    expect(peer.streamQueries[0]).toBe('?delta=1');
    const base = { id: 's1', name: 's1', status: 'run' };
    peer.lastStream.send(frame({ ...base, loops: [{ id: 'l1' }], agents: [agent('main', 'run'), agent('a', 'run'), agent('b', 'done')] }));
    peer.lastStream.send(frame({ ...base, agents: [agent('a', 'done')], agentsDelta: { removed: [] }, unchanged: ['loops'] }));
    peer.lastStream.send(frame({ ...base, agents: [agent('c', 'run')], agentsDelta: { removed: ['b'], order: ['main', 'a', 'c'] } }));
    await until('three updates', () => seen.length === 3);
    expect(seen.map((s) => s.agents.map((a) => `${a.id}:${a.status}`))).toEqual([
      ['main:run', 'a:run', 'b:done'],
      ['main:run', 'a:done', 'b:done'],
      ['main:run', 'a:done', 'c:run'],
    ]);
    expect(seen.every((s) => s.agentsDelta === undefined && s.unchanged === undefined)).toBe(true);
    // D95-q3: a field named unchanged keeps its previous value.
    expect(seen[1]?.loops).toEqual([{ id: 'l1' }]);
    // The cache behind the peer's session list holds the whole list too.
    expect(connection.sessions.find((s) => s.id === 's1')?.agents.map((a) => a.id)).toEqual(['main', 'a', 'c']);
    // A new stream: its first update is whole again (an older peer sends only whole ones).
    peer.lastStream.close();
    await until('a second stream', () => peer.streams.length === 2 && connection.state === 'online');
    peer.lastStream.send(frame({ ...base, agents: [agent('main', 'done')] }));
    peer.lastStream.send(frame({ ...base, agents: [agent('main', 'done'), agent('d', 'run')] }));
    await until('five updates', () => seen.length === 5);
    expect(seen.slice(3).map((s) => s.agents.map((a) => a.id))).toEqual([['main'], ['main', 'd']]);
  });
});
