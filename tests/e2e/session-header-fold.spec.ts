import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { seedFolder } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { openTempStore } from '../helpers/store.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D104 oracle (`docs/responsive.md` → *Session header: title and chips*), real
 * server over a temp data folder whose database holds two sessions:
 * - a workspace session with a long title and 15 solutions in scope: the title is
 *   one line cut with … (the full title its tooltip, and in the rename field);
 *   the chips (status first) fold to one line with "+N more ▾"; expanding wraps
 *   them, "▴ less" folds them, the choice survives a reload; the folded line
 *   follows the window's width (ResizeObserver);
 * - a session with few chips: no toggle, the row as it always was.
 * Screenshots go to `SWITCHBOARD_SHOTS_DIR` when set.
 */
const SHOTS = process.env['SWITCHBOARD_SHOTS_DIR'] ?? '';
const LONG_TITLE = 'Migrate the room booking flow to the new calendar contract across every front';
const SOLUTIONS = [
  'loyalty-front',
  'delivery-front',
  'acme-web-front',
  'catalog-front',
  'console-front',
  'accounts-microservice',
  'orders-microservice',
  'reminder-microservice',
  'billing-microservice',
  'invoice-func',
  'stock-sync-func',
  'design-kit-nuget',
  'acme-icons-nuget',
  'api-client-nuget',
  'mobile',
];

let tmp: string;
let server: ServerProcess;
let manyId: string;
let fewId: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-header-fold');
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const store = await openTempStore(dataDir);
  const folder = await seedFolder(store, workspace);
  const base = { claudeSessionId: randomUUID(), root: workspace, rootKind: 'workspace' as const, cwd: workspace, folderId: folder.id, worktrees: false, attached: true };
  manyId = (
    await store.sessions.create({
      ...base,
      name: 'calendar-contract',
      title: LONG_TITLE,
      task: 'Migrate the booking flow.',
      workType: 'feature',
      mode: 'orchestrator',
      phase: 'integration',
      ultracode: true,
      solutions: SOLUTIONS,
    })
  ).id;
  fewId = (
    await store.sessions.create({
      ...base,
      claudeSessionId: randomUUID(),
      name: 'small-fix',
      title: 'Small fix',
      task: 'Fix it.',
      workType: 'feature',
      mode: 'single',
      phase: 'ui-first',
      ultracode: false,
      solutions: ['loyalty-front'],
    })
  ).id;
  await store.close();
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir, SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config') });
});

test.afterAll(async () => {
  await server?.stop();
  if (tmp) await removeTempDir(tmp);
});

/** The chips row's state: the chips shown (in order), the folded count, the toggle's label, and whether the shown chips sit on one line. */
async function chipRow(page: Page): Promise<{ shown: string[]; folded: number; toggle: string | null; lines: number; overflow: boolean }> {
  return page.getByTestId('session-chips').evaluate((row) => {
    const chips = [...row.querySelectorAll<HTMLElement>(':scope > [data-testid="session-chip"]')];
    const visible = chips.filter((chip) => chip.dataset['folded'] !== 'true');
    const tops = new Set(visible.map((chip) => Math.round(chip.getBoundingClientRect().top)));
    const toggle = row.querySelector<HTMLElement>('[data-testid="session-chips-toggle"]');
    if (toggle) tops.add(Math.round(toggle.getBoundingClientRect().top));
    const rowBox = row.getBoundingClientRect();
    const outside = [...visible, ...(toggle ? [toggle] : [])].some((el) => el.getBoundingClientRect().right > rowBox.right + 1);
    return {
      shown: visible.map((chip) => chip.textContent ?? ''),
      folded: chips.length - visible.length,
      toggle: toggle?.textContent ?? null,
      lines: tops.size,
      overflow: outside || row.scrollWidth > row.clientWidth + 1,
    };
  });
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${server.baseUrl}/sessions/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('session-name')).toBeVisible();
  await expect(page.getByTestId('session-chip').first()).toBeVisible();
}

test('a long title stays on one line, cut with …, the full title in its tooltip and in the rename field', async ({ page }) => {
  await stubToolProbes(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSession(page, manyId);
  const name = page.getByTestId('session-name');
  await expect(name).toHaveText(LONG_TITLE);
  await expect(name).toHaveAttribute('title', new RegExp(`^${LONG_TITLE} \\(calendar-contract\\) · click to rename$`));
  const metrics = await name.evaluate((el) => {
    const style = getComputedStyle(el);
    return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, height: el.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3, cut: el.scrollWidth > el.clientWidth };
  });
  expect(metrics.whiteSpace).toBe('nowrap');
  expect(metrics.textOverflow).toBe('ellipsis');
  expect(metrics.cut).toBe(true);
  expect(metrics.height).toBeLessThan(metrics.lineHeight * 1.5);
  // The top row is one line: the dot, the name, the root path and the actions share a centre line.
  const top = await page.locator('.sb-sv-top').evaluate((row) => [...row.children].map((child) => Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2)));
  expect(Math.max(...top) - Math.min(...top)).toBeLessThanOrEqual(2);
  if (SHOTS) await page.getByTestId('session-header').screenshot({ path: path.join(SHOTS, 'd104-header-long-title-1280.png') });

  // Rename in place shows the whole title; Esc cancels.
  await name.click();
  await expect(page.getByTestId('title-input')).toHaveValue(LONG_TITLE);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-name')).toHaveText(LONG_TITLE);

  // At a phone width (D74) the title is still one line with … .
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => name.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap')).toBe(true);
});

