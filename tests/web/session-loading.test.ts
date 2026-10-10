import { describe, expect, it } from 'vitest';
import type { SessionDetail, SessionEvent } from '../../src/core/api.ts';
import {
  CACHE_EVENT_BUDGET,
  CHAT_EVENTS_PAGE,
  LOADING_SESSION,
  NOTHING_LOADING,
  PLACEHOLDER_DELAY_MS,
  PlaceholderDelay,
  SESSION_CACHE_LIMIT,
  SessionCache,
  type Timers,
  anyLoading,
  loadingParts,
  inWindow,
  mergeFetchedEvents,
  pageCursor,
  sessionCache,
  trimWindow,
  withOlderPage,
} from '../../src/web/views/session/session-loading.ts';

/**
 * D45 · loading a session (src/web/views/session/session-loading.ts,
 * docs/session-panel.md → *Loading a session*): the ~150 ms delay with injected
 * timers, which parts wait, the in-memory cache (size, order, `/hub` events of
 * sessions not on screen) and the merge of a fetch with the events streamed
 * meanwhile.
 */

/** Timers the test moves by hand. */
class ManualTimers implements Timers {
  now = 0;
  #seq = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Moves `ms` forward, firing what is due in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

function delay(): { timers: ManualTimers; gate: PlaceholderDelay; fired: string[] } {
  const timers = new ManualTimers();
  const fired: string[] = [];
  const gate = new PlaceholderDelay(timers, () => fired.push(`due@${timers.now}`));
  return { timers, gate, fired };
}

function detail(id: string, name = id): SessionDetail {
  return { id, name } as unknown as SessionDetail;
}

function event(id: number, label = `e${id}`, sessionId = 's'): SessionEvent {
  return { id, sessionId, agentId: null, ts: `2026-09-29T10:00:${String(id).padStart(2, '0')}.000Z`, endTs: null, kind: 'text', label, payload: null } as unknown as SessionEvent;
}

describe('D45 · the placeholder delay (no flicker)', () => {
  it('is about 150 ms', () => {
    expect(PLACEHOLDER_DELAY_MS).toBe(150);
    expect(LOADING_SESSION).toBe('Loading session…');
  });

  it('a wait shows placeholders only once it lasted the delay', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', true);
    expect(gate.due('a')).toBe(false);
    expect([...timers.pending.values()].map((t) => t.at)).toEqual([150]);
    timers.advance(149);
    expect(gate.due('a')).toBe(false);
    expect(fired).toEqual([]);
    timers.advance(1);
    expect(gate.due('a')).toBe(true);
    expect(fired).toEqual(['due@150']);
    // Later updates of the same wait neither re-arm nor fire again.
    gate.update('a', true);
    timers.advance(500);
    expect(fired).toEqual(['due@150']);
    expect(timers.pending.size).toBe(0);
  });

  it('data that arrives within the delay shows no placeholder at all', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', true);
    timers.advance(120);
    gate.update('a', false);
    expect(timers.pending.size).toBe(0);
    timers.advance(1000);
    expect(fired).toEqual([]);
    expect(gate.due('a')).toBe(false);
  });

  it('nothing is armed when nothing waits (a cached revisit)', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', false);
    timers.advance(1000);
    expect(timers.pending.size).toBe(0);
    expect(fired).toEqual([]);
  });

  it('the end of a wait hides the placeholders; the next wait gets its own delay', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', true);
    timers.advance(150);
    expect(gate.due('a')).toBe(true);
    gate.update('a', false);
    expect(gate.due('a')).toBe(false);
    // e.g. the chat tab opened later, its events not loaded yet.
    gate.update('a', true);
    expect(gate.due('a')).toBe(false);
    timers.advance(149);
    expect(gate.due('a')).toBe(false);
    timers.advance(1);
    expect(gate.due('a')).toBe(true);
    expect(fired).toEqual(['due@150', 'due@300']);
  });

  it('switching sessions starts over: the old session\'s delay never counts for the new one', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', true);
    timers.advance(150);
    expect(gate.due('a')).toBe(true);
    gate.update('b', true);
    expect(gate.due('a')).toBe(false);
    expect(gate.due('b')).toBe(false);
    timers.advance(100);
    // Switched again before b's delay passed: b's timer is dropped, c gets a fresh one.
    gate.update('c', true);
    expect([...timers.pending.values()].map((t) => t.at)).toEqual([400]);
    timers.advance(149);
    expect(gate.due('c')).toBe(false);
    timers.advance(1);
    expect(gate.due('c')).toBe(true);
    expect(gate.due('b')).toBe(false);
    expect(fired).toEqual(['due@150', 'due@400']);
  });

  it('dispose drops a pending timer', () => {
    const { timers, gate, fired } = delay();
    gate.update('a', true);
    gate.dispose();
    expect(timers.pending.size).toBe(0);
    timers.advance(1000);
    expect(fired).toEqual([]);
    // A remount (React strict mode) arms it again.
    gate.update('a', true);
    timers.advance(150);
    expect(fired).toEqual(['due@1150']);
  });

  it('takes another delay', () => {
    const timers = new ManualTimers();
    const gate = new PlaceholderDelay(timers, () => undefined, 40);
    gate.update('a', true);
    timers.advance(40);
    expect(gate.due('a')).toBe(true);
  });
});

