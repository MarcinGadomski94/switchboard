import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { readingFromGetUsage } from '../../src/core/usage.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D46 oracle (E2E) on the real code path (no demo seed, D13), the way D23's
 * `week-pace.spec.ts` does it: `node src/server/main.ts` with the fake CLIs and a
 * temp data folder holding one `get_usage` reading (the CLI's recorded shape):
 * Session 62 % with its reset about 2 h ahead (a whole minute), so the server
 * lists the Session window for the whole run. The pace is computed in the browser
 * from `usageWindows`, so only the page's clock moves (`page.clock`, in UTC for the
 * tooltip) through the window, which started 5 h before the reset. Each minute's
 * share counts from the minute's start (developer ruling 2026-09-29), so during
 * minute n (1–300) n × 100 / 300 % is allowed:
 * - in minute 120 (40 % allowed): yellow;
 * - in minute 186 (62 % allowed, exactly the usage): still yellow;
 * - one minute of page clock later, minute 187 (62.33 %): green, the marker moves;
 * - after the reset, and more than 5 h before it: no color, no marker, no pace in the tooltip.
 * The Week bar keeps its own (continuous) D23 pace throughout. D66: the bars are the
 * usage grid's (one line, Claude); the pace and the reset times are in the line's tooltip.
 */

const MIN = 60_000;
const SESSION_PCT = 62;
const WEEK_PCT = 18;

let tmp: string;
let server: ServerProcess;
/** The Session window's reset (epoch ms, a whole minute about 2 h ahead of the server's clock). */
let reset = 0;
/** The Session window's start: 5 h before its reset. */
let start = 0;

test.use({ timezoneId: 'UTC' });

/** `14:05` in UTC (the page's time zone here), as the tooltip names the next minute step. */
function utcTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** The computed color of a SPEC token, as the page resolves it. */
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

/**
 * D66: the pace line under a window in the usage grid line's tooltip (`5h: …` / `Week: …`,
 * then `  On pace: …`), `null` when that window has none.
 */
async function paceIn(page: Page, window: '5h' | 'Week'): Promise<string | null> {
  const lines = ((await page.getByTestId('usage-line').first().getAttribute('title')) ?? '').split('\n');
  const at = lines.findIndex((line) => line.startsWith(`${window}: `));
  const next = at >= 0 ? lines[at + 1] : undefined;
  return next?.startsWith('  ') ? next.trim() : null;
}

/** D66: the window's tooltip line (`5h: 62% · resets in 3h01`). */
async function windowIn(page: Page, window: '5h' | 'Week'): Promise<string | null> {
  const lines = ((await page.getByTestId('usage-line').first().getAttribute('title')) ?? '').split('\n');
  return lines.find((line) => line.startsWith(`${window}: `)) ?? null;
}

async function fillColor(row: Locator): Promise<string> {
  return row.locator('.sb-meter-fill').evaluate((fill) => getComputedStyle(fill).backgroundColor);
}

/** The marker sits on the bar at `pct` of its width (centered, ±1 px), 2 px wide and as high as the bar. */
async function expectMarkerAt(row: Locator, pct: number): Promise<void> {
  const track = await row.locator('.sb-meter-track').boundingBox();
  const marker = await row.getByTestId('pace-marker').boundingBox();
  expect(track && marker).toBeTruthy();
  if (!track || !marker) return;
  expect(marker.width).toBe(2);
  expect(marker.height).toBe(track.height);
  expect(Math.abs(marker.x + marker.width / 2 - (track.x + (track.width * pct) / 100))).toBeLessThanOrEqual(1);
}

/** The Session bar without a pace: no color, no pace in the tooltip, no marker, the bright fill. */
async function expectNoPace(page: Page, session: Locator): Promise<void> {
  await expect(session).not.toHaveAttribute('data-pace');
  expect(await paceIn(page, '5h')).toBeNull();
  await expect(session.getByTestId('pace-marker')).toHaveCount(0);
  expect(await fillColor(session)).toBe(await tokenColor(page, '--text'));
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-session-pace');
  const dataDir = path.join(tmp, 'data');
  const store = await openStore(storeFile(dataDir));
  try {
    const seededAt = Date.now();
    reset = Math.ceil((seededAt + 120 * MIN) / MIN) * MIN;
    start = reset - 300 * MIN;
    const iso = (ms: number): string => new Date(ms).toISOString().replace('Z', '+00:00');
    const answer = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: SESSION_PCT, resets_at: iso(reset), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
        seven_day: { utilization: WEEK_PCT, resets_at: iso(seededAt + 74 * 60 * MIN), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
      },
    };
    const reading = readingFromGetUsage({ kind: 'response', message: { subtype: 'success', response: answer, error: null, raw: {} } });
    await store.usage.add({
      receivedAt: new Date(seededAt).toISOString(),
      source: reading.source,
      sessionId: null,
      fiveHourPct: reading.fiveHourPct,
      fiveHourResetsAt: reading.fiveHourResetsAt,
      sevenDayPct: reading.sevenDayPct,
      sevenDayResetsAt: reading.sevenDayResetsAt,
      raw: reading.raw,
    });
  } finally {
    await store.close();
  }
  server = await startServer({ SWITCHBOARD_DATA_DIR: dataDir });
});

