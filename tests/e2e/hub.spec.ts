import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * The page's `/hub` client (src/web/api/useHub.ts) over the real SSE route
 * (M2.3, D5) on the real code path (no demo seed, D13): `node src/server/main.ts`
 * with fake-claude as the CLI and a temp workspace. A session started through the
 * API shows up in the sidebar without a reload, because the sidebar reloads its
 * list on `sessionUpdated`, which only the hub delivers (it never polls).
 */
let tmp: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-hub');
  const workspace = path.join(tmp, 'work space');
  const claudeConfig = path.join(tmp, 'claude-config');
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeConfig, { recursive: true });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_WORKSPACE_ROOT: workspace,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_SCENARIO: 'tool-use',
  });
});

test.afterAll(async () => {
  // SIGTERM → app.close(): the open /hub stream must not keep the server from exiting cleanly.
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

test('the sidebar follows a new session live through /hub (sessionUpdated), without a reload', async ({ page }) => {
  const sessionListLoads: number[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/sessions' && response.request().method() === 'GET') sessionListLoads.push(response.status());
  });
  const hubResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/hub');

  await page.goto(`${server.baseUrl}/`);
  await expect(page.getByTestId('shell')).toBeVisible();
  const hub = await hubResponse;
  expect(hub.status()).toBe(200);
  expect(hub.headers()['content-type']).toBe('text/event-stream');
  await expect(page.getByTestId('sidebar-sessions').locator('a')).toHaveCount(0);
  await expect.poll(() => sessionListLoads.length).toBe(1);

  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documents.push(request.url());
  });

  // Started through the API from the page itself (same origin, the sb_token cookie).
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'hub-live',
        task: 'Write out.txt, then run a command.',
        workType: 'feature',
        mode: 'single',
        solutions: ['acme-app-front'],
        phase: 'ui-first',
        coordination: 'none',
        qa: null,
        worktrees: false,
        ultracode: false,
      }),
    });
    return response.status;
  });
  expect(status).toBe(201);

  const row = page.getByTestId('sidebar-sessions').locator('a');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.sb-session-name')).toHaveText('hub-live');
  expect(sessionListLoads.length).toBeGreaterThan(1);
  expect(sessionListLoads.every((code) => code === 200)).toBe(true);
  expect(documents).toEqual([]);
});
