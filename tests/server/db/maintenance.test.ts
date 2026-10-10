import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseMaintenance, MAINTENANCE_IDLE_MS } from '../../../src/server/db/maintenance.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D95 (`docs/performance.md` → *Database maintenance*): the WAL is checkpointed and truncated while the database is idle. */

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('db-maintenance');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

describe('D95 · DatabaseMaintenance', () => {
  it('waits while events are being written; once idle it truncates the WAL', async () => {
    let now = Date.now();
    const maintenance = new DatabaseMaintenance(store, { timer: false, now: () => now });
    await store.sessions.create({ id: 's1', name: 'a', claudeSessionId: 'c1' });
    for (let i = 0; i < 200; i += 1) await store.events.append({ sessionId: 's1', kind: 'text', payload: { type: 'assistant', text: 'x'.repeat(2000), messageId: null } });
    const wal = `${store.file}-wal`;
    expect((await stat(wal)).size).toBeGreaterThan(0);
    expect(await maintenance.run()).toBe(false);
    now = Date.now() + MAINTENANCE_IDLE_MS + 1;
    expect(await maintenance.run()).toBe(true);
    expect((await stat(wal)).size).toBe(0);
    maintenance.stop();
  });
});
