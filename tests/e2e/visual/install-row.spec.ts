import { type Page, expect, test } from '@playwright/test';
import { stubToolProbes } from '../probes.ts';
import { type DemoApp, BOX_TOLERANCE_PX, VIEWPORT, newVisualPage, openApp, openPrototype, round, startDemoApp, writeReport } from './harness.ts';

/**
 * D34 (an addition, checked on its own like D18's Name row): Settings → Claude
 * Code → **Install as app** is not in the prototype. It shows only while the
 * browser offers installation (a synthetic `beforeinstallprompt` here) or, as a
 * one-line hint, in Safari; the Settings visual spec never sees it (the test
 * Chromium offers nothing), so the prototype rows keep their boxes there.
 *
 * Here the row is compared with the prototype's own template for a row with an
 * action, Notifications → "In-app toast + sound" (label, description, the small
 * outlined "Send test"), at 1440×900: the row's padding and divider, the label,
 * description and button styles equal, the button's size within ±2 px, the row's
 * width and x equal to its neighbours', and its place between Start at login and
 * Permissions. The Safari hint row: the same row frame, one line in the
 * description style. Report: `install-row.md` (+ PNG).
 */

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';

const ROW_STYLES = ['display', 'align-items', 'column-gap', 'padding-top', 'padding-bottom', 'border-bottom-width', 'border-bottom-style', 'border-bottom-color'] as const;
const TEXT_STYLES = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color'] as const;
const ACTION_STYLES = [...TEXT_STYLES, 'border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'background-color'] as const;

interface Measured {
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly text: string;
  readonly style: Readonly<Record<string, string>>;
}

/** The row whose first text line is `label` (or a row element given by selector): row, label, description, action. */
async function measureRow(page: Page, find: { readonly label?: string; readonly selector?: string }): Promise<Record<'row' | 'label' | 'desc' | 'action', Measured | null>> {
  return page.evaluate(
    ({ find: wanted, props }) => {
      const row =
        (wanted.selector ? document.querySelector<HTMLElement>(wanted.selector) : null) ??
        [...document.querySelectorAll<HTMLElement>('body *')].find(
          (el) => getComputedStyle(el).display === 'flex' && el.firstElementChild?.firstElementChild?.textContent === wanted.label,
        );
      if (!row) throw new Error(`no row ${wanted.label ?? wanted.selector}`);
      const pick = (el: Element | null | undefined) => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (el.textContent ?? '').trim(), style };
      };
      const text = row.firstElementChild;
      const single = text?.children.length === 1;
      return {
        row: pick(row),
        label: single ? null : pick(text?.children[0]),
        desc: pick(single ? text?.children[0] : text?.children[1]),
        action: pick(row.children[1]),
      };
    },
    { find, props: [...new Set([...ROW_STYLES, ...ACTION_STYLES])] as string[] },
  );
}

/** Dispatches a `beforeinstallprompt` like Chrome's. */
async function offerInstall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) });
    window.dispatchEvent(event);
  });
}

const fmt = (m: Measured | null): string => (m ? `${round(m.box.x)},${round(m.box.y)} ${round(m.box.width)}×${round(m.box.height)}` : 'missing');