test('15 solutions: one line with "+N more ▾" (status chips first); expand / collapse; the choice survives a reload; the line follows the width', async ({ page }) => {
  await stubToolProbes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.baseUrl);
  await page.evaluate(() => localStorage.removeItem('switchboard.chipRows'));
  await openSession(page, manyId);
  const toggle = page.getByTestId('session-chips-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveText(/^\+\d+ more ▾$/);
  await expect(page.getByTestId('session-chips')).toHaveAttribute('data-fold', 'collapsed');
  let state = await chipRow(page);
  // Status chips first (the session's state is never folded away), then the solutions.
  expect(state.shown.slice(0, 4)).toEqual(['work feature-building', 'mode orchestrator', 'phase integration', 'ultracode on']);
  // Every folded chip is a solution of the scope.
  expect(await page.locator('[data-testid="session-chip"][data-folded="true"]:not([data-scope="true"])').count()).toBe(0);
  expect(state.lines).toBe(1);
  expect(state.overflow).toBe(false);
  expect(state.folded).toBeGreaterThan(0);
  expect(state.toggle).toBe(`+${state.folded} more ▾`);
  expect(state.shown.length + state.folded).toBe(4 + SOLUTIONS.length);
  if (SHOTS) await page.getByTestId('session-header').screenshot({ path: path.join(SHOTS, 'd104-chips-collapsed-1440.png') });

  // Expand: every chip, wrapping; "▴ less" last.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveText('▴ less');
  state = await chipRow(page);
  expect(state.folded).toBe(0);
  expect(state.lines).toBeGreaterThan(1);
  expect(state.overflow).toBe(false);
  if (SHOTS) await page.getByTestId('session-header').screenshot({ path: path.join(SHOTS, 'd104-chips-expanded-1440.png') });

  // Remembered for this session.
  await page.reload();
  await expect(page.getByTestId('session-chips-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('session-chips-toggle')).toHaveText('▴ less');
  await page.getByTestId('session-chips-toggle').click();
  await expect(page.getByTestId('session-chips-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.getByTestId('session-chips-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('session-chips-toggle')).toHaveText(/^\+\d+ more ▾$/);
  const at1440 = (await chipRow(page)).shown.length;

  // The right panel hidden (⌥⌘B): the session column widens, more chips fit.
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect.poll(async () => (await chipRow(page)).shown.length).toBeGreaterThan(at1440);
  state = await chipRow(page);
  expect(state.shown[4]).toBe('scope loyalty-front');
  expect(state.lines).toBe(1);
  expect(state.toggle).toBe(`+${state.folded} more ▾`);
  if (SHOTS) await page.getByTestId('session-header').screenshot({ path: path.join(SHOTS, 'd104-chips-collapsed-1440-no-panel.png') });
  await page.keyboard.press('ControlOrMeta+Alt+b');
  await expect.poll(async () => (await chipRow(page)).shown.length).toBe(at1440);

  // Wider: more chips on the line; narrower: fewer; always one line inside the row.
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(async () => (await chipRow(page)).shown.length).toBeGreaterThan(at1440);
  state = await chipRow(page);
  expect(state.lines).toBe(1);
  expect(state.overflow).toBe(false);
  expect(state.toggle).toBe(`+${state.folded} more ▾`);
  const at1920 = state.shown.length;
  // 1024: the right panel is a drawer (D74), the row is narrower than at 1920 all the same.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(async () => (await chipRow(page)).shown.length).toBeLessThan(at1920);
  state = await chipRow(page);
  expect(state.lines).toBe(1);
  expect(state.overflow).toBe(false);
  expect(state.toggle).toBe(`+${state.folded} more ▾`);
  // A phone: still one line (the compact layouts' sideways row folds the same way).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await chipRow(page)).lines).toBe(1);
  state = await chipRow(page);
  expect(state.overflow).toBe(false);
  expect(state.shown[0]).toBe('work feature-building');
  if (SHOTS) await page.getByTestId('session-header').screenshot({ path: path.join(SHOTS, 'd104-chips-collapsed-390.png') });
  await page.getByTestId('session-chips-toggle').click();
  state = await chipRow(page);
  expect(state.folded).toBe(0);
  expect(state.overflow).toBe(false);
  await page.getByTestId('session-chips-toggle').click();
});

test('a few chips: no toggle, the row as before', async ({ page }) => {
  await stubToolProbes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSession(page, fewId);
  await expect(page.getByTestId('session-chip')).toHaveText(['work feature-building', 'mode single-solution', 'phase UI-first', 'scope loyalty-front']);
  await expect(page.getByTestId('session-chips-toggle')).toHaveCount(0);
  await expect(page.getByTestId('session-chips')).not.toHaveAttribute('data-fold', /.*/);
});
