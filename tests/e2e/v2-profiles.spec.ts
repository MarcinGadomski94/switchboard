import { type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import type { UserProfile } from '../../src/core/user-profiles.ts';
import { type PlansWorld, startPlansWorld } from './plans-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D165 · the rail's profile switcher with many profiles (Default, Bo without a password, Ann with
 * one): the menu lists them all with the active one checked; Bo switches at once (the page reloads
 * in Bo, and Default's agent is not there); Ann asks for her password (a wrong one is refused, the
 * right one switches); back to Default shows its agent again.
 */

let world: PlansWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startPlansWorld(V2_SERVER_ENV);
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function listed(page: Page): Promise<string[]> {
  return ((await world.call(page, 'GET', '/api/sessions')).body as Session[]).map((session) => session.id);
}

async function choose(page: Page, name: string): Promise<void> {
  await page.getByTestId('v2-profile-switcher').click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
}

test('switch between many profiles from the rail; a password guards Ann', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${world.baseUrl}/agents`);
  const own = await world.sourceSession(page, 'v2-profiles-default');
  const bo = (await world.call(page, 'POST', '/api/user-profiles', { name: 'Bo', color: 'amber' })).body as UserProfile;
  const ann = (await world.call(page, 'POST', '/api/user-profiles', { name: 'Ann', color: 'green', password: 'ann-secret' })).body as UserProfile;
  expect(bo.id).toBeTruthy();
  expect(ann.hasPassword).toBe(true);
  await page.reload();

  const switcher = page.getByTestId('v2-profile-switcher');
  await expect(switcher).toHaveAttribute('data-active', 'default');
  await switcher.click();
  const menu = page.getByTestId('v2-profile-menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(4);
  await page.keyboard.press('Escape');
  expect(await listed(page)).toContain(own);

  await choose(page, 'Bo');
  await expect(switcher).toHaveAttribute('data-active', bo.id);
  expect(await listed(page)).not.toContain(own);

  await choose(page, 'Ann');
  const dialog = page.getByTestId('v2-profile-password');
  await expect(dialog).toBeVisible();
  await page.getByTestId('v2-profile-password-input').fill('wrong');
  await page.getByTestId('v2-profile-password-go').click();
  await expect(dialog.getByRole('alert')).toContainText('not right');
  await page.getByTestId('v2-profile-password-input').fill('ann-secret');
  await page.getByTestId('v2-profile-password-go').click();
  await expect(switcher).toHaveAttribute('data-active', ann.id);

  await choose(page, 'Default');
  await expect(switcher).toHaveAttribute('data-active', 'default');
  expect(await listed(page)).toContain(own);
});
