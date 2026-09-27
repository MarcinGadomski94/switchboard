import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * Real browser check of gap #20: loading the UI sets an HttpOnly, SameSite=Strict
 * `sb_token` cookie that the page's own API calls carry, and a browser without it
 * gets 401. Runs the real `node src/server/main.ts` on a 4871–4879 test port with
 * a temp data dir (no demo seed).
 */
let tmp: string;
let server: ServerProcess;
let token: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-security');
  const dataDir = path.join(tmp, 'data');
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
  token = (await readFile(path.join(dataDir, 'sb_token'), 'utf8')).trim();
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test('UI load sets the sb_token cookie and the page can call the API', async ({ page, context }) => {
  await page.goto(`${server.baseUrl}/`);
  await expect(page).toHaveTitle('Switchboard');

  const cookies = await context.cookies(server.baseUrl);
  const sb = cookies.find((cookie) => cookie.name === 'sb_token');
  expect(sb).toBeDefined();
  expect(sb).toMatchObject({ value: token, httpOnly: true, sameSite: 'Strict', path: '/', domain: '127.0.0.1', expires: -1 });

  // HttpOnly: invisible to page scripts, but sent with same-origin requests.
  expect(await page.evaluate(() => document.cookie)).not.toContain('sb_token');
  const status = await page.evaluate(async () => (await fetch('/api/sessions')).status);
  expect(status).toBe(404); // past the guard; the route itself comes in a later item
});

test('without the cookie the API answers 401', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const response = await context.request.get(`${server.baseUrl}/api/sessions`);
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  } finally {
    await context.close();
  }
});
