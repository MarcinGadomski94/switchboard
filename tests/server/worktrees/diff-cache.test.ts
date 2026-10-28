import { describe, expect, it } from 'vitest';
import type { DiffCount, DiffScope, FileDiff, Session } from '../../../src/core/api.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { DiffProvider } from '../../../src/server/providers.ts';
import { DiffCache } from '../../../src/server/worktrees/diff-cache.ts';
import { TOUCHED_PATHSPEC_LIMIT, touchedPathspec } from '../../../src/server/worktrees/manager.ts';

/** An inner provider whose answers the test releases by hand. */
function slowInner() {
  const calls = { count: 0, diff: 0 };
  let files = 3;
  const waiting: Array<() => void> = [];
  const hold = (): Promise<void> => new Promise((resolve) => waiting.push(resolve));
  let held = false;
  const inner: DiffProvider = {
    async diff(): Promise<FileDiff[]> {
      calls.diff += 1;
      if (held) await hold();
      return Array.from({ length: files }, (_, i) => ({ solution: 's', path: `f${i}`, branch: 'main', added: 1, removed: 0, lines: [], uncommitted: true }));
    },
    async count(_id: string, scope: DiffScope): Promise<DiffCount> {
      calls.count += 1;
      if (held) await hold();
      return { scope, files };
    },
  };
  return {
    inner,
    calls,
    setFiles: (n: number) => {
      files = n;
    },
    hold: (on: boolean) => {
      held = on;
    },
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

function cache(inner: DiffProvider, fingerprint: { value: string }, waits = { refresh: 20, first: 40, detail: 10 }) {
  return new DiffCache({ inner, fingerprint: async () => fingerprint.value, waits, onError: (error) => { throw error; } });
}

describe('DiffCache (D144)', () => {
  it('coalesces concurrent asks into one computation and answers from memory while the fingerprint holds', async () => {
    const fake = slowInner();
    const fp = { value: 'r1' };
    const c = cache(fake.inner, fp, { refresh: 20, first: 2_000, detail: 10 });
    const answers = await Promise.all(Array.from({ length: 10 }, () => c.count('s1', 'head')));
    expect(fake.calls.count).toBe(1);
    expect(answers.every((a) => a.files === 3 && a.stale === undefined)).toBe(true);
    // Asked again: no computation.
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 3 });
    expect(fake.calls.count).toBe(1);
    // Another view is its own computation.
    await c.count('s1', 'repo');
    expect(fake.calls.count).toBe(2);
  });

  it('a changed fingerprint refreshes; a slow refresh answers the last number as stale (with when it was counted), then fresh', async () => {
    const fake = slowInner();
    const fp = { value: 'r1' };
    const c = cache(fake.inner, fp);
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 3 });
    fp.value = 'r2';
    fake.setFiles(5);
    fake.hold(true);
    const stale = await c.count('s1', 'head');
    expect(stale.files).toBe(3);
    expect(stale.stale).toBe(true);
    expect(typeof stale.at).toBe('string');
    // Concurrent asks while it runs: still one computation.
    await Promise.all([c.count('s1', 'head'), c.count('s1', 'head')]);
    expect(fake.calls.count).toBe(2);
    fake.release();
    await c.idle();
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 5 });
    expect(fake.calls.count).toBe(2);
  });

  it('the first ask waits a little, then answers 0 as stale (never counted: at null) while the count goes on', async () => {
    const fake = slowInner();
    fake.hold(true);
    const c = cache(fake.inner, { value: 'r1' });
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 0, stale: true, at: null });
    fake.release();
    await c.idle();
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 3 });
  });

  it("the detail's files never wait for git beyond their short budget", async () => {
    const fake = slowInner();
    fake.hold(true);
    const c = cache(fake.inner, { value: 'r1' });
    const started = Date.now();
    expect(await c.detailFiles('s1')).toEqual({ files: [], stale: true });
    expect(Date.now() - started).toBeLessThan(500);
    fake.release();
    await c.idle();
    const fresh = await c.detailFiles('s1');
    expect(fresh.stale).toBe(false);
    expect(fresh.files.map((f) => f.path)).toEqual(['f0', 'f1', 'f2']);
  });

  it('the full diff is never kept, but identical concurrent asks share one read', async () => {
    const fake = slowInner();
    const c = cache(fake.inner, { value: 'r1' });
    await Promise.all([c.diff('s1', undefined, 'head'), c.diff('s1', undefined, 'head'), c.diff('s1', undefined, 'repo')]);
    expect(fake.calls.diff).toBe(2);
    await c.diff('s1', undefined, 'head');
    expect(fake.calls.diff).toBe(3);
  });

  it("a turn's end (run → idle) counts the views asked before again, in the background", async () => {
    const fake = slowInner();
    const fp = { value: 'r1' };
    const c = cache(fake.inner, fp);
    const bus = new HubBus();
    const stop = c.listen(bus);
    await c.count('s1', 'head');
    expect(fake.calls.count).toBe(1);
    const session = (status: Session['status']) => ({ id: 's1', status }) as Session;
    bus.publish('sessionUpdated', session('run'));
    fp.value = 'r2';
    fake.setFiles(7);
    bus.publish('sessionUpdated', session('idle'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await c.idle();
    expect(fake.calls.count).toBe(2);
    // Ready when asked.
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 7 });
    expect(fake.calls.count).toBe(2);
    stop();
  });

  it('invalidate() makes the next ask count again', async () => {
    const fake = slowInner();
    const c = cache(fake.inner, { value: 'r1' });
    await c.count('s1', 'head');
    c.invalidate('s1');
    fake.setFiles(1);
    expect(await c.count('s1', 'head')).toEqual({ scope: 'head', files: 1 });
    expect(fake.calls.count).toBe(2);
  });
});

describe('touchedPathspec (D144: git reads only the session\'s own files in place)', () => {
  it('literal pathspecs for a small set; none (the whole tree) without a set, for an empty or a large one', () => {
    expect(touchedPathspec(new Set(['b.txt', 'a dir/[x].md']))).toEqual([':(literal)a dir/[x].md', ':(literal)b.txt']);
    expect(touchedPathspec(null)).toEqual([]);
    expect(touchedPathspec(new Set())).toEqual([]);
    expect(touchedPathspec(new Set(Array.from({ length: TOUCHED_PATHSPEC_LIMIT + 1 }, (_, i) => `f${i}`)))).toEqual([]);
  });
});
