import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeNpmBinEnv } from '../../tools/fake-npm/command.ts';
import { fakeServiceCtlEnv } from '../../tools/fake-servicectl/command.ts';
import { type FakeGitHub, apiRelease, releaseAssets, startFakeGitHub } from '../helpers/fake-github.ts';
import { parseSemVer } from '../../src/core/semver.ts';
import { REPO_ROOT, freeTestPorts, makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * D55 "Updates from GitHub releases" on the real code path (D13, no demo): the
 * server checks a fake GitHub (loopback, `SWITCHBOARD_UPDATE_API`) at start.
 * A release install gets the banner → What's new (the notes as Markdown) →
 * Update → the confirmation → download, checksum, unpack, `npm ci` (tools/fake-npm),
 * the switch (the login service re-registered in a temp home with
 * tools/fake-servicectl) and the restart request; a git checkout only gets the
 * notes and the git commands, the Inbox item and Settings → Updates.
 */

/** The version the server under test runs (this checkout's `package.json`). */
const RUNNING = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** The release the fake GitHub offers: the next minor of {@link RUNNING}, so the spec survives every version bump. */
const OFFERED = ((): string => {
  const running = parseSemVer(RUNNING);
  if (!running) throw new Error(`package.json version "${RUNNING}" is not semver`);
  return `${running.major}.${running.minor + 1}.0`;
})();

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

interface World {
  readonly root: string;
  readonly github: FakeGitHub;
  readonly server: ServerProcess;
}

async function startWorld(kind: 'release' | 'git'): Promise<World> {
  const root = await makeTempDir(`updates-${kind}`);
  const [port] = await freeTestPorts();
  const github = await startFakeGitHub(port !== undefined ? { port } : {});
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  github.state.status = 200;
  github.state.release = apiRelease(OFFERED, { body: "## What's new\n\n- Updates from **GitHub releases**\n- Faster `npm ci`" });
  github.state.assets = await releaseAssets(assets, OFFERED);
  const server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(root, 'data'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    SWITCHBOARD_UPDATES: 'on',
    SWITCHBOARD_UPDATE_API: github.origin,
    SWITCHBOARD_UPDATE_REPO: github.repo,
    SWITCHBOARD_UPDATE_TEST_INSTALL: kind,
    SWITCHBOARD_NPM_BIN: fakeNpmBinEnv(),
    SWITCHBOARD_SERVICE_HOME: path.join(root, 'home'),
    SWITCHBOARD_SERVICE_CTL: fakeServiceCtlEnv(),
    FAKE_SERVICECTL_LOG: path.join(root, 'servicectl.log'),
    ...(kind === 'release' ? { SWITCHBOARD_UPDATE_TEST_UNDER_SERVICE: '1' } : {}),
  });
  return { root, github, server };
}

async function stopWorld(world: World | undefined): Promise<void> {
  if (!world) return;
  await world.server.stop();
  await world.github.close();
  await removeTempDir(world.root);
}

