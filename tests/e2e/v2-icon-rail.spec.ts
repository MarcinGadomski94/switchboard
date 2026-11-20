import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D181 · the icon rail (`docs/v2.md` → *Shell*): icons only, a tooltip with the name on hover
 * and on keyboard focus, Pinned and Recent open beside the rail (Esc closes and gives the focus
 * back), Recent lists as many agents as Settings › Appearance says, and Results is Artifacts.
 */
let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-icon-rail', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('icons only, with a tooltip on hover and on focus; Artifacts', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const rail = page.getByTestId('v2-rail');
  await expect(rail).toBeVisible();
  // 64 px at every width the rail shows (it was 232 px on a desktop).
  expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(64);
  await expect(page.getByTestId('v2-nav-results')).toHaveAccessibleName('Artifacts');
  await page.getByTestId('v2-nav-agents').hover();
  await expect(page.getByTestId('v2-rail-tip')).toHaveText('Agents');
  await page.mouse.move(700, 450);
  await expect(page.getByTestId('v2-rail-tip')).toHaveCount(0);
  await page.getByTestId('v2-nav-results').focus();
  await expect(page.getByTestId('v2-rail-tip')).toHaveText('Artifacts');
  await page.getByTestId('v2-nav-results').click();
  await expect(page).toHaveURL(/\/results$/);
  await expect(page.getByRole('heading', { name: 'Artifacts' }).first()).toBeVisible();
});

test('Pinned and Recent open beside the rail; Esc closes and gives the focus back; Recent follows Settings', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`${world.baseUrl}/`);
  await page.evaluate(() => {
    window.localStorage.removeItem('switchboard.v2.recent');
    window.localStorage.removeItem('switchboard.v2.recentCount');
  });
  // Pinned: the hint while nothing is pinned.
  const pinsButton = page.getByTestId('v2-rail-pins-button');
  await pinsButton.click();
  await expect(pinsButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('v2-rail-pins-flyout')).toContainText('Pin agents or crews from their ⋯ menu.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('v2-rail-pins-flyout')).toHaveCount(0);
  await expect(pinsButton).toBeFocused();

  // Three agents opened: Recent lists them, newest first.
  const ids: string[] = [];
  for (const name of ['acme-one', 'acme-two', 'acme-three']) {
    const session = await world.startSession(page, name, 'Reply with just OK.');
    ids.push(session.id);
    await page.goto(`${world.baseUrl}/agents/${session.id}`);
    await expect(page.getByTestId('v2-agent-title')).toBeVisible();
  }
  const recentButton = page.getByTestId('v2-rail-recent-button');
  await recentButton.click();
  const items = page.getByTestId('v2-rail-recent-flyout').getByTestId('v2-recent-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-session', ids[2] as string);
  // A pick opens the agent and closes the list.
  await items.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${ids[1]}$`));
  await expect(page.getByTestId('v2-rail-recent-flyout')).toHaveCount(0);

  // Pin one: it shows in Pinned (and leaves Recent); a screenshot of Home with Pinned open.
  await page.getByTestId('v2-agent-menu').click();
  await page.getByRole('menuitem', { name: 'Pin to sidebar' }).click();
  await page.goto(`${world.baseUrl}/`);
  await pinsButton.click();
  await expect(page.getByTestId('v2-rail-pins').getByTestId('v2-pin-agent')).toHaveCount(1);
  await page.mouse.move(900, 600);
  await page.screenshot({ path: path.join(os.tmpdir(), 'd181-shots', 'home-pinned-1440.png') });
  await page.keyboard.press('Escape');

  // Settings › Appearance › Recent agents: 1, then 0 (Recent and its button go).
  await page.goto(`${world.baseUrl}/settings/appearance`);
  const count = page.getByTestId('v2-recent-count');
  await expect(count).toHaveValue('5');
  await count.selectOption('1');
  await recentButton.click();
  await expect(page.getByTestId('v2-rail-recent-flyout').getByTestId('v2-recent-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await count.selectOption('0');
  await expect(recentButton).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('v2-recent-count')).toHaveValue('0');
  await expect(page.getByTestId('v2-rail-recent-button')).toHaveCount(0);
});
