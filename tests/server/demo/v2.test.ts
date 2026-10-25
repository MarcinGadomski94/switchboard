import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoV2 } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { seedDemo } from '../../../src/server/demo/seed.ts';
import { DEMO_V2_KEY, DEMO_V2_TEAMMATES, seedDemoV2Files } from '../../../src/server/demo/v2.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D131 · lane X · the demo's v2 layer (docs/demo.md → The v2 layer). */

const NOW = new Date('2026-09-28T12:00:00.000Z');

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('demo-v2');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

describe('when the v2 layer runs', () => {
  it('only in demo mode, unless the default theme is classic (test servers); SWITCHBOARD_DEMO_V2 forces it', () => {
    expect(demoV2({})).toBe(false);
    expect(demoV2({ SWITCHBOARD_DEMO_V2: '1' })).toBe(false);
    expect(demoV2({ SWITCHBOARD_DEMO: '1' })).toBe(true);
    expect(demoV2({ SWITCHBOARD_DEMO: '1', SWITCHBOARD_UI_THEME_DEFAULT: 'v2' })).toBe(true);
    expect(demoV2({ SWITCHBOARD_DEMO: '1', SWITCHBOARD_UI_THEME_DEFAULT: 'classic' })).toBe(false);
    expect(demoV2({ SWITCHBOARD_DEMO: '1', SWITCHBOARD_UI_THEME_DEFAULT: 'classic', SWITCHBOARD_DEMO_V2: '1' })).toBe(true);
    expect(demoV2({ SWITCHBOARD_DEMO: '1', SWITCHBOARD_DEMO_V2: '0' })).toBe(false);
  });
});

describe('seedDemoV2Files', () => {
  it('adds the teammates’ agents, tasks, a week of Insights rows and three projects, once', async () => {
    const data = await loadDemoData();
    await seedDemo(store, data, { now: NOW });
    expect(await seedDemoV2Files(store, tmp, data, NOW)).toBe(true);

    const ids = (await store.sessions.list()).map((s) => s.id);
    for (const mate of DEMO_V2_TEAMMATES) expect(ids).toContain(mate.id);
    expect(ids.length).toBe(data.sessions.length + DEMO_V2_TEAMMATES.length);

    const todos = store.db.prepare('SELECT state, COUNT(*) AS n FROM session_todos GROUP BY state ORDER BY state').all();
    expect(Object.fromEntries(todos.map((row) => [row['state'], Number(row['n'])]))).toEqual({ done: 7, in_progress: 6, open: 6 });
    const days = store.db.prepare('SELECT COUNT(DISTINCT day) AS n FROM insight_turns_daily').get();
    expect(Number(days?.['n'])).toBe(7);

    const plans = new DatabaseSync(path.join(tmp, 'plans.db'));
    try {
      expect(plans.prepare('SELECT title, state FROM plans ORDER BY title').all().map((row) => `${row['title']} · ${row['state']}`)).toEqual([
        'PROJ-123 Acme checkout · running',
        'PROJ-140 Acme alerts digest · done',
        'PROJ-150 Acme loyalty points · draft',
      ]);
      const states = plans.prepare("SELECT state, COUNT(*) AS n FROM plan_items WHERE plan_id = 'demo-v2-checkout' GROUP BY state ORDER BY state").all();
      expect(Object.fromEntries(states.map((row) => [row['state'], Number(row['n'])]))).toEqual({ done: 2, pending: 2, running: 3 });
      // Every step is a task of its project's agent.
      expect(Number(plans.prepare('SELECT COUNT(*) AS n FROM plan_items WHERE todo_id IS NULL').get()?.['n'])).toBe(0);
    } finally {
      plans.close();
    }

    expect(await store.settings.get(DEMO_V2_KEY)).toMatchObject({ files: true, api: false });
    // A second start writes nothing.
    expect(await seedDemoV2Files(store, tmp, data, NOW)).toBe(false);
    expect((await store.sessions.list()).length).toBe(data.sessions.length + DEMO_V2_TEAMMATES.length);
  });
});
