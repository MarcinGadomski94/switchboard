import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type Locator, type Page, expect, test } from '@playwright/test';
import type { SetupState } from '../../src/core/api.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { fakeClaudeCommand } from '../../tools/fake-claude/command.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { seedFolderInDataDir } from '../helpers/folders.ts';

/**
 * M5.3 oracle (E2E): the first-run setup wizard on the real code path (no demo
 * seed, D13): `node src/server/main.ts` with fake-claude and fake gh as the
 * configurable CLIs (tests/helpers/server-process.ts), a temp data folder and a
 * fixture workspace in a temp folder (the router AGENTS.md fixture, git repos
 * `microfrontends/web-front`, `mobile`, `deprecated/microfrontends/old-front`,
 * plain folders `nugets/ui-nuget`, `other/tool`, `infrastructure`).
 * 1. First run without a saved folder (D14): the wizard opens by itself and
 *    walks its five steps: the `claude --version` / `claude auth status` /
 *    `gh auth status` rows; "Add your first folder" (skippable: Continue with an
 *    empty field moves on and the scan says there is no folder yet; a git repo
 *    reads `✓ git repo · single solution`; a plain folder is refused and not
 *    added; the workspace chosen with Browse… is added with `POST /api/folders`
 *    and becomes the default); the real scan of it, the notification permission
 *    (mocked `Notification`) with its confirmation, the usage threshold; Back and
 *    the rail move between steps; Finish stores it. The folder is used at once (a
 *    session starts there) and after a restart; the wizard does not open again.
 * 2. Signed out (claude + gh), a folder saved already: failing rows, the saved
 *    folder shown with its check line, Skip / Esc close it, it stays closed in
 *    this tab and opens again in a new one because the setup is not finished.
 */

let tmp: string;
let workspace: string;
let gitEnv: Record<string, string>;
const ROUTER_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'workspace', 'router-AGENTS.md');
let routerLines = 0;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
}

async function makeRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
}

/** A `Notification` double: permission `default` until `requestPermission()` grants it; notifications are recorded. */
async function mockNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record: { requests: number; sent: Array<{ title: string; body: string }> } = { requests: 0, sent: [] };
    (window as unknown as { __wizard: typeof record }).__wizard = record;
    class MockNotification {
      static permission = 'default';
      static requestPermission(): Promise<string> {
        record.requests += 1;
        MockNotification.permission = 'granted';
        return Promise.resolve('granted');
      }
      onclick: (() => unknown) | null = null;
      constructor(title: string, options?: { body?: string }) {
        record.sent.push({ title, body: options?.body ?? '' });
      }
      close(): void {}
    }
    Object.defineProperty(window, 'Notification', { value: MockNotification, configurable: true, writable: true });
  });
}

async function setupState(page: Page): Promise<SetupState> {
  return page.evaluate(async () => (await (await fetch('/api/setup')).json()) as SetupState);
}

/** Loads `url` and waits until the first-run check (`GET /api/setup`) has answered. */
async function load(page: Page, url: string): Promise<void> {
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/setup');
  await page.goto(url);
  expect((await answered).status()).toBe(200);
  await expect(page.getByTestId('shell')).toBeVisible();
}

/**
 * Loads `url` in a tab where the wizard was closed unfinished: the first-run check
 * is not even asked (sessionStorage), so nothing can open it.
 */
async function loadSkipped(page: Page, url: string): Promise<void> {
  const setupCalls: string[] = [];
  const onRequest = (request: { url(): string }): void => {
    if (new URL(request.url()).pathname === '/api/setup') setupCalls.push(request.url());
  };
  page.on('request', onRequest);
  // Once the sidebar's sources have answered, the gate (mounted with them) has decided.
  const sidebar = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/system');
  await page.goto(url);
  await expect(page.getByTestId('shell')).toBeVisible();
  await sidebar;
  expect(await page.evaluate(() => sessionStorage.getItem('switchboard.setupSkipped'))).toBe('1');
  page.off('request', onRequest);
  expect(setupCalls).toEqual([]);
}

async function expectStep(wizard: Locator, index: number, title: string): Promise<void> {
  await expect(wizard.getByTestId('wz-pos')).toHaveText(`Step ${index + 1} of 5`);
  await expect(wizard.getByTestId('wz-title')).toHaveText(title);
  await expect(wizard).toHaveAttribute('data-step', String(index));
}

