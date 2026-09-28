import { stat } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { LoginServiceStatus } from '../../src/core/login-service.ts';
import { type ServiceWorld, startServiceWorld } from './service-world.ts';

/**
 * "Start at login" in Settings (M9.1) on the real code path (D13): the toggle →
 * `PUT /api/service` → `LoginService` writes this OS's service definition into
 * the redirected temp home and registers it with the fake service manager; off
 * removes it. A refusal (no Node ≥ 24 on PATH) shows the service's message.
 */

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function serviceStatus(page: Page): Promise<LoginServiceStatus> {
  return page.evaluate(async () => (await (await fetch('/api/service')).json()) as LoginServiceStatus);
}

test.describe('Start at login', () => {
  let world: ServiceWorld;

  test.beforeAll(async () => {
    world = await startServiceWorld();
  });

  test.afterAll(async () => {
    if (world) expect(await world.stop()).toBe(0);
  });

  test('the toggle registers and removes the per-user service', async ({ page }) => {
    await page.goto(`${world.server.baseUrl}/settings`);
    const row = page.locator('[data-row="start-at-login"]');
    await expect(row).toContainText('Start at login');
    await expect(row).toContainText('Launch the service when you sign in (Windows / macOS)');
    const toggle = page.getByTestId('start-at-login');
    await expect(toggle).toHaveText('off');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    const before = await serviceStatus(page);
    expect(before.startAtLogin).toBe(false);
    const file = before.file ?? '';
    expect(file.startsWith(world.home) || file.startsWith(path.join(world.root, 'data'))).toBe(true);
    expect(await exists(file)).toBe(false);

    await toggle.click();
    await expect(toggle).toHaveText('on');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toHaveAttribute('title', `Registered: ${file} · click to turn off`);
    expect(await exists(file)).toBe(true);

    // It is the service's state, not the page's: a reload still shows it.
    await page.reload();
    await expect(page.getByTestId('start-at-login')).toHaveText('on');

    await page.getByTestId('start-at-login').click();
    await expect(page.getByTestId('start-at-login')).toHaveText('off');
    expect(await exists(file)).toBe(false);
    await expect(page.getByTestId('start-at-login-error')).toHaveCount(0);

    // Only this platform's manager commands ran, all against the fake.
    const calls = (await world.ctlCalls()).map((argv) => argv.join(' '));
    if (process.platform === 'darwin') expect(calls).toEqual([]);
    if (process.platform === 'linux') expect(calls).toEqual(['--user daemon-reload', '--user enable switchboard.service', '--user disable switchboard.service', '--user daemon-reload']);
  });

  test('other settings sections do not show the row (M8.2 fills them)', async ({ page }) => {
    await page.goto(`${world.server.baseUrl}/settings/tools`);
    await expect(page.getByTestId('view-settings')).toHaveAttribute('data-section', 'tools');
    await expect(page.getByTestId('start-at-login')).toHaveCount(0);
  });
});

test.describe('Start at login without node on PATH', () => {
  let world: ServiceWorld;

  test.beforeAll(async ({}, testInfo) => {
    // The server itself runs from process.execPath; only its PATH lacks node.
    world = await startServiceWorld({ PATH: path.join(testInfo.outputDir, 'no-bin') });
  });

  test.afterAll(async () => {
    if (world) expect(await world.stop()).toBe(0);
  });

  test('shows the refusal and stays off', async ({ page }) => {
    await page.goto(`${world.server.baseUrl}/settings/claude`);
    const toggle = page.getByTestId('start-at-login');
    await expect(toggle).toHaveText('off');
    await toggle.click();
    await expect(page.getByTestId('start-at-login-error')).toHaveText('Node.js ≥ 24 must be on PATH: no node was found there.');
    await expect(toggle).toHaveText('off');
    await expect(toggle).toBeEnabled();
    expect((await serviceStatus(page)).startAtLogin).toBe(false);
    expect(await world.ctlCalls()).toEqual([]);
  });
});
