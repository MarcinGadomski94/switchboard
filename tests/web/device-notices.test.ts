import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_EVENTS, type DeviceNotice, type DevicePresenceInput, PRESENCE_HEARTBEAT_MS } from '../../src/core/devices.ts';
import { type NoticeContext, SW_NOTICE_MESSAGE, noticeFromMessage, noticeSession, noticeToast, readNotice, shouldToast } from '../../src/web/toast/device-notice.ts';
import { PresenceReporter } from '../../src/web/pwa/presence.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): the
 * page's side. A paired device's open page reports whether it is in front, and
 * shows the push-worthy happenings as toasts (the `/hub` `notice`, or the
 * service worker's message), once per happening, for the kinds switched on.
 */

const NOTICE: DeviceNotice = { id: 'session-s1:abc:1', kind: 'turnFinished', title: 'web finished', body: 'The turn is done; the session is waiting for you.', url: '/sessions/s1', tag: 'session-s1' };
const DEVICE: NoticeContext = { device: true, events: DEFAULT_PUSH_EVENTS, viewing: null, hidden: false, seen: new Set() };

describe('D87 notice toasts', () => {
  it('a toast for every push-worthy kind on a paired device, the peers’ too', () => {
    for (const kind of ['permission', 'turnFinished', 'errors', 'inbox', 'review'] as const) {
      expect(shouldToast({ ...NOTICE, kind }, DEVICE), kind).toBe(true);
    }
    expect(shouldToast({ ...NOTICE, url: '/sessions/r~abcdefghijkl~s9' }, DEVICE)).toBe(true);
    expect(noticeToast(NOTICE)).toEqual({ id: 'session-s1:abc:1', title: 'web finished', sub: 'finished · now', branch: '', text: 'The turn is done; the session is waiting for you.', sessionId: 's1' });
    expect(noticeToast({ ...NOTICE, kind: 'permission', url: '/sessions/r~abcdefghijkl~s9' }).sessionId).toBe('r~abcdefghijkl~s9');
    expect(noticeToast({ ...NOTICE, kind: 'review', url: '/inbox' })).toMatchObject({ sub: 'ready for review · now', sessionId: null });
  });

  it('none on this machine’s UI, for a kind switched off, twice, for question batches (the question toast has them), or for the session on screen', () => {
    expect(shouldToast(NOTICE, { ...DEVICE, device: false })).toBe(false);
    expect(shouldToast(NOTICE, { ...DEVICE, events: { ...DEFAULT_PUSH_EVENTS, turnFinished: false } })).toBe(false);
    expect(shouldToast(NOTICE, { ...DEVICE, seen: new Set([NOTICE.id]) })).toBe(false);
    expect(shouldToast({ ...NOTICE, kind: 'questions' }, DEVICE)).toBe(false);
    expect(shouldToast(NOTICE, { ...DEVICE, viewing: 's1' })).toBe(false);
    // The session on screen, but the page is hidden (it came back to it later): toast.
    expect(shouldToast(NOTICE, { ...DEVICE, viewing: 's1', hidden: true })).toBe(true);
    expect(shouldToast(NOTICE, { ...DEVICE, viewing: 's2' })).toBe(true);
  });

  it('reads notices from the hub and from the service worker’s messages strictly', () => {
    expect(readNotice(NOTICE)).toEqual(NOTICE);
    expect(readNotice({ ...NOTICE, kind: 'test' })).toBeNull();
    expect(readNotice({ ...NOTICE, id: undefined })).toBeNull();
    expect(readNotice(null)).toBeNull();
    expect(noticeFromMessage({ type: SW_NOTICE_MESSAGE, notice: { ...NOTICE, extra: 1 } })).toEqual(NOTICE);
    expect(noticeFromMessage({ type: 'other', notice: NOTICE })).toBeNull();
    expect(noticeFromMessage('x')).toBeNull();
    expect(noticeSession({ ...NOTICE, url: '/sessions/a%20b' })).toBe('a b');
    expect(noticeSession({ ...NOTICE, url: '/inbox' })).toBeNull();
  });
});

describe('D87 presence reports', () => {
  function host(state: { visible: boolean; focused: boolean }) {
    const sent: Array<{ report: DevicePresenceInput; leaving: boolean }> = [];
    const timers: Array<{ run: () => void; ms: number; stopped: boolean }> = [];
    return {
      sent,
      timers,
      host: {
        visible: () => state.visible,
        focused: () => state.focused,
        send: (report: DevicePresenceInput, leaving: boolean) => void sent.push({ report, leaving }),
        every: (run: () => void, ms: number) => {
          const timer = { run, ms, stopped: false };
          timers.push(timer);
          return () => void (timer.stopped = true);
        },
      },
    };
  }

  it('reports changes, heartbeats every 30 s only while visible, and says hidden when the page goes', () => {
    const state = { visible: true, focused: true };
    const h = host(state);
    const reporter = new PresenceReporter(h.host, 'page-000000001');
    reporter.report(true);
    expect(h.sent).toEqual([{ report: { client: 'page-000000001', visible: true, focused: true }, leaving: false }]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(PRESENCE_HEARTBEAT_MS);
    // Nothing changed: no report; the heartbeat reports anyway.
    reporter.report();
    expect(h.sent).toHaveLength(1);
    h.timers[0]?.run();
    expect(h.sent).toHaveLength(2);
    // Blur, then hidden: reported; the heartbeat stops.
    state.focused = false;
    reporter.report();
    state.visible = false;
    reporter.report();
    expect(h.sent.slice(2).map((s) => s.report)).toEqual([
      { client: 'page-000000001', visible: true, focused: false },
      { client: 'page-000000001', visible: false, focused: false },
    ]);
    expect(h.timers[0]?.stopped).toBe(true);
    // Visible again: a new heartbeat.
    state.visible = true;
    reporter.report();
    expect(h.timers).toHaveLength(2);
    // The page unloads: hidden, with keepalive; the heartbeat stops.
    reporter.leave();
    expect(h.sent.at(-1)).toEqual({ report: { client: 'page-000000001', visible: false, focused: false }, leaving: true });
    expect(h.timers[1]?.stopped).toBe(true);
  });
});