async function ctlCalls(world: World): Promise<string[]> {
  try {
    return (await readFile(path.join(world.root, 'servicectl.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(' '));
  } catch {
    return [];
  }
}

test.describe('Updates: a release install', () => {
  let world: World | undefined;

  test.beforeAll(async () => {
    world = await startWorld('release');
  });

  test.afterAll(async () => {
    await stopWorld(world);
  });

  test('banner → What\'s new → Update → confirm → installed, switched, restart requested', async ({ page }) => {
    if (!world) throw new Error('no world');
    await page.goto(world.server.baseUrl);
    const banner = page.getByTestId('update-banner');
    await expect(banner).toHaveAttribute('data-kind', 'available');
    await expect(page.getByTestId('update-banner-text')).toHaveText(`Switchboard ${OFFERED} is available`);
    await expect(page.getByTestId('update-banner-update')).toBeVisible();

    await page.getByTestId('update-banner-whats-new').click();
    const dialog = page.getByTestId('update-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.sb-update-title')).toHaveText(`Switchboard ${OFFERED}`);
    await expect(page.getByTestId('update-dialog-sub')).toContainText(`You run ${RUNNING} · release install`);
    // The notes as Markdown: a heading, bold, inline code.
    await expect(page.getByTestId('update-notes').locator('h2')).toHaveText("What's new");
    await expect(page.getByTestId('update-notes').locator('strong')).toHaveText('GitHub releases');
    await expect(page.getByTestId('update-notes').locator('code')).toHaveText('npm ci');

    await page.getByTestId('update-start').click();
    await expect(page.getByTestId('update-confirm')).toContainText(`Switchboard downloads ${OFFERED}, checks its SHA-256 checksum, installs its dependencies and switches to it`);
    await expect(page.getByTestId('update-confirm')).toContainText('Then it restarts through its login service.');
    await page.getByTestId('update-confirm-button').click();

    // The server asks for the restart and exits (0) once the update is in place.
    expect(await world.server.closed).toBe(0);
    const data = path.join(world.root, 'data');
    const target = path.join(data, 'versions', OFFERED);
    expect(JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')).version).toBe(OFFERED);
    expect(await exists(path.join(target, 'node_modules', '.fake-npm-ci'))).toBe(true);
    expect(await exists(path.join(target, 'dist', 'web', 'index.html'))).toBe(true);
    const ledger = JSON.parse(await readFile(path.join(data, 'updates', 'installs.json'), 'utf8')) as { current: { version: string; dir: string } };
    expect(ledger.current).toEqual({ version: OFFERED, dir: target });
    // Downloaded from the release's asset URLs (through the CDN redirect), checksum first.
    expect(world.github.requests.filter((p) => p.startsWith('/cdn/'))).toEqual([`/cdn/switchboard-${OFFERED}.tar.gz.sha256`, `/cdn/switchboard-${OFFERED}.tar.gz`]);

    // The login service now starts the new version.
    if (process.platform === 'darwin') {
      const plist = await readFile(path.join(world.root, 'home', 'Library', 'LaunchAgents', 'local.switchboard.plist'), 'utf8');
      expect(plist).toContain(path.join(target, 'src', 'server', 'main.ts'));
      // The detached helper: bootout + bootstrap after the exit.
      await expect.poll(() => ctlCalls(world as World), { timeout: 15_000 }).toEqual([
        `bootout gui/${process.getuid?.() ?? 0}/local.switchboard`,
        `bootstrap gui/${process.getuid?.() ?? 0} ${path.join(world.root, 'home', 'Library', 'LaunchAgents', 'local.switchboard.plist')}`,
      ]);
    }
    if (process.platform === 'linux') {
      const unit = await readFile(path.join(world.root, 'home', '.config', 'systemd', 'user', 'switchboard.service'), 'utf8');
      expect(unit).toContain(`WorkingDirectory=${target}`);
      expect(await ctlCalls(world)).toContain('--user restart --no-block switchboard.service');
    }
  });
});

test.describe('Updates: a git checkout', () => {
  let world: World | undefined;

  test.beforeAll(async () => {
    world = await startWorld('git');
  });

  test.afterAll(async () => {
    await stopWorld(world);
  });

  test('notifies only: notes and git commands, the Inbox item, Settings → Updates', async ({ page }) => {
    if (!world) throw new Error('no world');
    await page.goto(world.server.baseUrl);
    await expect(page.getByTestId('update-banner-text')).toHaveText(`Switchboard ${OFFERED} is available`);
    await expect(page.getByTestId('update-banner-update')).toHaveCount(0);
    await page.getByTestId('update-banner-whats-new').click();
    await expect(page.getByTestId('update-git')).toContainText(`git merge --ff-only v${OFFERED}`);
    await expect(page.getByTestId('update-start')).toHaveCount(0);
    await page.getByTestId('update-close').click();

    // The Inbox item: What's new closes it and opens Settings → Updates.
    await page.goto(`${world.server.baseUrl}/inbox`);
    const detail = page.getByTestId('inbox-detail');
    await expect(detail).toContainText(`Switchboard ${OFFERED} is available`);
    await expect(detail).toContainText('from a git checkout');
    await detail.getByRole('button', { name: "What's new" }).click();
    await expect(page).toHaveURL(`${world.server.baseUrl}/settings/updates`);
    await expect(page.getByTestId('settings-title')).toHaveText('Updates');
    await expect(page.locator('[data-row="updates-version"] [data-testid="setting-value"]')).toHaveText(RUNNING);
    await expect(page.locator('[data-row="updates-install"] [data-testid="setting-value"]')).toHaveText('git checkout');
    await expect(page.locator('[data-row="updates-latest"] [data-testid="setting-value"]')).toHaveText(OFFERED);
    await expect(page.locator('[data-row="updates-last-check"] [data-testid="setting-value"]')).toContainText('GitHub API');
    await expect(page.getByTestId('updates-git')).toBeVisible();
    await expect(page.getByTestId('updates-update')).toHaveCount(0);

    // A failed check shows its error line; the next good one clears it.
    world.github.state.status = 500;
    await page.getByTestId('updates-check').click();
    await expect(page.getByTestId('updates-error')).toHaveText("Can't reach releases: GitHub answered HTTP 500.");
    world.github.state.status = 200;
    await page.getByTestId('updates-check').click();
    await expect(page.getByTestId('updates-error')).toHaveCount(0);

    // × hides that version's banner, also after a reload.
    await page.getByTestId('update-banner-dismiss').click();
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('settings-title')).toHaveText('Updates');
    await expect(page.getByTestId('update-banner')).toHaveCount(0);
  });
});
