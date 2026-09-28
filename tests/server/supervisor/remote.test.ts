import { describe, expect, it } from 'vitest';
import type { RemotePayload } from '../../../src/core/event-payload.ts';
import type { ControlRequestLine } from '../../../src/core/stdin.ts';
import type { ControlResponseMessage } from '../../../src/core/stream-json.ts';
import type { SessionPatch, SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { LiveRemote, RemoteControlError, type RemoteHost } from '../../../src/server/supervisor/remote.ts';

/**
 * D24 unit oracle for `LiveRemote` (src/server/supervisor/remote.ts) against a
 * stub host: the cases fake-claude does not reach easily (a failed "off", a
 * process that ends mid-request, a stored entry that cannot be reattached, the
 * `answeredOn` rule, one step at a time). The real path is
 * tests/server/api/remote-control.test.ts.
 */

type Reply = Pick<ControlResponseMessage, 'subtype' | 'response' | 'error'> | null;

function response(requestId: string, reply: NonNullable<Reply>): ControlResponseMessage {
  return { kind: 'control-response', raw: {}, uuid: null, sessionId: null, requestId, ...reply };
}

interface Stub {
  readonly host: RemoteHost;
  readonly sent: ControlRequestLine[];
  readonly events: Array<{ kind: string; label: string; payload: RemotePayload }>;
  readonly session: { value: Partial<SessionRecord> };
  /** Replies by request subtype (`initialize`, `remote_control`), used in order; a function sees the line. */
  readonly replies: Array<(line: ControlRequestLine) => Reply | Promise<Reply>>;
  current: boolean;
  published: number;
}

function stub(session: Partial<SessionRecord> = {}): Stub {
  const state: Stub = {
    sent: [],
    events: [],
    session: { value: { id: 's1', name: 'remote-demo', title: 'Remote from the phone', remoteEnabled: false, remoteBridgeId: null, remoteSessionUrl: null, ...session } },
    replies: [],
    current: true,
    published: 0,
    host: undefined as unknown as RemoteHost,
  };
  const host: RemoteHost = {
    request: async (line: ControlRequestLine) => {
      state.sent.push(line);
      const next = state.replies.shift();
      const reply = next ? await next(line) : null;
      return reply ? response(line.request_id, reply) : null;
    },
    session: async () => state.session.value as SessionRecord,
    update: async (patch: SessionPatch) => {
      state.session.value = { ...state.session.value, ...patch };
    },
    record: async (kind, label, payload) => {
      state.events.push({ kind, label, payload });
    },
    publish: async () => {
      state.published += 1;
    },
    current: () => state.current,
  };
  return Object.assign(state, { host });
}

const INIT_OK = (): Reply => ({ subtype: 'success', response: { remote_control_available: true }, error: null });
const ON_OK = (id = 'X1'): (() => Reply) => () => ({
  subtype: 'success',
  response: { session_url: `https://claude.ai/code/session_${id}`, bridge_session_id: `cse_${id}` },
  error: null,
});

async function ready(s: Stub): Promise<LiveRemote> {
  s.replies.push(INIT_OK);
  const remote = new LiveRemote(s.host);
  await remote.handshake();
  return remote;
}

describe('LiveRemote (D24)', () => {
  it('handshake: initialize is written at once; no reply (or an error) means not available', async () => {
    const s = stub();
    const remote = new LiveRemote(s.host);
    const done = remote.handshake();
    expect(s.sent.map((line) => line.request.subtype)).toEqual(['initialize']);
    await done;
    expect(remote.available).toBe(false);
    expect(s.session.value.remoteAvailable).toBe(false);
    expect(s.published).toBe(1);

    const t = stub();
    t.replies.push(() => ({ subtype: 'error', response: null, error: 'nope' }));
    const other = new LiveRemote(t.host);
    await other.handshake();
    expect(other.available).toBe(false);
  });

  it('answeredOn: claude.ai only while the bridge is on (or starting) and Switchboard is not stopping the process', async () => {
    const s = stub();
    const remote = await ready(s);
    expect(remote.answeredOn()).toBeNull();
    s.replies.push(ON_OK());
    await remote.set(true);
    expect(remote.bridge).toBe('on');
    expect(remote.answeredOn()).toBe('claude.ai');
    s.current = false;
    expect(remote.answeredOn()).toBeNull();
  });

  it('a failed "off" keeps Remote on, records the CLI text and throws it verbatim', async () => {
    const s = stub();
    const remote = await ready(s);
    s.replies.push(ON_OK());
    await remote.set(true);
    s.replies.push(() => ({ subtype: 'error', response: null, error: 'bridge teardown failed: 503' }));
    await expect(remote.set(false)).rejects.toEqual(new RemoteControlError('remote-failed', 'bridge teardown failed: 503'));
    expect(s.session.value.remoteEnabled).toBe(true);
    expect(remote.bridge).toBe('on');
    expect(s.events.at(-1)).toEqual({
      kind: 'error',
      label: 'Remote Control could not be turned off: bridge teardown failed: 503',
      payload: { type: 'remote', action: 'failed', enabled: false, error: 'bridge teardown failed: 503' },
    });
  });

  it('"off" while the process ends: its bridge ended with it, so Remote is off as asked', async () => {
    const s = stub();
    const remote = await ready(s);
    s.replies.push(ON_OK());
    await remote.set(true);
    s.replies.push(() => {
      s.current = false;
      return null;
    });
    await remote.set(false);
    expect(s.session.value.remoteEnabled).toBe(false);
    expect(s.events.at(-1)?.label).toBe('Remote Control off');
  });

  it('a stored entry that cannot be reattached is dropped (the next "on" starts a new one); never retried', async () => {
    const s = stub({ remoteBridgeId: 'cse_OLD', remoteSessionUrl: 'https://claude.ai/code/session_OLD' });
    const remote = await ready(s);
    s.replies.push(() => ({ subtype: 'error', response: null, error: 'session cse_OLD is archived' }));
    await expect(remote.set(true)).rejects.toThrow('session cse_OLD is archived');
    expect(s.sent.at(-1)?.request).toMatchObject({ reattach_session_id: 'cse_OLD' });
    expect(s.sent.filter((line) => line.request.subtype === 'remote_control')).toHaveLength(1);
    expect(s.session.value).toMatchObject({ remoteEnabled: false, remoteBridgeId: null, remoteSessionUrl: null });
    s.replies.push(ON_OK('NEW'));
    await remote.set(true);
    expect(s.sent.at(-1)?.request).not.toHaveProperty('reattach_session_id');
    expect(s.session.value).toMatchObject({ remoteEnabled: true, remoteBridgeId: 'cse_NEW', remoteSessionUrl: 'https://claude.ai/code/session_NEW' });
  });

  it('a reply without bridge_session_id keeps the id it reattached (same entry); refused when not available or not live', async () => {
    const s = stub({ remoteBridgeId: 'cse_KEEP' });
    const remote = await ready(s);
    s.replies.push(() => ({ subtype: 'success', response: { session_url: 'https://claude.ai/code/session_KEEP' }, error: null }));
    await remote.set(true);
    expect(s.session.value.remoteBridgeId).toBe('cse_KEEP');

    const unavailable = stub();
    unavailable.replies.push(() => ({ subtype: 'success', response: { remote_control_available: false }, error: null }));
    const off = new LiveRemote(unavailable.host);
    await off.handshake();
    await expect(off.set(true)).rejects.toMatchObject({ code: 'remote-unavailable' });
    expect(unavailable.sent.map((line) => line.request.subtype)).toEqual(['initialize']);
    unavailable.current = false;
    await expect(off.set(true)).rejects.toMatchObject({ code: 'not-live' });
  });

  it('one step at a time: a toggle waits for the handshake (and its reattach)', async () => {
    const s = stub({ remoteEnabled: true, remoteBridgeId: 'cse_R' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.replies.push(async () => {
      await gate;
      return INIT_OK();
    });
    s.replies.push(ON_OK('R'));
    const remote = new LiveRemote(s.host);
    const handshake = remote.handshake();
    const toggle = remote.set(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.sent.map((line) => line.request.subtype)).toEqual(['initialize']);
    s.replies.splice(1, 0, () => ({ subtype: 'success', response: {}, error: null }));
    release();
    await handshake;
    await toggle;
    expect(s.sent.map((line) => [line.request.subtype, line.request['enabled'] ?? null, line.request['reattach_session_id'] ?? null])).toEqual([
      ['initialize', null, null],
      ['remote_control', true, 'cse_R'],
      ['remote_control', false, null],
    ]);
    expect(s.events.map((event) => event.label)).toEqual(['Remote Control on again · https://claude.ai/code/session_R', 'Remote Control off']);
  });

  it('a stop that cuts the reattach short changes nothing (the next process tries again)', async () => {
    const s = stub({ remoteEnabled: true, remoteBridgeId: 'cse_R' });
    s.replies.push(INIT_OK);
    s.replies.push(() => {
      s.current = false;
      return null;
    });
    const remote = new LiveRemote(s.host);
    await remote.handshake();
    expect(s.session.value.remoteEnabled).toBe(true);
    expect(s.events).toEqual([]);
  });
});
