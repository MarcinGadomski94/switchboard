import { describe, expect, it } from 'vitest';
import { FRAME_HELPER_ATTRIBUTE } from '../../src/core/site-tools.ts';
import {
  type FrameHelperEnvironment,
  type FrameHelperSites,
  type FrameHelperState,
  HELPER_MESSAGE_SOURCE,
  MARKER_WAIT_MS,
  SITES_TIMEOUT_MS,
  type SitesMessage,
  createSitesSync,
  readFrameHelperMarker,
  readSitesAnswer,
  siteFrameStatus,
  watchFrameHelper,
} from '../../src/web/tools/frame-helper.ts';

/** D28: the frame helper's marker and state (src/web/tools/frame-helper.ts, docs/frame-helper.md). */

/** A page whose marker, observer, timer and capability check the test drives by hand. */
class FakePage implements FrameHelperEnvironment {
  marker: string | null = null;
  observers = new Set<() => void>();
  timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  checks: Array<(ok: boolean | Error) => void> = [];
  /** `null`: the host list is settled at once; otherwise the test settles it by hand. */
  settle: (() => void) | null = null;
  settledCalls = 0;

  readMarker(): string | null {
    return this.marker;
  }

  observeMarker(onChange: () => void): () => void {
    this.observers.add(onChange);
    return () => this.observers.delete(onChange);
  }

