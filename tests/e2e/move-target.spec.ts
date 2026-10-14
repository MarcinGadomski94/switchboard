import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { makeTempDir } from '../helpers/net.ts';
import { waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';

/**
 * D110 oracle (`docs/peers.md` → *Target folders and verification*): two real
 * Switchboards (the pc and the mac), fake CLIs, temp repos with local bare repos
 * as the shared remotes. The mac keeps the repo under another folder and another
 * name, unsaved. In the Move dialog the developer chooses folders on the mac
 * (browsing them through the peer API); the table shows ✓ / ⚠ / ✖ per repo, Move
 * is enabled only when every repo is found or cloned, and the move uses exactly
 * the chosen checkout. `MOVE_TARGET_SHOTS=<dir>` saves the screenshots.
 */

const SHOTS = process.env['MOVE_TARGET_SHOTS'] ?? null;

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-move-target');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

test('the Move dialog: choose folders on the mac, the ✓ / ⚠ / ✖ table, a pick among several, Move uses that checkout', async ({ browser }) => {
  test.setTimeout(180_000);
  const w = (world = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true } }));
  const code = path.dirname(w.paths.b.alpha);
  const clone = async (dir: string): Promise<string> => {
    await mkdir(path.dirname(dir), { recursive: true });
    await w.git(path.dirname(dir), 'clone', '-q', w.remotes.gamma, dir);
    return realpath(dir);
  };
  const onMac = await clone(path.join(code, 'elsewhere', 'gamma-mac'));
  const dirty = await clone(path.join(code, 'old', 'gamma'));
  await writeFile(path.join(dirty, 'scratch.txt'), 'local work\n');
  const started = await startRepoSession(w.a, w.folders.a.gamma as string, 'gamma-work');
  await writeFile(path.join(w.paths.a.gamma, 'tracked.txt'), 'gamma edit\n');

  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${w.a.baseUrl}/sessions/${started.id}`);
  await page.getByTestId('session-takeover').click();
  const dialog = page.getByTestId('takeover-dialog');
  const repo = dialog.getByTestId('takeover-repo');
  const mark = repo.getByTestId('takeover-repo-mark');
  const start = page.getByTestId('takeover-start');

  // The mac's saved folders do not hold gamma: ⚠ clone first (as before D110).
  await expect(repo).toHaveAttribute('data-action', 'clone');
  await expect(mark).toHaveText('⚠');
  await expect(page.getByTestId('takeover-folders-saved')).toHaveText('its saved folders');
  await expect(repo.getByTestId('takeover-repo-remote')).toHaveText(w.remotes.gamma);
  await expect(repo.getByTestId('takeover-repo-work')).toContainText('1 uncommitted file');

  // Choose folders…: the mac's saved folders and home, then browse its code folder (folders only).
  await page.getByTestId('takeover-folders-toggle').click();
  await expect(page.getByTestId('takeover-place').first()).toBeVisible();
  await expect(page.getByTestId('takeover-place').filter({ hasText: 'Home' })).toHaveCount(1);
  await page.getByTestId('takeover-folder-path').fill(code);
  await page.getByTestId('takeover-folder-open').click();
  const folders = page.getByTestId('takeover-folder');
  await expect(folders.filter({ hasText: 'elsewhere/' })).toHaveCount(1);
  await expect(folders.filter({ hasText: 'alpha (git)/' })).toHaveCount(1);
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/move-target-picker.png` });
  // A folder outside the mac's home and saved folders is refused.
  await page.getByTestId('takeover-folder-path').fill(path.join(tmp, 'remotes'));
  await page.getByTestId('takeover-folder-open').click();
  await expect(page.getByTestId('takeover-folder-error')).toContainText('outside the home folder and the saved folders');
  await page.getByTestId('takeover-folder-path').fill(code);
  await page.getByTestId('takeover-folder-open').click();
  await folders.filter({ hasText: 'elsewhere/' }).click();
  await expect(page.getByTestId('takeover-browser-path')).toHaveText(path.join(await realpath(code), 'elsewhere'));
  await page.getByTestId('takeover-folder-use').click();

  // ✓: found by its remote under another name; Move is enabled.
  await expect(page.getByTestId('takeover-root')).toHaveCount(1);
  await expect(repo).toHaveAttribute('data-state', 'found');
  await expect(mark).toHaveText('✓');
  await expect(repo.getByTestId('takeover-repo-summary')).toContainText(`Use ${onMac}; check out main`);
  await expect(start).toBeEnabled();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/move-target-found.png` });

  // A second folder with another checkout of it: ⚠ several, choose one; Move waits.
  await page.getByTestId('takeover-folders-toggle').click();
  await page.getByTestId('takeover-folder-path').fill(path.join(code, 'old'));
  await page.getByTestId('takeover-folder-use').click();
  await expect(page.getByTestId('takeover-root')).toHaveCount(2);
  await expect(repo).toHaveAttribute('data-state', 'ambiguous');
  await expect(mark).toHaveText('⚠');
  await expect(repo.getByTestId('takeover-repo-choice')).toHaveCount(2);
  await expect(start).toBeDisabled();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/move-target-several.png` });

  // The dirty one: ✖ (a main-checkout session needs a clean checkout there).
  await repo.getByTestId('takeover-repo-choice').filter({ hasText: dirty }).click();
  await expect(mark).toHaveText('✖');
  await expect(repo).toHaveAttribute('data-state', 'differs');
  await expect(repo.getByTestId('takeover-repo-summary')).toContainText('1 uncommitted file there');
  await expect(start).toBeDisabled();
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/move-target-blocked.png` });

  // Another checkout…: the clean one; ✓ again, then Move uses exactly that path.
  await repo.getByTestId('takeover-repo-other').click();
  const override = repo.getByTestId('takeover-repo-override');
  await override.fill(onMac);
  await override.blur();
  await expect(mark).toHaveText('✓');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByTestId('takeover-headline')).toHaveText('Taken over', { timeout: 60_000 });
  const created = await waitFor('the session on the mac', async () => ((await w.b.call('GET', '/api/sessions')).body as Session[]).find((session) => session.movedFrom?.sessionId === started.id) ?? null);
  expect(created.cwd).toBe(onMac);
  expect(await w.git(onMac, 'status', '--porcelain')).toContain('tracked.txt');
  // The dirty checkout was never touched.
  expect(await w.git(dirty, 'status', '--porcelain')).toBe('?? scratch.txt');
});
