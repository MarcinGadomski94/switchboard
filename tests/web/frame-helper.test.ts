import { describe, expect, it } from 'vitest';
import { FRAME_HELPER_ATTRIBUTE } from '../../src/core/site-tools.ts';
import { type FrameHelperEnvironment, type FrameHelperState, MARKER_WAIT_MS, readFrameHelperMarker, watchFrameHelper } from '../../src/web/tools/frame-helper.ts';

/** D28: the frame helper's marker and state (src/web/tools/frame-helper.ts, docs/frame-helper.md). */

/** A page whose marker, observer, timer and capability check the test drives by hand. */
class FakePage implements FrameHelperEnvironment {
  marker: string | null = null;
  observers = new Set<() => void>();
  timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  checks: Array<(ok: boolean | Error) => void> = [];

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
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('a check that fails counts as blocked', async () => {
    const page = new FakePage();
    page.marker = '1.0.0';
    const { states } = watch(page);
    page.checks[0]!(new Error('boom'));
    await flush();
    expect(states.at(-1)).toEqual({ status: 'blocked', version: '1.0.0' });
  });

  it('stop() ends the watch: no observer, the timer cancelled, later results dropped', async () => {
    const page = new FakePage();
    page.marker = '1.0.0';
    const { states, stop } = watch(page);
    stop();
    expect(page.observers.size).toBe(0);
    expect(page.timers.every((t) => t.cancelled)).toBe(true);
    page.checks[0]!(true);
    await flush();
    expect(states.at(-1)).toEqual({ status: 'checking', version: '1.0.0' });
  });
});