  setTimer(run: () => void, ms: number): () => void {
    const timer = { run, ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  sitesSettled(): Promise<void> {
    this.settledCalls += 1;
    if (this.settle === null) return Promise.resolve();
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  checkFraming(): Promise<boolean> {
    return new Promise((resolve, reject) => this.checks.push((ok) => (ok instanceof Error ? reject(ok) : resolve(ok))));
  }

  /** The content script sets the marker (the observer hears it). */
  mark(version: string): void {
    this.marker = version;
    for (const observer of this.observers) observer();
  }

  /** The wait for the marker runs out. */
  elapse(): void {
    for (const timer of this.timers) if (!timer.cancelled) timer.run();
  }
}

function watch(page: FakePage): { states: FrameHelperState[]; stop: () => void } {
  const states: FrameHelperState[] = [];
  const stop = watchFrameHelper(page, (state) => states.push(state));
  return { states, stop };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('readFrameHelperMarker', () => {
  it('reads the version from data-sb-frame-helper; missing or blank is null', () => {
    const root = (value: string | null) => ({ getAttribute: (name: string) => (name === FRAME_HELPER_ATTRIBUTE ? value : null) });
    expect(FRAME_HELPER_ATTRIBUTE).toBe('data-sb-frame-helper');
    expect(readFrameHelperMarker(root('1.0.0'))).toBe('1.0.0');
    expect(readFrameHelperMarker(root(' 1.0.0 '))).toBe('1.0.0');
    expect(readFrameHelperMarker(root(''))).toBeNull();
    expect(readFrameHelperMarker(root(null))).toBeNull();
    expect(readFrameHelperMarker(null)).toBeNull();
  });
});

describe('watchFrameHelper', () => {
  it('marker already there: checking → one capability check → ready', async () => {
    const page = new FakePage();
    page.marker = '1.0.0';
    const { states } = watch(page);
    expect(states).toEqual([
      { status: 'checking', version: null },
      { status: 'checking', version: '1.0.0' },
    ]);
    await flush();
    expect(page.checks).toHaveLength(1);
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'ready', version: '1.0.0' });
    page.elapse(); // the wait running out later changes nothing
    expect(states.at(-1)).toEqual({ status: 'ready', version: '1.0.0' });
  });

  it('a marker that arrives after load, within the wait, still counts; a refused check is blocked (Safari)', async () => {
    const page = new FakePage();
    const { states } = watch(page);
    expect(page.timers.map((t) => t.ms)).toEqual([MARKER_WAIT_MS]);
    expect(states).toEqual([{ status: 'checking', version: null }]);
    page.mark('1.0.0');
    page.mark('1.0.0'); // a second mutation: still one check
    await flush();
    expect(page.checks).toHaveLength(1);
    page.checks[0]!(false);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'blocked', version: '1.0.0' });
  });

  it('no marker within the wait: absent; a late marker is still checked', async () => {
    const page = new FakePage();
    const { states } = watch(page);
    page.elapse();
    expect(states.at(-1)).toEqual({ status: 'absent', version: null });
    expect(page.checks).toHaveLength(0);
    page.mark('2.0.0');
    expect(states.at(-1)).toEqual({ status: 'checking', version: '2.0.0' });
    await flush();
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('a check that fails counts as blocked', async () => {
    const page = new FakePage();
    page.marker = '1.0.0';
    const { states } = watch(page);
    await flush();
    page.checks[0]!(new Error('boom'));
    await flush();
    expect(states.at(-1)).toEqual({ status: 'blocked', version: '1.0.0' });
  });

  it('the capability check waits until the helper answered the page\'s host list (D28 ruling)', async () => {
    const page = new FakePage();
    page.settle = () => {};
    page.marker = '2.0.0';
    const { states } = watch(page);
    expect(page.settledCalls).toBe(1);
    await flush();
    expect(page.checks).toHaveLength(0); // no check before the helper has this page's own host
    expect(states.at(-1)).toEqual({ status: 'checking', version: '2.0.0' });
    page.settle!();
    await flush();
    expect(page.checks).toHaveLength(1);
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('stop() ends the watch: no observer, the timer cancelled, later results dropped', async () => {
    const page = new FakePage();
    page.marker = '1.0.0';
    const { states, stop } = watch(page);
    stop();
    expect(page.observers.size).toBe(0);
    expect(page.timers.every((t) => t.cancelled)).toBe(true);
    await flush();
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'checking', version: '1.0.0' });
  });
});

/** Timers and posted messages the test drives by hand. */
function fakeSites(timeoutMs = SITES_TIMEOUT_MS) {
  const posted: SitesMessage[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const sync = createSitesSync(
    {
      post: (message) => posted.push(message),
      setTimer(run, ms) {
        const timer = { run, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    timeoutMs,
  );
  const answer = (id: number, ok: boolean, hosts: string[], error: string | null = null) =>
    sync.receive({ source: HELPER_MESSAGE_SOURCE, type: 'frame-helper:sites-applied', id, ok, hosts, error });
  const elapse = () => {
    for (const timer of [...timers]) if (!timer.cancelled) timer.run();
  };
  return { sync, posted, timers, answer, elapse };
}

describe('readSitesAnswer', () => {
  it("reads the helper's answer; anything else is null", () => {
    const base = { source: HELPER_MESSAGE_SOURCE, type: 'frame-helper:sites-applied', id: 3 };
    expect(readSitesAnswer({ ...base, ok: true, hosts: ['127.0.0.1', 'site.test'], error: null })).toEqual({ id: 3, ok: true, hosts: ['127.0.0.1', 'site.test'], error: null });
    expect(readSitesAnswer({ ...base, ok: false, hosts: [], error: 'at most 50 hosts' })).toEqual({ id: 3, ok: false, hosts: [], error: 'at most 50 hosts' });
    expect(readSitesAnswer({ ...base, ok: false, hosts: ['x.example'] })).toEqual({ id: 3, ok: false, hosts: [], error: 'refused' });
    for (const data of [
      null,
      'frame-helper:sites-applied',
      { ...base, source: 'switchboard', ok: true, hosts: [] }, // the page's own message
      { ...base, type: 'frame-helper:sites', ok: true, hosts: [] },
      { ...base, id: '3', ok: true, hosts: [] },
      { ...base, ok: true, hosts: 'site.test' },
      { ...base, ok: true, hosts: [1] },
    ]) {
      expect(readSitesAnswer(data), JSON.stringify(data)).toBeNull();
    }
  });
});

describe('createSitesSync (the page gives the helper its host list, D28 ruling)', () => {
  it('sends a list once, with a new id per change; the answer to the latest list is what counts', async () => {
    const { sync, posted, answer } = fakeSites();
    const states: FrameHelperSites[] = [];
    sync.subscribe(() => states.push(sync.state()));
    expect(sync.state()).toEqual({ answered: false, pending: false, applied: [], error: null });
    sync.send(['127.0.0.1', 'site.test']);
    sync.send(['127.0.0.1', 'site.test']); // unchanged: not sent again
    expect(posted).toEqual([{ source: 'switchboard', type: 'frame-helper:sites', id: 1, hosts: ['127.0.0.1', 'site.test'] }]);
    expect(sync.state()).toEqual({ answered: false, pending: true, applied: [], error: null });
    sync.send(['127.0.0.1']);
    expect(posted.map((m) => m.id)).toEqual([1, 2]);
    answer(1, true, ['127.0.0.1', 'site.test']); // an older list's answer: the helper answers, but its hosts are replaced
    expect(sync.state()).toEqual({ answered: true, pending: true, applied: [], error: null });
    answer(2, true, ['127.0.0.1']);
    expect(sync.state()).toEqual({ answered: true, pending: false, applied: ['127.0.0.1'], error: null });
    answer(3, true, ['evil.example']); // not a list this page sent
    expect(sync.state().applied).toEqual(['127.0.0.1']);
    sync.receive({ source: 'switchboard', type: 'frame-helper:sites', id: 2, hosts: ['evil.example'] });
    expect(sync.state().applied).toEqual(['127.0.0.1']);
    expect(states.length).toBeGreaterThan(0);
    sync.resend();
    expect(posted.at(-1)).toEqual({ source: 'switchboard', type: 'frame-helper:sites', id: 3, hosts: ['127.0.0.1'] });
  });

  it('a refused list confirms no host; an unanswered one stops waiting after the timeout', () => {
    const { sync, answer, elapse, timers } = fakeSites();
    sync.send(['127.0.0.1', 'site.test']);
    answer(1, false, [], 'at most 50 hosts');
    expect(sync.state()).toEqual({ answered: true, pending: false, applied: [], error: 'at most 50 hosts' });
    const silent = fakeSites();
    silent.sync.send(['127.0.0.1']);
    expect(silent.timers.map((t) => t.ms)).toEqual([SITES_TIMEOUT_MS]);
    silent.elapse();
    expect(silent.sync.state()).toEqual({ answered: false, pending: false, applied: [], error: null });
    expect(timers.every((t) => t.cancelled)).toBe(true); // the answer cancelled the first sync's wait
    elapse();
  });

  it('settled() resolves once the latest list is answered or its wait ran out, and at most after the timeout', async () => {
    const { sync, answer, elapse } = fakeSites();
    let done = 0;
    void sync.settled().then(() => (done += 1)); // nothing sent yet
    sync.send(['127.0.0.1']);
    await flush();
    expect(done).toBe(0);
    answer(1, true, ['127.0.0.1']);
    await flush();
    expect(done).toBe(1);
    await sync.settled(); // already settled
    sync.send(['127.0.0.1', 'site.test']);
    void sync.settled().then(() => (done += 1));
    elapse(); // no answer: the wait runs out
    await flush();
    expect(done).toBe(2);
    const idle = fakeSites();
    let idleDone = false;
    void idle.sync.settled().then(() => (idleDone = true)); // never sent: gives up after the timeout
    idle.elapse();
    await flush();
    expect(idleDone).toBe(true);
  });
});

describe('siteFrameStatus (a site frames only once the helper confirmed its host)', () => {
  const ready: FrameHelperState = { status: 'ready', version: '2.0.0' };
  const sites = (patch: Partial<FrameHelperSites>): FrameHelperSites => ({ answered: true, pending: false, applied: ['127.0.0.1', 'site.test'], error: null, ...patch });

  it("follows the helper's own state until it is ready", () => {
    for (const status of ['checking', 'absent', 'blocked'] as const) {
      expect(siteFrameStatus({ status, version: null }, sites({}), 'site.test')).toBe(status);
    }
  });

  it('ready with its host confirmed; checking while the list waits; blocked when the helper answered without it', () => {
    expect(siteFrameStatus(ready, sites({}), 'site.test')).toBe('ready');
    expect(siteFrameStatus(ready, sites({ pending: true, applied: ['127.0.0.1'] }), 'site.test')).toBe('checking');
    expect(siteFrameStatus(ready, sites({ applied: ['127.0.0.1'] }), 'site.test')).toBe('blocked');
    expect(siteFrameStatus(ready, sites({ applied: [], error: 'at most 50 hosts' }), 'site.test')).toBe('blocked');
    expect(siteFrameStatus(ready, sites({}), 'other.test')).toBe('blocked');
  });

  it('an older helper that never answers a list is trusted on its capability check', () => {
    expect(siteFrameStatus(ready, sites({ answered: false, applied: [] }), 'site.test')).toBe('ready');
    expect(siteFrameStatus(ready, sites({ answered: false, pending: true, applied: [] }), 'site.test')).toBe('checking');
  });
});
