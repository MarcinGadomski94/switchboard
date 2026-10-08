import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import type { Session } from '../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type PeerNode, pairedNodes, waitFor } from '../helpers/peers.ts';

/**
 * D74 follow-up oracle (`docs/responsive.md` → *Header actions in a narrow session column*):
 * at desktop window widths the session column can still be narrow (the right panel and the
 * sidebar open). The header's actions adapt to the width the header has: every action stays
 * inside the session column (left of the right panel); "Move to <machine> ▸" shortens to
 * "Move ▸" first, then the actions that do not fit move into ⋯ (Move, Continue in terminal,
 * Remote, Close first; the pickers and Pause last), where they stay reachable. The tabs and
 * the chips stay inside the column too.
 */
const LONG_MACHINE = 'Marcins-Very-Long-PC-Name';
const ACTIONS = ['session-cli', 'session-account', 'session-model', 'session-close', 'session-remote', 'session-takeover', 'session-pause', 'session-handoff'];

let tmp: string;
let nodes: PeerNode[] = [];
let contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  tmp = await makeTempDir('e2e-header-overflow');
});

test.afterEach(async () => {
  await Promise.all(contexts.map((context) => context.close()));
  contexts = [];
  await Promise.all(nodes.map((node) => node.server.stop()));
  nodes = [];
  await removeTempDir(tmp);
});

/** The testids of the header actions in the row, and in the ⋯ menu (opened). */
async function placed(page: Page): Promise<{ row: string[]; menu: string[] }> {
  const ids = (selector: string) =>
    page.locator(selector).evaluateAll((els, wanted) => els.flatMap((el) => wanted.filter((id) => el.matches(`[data-testid="${id}"]`) || el.querySelector(`[data-testid="${id}"]`))), ACTIONS);
  const row = await ids('.sb-sv-actions > *');
  if ((await page.getByTestId('session-overflow').count()) === 0) return { row, menu: [] };
  await page.getByTestId('session-more').click();
  await expect(page.locator('.sb-sv-overflow')).toBeVisible();
  const menu = await ids('.sb-sv-overflow > *');
  // Everything in the open menu stays inside the window.
  const box = await page.locator('.sb-sv-overflow').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.sb-sv-overflow')).toBeHidden();
  return { row, menu };
}