test.describe('visual: Install as app row (D34 addition)', () => {
  let app: DemoApp;

  test.beforeAll(async () => {
    app = await startDemoApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test('matches the prototype row template and sits between Start at login and Permissions', async ({ browser }) => {
    const proto = await newVisualPage(browser);
    await openPrototype(proto);
    await proto.getByText('Settings', { exact: true }).first().click();
    await proto.getByText('Notifications & usage', { exact: true }).first().click();
    await proto.getByText('In-app toast + sound', { exact: true }).waitFor();
    const template = await measureRow(proto, { label: 'In-app toast + sound' });

    const page = await newVisualPage(browser);
    await stubToolProbes(page);
    await openApp(page, app.baseUrl, '/settings');
    await expect(page.getByTestId('start-at-login')).toHaveText('on');
    await offerInstall(page);
    await expect(page.getByTestId('settings-install-app')).toBeVisible();
    await page.mouse.move(0, 0);
    const install = await measureRow(page, { selector: '[data-row="install-app"]' });
    const login = await measureRow(page, { selector: '[data-row="start-at-login"]' });
    const permissions = await measureRow(page, { selector: '[data-row="permissions"]' });
    const shot = await page.screenshot({ clip: { x: 256, y: 0, width: VIEWPORT.width - 256, height: Math.min(VIEWPORT.height, Math.ceil((permissions.row?.box.y ?? 600) + (permissions.row?.box.height ?? 0) + 24)) } });

    const safariContext = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, userAgent: SAFARI_UA });
    const safari = await safariContext.newPage();
    await stubToolProbes(safari);
    await openApp(safari, app.baseUrl, '/settings');
    await expect(safari.getByTestId('settings-install-hint')).toBeVisible();
    const hint = await measureRow(safari, { selector: '[data-row="install-app"]' });
    const safariLogin = await measureRow(safari, { selector: '[data-row="start-at-login"]' });
    const safariPermissions = await measureRow(safari, { selector: '[data-row="permissions"]' });
    await safariContext.close();

    const rows: string[] = [];
    const failures: string[] = [];
    const check = (what: string, ok: boolean, note: string): void => {
      rows.push(`| ${what} | ${note.replaceAll('|', '\\|')} | ${ok ? 'ok' : 'FAIL'} |`);
      if (!ok) failures.push(`${what}: ${note}`);
    };
    const sameStyles = (what: string, a: Measured | null, b: Measured | null, props: readonly string[]): void => {
      const diffs = props.filter((prop) => a?.style[prop] !== b?.style[prop]).map((prop) => `${prop} ${a?.style[prop] ?? '?'} vs ${b?.style[prop] ?? '?'}`);
      check(what, !!a && !!b && diffs.length === 0, diffs.length === 0 ? props.join(', ') : diffs.join('; '));
    };
    const near = (a: number | undefined, b: number | undefined): boolean => a !== undefined && b !== undefined && Math.abs(a - b) <= BOX_TOLERANCE_PX;

    // Chrome: the row with its button.
    const r = install.row;
    check('place: after Start at login, before Permissions', !!r && !!login.row && !!permissions.row && r.box.y >= login.row.box.y + login.row.box.height - 0.5 && permissions.row.box.y >= r.box.y + r.box.height - 0.5, fmt(r));
    check('x and width of its neighbours', near(r?.box.x, login.row?.box.x) && near(r?.box.width, login.row?.box.width) && near(r?.box.width, permissions.row?.box.width), `${fmt(r)} vs ${fmt(login.row)}`);
    check('height of the prototype template row (label + one-line description + action)', near(r?.box.height, template.row?.box.height), `${round(r?.box.height ?? 0)} vs ${round(template.row?.box.height ?? 0)}`);
    sameStyles('row frame = the prototype row', r, template.row, ROW_STYLES);
    check('label copy', install.label?.text === 'Install as app', JSON.stringify(install.label?.text ?? null));
    sameStyles('label = the prototype label', install.label, template.label, TEXT_STYLES);
    check('description: one line', near(install.desc?.box.height, template.desc?.box.height), `${round(install.desc?.box.height ?? 0)} px`);
    sameStyles('description = the prototype description', install.desc, template.desc, TEXT_STYLES);
    check('button copy', install.action?.text === 'Install', JSON.stringify(install.action?.text ?? null));
    sameStyles('button = the prototype "Send test"', install.action, template.action, ACTION_STYLES);
    check('button height of "Send test"', near(install.action?.box.height, template.action?.box.height), `${round(install.action?.box.height ?? 0)} vs ${round(template.action?.box.height ?? 0)}`);
    check('button at the row\'s right edge', !!r && !!install.action && near(install.action.box.x + install.action.box.width, r.box.x + r.box.width), fmt(install.action));

    // Safari: the one-line hint in the same row frame.
    const h = hint.row;
    check('Safari hint: place', !!h && !!safariLogin.row && !!safariPermissions.row && h.box.y >= safariLogin.row.box.y + safariLogin.row.box.height - 0.5 && safariPermissions.row.box.y >= h.box.y + h.box.height - 0.5, fmt(h));
    check('Safari hint: x and width of its neighbours', near(h?.box.x, safariLogin.row?.box.x) && near(h?.box.width, safariLogin.row?.box.width), fmt(h));
    sameStyles('Safari hint: row frame = the prototype row', h, template.row, ROW_STYLES);
    check('Safari hint: copy', hint.desc?.text === 'Install: File → Add to Dock…', JSON.stringify(hint.desc?.text ?? null));
    sameStyles('Safari hint: text = the prototype description', hint.desc, template.desc, TEXT_STYLES);
    check('Safari hint: one line, no label, no control', !hint.label && !hint.action && near(h?.box.height, (template.desc?.box.height ?? 0) + 28 + 1), `${round(h?.box.height ?? 0)} px`);

    const report = [
      '# Visual check · Install as app row (D34 addition)',
      '',
      'Generated by `tests/e2e/visual/install-row.spec.ts`. The row is not in the prototype: it is checked on its own (like D18\'s Name row). App: demo seed, 1440×900, `/settings` (Claude Code) with a synthetic `beforeinstallprompt`; the Safari form with a Safari user agent. Template: the prototype\'s Notifications → "In-app toast + sound" row (label, description, "Send test").',
      '',
      `**Gate:** ${failures.length === 0 ? 'green' : 'red'}`,
      '',
      '| Check | Measured | Result |',
      '|---|---|---|',
      ...rows,
      '',
      'The Settings visual spec (`settings.spec.ts`) and the full pass never see the row (the test Chromium offers no installation), so the prototype\'s Claude Code rows keep their boxes there. Screenshot: `install-row.png` (the Claude Code section with the row).',
      '',
    ].join('\n');
    await writeReport({ 'install-row.md': report, 'install-row.png': shot });
    expect(failures).toEqual([]);
  });
});
