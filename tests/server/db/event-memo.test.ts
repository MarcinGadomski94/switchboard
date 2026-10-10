import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENT_CHANGE_LOG_LIMIT } from '../../../src/server/db/repos/events.ts';
import { EventMemo, payloadType } from '../../../src/server/db/event-memo.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D95 (`docs/performance.md` → *Incremental derivations*): the events repository's
 * write revisions and change log, and `EventMemo`, which keeps a value derived from
 * a session's whole history until an event that can change it is written.
 */

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('event-memo');
  store = await openTempStore(tmp);
  await store.sessions.create({ id: 's1', name: 'a', claudeSessionId: 'c1' });
  await store.sessions.create({ id: 's2', name: 'b', claudeSessionId: 'c2' });
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

const user = (sessionId: string) => store.events.append({ sessionId, kind: 'text', payload: { type: 'user', text: 'hi', origin: 'user', delivered: true } });
const tool = (sessionId: string) => store.events.append({ sessionId, kind: 'plan', payload: { type: 'tool', name: 'Read', toolUseId: 't', input: {} } });

describe('D95 · EventRepository revisions', () => {
  it('counts the writes per session and names the ids written since a revision (each once)', async () => {
    expect(await store.events.revision('s1')).toBe(0);
    const a = await user('s1');
    const b = await tool('s1');
    await tool('s2');
    await store.events.update(a.id, { label: 'changed' });
    expect(await store.events.revision('s1')).toBe(3);
    expect(await store.events.revision('s2')).toBe(1);
    expect(await store.events.changedSince('s1', 3)).toEqual([]);
    expect(await store.events.changedSince('s1', 1)).toEqual([b.id, a.id]);
    expect(await store.events.changedSince('s1', 0)).toEqual([a.id, b.id]);
    expect(await store.events.changedSince('s1', 9)).toBeNull();
    expect((await store.events.byIds('s1', [b.id, a.id, 999])).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('a revision older than the log reaches gives null (read everything again)', async () => {
    for (let i = 0; i < EVENT_CHANGE_LOG_LIMIT * 2 + 1; i += 1) await tool('s1');
    expect(await store.events.changedSince('s1', 0)).toBeNull();
    expect(await store.events.changedSince('s1', EVENT_CHANGE_LOG_LIMIT * 2)).toHaveLength(1);
  });
});

describe('D95 · EventMemo', () => {
  it('computes once, keeps the value through writes that cannot change it, computes again after one that can', async () => {
    let computed = 0;
    const memo = new EventMemo<number>((event) => payloadType(event) === 'user');
    const count = () => memo.get(store.events, 's1', '', async () => (computed += 1));
    expect(await count()).toBe(1);
    expect(await count()).toBe(1);
    await tool('s1');
    await tool('s2');
    expect(await count()).toBe(1);
    await user('s1');
    expect(await count()).toBe(2);
    // Another key of the same session is its own value.
    expect(await memo.get(store.events, 's1', 'other', async () => 42)).toBe(42);
    expect(computed).toBe(2);
  });

  it('countUserMessages of the whole session follows new user messages', async () => {
    await user('s1');
    expect(await store.events.countUserMessages('s1')).toBe(1);
    await tool('s1');
    expect(await store.events.countUserMessages('s1')).toBe(1);
    const second = await user('s1');
    expect(await store.events.countUserMessages('s1')).toBe(2);
    expect(await store.events.countUserMessages('s1', second.id - 1)).toBe(1);
  });
});

describe('D95 · AgentRepository.listBySession from memory', () => {
  it('follows creates, updates and deletes, and a session delete (a cascade the repository does not see)', async () => {
    const a = await store.agents.create({ sessionId: 's1', name: 'main', kind: 'main' });
    expect((await store.agents.listBySession('s1')).map((agent) => agent.name)).toEqual(['main']);
    await store.agents.create({ sessionId: 's1', name: 'helper' });
    expect((await store.agents.listBySession('s1')).map((agent) => agent.name)).toEqual(['main', 'helper']);
    await store.agents.update(a.id, { status: 'done' });
    expect((await store.agents.listBySession('s1'))[0]?.status).toBe('done');
    // Callers get their own array.
    (await store.agents.listBySession('s1')).pop();
    expect(await store.agents.listBySession('s1')).toHaveLength(2);
    expect((await store.agents.mainOf('s1'))?.id).toBe(a.id);
    await store.sessions.delete('s1');
    expect(await store.agents.listBySession('s1')).toEqual([]);
  });
});
