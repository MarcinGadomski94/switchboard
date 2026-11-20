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
