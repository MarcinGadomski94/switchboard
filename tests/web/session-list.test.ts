import { describe, expect, it } from 'vitest';
import type { Session, SessionListItem } from '../../src/core/api.ts';
import { SessionListStore, patchSessionList } from '../../src/web/api/session-list-store.ts';

/** D95 follow-up 2 (`docs/performance.md` → *Session list in memory*): the page's list patched from `/hub`. */

function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, name: id, status: 'run', closedAt: null, machine: null, agents: [{ id: 'main' }], ...patch } as unknown as Session;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('patchSessionList', () => {
  const list = [session('b'), session('a')].map(({ agents: _a, ...item }) => item as SessionListItem);

  it('replaces a known row in place, without its agents', () => {
    const { list: next, unknown } = patchSessionList(list, session('a', { status: 'done' }), 'open');
    expect(unknown).toBe(false);
    expect(next.map((s) => [s.id, s.status])).toEqual([['b', 'run'], ['a', 'done']]);
    expect('agents' in (next[1] as object)).toBe(false);
  });

  it('a closed session leaves the open list and stays in the whole one', () => {
    const closed = session('a', { closedAt: '2026-10-10T10:00:00Z' });
    expect(patchSessionList(list, closed, 'open')).toEqual({ list: [list[0]], unknown: false });
    expect(patchSessionList(list, closed, 'all').list.map((s) => s.closedAt)).toEqual([null, '2026-10-10T10:00:00Z']);
    // A closed one the open list never had: nothing to do.
    expect(patchSessionList(list, session('z', { closedAt: 'x' }), 'open').list).toBe(list);
  });

  it('an unknown session: a local one first (the newest), a paired machine\'s last; both ask for a resync', () => {
    expect(patchSessionList(list, session('c'), 'open')).toMatchObject({ unknown: true });
    expect(patchSessionList(list, session('c'), 'open').list.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    const remote = session('r~m~x', { machine: { id: 'm', name: 'm', state: 'online' } } as Partial<Session>);
    expect(patchSessionList(list, remote, 'open').list.map((s) => s.id)).toEqual(['b', 'a', 'r~m~x']);
  });
});

describe('SessionListStore', () => {
  it('reads once, then patches from updates (no read per update); an unknown session is one resync for a burst', async () => {
    const answers = [[session('a')]];
    const store = new SessionListStore('open', async () => answers.shift() ?? [session('a'), session('c')], 5);
    store.load();
    await tick();
    expect(store.getState().data?.map((s) => s.id)).toEqual(['a']);
    for (let i = 0; i < 50; i++) store.update(session('a', { status: i % 2 ? 'run' : 'done' }));
    expect(store.reads).toBe(1);
    expect(store.getState().data?.[0]?.status).toBe('run');
    store.update(session('c'));
    store.update(session('c', { status: 'done' }));
    expect(store.getState().data?.map((s) => s.id)).toEqual(['c', 'a']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.reads).toBe(2);
    expect(store.getState().data?.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('updates that arrive while a read is in flight are applied over its answer, in order', async () => {
    const pending = deferred<Session[]>();
    const store = new SessionListStore('open', () => pending.promise);
    store.load();
    store.update(session('a', { status: 'need' }));
    store.update(session('a', { status: 'done' }));
    pending.resolve([session('a', { status: 'run' })]);
    await tick();
    expect(store.getState().data?.map((s) => [s.id, s.status])).toEqual([['a', 'done']]);
    expect(store.getState().data?.every((s) => !('agents' in s))).toBe(true);
  });

  it('an older read landing after a newer one is dropped; a failed read keeps the last list; clear forgets it', async () => {
    const first = deferred<Session[]>();
    const second = deferred<Session[]>();
    const reads = [first, second];
    const store = new SessionListStore('open', () => (reads.shift() as typeof first).promise);
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getState().data?.length ?? -1));
    store.load();
    store.load();
    second.resolve([session('a'), session('b')]);
    await tick();
    first.resolve([session('a')]);
    await tick();
    expect(store.getState().data?.map((s) => s.id)).toEqual(['a', 'b']);
    const failing = new SessionListStore('open', () => Promise.reject(new Error('down')));
    failing.load();
    await tick();
    expect(failing.getState()).toMatchObject({ data: null, loading: false });
    expect(failing.getState().error).not.toBeNull();
    store.clear();
    expect(store.getState()).toMatchObject({ data: null, loading: true });
    expect(seen.length).toBeGreaterThan(0);
  });
});
