import { expect, test } from '@playwright/test';
import type { TeamView } from '../../src/core/team.ts';
import { makeTempDir } from '../helpers/net.ts';
import { waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';

/**
 * D100 · the Team page between two paired machines (T3; the D65 take-over behind it):
 * the header says "⇄ synced with <PC>"; the member's ⋯ → Move to <PC>… opens the
 * move dialog, which shows the checks of both machines first and moves only on
 * Move; the card then runs on the other machine.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-team-move');
  world = await takeoverWorld(tmp);
});

test.afterAll(async () => {
  if (world) {
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
    await removeWorld(tmp);
  }
});

test('move dialog: the checks first, then Move; the member runs on the other machine', async ({ page }) => {
  test.setTimeout(150_000);
  const w = world as TakeoverWorld;
  for (const node of [w.a, w.b]) expect((await node.call('PUT', '/api/settings', { 'experimental.team': true })).status).toBe(200);
  const session = await startRepoSession(w.a, w.folders.a.alpha as string, 'tracker-run');
  const adopted = await w.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Tracker' });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
  const bName = ((await w.a.call('GET', '/api/machines')).body as { machines: Array<{ id: string; name: string }> }).machines.find((m) => m.id === w.bId)?.name as string;
  await waitFor('the session to be idle', async () => ((await w.a.call('GET', `/api/sessions/${session.id}`)).body as { status: string }).status !== 'run');

  await page.goto(`${w.a.baseUrl}/team`);
  await expect(page.getByTestId('team-synced')).toHaveText(`⇄ synced with ${bName}`);
  const card = page.getByTestId('team-card').filter({ hasText: 'Tracker' });
  await expect(card.getByTestId('team-card-machine')).not.toHaveText(bName);
  await card.getByTestId('team-card-menu').click();
  await page.getByTestId('team-member-menu').locator(`[data-testid="team-menu-move"][data-machine-id="${w.bId}"]`).click();

  const dialog = page.getByTestId('team-move-dialog');
  await expect(dialog).toContainText(`Move Tracker to ${bName}`);
  // The checks come first; nothing moves until Move.
  await expect(dialog.getByTestId('team-move-check')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByTestId('team-move-check')).toHaveAttribute('data-ok', 'true');
  const before = (await w.a.call('GET', '/api/team')).body as TeamView;
  expect(before.members.find((m) => m.name === 'Tracker')?.machineId).toBe(w.aId);
  await dialog.getByTestId('team-move-start').click();
  await expect(dialog.getByTestId('team-move-run')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  await dialog.getByTestId('team-move-close').click();
  await expect(card.getByTestId('team-card-machine')).toHaveText(bName, { timeout: 20_000 });
});
