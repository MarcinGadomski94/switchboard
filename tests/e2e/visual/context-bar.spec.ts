import { type Page, expect, test } from '@playwright/test';
import type { SessionContext, SessionDetail } from '../../../src/core/api.ts';
import { type DemoApp, BOX_TOLERANCE_PX, hexToRgb, newVisualPage, openApp, round, sideBySide, startDemoApp, writeReport } from './harness.ts';

/**
 * D49 (an addition, checked on its own like D18's Name row and D45's placeholders):
 * the context bar is not in the prototype, and the demo seed's sessions have no
 * meter data (`Session.context` is `null`: Switchboard never ran their process),
 * so every other visual spec and the full pass measure the composer as before.
 *
 * The demo app at 1440×900 on `calendar-func-fix`, first as seeded (the template),
 * then with a `context` added to its `GET /api/sessions/{id}` in the browser
 * (`page.route`), one page load per state. Gated here:
 * - the bar is the composer's first row, directly above the quick replies (the
 *   composer's 8 px gap), at their x and width;
 * - the quick replies, the field and Send keep their boxes: the composer (at the
 *   column's bottom) grows upwards by exactly the bar's height + 8 px, and the
 *   conversation gives up that height;
 * - SPEC tokens as computed styles: a 4 px track, radius 2 px, `--border-card`;
 *   the fill `--status-done` / `--status-need` / `--status-fail` for ok / warn /
 *   high and 0 px wide while unknown; the text Geist Mono 11 px `--muted-2`
 *   (the machine footer's), "compacted HH:MM" in `--muted-3`;
 * - the fill's width is the percentage of the track.
 * Report: `context-bar.md` + `context-bar-side-by-side.png` (seeded left, with the
 * bar right).
 */

const SESSION = 'calendar-func-fix';
const BORDER_CARD = hexToRgb('#26272c');
const MUTED_2 = hexToRgb('#8d8c87');
const MUTED_3 = hexToRgb('#76756f');

const AT = '2026-09-29T12:05:00.000Z';

function context(tokens: number | null, extra: Partial<SessionContext> = {}): SessionContext {
  const percent = tokens === null ? null : Math.round((tokens / 200_000) * 100);
  const band = percent === null ? 'unknown' : percent >= 80 ? 'high' : percent >= 60 ? 'warn' : 'ok';
  return { tokens, window: 200_000, windowSource: 'reported', model: 'claude-opus-4-7', percent, band, updatedAt: AT, compaction: null, compactedRecently: false, ...extra };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Parts {
  readonly composer: Box | null;
  readonly quick: Box | null;
  readonly input: Box | null;
  readonly send: Box | null;
  readonly chat: Box | null;
  readonly bar: Box | null;
  readonly track: Box | null;
  readonly fill: Box | null;
  readonly firstChild: string | null;
  readonly styles: Readonly<Record<string, string>>;
}

async function parts(page: Page): Promise<Parts> {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const style = (sel: string, prop: string): string => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop) : '';
    };
    const composer = document.querySelector('[data-testid="chat-composer"]');
    return {
      composer: box('[data-testid="chat-composer"]'),
      quick: box('.sb-chat-quick'),
      input: box('[data-testid="chat-input"]'),
      send: box('[data-testid="chat-send"]'),
      chat: box('[data-testid="session-chat"]'),
      bar: box('[data-testid="chat-context"]'),
      track: box('.sb-chat-context-track'),
      fill: box('[data-testid="chat-context-fill"]'),
      firstChild: (composer?.firstElementChild as HTMLElement | null)?.dataset['testid'] ?? null,
      styles: {
        trackBg: style('.sb-chat-context-track', 'background-color'),
        trackRadius: style('.sb-chat-context-track', 'border-radius'),
        fillBg: style('[data-testid="chat-context-fill"]', 'background-color'),
        textFont: style('[data-testid="chat-context-text"]', 'font-family'),
        textSize: style('[data-testid="chat-context-text"]', 'font-size'),
        textColor: style('[data-testid="chat-context-text"]', 'color'),
        compactedColor: style('[data-testid="chat-context-compacted"]', 'color'),
        statusDone: getComputedStyle(document.documentElement).getPropertyValue('--status-done').trim(),
      },
    };
  });
}

/** The session opened with `value` as its `context` (`null`: as seeded). */
async function openWith(page: Page, app: DemoApp, value: SessionContext | null): Promise<Parts> {
  await page.unrouteAll({ behavior: 'wait' });
  if (value !== null) {
    await page.route(
      (url) => url.pathname === `/api/sessions/${SESSION}`,
      async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as SessionDetail;
        await route.fulfill({ response, json: { ...body, context: value } });
      },
    );
  }
  await openApp(page, app.baseUrl, `/sessions/${SESSION}`);
  await expect(page.getByTestId('session-name')).toHaveText(SESSION);
  await expect(page.getByTestId('chat-context')).toHaveCount(value === null ? 0 : 1);
  await page.mouse.move(0, 0);
  return parts(page);
}

/** A token's value computed as a background color. */
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

const fmt = (box: Box | null | undefined): string => (box ? `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}` : 'missing');