describe('D45 · which parts wait', () => {
  it('the detail late: header, panel and (on the chat tab) the chat', () => {
    expect(loadingParts('loading', 'loading', true)).toEqual({ header: true, chat: true, panel: true });
    expect(loadingParts('loading', 'ready', true)).toEqual({ header: true, chat: true, panel: true });
    expect(loadingParts('loading', 'loading', false)).toEqual({ header: true, chat: false, panel: true });
  });

  it('only the events late: only the chat, and only on the chat tab', () => {
    expect(loadingParts('ready', 'loading', true)).toEqual({ header: false, chat: true, panel: false });
    expect(loadingParts('ready', 'loading', false)).toEqual(NOTHING_LOADING);
  });

  it('everything there (loaded or cached): nothing waits', () => {
    expect(loadingParts('ready', 'ready', true)).toEqual(NOTHING_LOADING);
    expect(anyLoading(NOTHING_LOADING)).toBe(false);
  });

  it('a failed load waits no more (the error / missing state, never a stuck placeholder)', () => {
    expect(loadingParts('failed', 'loading', true)).toEqual(NOTHING_LOADING);
    expect(loadingParts('failed', 'failed', true)).toEqual(NOTHING_LOADING);
    expect(loadingParts('ready', 'failed', true)).toEqual(NOTHING_LOADING);
    // The detail still on its way while the events failed: the header and panel wait, the chat does not.
    expect(loadingParts('loading', 'failed', true)).toEqual({ header: true, chat: false, panel: true });
  });

  it('anyLoading is true while any part waits', () => {
    expect(anyLoading({ header: false, chat: true, panel: false })).toBe(true);
    expect(anyLoading({ header: true, chat: false, panel: true })).toBe(true);
  });
});