test('the header actions stay inside the session column at 1280 / 1366 / 1440, right panel and sidebar open or closed; the rest is in ⋯', async ({ browser }) => {
  test.setTimeout(180_000);
  const { a, b, aId } = await pairedNodes(tmp);
  nodes.push(a, b);
  // B's name for A (a paired machine can be renamed on this side).
  const renamed = await b.call('PUT', `/api/machines/${encodeURIComponent(aId)}`, { name: LONG_MACHINE });
  expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  await waitFor('the long name on B', async () => ((await b.call('GET', '/api/machines')).body as { machines: Array<{ id: string; name: string; state: string }> }).machines.find((m) => m.id === aId && m.name === LONG_MACHINE && m.state === 'online'));
  // B's own session (Move to <A> ▸), with a long model label and Remote on: the widest header.
  const created = await b.call('POST', '/api/sessions', { name: 'header-overflow', task: 'Reply with just OK.', folder: b.folderId, worktrees: false, ultracode: false, model: 'opus', effort: 'xhigh' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as Session).id;
  await waitFor('idle', async () => ['idle', 'done'].includes(((await b.call('GET', `/api/sessions/${id}`)).body as Session).status));
  await waitFor('remote available', async () => ((await b.call('GET', `/api/sessions/${id}`)).body as Session).remote?.available === true);
  expect((await b.call('PUT', `/api/sessions/${id}/remote`, { enabled: true })).status).toBe(200);

  // The reference: the widest window, nothing beside the session: every action in the row, nothing in ⋯.
  const context = await browser.newContext({ viewport: { width: 1920, height: 900 } });
  contexts.push(context);
  const page = await context.newPage();
  const open = async (width: number, sidebarHidden: boolean, rightPanelHidden: boolean): Promise<void> => {
    expect((await b.call('PUT', '/api/settings', { 'ui.sidebarHidden': sidebarHidden, 'ui.rightPanelHidden': rightPanelHidden })).status).toBe(200);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${b.baseUrl}/sessions/${encodeURIComponent(id)}`);
    await expect(page.getByTestId('session-takeover')).toHaveCount(1);
    await expect(page.getByTestId('session-model-button')).toHaveText('Opus 5.5 · xhigh▾');
    await expect(page.getByTestId('session-remote-toggle')).toHaveAttribute('data-state', 'on');
    if (rightPanelHidden) await expect(page.getByTestId('session-right-panel')).toHaveAttribute('aria-hidden', 'true');
    else await expect(page.getByTestId('session-right-panel')).not.toHaveAttribute('aria-hidden', 'true');
  };
  await open(1920, true, true);
  const reference = await placed(page);
  expect(reference.menu).toEqual([]);
  await expect(page.getByTestId('session-takeover')).toHaveText(`Move to ${LONG_MACHINE} ▸`);
  const all = reference.row;
  expect(all).toEqual(expect.arrayContaining(['session-model', 'session-close', 'session-remote', 'session-takeover', 'session-pause', 'session-handoff']));

  const overflowed: string[] = [];
  for (const width of [1280, 1366, 1440]) {
    for (const sidebarHidden of [false, true]) {
      for (const rightPanelHidden of [false, true]) {
        const label = `${width} · sidebar ${sidebarHidden ? 'hidden' : 'shown'} · right panel ${rightPanelHidden ? 'hidden' : 'open'}`;
        await open(width, sidebarHidden, rightPanelHidden);
        // Let the header settle (it measures after each render).
        await page.waitForTimeout(150);
        const header = (await page.getByTestId('session-header').boundingBox())!;
        const panel = rightPanelHidden ? null : await page.getByTestId('session-right-panel').boundingBox();
        const limit = Math.min(header.x + header.width, panel ? panel.x : Number.POSITIVE_INFINITY);
        // Every action of the row, the ⋯ button, the tabs and the chips: inside the column.
        for (const locator of [page.locator('.sb-sv-actions > *'), page.getByTestId('session-more'), page.locator('.sb-sv-tabs'), page.locator('.sb-sv-chips')]) {
          for (const [what, right] of await locator.evaluateAll((els) => els.map((el) => [`${el.className} ${el.getAttribute('data-testid') ?? ''} ${el.textContent?.slice(0, 30) ?? ''}`, el.getBoundingClientRect().right] as const))) {
            expect(right, `${label}: ${what}`).toBeLessThanOrEqual(limit + 0.5);
          }
        }
        const { row, menu } = await placed(page);
        // Nothing lost: every action is in the row or in ⋯, once.
        expect([...row, ...menu].sort(), label).toEqual([...all].sort());
        // The order: Move, Continue in terminal, Remote, Close go first; the pickers and Pause last.
        const order = ['takeover', 'handoff', 'remote', 'close', 'account', 'cli', 'pause', 'model'].filter((key) => all.includes(`session-${key}`));
        const hidden = (await page.locator('.sb-sv-top').getAttribute('data-overflow'))?.split(' ').filter((key) => key !== 'short') ?? [];
        expect(hidden, label).toEqual(order.slice(0, hidden.length));
        expect(menu.map((testId) => testId.replace('session-', '')).sort(), label).toEqual([...hidden].sort());
        if (row.includes('session-takeover') && menu.length === 0 && (await page.getByTestId('session-takeover').textContent()) === 'Move ▸') overflowed.push(`${label}: short`);
        if (menu.length > 0) overflowed.push(`${label}: ${menu.join(', ')}`);
      }
    }
  }
  // The narrowest case (1280, both open) cannot fit the widest header: something moved.
  expect(overflowed.some((line) => line.startsWith('1280 · sidebar shown · right panel open'))).toBe(true);

  // An action in ⋯ still works: Close asks first there as in the row.
  await open(1280, false, false);
  await page.waitForTimeout(150);
  await page.getByTestId('session-more').click();
  const menuTakeover = page.locator('.sb-sv-overflow').getByTestId('session-takeover');
  await expect(menuTakeover).toBeVisible();
  await menuTakeover.click();
  await expect(page.getByTestId('takeover-dialog')).toBeVisible();
});
