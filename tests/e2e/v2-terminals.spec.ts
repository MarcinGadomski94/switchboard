import { expect, test } from '@playwright/test';
import { stubToolProbes } from './probes.ts';
import { type TeamWorld, startTeamWorld } from './team-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D170 · Terminals (`docs/terminals.md`), on the real path: Terminals → New terminal opens a
 * pseudo-terminal on this computer and its page; what you type reaches the program and its
 * answer shows in the xterm screen; the list shows it with Close, and Close ends it. The
 * program is a deterministic Node echo (`SWITCHBOARD_TEST_TERMINAL_ARGV`), never a real shell.
 */

const ECHO = "process.stdout.write('ready\\r\\n');process.stdin.on('data',(d)=>{const t=String(d).trim();if(t)process.stdout.write('echo:'+t+'\\r\\n');});";

let world: TeamWorld;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await startTeamWorld('e2e-v2-terminals', { plain: true, env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory', SWITCHBOARD_TEST_TERMINAL_ARGV: JSON.stringify([process.execPath, '-e', ECHO]) } });
});

test.afterAll(async () => {
  await world?.stop();
});

test('open a terminal on this computer, type, see the answer, close it', async ({ page }) => {
  test.setTimeout(90_000);
  await stubToolProbes(page);
  await page.goto(`${world.baseUrl}/terminals`);
  await expect(page.getByTestId('v2-terminals-empty')).toBeVisible();
  await page.getByTestId('v2-terminals-new').click();
  await expect(page.getByTestId('v2-new-terminal')).toBeVisible();
  await expect(page.getByTestId('v2-new-terminal-open')).toBeEnabled();
  await page.getByTestId('v2-new-terminal-open').click();

  await expect(page.getByTestId('v2-page-terminal')).toBeVisible();
  await expect(page.getByTestId('v2-page-terminal')).toHaveAttribute('data-link', 'open', { timeout: 15_000 });
  const screen = page.getByTestId('v2-terminal-screen');
  await expect(screen.locator('.xterm-rows')).toContainText('ready', { timeout: 15_000 });
  await screen.click();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect(screen.locator('.xterm-rows')).toContainText('echo:hello', { timeout: 15_000 });

  // It keeps running when you leave: the list shows it, and Close ends it.
  await page.goto(`${world.baseUrl}/terminals`);
  await expect(page.getByTestId('v2-terminals-row')).toHaveCount(1);
  await page.getByTestId('v2-terminals-close').click();
  await expect(page.getByTestId('v2-terminals-empty')).toBeVisible();
  expect((await world.call(page, 'GET', '/api/terminals')).body.terminals).toEqual([]);
});
