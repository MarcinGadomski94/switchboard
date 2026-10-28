import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { DIFF_SCOPE_KEY } from '../../src/web/views/session/diff.ts';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';
import { type LargeRoot, makeLargeRoot } from '../helpers/large-root.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';
import { openWithHub } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D144 · v2: an agent in a large **non-git** multi-repo root (a synthetic temp tree:
 * thousands of files beside the one solution repo, agent worktrees under its
 * `.claude/worktrees`). Opening it shows the chat promptly, without waiting for the
 * Changes count; while the server still counts (its answer is `stale`), the tab
 * shows "…", then the number. Phone (390 × 844) and desktop.
 */
let tmp = '';
let big: LargeRoot;
let server: ServerProcess | undefined;
let sessionId = '';

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-v2-large-root'));
  const gitConfig = path.join(tmp, 'gitconfig');
  await writeFile(gitConfig, '');
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
  const gitEnv: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  big = await makeLargeRoot(tmp, { env: { ...process.env, ...gitEnv }, siblingFiles: 8_000, worktreeNodeModules: 500 });
  await seedFolderInDataDir(path.join(tmp, 'data'), big.root);
  await writeFile(path.join(tmp, 'fake-gh-prs.json'), '{}');
  server = await startServer({
    ...gitEnv,
    ...V2_SERVER_ENV,
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
    FAKE_GH_PRS: path.join(tmp, 'fake-gh-prs.json'),
  });
});

test.afterAll(async () => {
  try {
    if (server) expect(await server.stop()).toBe(0);
  } finally {
    if (tmp) await removeTempDir(tmp);
  }
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function startAgent(page: Page): Promise<string> {
  if (sessionId) return sessionId;
  if (!server) throw new Error('no server');
  await page.goto(`${server.baseUrl}/`);
  const result = await page.evaluate(
    async (body) => {
      const response = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as { id: string } };
    },
    { name: 'big-root', task: 'Reply with just OK.', workType: 'feature', mode: 'single', solutions: [big.solution], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false },
  );
  expect(result.status).toBe(201);
  sessionId = result.body.id;
  await expect
    .poll(async () => page.evaluate(async (id) => ((await (await fetch(`/api/sessions/${id}`)).json()) as { status: string }).status, sessionId), { timeout: 20_000 })
    .toMatch(/^(done|idle)$/);
  return sessionId;
}

/**
 * Opens the agent with the Changes count on "All uncommitted changes" (the solution's 5 changes), the server's
 * first two count answers made `stale` (as on a tree that takes long to count), the later ones real.
 */
async function openAgent(page: Page, id: string): Promise<{ readonly opened: number }> {
  if (!server) throw new Error('no server');
  await page.addInitScript(
    ({ key, session }) => {
      window.localStorage.setItem(key, JSON.stringify({ [session]: 'repo' }));
    },
    { key: DIFF_SCOPE_KEY, session: id },
  );
  let staleLeft = 2;
  await page.route(/\/api\/sessions\/[^/]+\/diff\/count/, async (route) => {
    if (staleLeft > 0) {
      staleLeft -= 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope: 'repo', files: 0, stale: true, at: null }) });
      return;
    }
    await route.continue();
  });
  const opened = Date.now();
  await openWithHub(page, `${server.baseUrl}/agents/${id}`);
  return { opened };
}

for (const layout of [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
] as const) {
  test(`${layout.name}: the chat shows promptly; the Changes count reads "…" while counted, then the number`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    const id = await startAgent(page);
    const { opened } = await openAgent(page, id);
    await expect(page.getByTestId('v2-agent-you').first()).toContainText('Reply with just OK.', { timeout: 5_000 });
    expect(Date.now() - opened).toBeLessThan(5_000);
    if (layout.name === 'desktop') {
      const count = page.getByTestId('v2-agent-tabs').locator('[data-tab="changes"] .v2-tab-n');
      await expect(count).toHaveText('…');
      await page.screenshot({ path: path.join('test-results', 'v2-large-root-counting.png') });
      await expect(count).toHaveText('5', { timeout: 15_000 });
    } else {
      // The phone folds the tab row into the header's ⋯ menu: "Changes · …", then "Changes · 5".
      await page.getByTestId('v2-agent-menu').click();
      const item = page.getByTestId('v2-agent-menu-list').locator('[data-item="tab-changes"]');
      await expect(item).toContainText('Changes · …');
      await page.screenshot({ path: path.join('test-results', 'v2-large-root-counting-phone.png') });
      await expect(item).toContainText('Changes · 5', { timeout: 15_000 });
    }
  });
}