test.afterAll(async () => {
  await server?.stop();
  await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test('the Session bar is yellow at or above its allowance, green below it, stepping every minute, with a marker at the allowance and a pace tooltip', async ({ page }) => {
  // Minute 120 of the window (10 s past its start): 62 % ≥ 40 % → ahead of pace, yellow.
  await page.clock.install({ time: start + 119 * MIN + 10_000 });
  await page.goto(`${server.baseUrl}/`);
  const usage = page.getByTestId('usage-meters');
  const session = usage.locator('[data-window="session"]');
  const week = usage.locator('[data-window="week"]');
  await expect(session.locator('.sb-usage-pct')).toHaveText(`${SESSION_PCT}%`);
  await expect.poll(() => windowIn(page, '5h')).toBe(`5h: ${SESSION_PCT}% · resets in 3h01`);
  const need = await tokenColor(page, '--status-need');
  const done = await tokenColor(page, '--status-done');
  const text = await tokenColor(page, '--text');
  const muted = await tokenColor(page, '--muted-3');
  expect(new Set([need, done, text]).size).toBe(3);
  await expect(session).toHaveAttribute('data-pace', 'ahead');
  await expect.poll(() => paceIn(page, '5h')).toBe(`Ahead of pace: ${SESSION_PCT}% of 40% until ${utcTime(start + 120 * MIN)}`);
  expect(await fillColor(session)).toBe(need);
  await expect(session.locator('.sb-meter-fill')).toHaveAttribute('style', `width: ${SESSION_PCT}%;`);
  await expectMarkerAt(session, 40);
  expect(await session.getByTestId('pace-marker').evaluate((marker) => getComputedStyle(marker).backgroundColor)).toBe(muted);
  // The Week row keeps its own pace (18 %, by the minute over its week, ruling 2026-09-29): about 75 h before its reset
  // (74 h after the seed plus the page's 3 h lead) is its 5 580th or 5 581st minute, 55.36–55.37 % allowed: on pace.
  await expect(week).toHaveAttribute('data-pace', 'on');
  await expect.poll(() => paceIn(page, 'Week')).toMatch(/^On pace: 18% of 55\.3[67]% until \d\d:\d\d$/);

  // Minute 186: the allowance is exactly the usage (62 %), which is not below it → still yellow.
  await page.clock.pauseAt(start + 185 * MIN + 10_000);
  await expect.poll(() => paceIn(page, '5h')).toBe(`Ahead of pace: ${SESSION_PCT}% of 62% until ${utcTime(start + 186 * MIN)}`);
  await expect(session).toHaveAttribute('data-pace', 'ahead');
  expect(await fillColor(session)).toBe(need);
  await expectMarkerAt(session, 62);

  // One minute of page clock later the allowance steps to 62.33 %: on pace, green; the marker moves.
  await page.clock.runFor(MIN);
  await expect.poll(() => paceIn(page, '5h')).toBe(`On pace: ${SESSION_PCT}% of 62.33% until ${utcTime(start + 187 * MIN)}`);
  await expect(session).toHaveAttribute('data-pace', 'on');
  expect(await fillColor(session)).toBe(done);
  await expectMarkerAt(session, 62.33);
  await expect(session.getByTestId('pace-marker')).toHaveCount(1);
  // 113 min 50 s to the reset, rounded like every reset time.
  await expect.poll(() => windowIn(page, '5h')).toBe(`5h: ${SESSION_PCT}% · resets in 1h54`);

  // After the reset the page still has the window (the server's clock has not reached it), but no pace.
  await page.clock.pauseAt(reset + MIN);
  await expect.poll(() => windowIn(page, '5h')).toBe(`5h: ${SESSION_PCT}% · resets in 0m`);
  await expectNoPace(page, session);

  // More than 5 h before the reset: before the window, no pace either.
  await page.clock.setSystemTime(start - 30 * MIN);
  await page.clock.runFor(30_000);
  await expect.poll(() => windowIn(page, '5h')).toBe(`5h: ${SESSION_PCT}% · resets in 5h30`);
  await expectNoPace(page, session);
  await expect(week).toHaveAttribute('data-pace', 'on');
});
