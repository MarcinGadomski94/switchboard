import { expect, test } from '@playwright/test';
import { openWithHub } from './question-world.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';

/**
 * D99 / D76 follow-up 2026-10-19 (`docs/sidebar.md` → *Where runs appear*): a plan item's run
 * session shows in the sidebar under its source session's folder (Acme / Releases), right after
 * the source, not at the root of SESSIONS. Real path: fake-claude, temp git, fake gh.
 */

let world: PlansWorld;

test.beforeAll(async () => {
  world = await startPlansWorld();
});

test.afterAll(async () => {
  await world?.stop();
});

test('a plan item starting shows its session under the source\'s folder, right after the source', async ({ page }) => {
  test.setTimeout(90_000);
  await openWithHub(page, `${world.baseUrl}/inbox`);
  await world.setPlans(page, true);
  const source = await world.sourceSession(page, 'release-source');
  const acme = await world.call(page, 'POST', '/api/sidebar/folders', { name: 'Acme' });
  expect(acme.status).toBe(201);
  const releases = await world.call(page, 'POST', '/api/sidebar/folders', { name: 'Releases', parentId: acme.body.folders.find((f: { name: string }) => f.name === 'Acme').id });
  expect(releases.status).toBe(201);
  const releasesId = releases.body.folders.find((f: { name: string }) => f.name === 'Releases').id as string;
  expect((await world.call(page, 'POST', '/api/sidebar/place', { sessionId: source, place: 'folder', folderId: releasesId })).status).toBe(200);

  const created = await world.call(page, 'POST', '/api/plans', { sourceSessionId: source, title: 'Release 2.0', targetBranch: world.target, baseBranch: 'main' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const planId = created.body.id as string;
  expect((await world.call(page, 'POST', `/api/plans/${planId}/items`, { key: 'PROJ-7', todo: { title: 'Write the release notes', estimateMinutes: 20 } })).status).toBe(201);

  const sessions = page.getByTestId('sidebar-sessions');
  const sourceRow = sessions.locator(`a.sb-session[data-session-id="${source}"]`);
  await expect(sourceRow).toHaveAttribute('data-group-folder', releasesId);

  expect((await world.call(page, 'POST', `/api/plans/${planId}/start`, { mergeMode: 'agents' })).status).toBe(200);
  const run = (await world.itemIn(page, planId, 'PROJ-7', 'running')).runSessionId as string;
  const runRow = sessions.locator(`a.sb-session[data-session-id="${run}"]`);
  await expect(runRow).toHaveAttribute('data-group-folder', releasesId);
  await expect(runRow).toHaveAttribute('data-group', 'folder');
  // Right after its source in the folder (not at the top of the loose list).
  const order = await sessions.locator('a.sb-session').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-id')));
  expect(order.indexOf(run)).toBe(order.indexOf(source) + 1);
});
