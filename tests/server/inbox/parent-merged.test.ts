/**
 * D47 rule 5: the "Parent … merged" system item from stored state (D13), without
 * git or a CLI: `SystemItemService.sync` raises it for a worktree whose
 * `parent_merged_at` is set (e.g. the service restarted between the poll and the
 * raise), sends the session its message once, falls back to the outbox when the
 * session cannot take it (continued in a terminal), and sends nothing for a
 * closed session. The real path (fake-gh, temp repos) is in
 * `tests/server/worktrees/stacking.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserMessageOrigin } from '../../../src/core/event-payload.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { PARENT_MERGED, PARENT_MERGED_KIND, SystemItemService, parentMergedItem, parentMergedOf } from '../../../src/server/inbox/system-items.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

let dir = '';
let store: Store | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (dir) await removeTempDir(dir);
  dir = '';
});

const EPIC = 'feature/PROJ-3010-Platform';
const PARENT = 'PROJ-3013-cookie-banner';
const TASK = 'PROJ-3014-kpi-events';

async function world(options: { readonly closed?: boolean; readonly fail?: boolean } = {}) {
  dir = await makeTempDir('switchboard-parent-merged-');
  store = await openTempStore(dir);
  const session = await store.sessions.create({ name: 'kpi-events', claudeSessionId: randomUUID(), solutions: ['web-front'], worktrees: true });
  if (options.closed) await store.sessions.update(session.id, { closedAt: '2026-09-29T11:00:00.000Z' });
  const worktree = await store.worktrees.create({
    repo: 'web-front',
    repoPath: '/r/web-front',
    branch: TASK,
    path: '/r/web-front-wt-kpi-events',
    baseRef: `origin/${EPIC}`,
    sessionId: session.id,
    prNumber: 412,
    parentBranch: PARENT,
    parentPrNumber: 306,
    parentPrState: 'MERGED',
    parentBase: EPIC,
    parentHeadOid: 'abc1234',
    parentMerge: 'squash',
    parentMergedAt: '2026-09-29T12:00:00.000Z',
  });
  const sent: Array<{ sessionId: string; text: string; origin: UserMessageOrigin }> = [];
  const service = new SystemItemService({
    store,
    sessions: {
      async sendMessage(sessionId, text, origin) {
        if (options.fail) throw new Error('the session continues in a terminal; attach it first');
        sent.push({ sessionId, text, origin });
      },
    },
  });
  return { store, session, worktree, sent, service };
}

describe('SystemItemService · D47 parent merged', () => {
  it('sync raises the item once and sends the session the rule-5 message once', async () => {
    const w = await world();
    const [item] = await w.service.sync();
    expect(item).toMatchObject({
      kind: PARENT_MERGED,
      source: 'worktrees',
      status: 'need',
      title: `Parent ${PARENT} merged — retarget and rebase ${TASK}`,
      sessionId: w.session.id,
      worktreeId: w.worktree.id,
      actions: [{ id: 'dismiss', label: 'Dismiss' }],
      createdAt: '2026-09-29T12:00:00.000Z',
    });
    expect(item?.detail).toBe(
      `web-front · PR #306 ${PARENT} was merged into ${EPIC} (squash-merged). The session was asked to retarget the PR to ${EPIC} (gh pr edit ${TASK} --base ${EPIC}) and rebase: git rebase --onto origin/${EPIC} abc1234 ${TASK}, then report.`,
    );
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ sessionId: w.session.id, origin: 'service' });
    expect(w.sent[0]?.text).toContain('1. Retarget your PR #412 to');
    expect(await w.service.sync()).toEqual([]);
    expect(await w.service.parentMerged(w.worktree.id)).toBeNull();
    expect(w.sent).toHaveLength(1);
    // Dismiss closes it like any system item.
    expect(await w.service.act(item?.id as string, 'dismiss')).toMatchObject({ state: 'closed', closedAction: 'dismiss' });
  });

  it('a session that cannot take the message (a terminal owns it): the message waits in its outbox', async () => {
    const w = await world({ fail: true });
    await w.service.sync();
    const pending = await w.store.pendingMessages.pending(w.session.id);
    expect(pending.map((message) => message.kind)).toEqual([PARENT_MERGED_KIND]);
    expect(pending[0]?.text).toContain(`git rebase --onto origin/${EPIC} abc1234 ${TASK}`);
  });

  it('a closed session: only the item, which says nothing was sent', async () => {
    const w = await world({ closed: true });
    const [item] = await w.service.sync();
    expect(item?.detail).toContain('The session is closed, so nothing was sent to it: retarget the PR');
    expect(w.sent).toEqual([]);
    expect(await w.store.pendingMessages.pending(w.session.id)).toEqual([]);
  });

  it('builds the item from the stored row (pure)', () => {
    const row = {
      id: 'w1',
      repo: 'web-front',
      repoPath: '/r',
      branch: TASK,
      baseRef: null,
      path: '/r-wt',
      sessionId: null,
      prNumber: null,
      prUrl: null,
      prState: null,
      prCheckedAt: null,
      removable: false,
      createdAt: 'x',
      updatedAt: 'x',
      removedAt: null,
      parentBranch: PARENT,
      parentPrNumber: null,
      parentPrUrl: null,
      parentPrState: 'MERGED',
      parentBase: EPIC,
      parentHeadOid: null,
      parentMerge: null,
      parentMergedAt: null,
    };
    const merged = parentMergedOf(row);
    expect(merged).toMatchObject({ merge: 'unknown', oldTip: null, childPr: null, parentPr: null });
    expect(parentMergedItem(row, merged, true).detail).toBe(
      `web-front · ${PARENT} was merged into ${EPIC} (merge kind unknown). The session was asked to retarget the PR to ${EPIC} (gh pr edit ${TASK} --base ${EPIC}) and rebase: git rebase --onto origin/${EPIC} <old parent tip> ${TASK}, then report.`,
    );
  });
});
