import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { TeamView } from '../../src/core/team.ts';
import { makeTempDir } from '../helpers/net.ts';
import { machineOn, waitFor } from '../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, startRepoSession, takeoverWorld } from '../helpers/takeover.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D100 × D65 · v2's Move to computer… between two paired machines (fake claude, temp repos,
 * a local bare remote): a move whose take-over fails half-way stays in the dialog as a
 * failure with its reason (the teammate still on this computer, never a success toast);
 * while the other computer is offline the menu entry says so and nothing moves; once it is
 * back the move succeeds and the teammate's card shows the other computer.
 */

let tmp: string;
let world: TakeoverWorld | null = null;
let memberId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-v2-team-move');
  world = await takeoverWorld(tmp, { env: { ...V2_SERVER_ENV, SWITCHBOARD_TEST_SECRET_STORE: 'memory', SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_PEER_GRACE_MS: '3000' } });
  const session = await startRepoSession(world.a, world.folders.a.alpha as string, 'dev-run');
  const adopted = await world.a.call('POST', '/api/team/members', { sessionId: session.id, name: 'Developer' });
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
  memberId = (adopted.body as { id: string }).id;
});

test.afterAll(async () => {
  if (world) {
    await Promise.all([world.a.server.stop(), world.b.server.stop()]);
    world = null;
  }
  await removeWorld(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function machineOfMember(w: TakeoverWorld): Promise<string | undefined> {
  return ((await w.a.call('GET', '/api/team')).body as TeamView).members.find((member) => member.id === memberId)?.machineId;
}

async function openMoveDialog(page: Page) {
  const card = page.locator(`[data-testid="v2-teammate"][data-member="${memberId}"]`);
  await card.getByTestId('v2-teammate-menu').click();
  await page.getByRole('menuitem', { name: 'Move to computer…' }).click();
  return page.getByTestId('v2-move-computer');
}

test('a move that fails half-way shows the failure and its reason in the dialog; the teammate stays', async ({ page }) => {
  test.setTimeout(150_000);
  const w = world as TakeoverWorld;
  // The target's branch of the same name has a commit this machine lacks: the take-over cannot restore it there.
  await w.git(w.paths.a.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.a.alpha, 'a-side.txt'), 'from a\n');
  await w.git(w.paths.a.alpha, 'add', '-A');
  await w.git(w.paths.a.alpha, 'commit', '-q', '-m', 'a commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', '-b', 'feature/clash');
  await writeFile(path.join(w.paths.b.alpha, 'b-side.txt'), 'from b\n');
  await w.git(w.paths.b.alpha, 'add', '-A');
  await w.git(w.paths.b.alpha, 'commit', '-q', '-m', 'b commit');
  await w.git(w.paths.b.alpha, 'checkout', '-q', 'main');

  await page.goto(`${w.a.baseUrl}/crews/team`);
  const dialog = await openMoveDialog(page);
  await dialog.getByTestId('v2-move-computer-option').filter({ hasText: 'mac-laptop' }).click();
  await dialog.getByTestId('v2-move-computer-go').click();
  const progress = dialog.getByTestId('v2-move-computer-progress');
  await expect(progress).toHaveAttribute('data-state', 'moving', { timeout: 30_000 });
  await expect(progress).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  await expect(progress).toContainText('Couldn’t move Developer to mac-laptop: Restoring the working tree here failed');
  await expect(progress).toContainText('has commits the original does not have');
  await expect(progress).toContainText('Developer still runs on pc-office.');
  // Still open, Move offered again; no success toast.
  await expect(dialog.getByTestId('v2-move-computer-go')).toHaveText('Try again');
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'now runs on' })).toHaveCount(0);
  expect(await machineOfMember(w)).toBe(w.aId);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await w.git(w.paths.b.alpha, 'branch', '-q', '-D', 'feature/clash');
});

test('while the other computer is offline the menu entry says so; once it is back the move succeeds and the card shows it', async ({ page }) => {
  test.setTimeout(150_000);
  const w = world as TakeoverWorld;
  expect((await w.b.call('POST', '/api/test/peers/outage', { ms: 120_000 })).status).toBe(204);
  await waitFor('A sees B offline', async () => (await machineOn(w.a, w.bId))?.state === 'offline', 30_000);
  await page.goto(`${w.a.baseUrl}/crews/team`);
  const card = page.locator(`[data-testid="v2-teammate"][data-member="${memberId}"]`);
  await card.getByTestId('v2-teammate-menu').click();
  const entry = page.getByRole('menuitem', { name: 'Move to computer…' });
  await expect(entry).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.v2-menu-why').filter({ hasText: 'mac-laptop is not online; it can move once it reconnects.' })).toBeVisible();
  await page.keyboard.press('Escape');

  expect((await w.b.call('DELETE', '/api/test/peers/outage')).status).toBe(204);
  await waitFor('A sees B online', async () => (await machineOn(w.a, w.bId))?.state === 'online', 30_000);
  const dialog = await openMoveDialog(page);
  await dialog.getByTestId('v2-move-computer-option').filter({ hasText: 'mac-laptop' }).click();
  await dialog.getByTestId('v2-move-computer-go').click();
  // Success only once the record names the other computer: the dialog closes, the toast says so, the card shows it.
  await expect(dialog).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Developer now runs on mac-laptop.' })).toBeVisible();
  expect(await machineOfMember(w)).toBe(w.bId);
  await expect(card.getByTestId('v2-computer-tag')).toHaveAttribute('title', 'Runs on mac-laptop', { timeout: 20_000 });
});