describe('D45 · the session cache (instant revisit)', () => {
  it('keeps the detail and the events of a session, each null until stored', () => {
    const cache = new SessionCache();
    expect(cache.get('a')).toBeNull();
    cache.putDetail('a', detail('a'));
    expect(cache.get('a')).toEqual({ detail: detail('a'), events: null, cursor: null });
    const events = [event(1), event(2)];
    cache.putEvents('a', events);
    expect(cache.get('a')).toEqual({ detail: detail('a'), events, cursor: null });
    cache.putDetail('a', detail('a', 'renamed'));
    expect(cache.get('a')?.detail?.name).toBe('renamed');
    expect(cache.get('a')?.events).toBe(events);
  });

  it('keeps the last 20 sessions stored; the least recently stored goes first', () => {
    expect(SESSION_CACHE_LIMIT).toBe(20);
    const cache = new SessionCache();
    for (let i = 1; i <= 20; i += 1) cache.putDetail(`s${i}`, detail(`s${i}`));
    expect(cache.size).toBe(20);
    // Storing s1 again (a revisit's refresh) makes it the most recent: s2 goes when s21 comes.
    cache.putEvents('s1', [event(1)]);
    cache.putDetail('s21', detail('s21'));
    expect(cache.size).toBe(20);
    expect(cache.get('s2')).toBeNull();
    expect(cache.get('s1')?.events).toHaveLength(1);
    expect(cache.ids()[0]).toBe('s3');
    expect(cache.ids().at(-1)).toBe('s21');
  });

  it('reading does not reorder', () => {
    const cache = new SessionCache(2);
    cache.putDetail('a', detail('a'));
    cache.putDetail('b', detail('b'));
    cache.get('a');
    cache.putDetail('c', detail('c'));
    expect(cache.ids()).toEqual(['b', 'c']);
  });

  it('drop forgets a session (the service answered 404)', () => {
    const cache = new SessionCache();
    cache.putDetail('a', detail('a'));
    cache.drop('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('hub events of a session not on screen keep applying to its cached events', () => {
    const cache = new SessionCache();
    cache.putEvents('a', [event(1, 'first'), event(2, 'running')]);
    cache.applyEvent('a', event(2, 'finished'));
    cache.applyEvent('a', event(3, 'new'));
    expect(cache.get('a')?.events?.map((e) => `${e.id}:${e.label}`)).toEqual(['1:first', '2:finished', '3:new']);
  });

  it('hub events never start a cached list (a partial list would pass for a complete one), nor reorder', () => {
    const cache = new SessionCache(2);
    cache.applyEvent('x', event(1));
    expect(cache.get('x')).toBeNull();
    cache.putDetail('a', detail('a'));
    cache.applyEvent('a', event(1));
    expect(cache.get('a')).toEqual({ detail: detail('a'), events: null, cursor: null });
    cache.putEvents('b', []);
    cache.putEvents('a', []);
    cache.applyEvent('b', event(1));
    expect(cache.ids()).toEqual(['b', 'a']);
  });

  it('the page has one cache with the default limit', () => {
    expect(sessionCache).toBeInstanceOf(SessionCache);
  });
});

describe('D45 · a fetch merged with the events streamed meanwhile', () => {
  it('the fetched list replaces what was shown (a cached list) and streamed events stay, by id', () => {
    const fetched = [event(1, 'first'), event(2, 'finished')];
    const streamed = [event(2, 'finished, then more'), event(3, 'new')];
    expect(mergeFetchedEvents(fetched, streamed).map((e) => `${e.id}:${e.label}`)).toEqual(['1:first', '2:finished, then more', '3:new']);
  });

  it('nothing streamed: the fetched list as it is (a copy)', () => {
    const fetched = [event(1)];
    const merged = mergeFetchedEvents(fetched, []);
    expect(merged).toEqual(fetched);
    expect(merged).not.toBe(fetched);
  });
});

describe('D95 · the chat window (newest page first, older pages on scroll)', () => {
  const at = (id: number, minute: number): SessionEvent => ({ ...event(id), ts: `2026-10-10T10:${String(minute).padStart(2, '0')}:00.000Z` });

  it('a full page leaves a cursor at its oldest event (in time order, not id order); a short page is complete', () => {
    const page = [at(7, 1), at(3, 2), at(9, 3)];
    expect(pageCursor(page, 3)?.id).toBe(7);
    expect(pageCursor(page, 4)).toBeNull();
    // A machine without paging answers every event: more than asked, complete.
    expect(pageCursor([...page, at(10, 4)], 3)).toBeNull();
  });

  it('hub events older than the cursor wait for their page; known ones and newer ones apply', () => {
    const window = { list: [at(5, 5), at(6, 6)], cursor: at(5, 5) };
    expect(inWindow(window, at(4, 4))).toBe(false);
    expect(inWindow(window, at(5, 5))).toBe(true);
    expect(inWindow(window, at(8, 7))).toBe(true);
    // An imported terminal turn: a new id with an older time.
    expect(inWindow(window, at(99, 1))).toBe(false);
    expect(inWindow({ list: window.list, cursor: null }, at(99, 1))).toBe(true);
  });

  it('an older page goes in front; a page with nothing new (a machine without paging) ends the window', () => {
    const window = { list: [at(5, 5), at(6, 6)], cursor: at(5, 5) };
    const older = withOlderPage(window, [at(3, 3), at(4, 4)], 2);
    expect(older.list.map((e) => e.id)).toEqual([3, 4, 5, 6]);
    expect(older.cursor?.id).toBe(3);
    expect(withOlderPage(older, [at(1, 1)], 2).cursor).toBeNull();
    expect(withOlderPage(window, [at(5, 5), at(6, 6)], 2)).toEqual({ list: window.list, cursor: null });
  });

  it('trimWindow keeps the newest events past the bound and moves the cursor', () => {
    const list = [at(1, 1), at(4, 4), at(2, 2), at(3, 3)];
    expect(trimWindow({ list, cursor: null }, 2, 5).list).toBe(list);
    const cut = trimWindow({ list, cursor: null }, 2, 3);
    expect(cut.list.map((e) => e.id)).toEqual([3, 4]);
    expect(cut.cursor?.id).toBe(3);
  });

  it('the cache keeps two pages a session at most, and a budget across sessions (the least recent lose their events)', () => {
    expect(CHAT_EVENTS_PAGE).toBe(1000);
    const many = (from: number, n: number): SessionEvent[] => Array.from({ length: n }, (_, i) => at(from + i, 0));
    const cache = new SessionCache(20, 2500);
    cache.putEvents('a', many(1, CHAT_EVENTS_PAGE * 2 + 1), null);
    expect(cache.get('a')?.events).toHaveLength(CHAT_EVENTS_PAGE);
    expect(cache.get('a')?.cursor).not.toBeNull();
    cache.putDetail('b', detail('b'));
    cache.putEvents('b', many(5000, 1000), null);
    cache.putEvents('c', many(9000, 1000), null);
    expect(cache.get('a')?.events).toBeNull();
    expect(cache.get('a')?.detail).toBeNull();
    expect(cache.get('b')?.events).toHaveLength(1000);
    expect(cache.eventCount).toBe(2000);
    expect(CACHE_EVENT_BUDGET).toBe(6000);
  });

  it('a cached window takes hub events only inside it', () => {
    const cache = new SessionCache();
    cache.putEvents('a', [at(5, 5), at(6, 6)], at(5, 5));
    cache.applyEvent('a', at(2, 2));
    cache.applyEvent('a', at(7, 7));
    expect(cache.get('a')?.events?.map((e) => e.id)).toEqual([5, 6, 7]);
  });
});
