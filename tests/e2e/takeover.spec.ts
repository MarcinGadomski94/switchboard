import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { remoteId } from '../../src/core/peers.ts';
import { makeTempDir } from '../helpers/net.ts';
import { type PeerNode, waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';

/**
 * D65 oracle (`docs/peers.md` → *Taking a session over*): two real Switchboards
 * (the pc and the mac), fake CLIs, temp repos with a local bare repo as the shared
 * remote. The session's header offers **Take over to this machine**, the dialog
 * shows what happens to each repo, the steps run, the chat of the new session
 * starts with "Taken over from pc-office", and the pc's session says "Moved to
 * mac-laptop". Each machine's UI is its own browser context.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-takeover');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

async function pageOf(browser: import('@playwright/test').Browser, target: PeerNode, route: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(`${target.baseUrl}${route}`);
  return page;
}

test('a pc session is taken over to the mac: the dialog, its progress, the divider, the "Moved to" note', async ({ browser }) => {
  const w = (world = await takeoverWorld(tmp));
  const started = await startRepoSession(w.a, w.folders.a.alpha as string, 'fix-login');
  await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/login');
  await writeFile(path.join(w.paths.a.alpha, 'tracked.txt'), 'edited on the pc\n');
  await writeFile(path.join(w.paths.a.alpha, 'notes.txt'), 'new on the pc\n');

  // The mac's UI, on the pc's session: the header offers the take-over.
  const page = await pageOf(browser, w.b, `/sessions/${encodeURIComponent(remoteId(w.aId, started.id))}`);
  const action = page.getByTestId('session-takeover');
  await expect(action).toHaveText('Take over to this machine');
  await action.click();

  // The dialog: both machines' view before anything changes.
  const dialog = page.getByTestId('takeover-dialog');
  await expect(page.getByTestId('takeover-title')).toHaveText('Take over from pc-office');
  await expect(page.getByTestId('takeover-sub')).toContainText('pc-office → mac-laptop');
  const repo = dialog.getByTestId('takeover-repo');
  await expect(repo).toHaveCount(1);
  await expect(repo).toHaveAttribute('data-action', 'use');
  await expect(repo.getByTestId('takeover-repo-branch')).toHaveText('feature/login');
  await expect(repo.getByTestId('takeover-repo-work')).toContainText('2 uncommitted files');
  await expect(repo.getByTestId('takeover-repo-summary')).toContainText('check out feature/login');
  await expect(page.getByTestId('takeover-cli')).toContainText('Claude Code on the account “Default” of mac-laptop');
  await expect(page.getByTestId('takeover-hooked-warning')).toHaveCount(0);
  await expect(page.getByTestId('takeover-blockers')).toHaveCount(0);

  // Start: the steps run one after the other and all end done.
  await page.getByTestId('takeover-start').click();
  const steps = page.getByTestId('takeover-step');
  await expect(steps).toHaveCount(7);
  await expect(page.getByTestId('takeover-headline')).toHaveText('Taken over', { timeout: 60_000 });
  for (const [index, step] of ['checks', 'stop', 'capture', 'transfer', 'apply', 'resume', 'finish'].entries()) {
    await expect(steps.nth(index)).toHaveAttribute('data-step', step);
    await expect(steps.nth(index)).toHaveAttribute('data-status', 'done');
  }
  await expect(page.getByTestId('takeover-leftover')).toHaveCount(0);
  // The git commands are listed on request.
  await page.getByTestId('takeover-log-toggle').click();
  await expect(page.getByTestId('takeover-log')).toContainText('commit-tree');

  // Open the new session: its chat starts with the divider, the header says where it came from.
  await page.getByTestId('takeover-open').click();
  await expect(page.getByTestId('takeover-dialog')).toHaveCount(0);
  await expect(page.getByTestId('chat-divider').first()).toContainText('Taken over from pc-office');
  await expect(page.getByTestId('session-taken-over-note')).toHaveText('Taken over from pc-office');
  await expect(page.getByTestId('session-machine')).toHaveCount(0);
  const created = (await w.b.call('GET', '/api/sessions')).body as Session[];
  const moved = created.find((session) => session.movedFrom?.sessionId === started.id) as Session;
  expect(page.url()).toContain(`/sessions/${moved.id}`);
  // The mac has the work as it was.
  expect(await readFile(path.join(w.paths.b.alpha, 'tracked.txt'), 'utf8')).toBe('edited on the pc\n');
  expect(await w.git(w.paths.b.alpha, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login');

  // The pc's own page: the old session is closed and says where it went; it cannot be reopened.
  const pcPage = await pageOf(browser, w.a, `/sessions/${started.id}`);
  await expect(pcPage.getByTestId('session-moved-note')).toContainText('Moved to mac-laptop');
  await expect(pcPage.getByTestId('session-moved-link')).toHaveAttribute('href', new RegExp(`/sessions/r~${w.bId}~${moved.id}`));
  await expect(pcPage.getByTestId('session-close')).toBeDisabled();
  await expect(pcPage.getByTestId('session-takeover')).toHaveCount(0);
  await expect(pcPage.getByTestId('chat-divider').last()).toContainText('Moved to mac-laptop');
});

test('a session of this machine moves to the peer: the header names the machine; a missing repo asks where to clone it', async ({ browser }) => {
  const w = (world = await takeoverWorld(tmp, { aRepos: { alpha: true, gamma: true }, bRepos: { alpha: true } }));
  const started = await startRepoSession(w.a, w.folders.a.gamma as string, 'gamma-work');
  await writeFile(path.join(w.paths.a.gamma, 'tracked.txt'), 'gamma edit\n');

  const page = await pageOf(browser, w.a, `/sessions/${started.id}`);
  const action = page.getByTestId('session-takeover');
  await expect(action).toHaveText('Move to mac-laptop ▸');
  await expect(action).toHaveAttribute('data-direction', 'move');
  await action.click();

  const dialog = page.getByTestId('takeover-dialog');
  await expect(page.getByTestId('takeover-title')).toHaveText('Move to mac-laptop');
  const repo = dialog.getByTestId('takeover-repo');
  await expect(repo).toHaveAttribute('data-action', 'clone');
  const clonePath = repo.getByTestId('takeover-clone-path');
  await expect(clonePath).toHaveValue(path.join(path.dirname(w.paths.b.alpha), 'gamma'));
  // An empty path blocks Start; a typed one is what is cloned.
  await clonePath.fill('');
  await expect(page.getByTestId('takeover-start')).toBeDisabled();
  const typed = path.join(tmp, 'b', 'typed', 'gamma');
  await clonePath.fill(typed);
  await clonePath.blur();
  await expect(repo.getByTestId('takeover-repo-summary')).toContainText(`clone ${w.remotes.gamma} into ${typed}`);
  await page.getByTestId('takeover-start').click();
  await expect(page.getByTestId('takeover-headline')).toHaveText('Taken over', { timeout: 60_000 });
  await page.getByTestId('takeover-open').click();
  // The new session lives on the mac: this page now shows it as a remote session.
  await expect(page.getByTestId('session-machine')).toContainText('mac-laptop');
  await waitFor('the clone', async () => (await w.git(typed, 'status', '--porcelain')).includes('tracked.txt'));
});
