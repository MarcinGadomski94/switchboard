import path from 'node:path';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { readingFromGetUsage } from '../../src/core/usage.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D23 oracle (E2E) on the real code path (no demo seed, D13): `node
 * src/server/main.ts` with the fake CLIs and a temp data folder holding one
 * `get_usage` reading (the CLI's recorded shape): Week 62 % with its reset 74 h
 * ahead (a whole minute), so the server lists the Week window for the whole run.
 * The pace is computed in the browser from `usageWindows`, so the page gets a
 * fixed clock (`page.clock.setFixedTime`, timers keep running) at chosen moments
 * of that window, and the tooltip is read in UTC (`timezoneId`):
 * - one minute before the step into day 5 (day 4, 57.14 % allowed): yellow;
 * - at the step (day 5, 71.43 %): green, the marker moves;
 * - after the reset (the page still has the window): no color, no marker, no tooltip.
 * The Session row never changes.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WEEK_PCT = 62;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

let tmp: string;
let server: ServerProcess;
/** The Week window's reset (epoch ms, a whole minute ahead of now by about 74 h: the server's own clock is on day 4). */
let reset = 0;

test.use({ timezoneId: 'UTC' });

/** `Mon 15:00` in UTC (the page's time zone here), as the tooltip names the next step. */
function utcWeekdayTime(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAYS[date.getUTCDay()]} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
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

async function fillColor(row: Locator): Promise<string> {
  return row.locator('.sb-meter-fill').evaluate((fill) => getComputedStyle(fill).backgroundColor);
}

/** Opens the page with its clock fixed at `at` (epoch ms) and waits for the Week row's value. */
async function openAt(page: Page, at: number): Promise<Locator> {
  await page.clock.setFixedTime(at);
  await page.goto(`${server.baseUrl}/`);
  const week = page.getByTestId('usage-meters').locator('[data-meter="week"]');
  await expect(week.locator('.sb-meter-value')).toHaveText(new RegExp(`^${WEEK_PCT}% · \\d+h\\d\\d$|^${WEEK_PCT}% · \\d+m$`));
  return week;
}

/** The marker sits on the bar at `pct` of its width (centered, ±1 px), 2 px wide and as high as the bar. */
async function expectMarkerAt(week: Locator, pct: number): Promise<void> {
  const track = await week.locator('.sb-meter-track').boundingBox();
  const marker = await week.getByTestId('pace-marker').boundingBox();
  expect(track && marker).toBeTruthy();
  if (!track || !marker) return;
  expect(marker.width).toBe(2);
  expect(marker.height).toBe(track.height);
  expect(Math.abs(marker.x + marker.width / 2 - (track.x + (track.width * pct) / 100))).toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-week-pace');
  const dataDir = path.join(tmp, 'data');
  const store = await openStore(storeFile(dataDir));
  try {
    const seededAt = Date.now();
    reset = Math.ceil((seededAt + 74 * 60 * MIN) / MIN) * MIN;
    const iso = (ms: number): string => new Date(ms).toISOString().replace('Z', '+00:00');
    const answer = {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 20, resets_at: iso(seededAt + 2 * 60 * MIN), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
        seven_day: { utilization: WEEK_PCT, resets_at: iso(reset), limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
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

test('the Week bar is yellow at or above the day’s allowance, green below it, with a marker at the allowance and a pace tooltip', async ({ page }) => {
  const stepIntoDay5 = reset - 3 * DAY;

  // Day 4 (one minute before the step): 62 % ≥ 57.14 % → ahead of pace, yellow.
  let week = await openAt(page, stepIntoDay5 - MIN);
  const need = await tokenColor(page, '--status-need');
  const done = await tokenColor(page, '--status-done');
  const text = await tokenColor(page, '--text');
  const muted = await tokenColor(page, '--muted-3');
  expect(new Set([need, done, text]).size).toBe(3);
  await expect(week).toHaveAttribute('data-pace', 'ahead');
  await expect(week).toHaveAttribute('title', `Ahead of pace: ${WEEK_PCT}% of 57.14% allowed until ${utcWeekdayTime(stepIntoDay5)}`);
  expect(await fillColor(week)).toBe(need);
  await expect(week.locator('.sb-meter-fill')).toHaveAttribute('style', `width: ${WEEK_PCT}%;`);
  await expectMarkerAt(week, 57.14);
  expect(await week.getByTestId('pace-marker').evaluate((marker) => getComputedStyle(marker).backgroundColor)).toBe(muted);

  // The Session row is unchanged: no pace, the D17 bright fill, no marker, no tooltip.
  const session = page.getByTestId('usage-meters').locator('[data-meter="session"]');
  await expect(session).not.toHaveAttribute('data-pace');
  await expect(session).not.toHaveAttribute('title');
  await expect(session.getByTestId('pace-marker')).toHaveCount(0);
  expect(await fillColor(session)).toBe(text);

  // Day 5 starts at the reset hour: 62 % < 71.43 % → on pace, green; the marker moves to the new allowance.
  week = await openAt(page, stepIntoDay5);
  await expect(week).toHaveAttribute('data-pace', 'on');
  await expect(week).toHaveAttribute('title', `On pace: ${WEEK_PCT}% of 71.43% allowed until ${utcWeekdayTime(stepIntoDay5 + DAY)}`);
  expect(await fillColor(week)).toBe(done);
  await expectMarkerAt(week, 71.43);

  // After the reset the page still has the window, but its pace is unknown: no color, no marker, no tooltip.
  week = await openAt(page, reset + MIN);
  await expect(week).not.toHaveAttribute('data-pace');
  await expect(week).not.toHaveAttribute('title');
  await expect(week.getByTestId('pace-marker')).toHaveCount(0);
  expect(await fillColor(week)).toBe(text);
});