async function fakeLogCwds(logFile: string): Promise<string[]> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; cwd?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && entry.argv?.includes('--session-id'))
    .map((entry) => entry.cwd ?? '');
}

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-setup'));
  workspace = path.join(tmp, 'work space');
  const gitConfig = path.join(tmp, 'gitconfig');
  await writeFile(gitConfig, '');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  await mkdir(workspace, { recursive: true });
  await copyFile(ROUTER_FIXTURE, path.join(workspace, 'AGENTS.md'));
  const routerText = await readFile(ROUTER_FIXTURE, 'utf8');
  routerLines = routerText.split('\n').length - (routerText.endsWith('\n') ? 1 : 0);
  await makeRepo(path.join(workspace, 'microfrontends', 'web-front'));
  await makeRepo(path.join(workspace, 'mobile'));
  await makeRepo(path.join(workspace, 'deprecated', 'microfrontends', 'old-front'));
  await mkdir(path.join(workspace, 'nugets', 'ui-nuget'), { recursive: true });
  await mkdir(path.join(workspace, 'other', 'tool'), { recursive: true });
  await mkdir(path.join(workspace, 'infrastructure'), { recursive: true });
  // A folder without AGENTS.md, offered first and refused.
  await mkdir(path.join(tmp, 'not a workspace'), { recursive: true });
  await mkdir(path.join(tmp, 'claude-config'), { recursive: true });
});

test.afterAll(async () => {
  if (tmp) await removeTempDir(tmp);
});

