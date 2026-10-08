import { type Locator, type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D49 context bar on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude, whose `[fake:usage <tokens> [<window>]]` sets the main agent's
 * usage (and the result's reported window) and `[fake:compact <trigger> <pre> <post>]`
 * writes a `system/compact_boundary` after the turn's init. The bar sits directly
 * above the message box's row (D86: the quick replies are gone), reads `Context 62% · 124k / 200k`, turns yellow at 60 %
 * and red at 80 % (the SPEC status tokens), updates live over `/hub`, resets after a
 * compaction with "compacted HH:MM" until the next turn, and survives a reload and a
 * Switchboard restart. A tick marks where the CLI auto-compacts (ruling
 * D49-autocompact-mark). Before any usage: an empty neutral bar, `Context —`.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('context-bar');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

/** The value of a SPEC color token as the browser computes it for a background. */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

async function fillColor(bar: Locator): Promise<string> {
  return bar.getByTestId('chat-context-fill').evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}

test('the bar: live values and colors at the thresholds, a compaction resets it, it survives a reload and a restart', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'context-e2e', 'Fill it. [fake:usage 124000]');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);

  const bar = page.getByTestId('chat-context');
  const text = page.getByTestId('chat-context-text');
  await expect(text).toHaveText('Context 62% · 124k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'warn');
  expect(await fillColor(bar)).toBe(await tokenColor(page, '--status-need'));

  // Placement: the composer's first row, directly above the message box's row (D86: no quick replies between), as wide as it.
  const composer = page.getByTestId('chat-composer');
  expect(await composer.evaluate((el) => (el.firstElementChild as HTMLElement).dataset['testid'])).toBe('chat-context');
  const row = composer.locator('.sb-chat-compose');
  const [barBox, rowBox] = [await bar.boundingBox(), await row.boundingBox()];
  if (!barBox || !rowBox) throw new Error('no boxes');
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(rowBox.y);
  expect(rowBox.y - (barBox.y + barBox.height)).toBeLessThanOrEqual(8.5);
  expect(Math.abs(barBox.x - rowBox.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(barBox.width - rowBox.width)).toBeLessThanOrEqual(0.5);
  await expect(bar.locator('.sb-chat-context-track')).toHaveCSS('height', '4px');
  await expect(text).toHaveCSS('font-size', '11px');
  const fillWidth = async (): Promise<number> =>
    bar.getByTestId('chat-context-fill').evaluate((el) => el.getBoundingClientRect().width / (el.parentElement as HTMLElement).getBoundingClientRect().width);
  expect(await fillWidth()).toBeCloseTo(0.62, 2);
  // Ruling D49-autocompact-mark: a 2 px tick where the CLI auto-compacts (200 000 − min(32 000, 20 000) − 13 000 = 167 000 → 83.5 %).
  const tickAt = async (): Promise<number> =>
    bar.getByTestId('chat-context-tick').evaluate((el) => {
      const track = (el.parentElement as HTMLElement).getBoundingClientRect();
      const tick = el.getBoundingClientRect();
      return (tick.x + tick.width / 2 - track.x) / track.width;
    });
  expect(await tickAt()).toBeCloseTo(0.835, 2);
  await expect(bar.getByTestId('chat-context-tick')).toHaveCSS('width', '2px');
  await expect(bar).toHaveAttribute('title', 'Context window: 200,000 tokens · claude-haiku-4-5-20251001\nAuto-compact at 84%\nNot compacted yet');

  // Live over /hub (no reload): red from 80 %, green below 60 %.
  await send(page, 'More. [fake:usage 170000]');
  await expect(text).toHaveText('Context 85% · 170k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'high');
  expect(await fillColor(bar)).toBe(await tokenColor(page, '--status-fail'));
  await send(page, 'Less. [fake:usage 118000]');
  await expect(text).toHaveText('Context 59% · 118k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'ok');
  expect(await fillColor(bar)).toBe(await tokenColor(page, '--status-done'));
  await send(page, 'At 60. [fake:usage 120000]');
  await expect(text).toHaveText('Context 60% · 120k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'warn');
  await send(page, 'At 80. [fake:usage 160000]');
  await expect(text).toHaveText('Context 80% · 160k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'high');

  // A compaction: the bar resets to the new size, "compacted HH:MM" beside the text.
  await send(page, 'Compact. [fake:compact auto 160000 18000] [fake:usage 22000]');
  await expect(text).toHaveText('Context 11% · 22k / 200k');
  await expect(bar).toHaveAttribute('data-band', 'ok');
  const compactedAt = (await detail(page, id)).context?.compaction?.at ?? '';
  const clock = await page.evaluate((iso) => {
    const at = new Date(iso);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }, compactedAt);
  expect(clock).toMatch(/^\d\d:\d\d$/);
  await expect(page.getByTestId('chat-context-compacted')).toHaveText(`compacted ${clock}`);
  await expect(bar).toHaveAttribute('title', `Context window: 200,000 tokens · claude-haiku-4-5-20251001\nAuto-compact at 84%\nLast compacted: ${clock} (auto)`);
  expect(await fillWidth()).toBeCloseTo(0.11, 2);

  // A reload: the same bar (stored on the session), still "compacted" (no turn since).
  await page.reload();
  await expect(text).toHaveText('Context 11% · 22k / 200k');
  await expect(page.getByTestId('chat-context-compacted')).toHaveText(`compacted ${clock}`);

  // The next turn: "compacted" leaves the text, stays in the tooltip.
  await send(page, 'Next. [fake:usage 30000]');
  await expect(text).toHaveText('Context 15% · 30k / 200k');
  await expect(page.getByTestId('chat-context-compacted')).toHaveCount(0);
  await expect(bar).toHaveAttribute('title', new RegExp(`Last compacted: ${clock} \\(auto\\)$`));

  // A 1M window reported by the CLI.
  await send(page, 'Big. [fake:usage 820000 1000000]');
  await expect(text).toHaveText('Context 82% · 820k / 1M');
  await expect(bar).toHaveAttribute('data-band', 'high');
  // 1 000 000 − 20 000 − 13 000 = 967 000 → 96.7 %.
  await expect(bar).toHaveAttribute('title', /\nAuto-compact at 97%\n/);
  expect(await tickAt()).toBeCloseTo(0.967, 2);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');

  // A Switchboard restart: the same values from SQLite.
  await world.restart();
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context 82% · 820k / 1M');
  await expect(page.getByTestId('chat-context')).toHaveAttribute('title', new RegExp(`Last compacted: ${clock} \\(auto\\)$`));
});

test('before any usage: an empty neutral bar, "Context —"', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  // The turn holds before its reply: the process runs, no usage has come yet.
  const { id } = await world.startSession(page, 'context-unknown', 'Wait. [fake:hold 8]');
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  const bar = page.getByTestId('chat-context');
  await expect(page.getByTestId('chat-context-text')).toHaveText('Context —');
  await expect(bar).toHaveAttribute('data-band', 'unknown');
  expect(await bar.getByTestId('chat-context-fill').evaluate((el) => el.getBoundingClientRect().width)).toBe(0);
  await expect(bar).toHaveAttribute('title', 'Context window: 200,000 tokens\nAuto-compact at 84%\nNot compacted yet');
  // Its reply brings the first reading.
  await expect(page.getByTestId('chat-context-text')).toHaveText(/^Context \d+% · /, { timeout: 20_000 });
});
