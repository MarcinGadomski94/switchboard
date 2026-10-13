import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D100 (E2E, real code path with fake-claude): Settings → Experimental → Team
 * switches Team on; an adopted member's session leaves the sidebar's SESSIONS
 * while the other session stays; switching Team off in Settings puts it back.
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-team');
  const workspace = path.join(tmp, 'work space');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  await seedFolderInDataDir(path.join(tmp, 'data'), workspace);
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    SWITCHBOARD_TUTORIAL: 'off',
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { method, url, body },
  );
}

async function start(page: Page, name: string): Promise<string> {
  const answer = await call(page, 'POST', '/api/sessions', { name, task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body.id as string;
}

function row(page: Page, id: string) {
  return page.getByTestId('sidebar-sessions').locator(`a.sb-session[data-session-id="${id}"]`);
}

async function flipTeam(page: Page, to: 'on' | 'off'): Promise<void> {
  await page.goto(`${server.baseUrl}/settings/experimental`);
  const toggle = page.locator('[data-row="experimental-team"]').getByTestId('setting-value');
  await expect(toggle).toHaveText(to === 'on' ? 'off' : 'on');
  await toggle.click();
  await expect(toggle).toHaveText(to);
}

test('Team on: an adopted session leaves the sidebar; Team off: it is back', async ({ page }) => {
  await page.goto(`${server.baseUrl}/inbox`);
  const tracker = await start(page, 'tracker-run');
  const other = await start(page, 'other-run');
  await expect(row(page, tracker)).toBeVisible();
  await expect(row(page, other)).toBeVisible();

  // Off by default: the switch reads off and nothing is hidden.
  await flipTeam(page, 'on');
  const adopted = await call(page, 'POST', '/api/team/members', { sessionId: tracker, name: 'Tracker' });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
  await expect(row(page, tracker)).toHaveCount(0);
  await expect(row(page, other)).toBeVisible();

  await flipTeam(page, 'off');
  await expect(row(page, tracker)).toBeVisible();
  await expect(row(page, other)).toBeVisible();
});