test.describe('first run without a saved folder', () => {
  let server: ServerProcess | undefined;
  let env: Record<string, string>;
  const logFile = () => path.join(tmp, 'fake-first-run.log');

  test.beforeAll(async () => {
    env = {
      ...gitEnv,
      SWITCHBOARD_DATA_DIR: path.join(tmp, 'data-first-run'),
      SWITCHBOARD_SETUP_WIZARD: 'auto',
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      FAKE_CLAUDE_LOG: logFile(),
    };
    server = await startServer(env);
  });

  test.afterAll(async () => {
    if (server) expect(await server.stop()).toBe(0);
  });

  test('opens by itself and walks the five steps on the real services; the chosen root is used at once and after a restart', async ({ page }) => {
    test.setTimeout(90_000);
    if (!server) throw new Error('no server');
    await mockNotifications(page);
    await load(page, `${server.baseUrl}/`);
    const wizard = page.getByTestId('modal-setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard.locator('.sb-wz-brand')).toHaveText('SSet up Switchboard');
    await expect(wizard.locator('.sb-wz-note')).toHaveText('Everything stays on this PC. Switchboard never stores your Claude login.');
    const rail = wizard.getByTestId('wz-rail-step');
    await expect(rail).toHaveText(['1Claude Code CLI + login', '2Add your first folder', '3Scan solutions', '4Notifications', '5Usage warnings']);
    await expect(rail.nth(0)).toHaveAttribute('data-state', 'current');
    await expect(rail.nth(0).locator('.sb-wz-dot')).toHaveCSS('background-color', 'rgb(232, 231, 227)');

    // Step 1: the configured CLIs (fake-claude, fake gh), both signed in.
    await expectStep(wizard, 0, 'Claude Code on this PC');
    await expect(wizard.getByTestId('wz-text')).toHaveText(
      'Switchboard starts and drives Claude Code in the background, signed in with your Max plan. It also reads PR status through the GitHub CLI.',
    );
    const checks = wizard.getByTestId('wz-check');
    await expect(checks.locator('.sb-wz-check-label')).toHaveText(['Claude Code CLI found', 'Signed in', 'GitHub CLI signed in']);
    await expect(checks.locator('.sb-wz-check-detail')).toHaveText([
      fakeClaudeCommand().join(' '),
      'claude auth status · the login stays with Claude Code',
      'gh auth status · used to detect merged PRs',
    ]);
    await expect(checks.locator('.sb-wz-check-mark')).toHaveText(['✓', '✓', '✓']);
    await expect(checks.first().locator('.sb-wz-check-mark')).toHaveCSS('color', 'oklch(0.76 0.13 150)');
    await expect(wizard.getByTestId('wz-next')).toHaveText('Continue');

    // Step 2 (D14): "Add your first folder", nothing saved yet. It is skippable: Continue with an empty field moves on.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 1, 'Add your first folder');
    await expect(wizard.getByTestId('wz-text')).toHaveText(
      'A workspace (the folder that holds your router AGENTS.md) or a git repository. Each session picks its folder when it starts. You can skip this and add folders later in Settings → Folders.',
    );
    await expect(rail.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(rail.nth(0).locator('.sb-wz-dot')).toHaveText('✓');
    const input = wizard.getByTestId('wz-root-input');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'A workspace (router AGENTS.md) or a git repository');
    await expect(wizard.getByTestId('wz-root-line')).toHaveCount(0);
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 2, 'Solutions found');
    await expect(wizard.getByTestId('wz-scan-error')).toHaveText('No folder yet. Add one in step 2.');
    expect((await setupState(page)).folders).toEqual([]);
    await wizard.getByTestId('wz-back').click();
    await expectStep(wizard, 1, 'Add your first folder');

    // A missing folder, a git repo (fine, not added yet) and a folder without AGENTS.md (refused, not added).
    await input.fill(path.join(tmp, 'nope'));
    await expect(wizard.getByTestId('wz-root-line')).toHaveText('✕ folder not found');
    await expect(wizard.getByTestId('wz-root-line')).toHaveAttribute('data-ok', 'false');
    await input.fill(path.join(workspace, 'mobile'));
    await expect(wizard.getByTestId('wz-root-line')).toHaveText('✓ git repo · single solution');
    await expect(wizard.getByTestId('wz-root-line')).toHaveAttribute('data-ok', 'true');
    await input.fill(path.join(tmp, 'not a workspace'));
    await expect(wizard.getByTestId('wz-root-line')).toHaveText('✕ no AGENTS.md here and not a git repository');
    await wizard.getByTestId('wz-next').click();
    await expect(wizard.getByTestId('wz-root-error')).toHaveText('Not added: no AGENTS.md here and not a git repository');
    await expectStep(wizard, 1, 'Add your first folder');
    expect((await setupState(page)).folders).toEqual([]);

    // Browse…: from the typed folder's parent down to the workspace.
    await input.fill(tmp);
    await wizard.getByTestId('wz-browse').click();
    await expect(wizard.getByTestId('wz-browser-path')).toHaveText(tmp);
    await expect(wizard.getByTestId('wz-folder')).toContainText(['claude-config/', 'not a workspace/', 'work space/']);
    await wizard.getByTestId('wz-folder').filter({ hasText: /^work space\/$/ }).click();
    await expect(wizard.getByTestId('wz-browser-path')).toHaveText(workspace);
    await expect(wizard.getByTestId('wz-folder')).toHaveText(['deprecated/', 'infrastructure/', 'microfrontends/', 'mobile/', 'nugets/', 'other/']);
    await expect(input).toHaveValue(workspace);
    await expect(wizard.getByTestId('wz-root-error')).toHaveCount(0);
    await expect(wizard.getByTestId('wz-root-line')).toHaveText('✓ AGENTS.md (Workspace Router) · 6 solutions');
    await expect(wizard.getByTestId('wz-root-line')).toHaveCSS('color', 'oklch(0.76 0.13 150)');
    await wizard.getByTestId('wz-folder-up').click();
    await expect(wizard.getByTestId('wz-browser-path')).toHaveText(tmp);
    await wizard.getByTestId('wz-folder').filter({ hasText: /^work space\/$/ }).click();
    await expect(input).toHaveValue(workspace);

    // Continue adds the folder (POST /api/folders): the first one is the default.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 2, 'Solutions found');
    const saved = await setupState(page);
    expect(saved.folders).toMatchObject([
      { path: workspace, kind: 'workspace', isDefault: true, check: { kind: 'workspace', router: { title: 'AGENTS.md (Workspace Router)', lines: routerLines } } },
    ]);
    expect(saved.completedAt).toBeNull();

    // Step 3: the real scan of the chosen root.
    await expect(wizard.getByTestId('wz-text')).toHaveText('Scanned the folders your router defines. The folder rules are applied as written.');
    const rows = wizard.getByTestId('wz-scan-row');
    await expect(rows.locator('.sb-wz-scan-folder')).toHaveText(['microfrontends/', 'mobile/', 'nugets/', 'other/', 'deprecated/', 'infrastructure/']);
    await expect(rows.locator('.sb-wz-scan-count')).toHaveText(['1', '1', '1', '1', '1', '1']);
    await expect(rows.locator('.sb-wz-scan-examples')).toHaveText(['web-front', 'mobile', 'ui-nuget', 'tool', 'old-front', 'infrastructure']);
    await expect(rows.locator('.sb-wz-scan-rule')).toHaveText(['editable', 'editable', 'editable', 'on request only', 'read-only', 'read-only']);
    await expect(rows.nth(0).locator('.sb-wz-scan-rule')).toHaveCSS('color', 'rgb(141, 140, 135)');
    await expect(rows.nth(3).locator('.sb-wz-scan-rule')).toHaveCSS('color', 'oklch(0.72 0.1 70)');
    await expect(rows.nth(5).locator('.sb-wz-scan-rule')).toHaveCSS('color', 'oklch(0.72 0.1 70)');

    // Step 4: ask for notifications; granted → confirmed with an OS notification.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 3, 'Notifications');
    const permission = wizard.getByTestId('wz-permission');
    await expect(permission).toHaveText('not asked yet');
    await wizard.getByTestId('wz-allow-notifications').click();
    await expect(permission).toHaveText('✓ allowed');
    await expect(permission).toHaveCSS('color', 'oklch(0.74 0.13 150)');
    const record = await page.evaluate(() => (window as unknown as { __wizard: { requests: number; sent: Array<{ title: string; body: string }> } }).__wizard);
    expect(record).toEqual({ requests: 1, sent: [{ title: 'Switchboard', body: 'Notifications are on.' }] });

    // Step 5: the usage threshold (default 90%), just warn.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 4, 'Usage-limit warnings');
    await expect(wizard.getByTestId('wz-text')).toHaveText('You get a warning when your Max 5-hour window reaches the threshold. Nothing is paused automatically.');
    await expect(wizard.locator('.sb-wz-usage-row')).toHaveText('Warn at90%');
    await expect(wizard.locator('.sb-wz-usage-fill')).toHaveAttribute('style', 'width: 90%;');
    await expect(wizard.locator('.sb-wz-usage-note')).toHaveText('near limit → just warn');
    await expect(wizard.getByTestId('wz-next')).toHaveText('Finish');
    await expect(rail.locator('.sb-wz-dot')).toHaveText(['✓', '✓', '✓', '✓', '5']);

    // Back and the rail move between steps without saving anything.
    await wizard.getByTestId('wz-back').click();
    await expectStep(wizard, 3, 'Notifications');
    await rail.nth(1).click();
    await expectStep(wizard, 1, 'Add your first folder');
    await expect(input).toHaveValue(workspace);
    await rail.nth(4).click();
    await expectStep(wizard, 4, 'Usage-limit warnings');

    // Finish stores it and closes.
    await wizard.getByTestId('wz-next').click();
    await expect(wizard).toHaveCount(0);
    const done = await setupState(page);
    expect(done.completedAt).not.toBeNull();
    expect(done.autoOpen).toBe(false);

    // Not again on the next load.
    await load(page, `${server.baseUrl}/`);
    await expect(page.getByTestId('modal-setup-wizard')).toHaveCount(0);

    // The chosen folder is used at once: the scan answers and a session's process runs there.
    const solutions = await page.evaluate(async () => (await fetch('/api/solutions')).status);
    expect(solutions).toBe(200);
    const created = await page.evaluate(async () => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'after-setup', task: '', workType: 'feature', mode: 'single', solutions: ['web-front'], phase: 'ui-first', coordination: 'sequential', qa: null, worktrees: false, ultracode: false }),
      });
      return response.status;
    });
    expect(created).toBe(201);
    await expect.poll(() => fakeLogCwds(logFile())).toEqual([workspace]);

    // …and after a restart (the folder is stored in the database).
    expect(await server.stop()).toBe(0);
    server = await startServer(env);
    await load(page, `${server.baseUrl}/`);
    await expect(page.getByTestId('modal-setup-wizard')).toHaveCount(0);
    const after = await setupState(page);
    expect(after).toMatchObject({ completedAt: done.completedAt, autoOpen: false, folders: [{ path: workspace, isDefault: true }] });
    expect(await page.evaluate(async () => (await fetch('/api/solutions')).status)).toBe(200);
  });
});

