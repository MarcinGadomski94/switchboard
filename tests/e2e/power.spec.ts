import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SystemInfo } from '../../src/core/api.ts';
import type { PowerStatus } from '../../src/core/power.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { openDrawer } from './responsive-world.ts';

/**
 * D125 oracle (E2E, `docs/power.md`): the real code path (`node
 * src/server/main.ts`, no demo seed) with this machine's power reading from
 * `SWITCHBOARD_POWER_TEST_FILE` (sampled every 300 ms), so the battery and the
 * desktop variants are deterministic. The sidebar footer's power line at desktop
 * and phone width (shorter on phones, the details in the tooltip, a sentence for
 * screen readers), and Settings → Machines' line and Power estimate.
 */

const AT = '2026-10-21T10:00:00.000Z';
const DISCHARGING: PowerStatus = { kind: 'battery', percent: 64, charging: false, pluggedIn: false, minutesLeft: 130, watts: 9.5, at: AT };
const CHARGING: PowerStatus = { kind: 'battery', percent: 81, charging: true, pluggedIn: true, minutesToFull: 35, at: AT };
const DESKTOP: PowerStatus = { kind: 'estimated', watts: 210, parts: { gpu: 120, gpuCount: 1, cpu: 50, cpuPct: 35, base: 40 }, at: AT };

let tmp: string;
let server: ServerProcess;
let powerFile: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-power');
  powerFile = path.join(tmp, 'power.json');
  await writeFile(powerFile, JSON.stringify(DISCHARGING));
  server = await startServer({ SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'), SWITCHBOARD_POWER_TEST_FILE: powerFile, SWITCHBOARD_POWER_SAMPLE_MS: '300' });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** Writes this machine's reading and waits until `GET /api/system` reports it. */
async function report(page: Page, power: PowerStatus): Promise<void> {
  await writeFile(powerFile, JSON.stringify(power));
  await expect
    .poll(async () => {
      const answer = await page.request.get(`${server.baseUrl}/api/system`);
      const info = (await answer.json()) as SystemInfo;
      return { ...info.power, at: AT };
    })
    .toEqual({ ...power, at: AT });
}

test('the footer: battery discharging / charging and a desktop\'s estimate at desktop width', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await report(page, DISCHARGING);
  await page.reload();
  const row = page.getByTestId('power-meter');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-state', 'discharging');
  await expect(row.locator('.sb-power-icon')).toHaveText('🔋');
  await expect(row.locator('.sb-power-long')).toHaveText('64% · 2h10');
  await expect(row.locator('.sb-power-short')).toBeHidden();
  await expect(row).toHaveAttribute('title', "Battery 64% · discharging\n2h10 left (the OS's estimate)\nDraw: 9.5 W");
  await expect(page.getByTestId('power-meter-label')).toHaveText('Battery 64%, discharging, 2 hours 10 minutes left');
  // Right under RAM, in the meters' label column.
  await expect(page.getByTestId('machine-footer').locator('.sb-meter, .sb-power').locator('> span:first-child')).toHaveText(['CPU', 'RAM', 'PWR']);

  await report(page, CHARGING);
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'charging');
  await expect(row.locator('.sb-power-icon')).toHaveText('⚡');
  await expect(row.locator('.sb-power-long')).toHaveText('81% · 35m to full');

  await report(page, DESKTOP);
  await page.reload();
  await expect(row).toHaveAttribute('data-state', 'estimated');
  await expect(row.locator('.sb-power-icon')).toHaveCount(0);
  await expect(row.locator('.sb-power-long')).toHaveText('~210 W');
  expect(await row.getAttribute('title')).toContain('CPU: 50 W (estimated from 35% CPU)');
  await expect(page.getByTestId('power-meter-label')).toHaveText('Estimated power draw about 210 watts');
});

test('the footer on a phone: the shorter text in the drawer', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await stubToolProbes(page);
  await page.goto(`${server.baseUrl}/`);
  await report(page, CHARGING);
  await page.reload();
  await openDrawer(page);
  const row = page.getByTestId('power-meter');
  await expect(row).toBeVisible();
  await expect(row.locator('.sb-power-short')).toBeVisible();
  await expect(row.locator('.sb-power-short')).toHaveText('81% · 35m');
  await expect(row.locator('.sb-power-long')).toBeHidden();
  const box = await row.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);

  await report(page, DESKTOP);
  await page.reload();
  await openDrawer(page);
  await expect(row.locator('.sb-power-short')).toHaveText('~210 W');
  await context.close();
});

test('Settings → Machines: this machine\'s line and the Power estimate (saved, defaults as placeholders, reset)', async ({ page }) => {
  await page.goto(`${server.baseUrl}/`);
  await report(page, DESKTOP);
  await page.goto(`${server.baseUrl}/settings/machines`);
  await expect(page.getByTestId('machines-self-power')).toContainText('~210 W (estimated)');
  const row = page.locator('[data-row="power-estimate"]');
  await expect(row).toBeVisible();
  const idle = page.getByTestId('power-estimate-cpuIdleW');
  await expect(idle).toHaveValue('');
  expect(Number(await idle.getAttribute('placeholder'))).toBeGreaterThan(0);
  await page.getByTestId('power-estimate-baseW').fill('25');
  await page.getByTestId('power-estimate-cpuMaxW').fill('95');
  await page.getByTestId('power-estimate-save').click();
  await expect(page.getByTestId('power-estimate-note')).toContainText('Saved');
  const stored = await (await page.request.get(`${server.baseUrl}/api/settings`)).json();
  expect(stored['power.estimate']).toEqual({ cpuIdleW: null, cpuMaxW: 95, baseW: 25 });
  // Idle above max is refused before saving.
  await idle.fill('120');
  await page.getByTestId('power-estimate-save').click();
  await expect(page.getByTestId('power-estimate-note')).toContainText('CPU idle must not be above CPU max');
  await idle.fill('');
  await page.getByTestId('power-estimate-reset').click();
  await expect(page.getByTestId('power-estimate-baseW')).toHaveValue('');
  const reset = await (await page.request.get(`${server.baseUrl}/api/settings`)).json();
  expect(reset['power.estimate']).toEqual({ cpuIdleW: null, cpuMaxW: null, baseW: null });
});
