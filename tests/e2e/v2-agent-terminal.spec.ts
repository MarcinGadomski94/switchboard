import path from 'node:path';
import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D182 · the terminal at the bottom of an agent's conversation (`docs/terminals.md` → *The agent's
 * terminal*): Terminal starts it in the agent's folder (the program prints its folder), what you
 * type reaches it, Both shows the message box and the terminal together, the header has no Changes
 * or Helpers tab, and leaving the agent closes the terminal on the server. The program is a
 * deterministic Node echo (`SWITCHBOARD_TEST_TERMINAL_ARGV`), never a real shell.
 */

const ECHO = "process.stdout.write('ready in '+process.cwd()+'\\r\\n');process.stdin.on('data',(d)=>{const t=String(d).trim();if(t)process.stdout.write('echo:'+t+'\\r\\n');});";

let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-agent-terminal', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory', SWITCHBOARD_TEST_TERMINAL_ARGV: JSON.stringify([process.execPath, '-e', ECHO]) } });
});

test.afterAll(async () => {
  await world?.stop();
});

test('2026-11-20: the tabs share one row with the status line and Stop background tasks, in every mode', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  // A background command that keeps running: the status line offers Stop background tasks (D164).
  const { id } = await world.startSession(page, 'acme-bg-row', '[fake:background 60 sleep 60]');
  await page.goto(`${world.baseUrl}/agents/${id}`);
  const stop = page.getByTestId('v2-agent-stop-background');
  await expect(stop).toBeVisible({ timeout: 30_000 });
  const modes = page.getByTestId('v2-agent-dock-modes');
  const bar = page.getByTestId('v2-agent-bottom-bar');
  // One row: the status line (with Stop background tasks) and the tabs, in the dock's header row.
  await expect(bar.getByTestId('v2-agent-status')).toBeVisible();
  await expect(bar.getByTestId('v2-agent-dock-modes')).toBeVisible();
  const centre = async (box: { y: number; height: number } | null): Promise<number> => (box ? box.y + box.height / 2 : Number.NaN);
  const stopY = await centre(await stop.boundingBox());
  const modesY = await centre(await modes.boundingBox());
  expect(Math.abs(stopY - modesY)).toBeLessThan(4);
  // The tabs are right of the button.
  expect(((await modes.boundingBox())?.x ?? 0) > ((await stop.boundingBox())?.x ?? 0)).toBe(true);
  if (process.env['DOCK_ROW_SHOTS']) await page.screenshot({ path: path.join(process.env['DOCK_ROW_SHOTS'], 'dock-row-1440.png') });
  // Terminal: the same row stays above the terminal, so you can switch back.
  await modes.locator('[data-value="terminal"]').click();
  await expect(page.getByTestId('v2-agent-terminal')).toBeVisible();
  await expect(stop).toBeVisible();
  const terminalTop = (await page.getByTestId('v2-agent-terminal').boundingBox())?.y ?? 0;
  expect(((await modes.boundingBox())?.y ?? Number.POSITIVE_INFINITY) < terminalTop).toBe(true);
  await modes.locator('[data-value="message"]').click();
  await expect(page.getByTestId('v2-agent-input')).toBeVisible();
});

test('Terminal in the agent’s folder, Both with the message box, closed when you leave the agent', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'acme-terminal', 'Reply with just OK.');
  await world.settle(page, id);
  await page.goto(`${world.baseUrl}/agents/${id}`);

  // D182: Changes and Helpers are the side panel's, not the header's.
  const header = page.getByTestId('v2-agent-tabs');
  await expect(header.getByRole('tab', { name: 'Chat' })).toBeVisible();
  await expect(header.getByRole('tab', { name: /Changes/ })).toHaveCount(0);
  await expect(header.getByRole('tab', { name: /Helpers/ })).toHaveCount(0);

  // Message first; Terminal starts the terminal in the agent's folder.
  const modes = page.getByTestId('v2-agent-dock-modes');
  await expect(modes.locator('[data-value="message"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-agent-input')).toBeVisible();
  await modes.locator('[data-value="terminal"]').click();
  const terminal = page.getByTestId('v2-agent-terminal');
  const screen = terminal.getByTestId('v2-terminal-screen');
  await expect(screen.locator('.xterm-rows')).toContainText('ready in', { timeout: 15_000 });
  await expect(screen.locator('.xterm-rows')).toContainText(path.basename(world.workspace));
  await expect(page.getByTestId('v2-agent-input')).toBeHidden();
  await screen.click();
  await page.keyboard.type('acme');
  await page.keyboard.press('Enter');
  await expect(screen.locator('.xterm-rows')).toContainText('echo:acme', { timeout: 15_000 });
  const terminalId = (await terminal.getAttribute('data-terminal-id')) as string;
  expect(terminalId).toBeTruthy();
  // Not on the Terminals page.
  expect((await world.call(page, 'GET', '/api/terminals')).body.terminals).toEqual([]);

  // Both: the message box and the same terminal at once.
  await modes.locator('[data-value="both"]').click();
  await expect(page.getByTestId('v2-agent-input')).toBeVisible();
  await expect(terminal).toBeVisible();
  await expect(page.getByTestId('v2-agent-dock-handle')).toBeVisible();
  await expect(terminal).toHaveAttribute('data-terminal-id', terminalId);
  await expect(screen.locator('.xterm-rows')).toContainText('echo:acme');
  await page.screenshot({ path: path.join(process.env['D182_SHOTS'] ?? 'test-results', 'agent-terminal-both-1440.png') });

  // Leaving the agent closes the terminal on the server.
  expect((await world.call(page, 'GET', `/api/terminals/${terminalId}`)).status).toBe(200);
  await page.getByTestId('v2-nav-home').click();
  await expect(page.getByTestId('v2-page-home')).toBeVisible();
  await expect.poll(async () => (await world.call(page, 'GET', `/api/terminals/${terminalId}`)).status, { timeout: 10_000 }).toBe(404);

  // Back: Both is remembered, and a new terminal starts.
  await page.goto(`${world.baseUrl}/agents/${id}`);
  await expect(page.getByTestId('v2-agent-dock-modes').locator('[data-value="both"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('v2-agent-terminal').getByTestId('v2-terminal-screen').locator('.xterm-rows')).toContainText('ready in', { timeout: 15_000 });
  await expect(page.getByTestId('v2-agent-terminal')).not.toHaveAttribute('data-terminal-id', terminalId);
});