test.describe('signed out, a folder saved already', () => {
  let server: ServerProcess | undefined;

  test.beforeAll(async () => {
    // D14: the workspace is a saved folder (the default) in the server's database.
    await seedFolderInDataDir(path.join(tmp, 'data-signed-out'), workspace);
    server = await startServer({
      ...gitEnv,
      SWITCHBOARD_DATA_DIR: path.join(tmp, 'data-signed-out'),
      SWITCHBOARD_SETUP_WIZARD: 'auto',
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'),
      FAKE_CLAUDE_SIGNED_OUT: '1',
      FAKE_GH_SIGNED_OUT: '1',
    });
  });

  test.afterAll(async () => {
    if (server) expect(await server.stop()).toBe(0);
  });

  async function openFresh(browser: Browser): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    return context.newPage();
  }

  test('failing checks, the saved folder shown, Skip and Esc close it for this tab only', async ({ browser }) => {
    if (!server) throw new Error('no server');
    const page = await openFresh(browser);
    await load(page, `${server.baseUrl}/inbox`);
    const wizard = page.getByTestId('modal-setup-wizard');
    await expect(wizard).toBeVisible();
    await expectStep(wizard, 0, 'Claude Code on this PC');
    const checks = wizard.getByTestId('wz-check');
    await expect(checks.locator('.sb-wz-check-label')).toHaveText(['Claude Code CLI found', 'Not signed in', 'GitHub CLI not signed in']);
    await expect(checks.locator('.sb-wz-check-detail')).toHaveText([
      fakeClaudeCommand().join(' '),
      'claude auth status · run claude in a terminal to sign in',
      'gh auth status failed · merged PRs are not detected',
    ]);
    await expect(checks.locator('.sb-wz-check-mark')).toHaveText(['✓', '✕', '✕']);
    await expect(checks.nth(1)).toHaveAttribute('data-ok', 'false');
    await expect(checks.nth(1).locator('.sb-wz-check-mark')).toHaveCSS('color', 'oklch(0.68 0.17 25)');

    // The saved (default) folder is shown with its check line.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 1, 'Add your first folder');
    const input = wizard.getByTestId('wz-root-input');
    await expect(input).toHaveValue(workspace);
    await expect(wizard.getByTestId('wz-browse')).toHaveCount(1);
    await expect(wizard.getByTestId('wz-root-line')).toHaveText('✓ AGENTS.md (Workspace Router) · 6 solutions');
    // Adding a saved folder again answers the one saved (200), nothing new.
    const again = await page.evaluate(async (folder) => {
      const response = await fetch('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) });
      return { status: response.status, body: (await response.json()) as { path: string } };
    }, workspace);
    expect(again).toMatchObject({ status: 200, body: { path: workspace } });
    // Continue does not add it again.
    await wizard.getByTestId('wz-next').click();
    await expectStep(wizard, 2, 'Solutions found');
    await expect(wizard.getByTestId('wz-scan-row')).toHaveCount(6);
    await wizard.getByTestId('wz-back').click();
    await wizard.getByTestId('wz-back').click();
    await expectStep(wizard, 0, 'Claude Code on this PC');
    await wizard.getByTestId('wz-back').click();
    await expectStep(wizard, 0, 'Claude Code on this PC');

    // Skip closes it; the setup is not finished; not again in this tab.
    await wizard.getByTestId('wz-skip').click();
    await expect(wizard).toHaveCount(0);
    expect(await setupState(page)).toMatchObject({ completedAt: null, autoOpen: true, folders: [{ path: workspace }] });
    await loadSkipped(page, `${server.baseUrl}/inbox`);
    await expect(page.getByTestId('modal-setup-wizard')).toHaveCount(0);

    // A new tab: it opens again (first run still not finished); Esc closes it too.
    const second = await openFresh(browser);
    await load(second, `${server.baseUrl}/`);
    await expect(second.getByTestId('modal-setup-wizard')).toBeVisible();
    await second.keyboard.press('Escape');
    await expect(second.getByTestId('modal-setup-wizard')).toHaveCount(0);
    await loadSkipped(second, `${server.baseUrl}/`);
    await expect(second.getByTestId('modal-setup-wizard')).toHaveCount(0);
    await page.context().close();
    await second.context().close();
  });
});
