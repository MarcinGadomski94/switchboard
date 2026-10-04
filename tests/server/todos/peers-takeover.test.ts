import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionTodoList, TodoGroup } from '../../../src/core/api.ts';
import type { TakeoverRun as Run } from '../../../src/core/takeover.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D68 with two real Switchboard processes ("pc" = a, "mac" = b), paired (D48)
 * and fake CLIs: a peer's session's todo list is read and edited through the
 * proxy (`r~<machine>~<id>`), shows on the Todos page's groups and as the
 * session's count, and travels with the session when it is taken over (D65).
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('todos-peers');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function run(node: PeerNode, body: Record<string, unknown>): Promise<Run> {
  const started = await node.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as Run).id;
  return waitFor('the take-over to end', async () => {
    const current = (await node.call('GET', `/api/takeover/runs/${id}`)).body as Run;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

describe('D68 / D69 · todos of a paired machine', () => {
  it('are edited through the proxy, listed on the Todos page and travel with a take-over', async () => {
    const w = (world = await takeoverWorld(tmp));
    const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'todo-peer');
    const remote = remoteId(w.aId, started.id);

    // The mac edits the pc's session's list: the answers carry the remote ids; the pc stores it.
    const added = await w.b.call('POST', `/api/sessions/${encodeURIComponent(remote)}/todos`, { title: 'Ship the migration', description: 'For 1.8.', plan: 'Run 0027 on a copy first.' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const list = added.body as SessionTodoList;
    expect(list.sessionId).toBe(remote);
    expect(list.todos[0]).toMatchObject({ sessionId: remote, title: 'Ship the migration', text: 'Ship the migration', description: 'For 1.8.', plan: 'Run 0027 on a copy first.', addedBy: 'developer' });
    const second = (await w.b.call('POST', `/api/sessions/${encodeURIComponent(remote)}/todos`, { text: 'Done already' })).body as SessionTodoList;
    const doneId = second.todos[1]?.id as string;
    expect((await w.b.call('PUT', `/api/sessions/${encodeURIComponent(remote)}/todos/${doneId}`, { state: 'done' })).status).toBe(200);
    expect(((await w.a.call('GET', `/api/sessions/${started.id}/todos`)).body as SessionTodoList).todos.map((t) => [t.text, t.state])).toEqual([
      ['Ship the migration', 'open'],
      ['Done already', 'done'],
    ]);

    // The mac's lists: the session's count (sessionUpdated forwarded) and the Todos page's group.
    await waitFor('the remote session count', async () => {
      const sessions = (await w.b.call('GET', '/api/sessions')).body as Session[];
      return sessions.find((s) => s.id === remote)?.openTodoCount === 1 ? true : null;
    });
    const group = await waitFor('the remote group', async () => {
      const groups = (await w.b.call('GET', '/api/todos')).body as TodoGroup[];
      return groups.find((g) => g.sessionId === remote && g.todos.length === 2) ?? null;
    });
    expect(group.machine).toMatchObject({ id: w.aId, name: 'pc-office' });

    // Taken over to the mac: the new session has the same list, in order, open and done.
    const finished = await run(w.b, { sessionId: remote });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    const created = ((await w.b.call('GET', '/api/sessions')).body as Session[]).find((s) => s.movedFrom?.sessionId === started.id) as Session;
    expect(created).toBeTruthy();
    const moved = (await w.b.call('GET', `/api/sessions/${created.id}/todos`)).body as SessionTodoList;
    // D69: with the description and plan.
    expect(moved.todos.map((t) => [t.title, t.description, t.plan, t.state, t.addedBy])).toEqual([
      ['Ship the migration', 'For 1.8.', 'Run 0027 on a copy first.', 'open', 'developer'],
      ['Done already', null, null, 'done', 'developer'],
    ]);
    expect(created.openTodoCount).toBe(1);
  }, 150_000);
});