test.describe('visual: context bar (D49 addition)', () => {
  let app: DemoApp;

  test.beforeAll(async () => {
    app = await startDemoApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test('the bar sits above the quick replies, the composer only grows by it, on SPEC tokens', async ({ browser }) => {
    const page = await newVisualPage(browser);
    const seeded = await openWith(page, app, null);
    const seededShot = await page.screenshot();
    const warn = await openWith(page, app, context(124_000, { compaction: { at: AT, trigger: 'auto', preTokens: 167_000, postTokens: 18_000 }, compactedRecently: true }));
    const warnShot = await page.screenshot();
    const ok = await openWith(page, app, context(40_000));
    const high = await openWith(page, app, context(170_000));
    const unknown = await openWith(page, app, context(null));
    const colors = {
      done: await tokenColor(page, '--status-done'),
      need: await tokenColor(page, '--status-need'),
      fail: await tokenColor(page, '--status-fail'),
    };

    const rows: string[] = [];
    const failures: string[] = [];
    const check = (what: string, pass: boolean, note: string): void => {
      rows.push(`| ${what} | ${note.replaceAll('|', '\\|')} | ${pass ? 'ok' : 'FAIL'} |`);
      if (!pass) failures.push(`${what}: ${note}`);
    };
    const near = (a: number | undefined, b: number | undefined, tolerance = BOX_TOLERANCE_PX): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;
    const w = warn;
    const shift = (w.bar?.height ?? 0) + 8;

    check('seeded: no bar (no meter data for the demo seed)', seeded.bar === null && seeded.firstChild === null, `${fmt(seeded.bar)} · first row ${seeded.firstChild ?? 'quick replies'}`);
    check('place: the composer\'s first row', w.firstChild === 'chat-context', String(w.firstChild));
    check('place: directly above the quick replies (8 px gap)', near((w.quick?.y ?? 0) - ((w.bar?.y ?? 0) + (w.bar?.height ?? 0)), 8, 0.5), `${fmt(w.bar)} → ${fmt(w.quick)}`);
    check('place: the quick replies\' x and width', near(w.bar?.x, w.quick?.x, 0.5) && near(w.bar?.width, w.quick?.width, 0.5), `${fmt(w.bar)} vs ${fmt(w.quick)}`);
    check('place: the bar starts at the composer\'s top padding (10 px)', near(w.bar?.y, (w.composer?.y ?? 0) + 10 + 1, 0.5), `${fmt(w.bar)} in ${fmt(w.composer)}`);
    for (const [name, a, b] of [
      ['quick replies', seeded.quick, w.quick],
      ['field', seeded.input, w.input],
      ['Send', seeded.send, w.send],
    ] as const) {
      check(`frame: ${name} keeps its box (the composer grows upwards)`, near(a?.x, b?.x, 0.5) && near(a?.y, b?.y, 0.5) && near(a?.width, b?.width, 0.5) && near(a?.height, b?.height, 0.5), `${fmt(a)} → ${fmt(b)}`);
    }
    check('frame: the composer grows upwards by bar + 8 px, its bottom stays', near((w.composer?.height ?? 0) - (seeded.composer?.height ?? 0), shift, 0.5) && near((w.composer?.y ?? 0) + (w.composer?.height ?? 0), (seeded.composer?.y ?? 0) + (seeded.composer?.height ?? 0), 0.5), `${fmt(seeded.composer)} → ${fmt(w.composer)}`);
    check('frame: the conversation gives up the same height', near((seeded.chat?.height ?? 0) - (w.chat?.height ?? 0), shift, 0.5), `${fmt(seeded.chat)} → ${fmt(w.chat)}`);
    check('track: 4 px, radius 2 px, --border-card', near(w.track?.height, 4, 0.01) && w.styles['trackRadius'] === '2px' && w.styles['trackBg'] === BORDER_CARD, `${fmt(w.track)} · ${w.styles['trackRadius']} · ${w.styles['trackBg']}`);
    check('fill: 62 % of the track', near(w.fill?.width, (w.track?.width ?? 0) * 0.62, 0.5), `${round(w.fill?.width ?? 0)} of ${round(w.track?.width ?? 0)}`);
    check('fill: ok --status-done, warn --status-need, high --status-fail', ok.styles['fillBg'] === colors.done && w.styles['fillBg'] === colors.need && high.styles['fillBg'] === colors.fail, `${ok.styles['fillBg']} · ${w.styles['fillBg']} · ${high.styles['fillBg']}`);
    check('fill: unknown is empty (0 px)', near(unknown.fill?.width, 0, 0.01), fmt(unknown.fill));
    check('text: Geist Mono 11 px --muted-2 (the machine footer\'s)', (w.styles['textFont'] ?? '').includes('Geist Mono') && w.styles['textSize'] === '11px' && w.styles['textColor'] === MUTED_2, `${w.styles['textFont']} ${w.styles['textSize']} ${w.styles['textColor']}`);
    check('text: "compacted HH:MM" in --muted-3', w.styles['compactedColor'] === MUTED_3, w.styles['compactedColor'] ?? '');
    check('height: one mono line (the bar adds at most 16 px + the gap)', (w.bar?.height ?? 99) <= 16, fmt(w.bar));

    const pair = await sideBySide(page, seededShot, warnShot);
    const report = [
      '# Visual check · Context bar (D49 addition)',
      '',
      `Generated by \`tests/e2e/visual/context-bar.spec.ts\`. The bar is not in the prototype, and the demo seed has no meter data (\`Session.context\` is \`null\`), so the composer every other spec and the full pass compare is unchanged; the bar is checked on its own against the seeded composer. App: demo seed, 1440×900, \`/sessions/${SESSION}\`; the bar's states come from a \`context\` added to \`GET /api/sessions/${SESSION}\` in the browser (\`page.route\`), one page load per state (warn 62 % with "compacted", ok 20 %, high 85 %, unknown).`,
      '',
      `**Gate:** ${failures.length === 0 ? 'green' : 'red'}`,
      '',
      '| Check | Measured | Result |',
      '|---|---|---|',
      ...rows,
      '',
      'Screenshot: `context-bar-side-by-side.png` (seeded left, the bar at 62 % after a compaction right).',
      '',
    ].join('\n');
    await writeReport({ 'context-bar.md': report, 'context-bar-side-by-side.png': pair });
    await page.context().close();
    expect(failures).toEqual([]);
  });
});
