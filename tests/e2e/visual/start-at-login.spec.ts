import { type Page, expect, test } from '@playwright/test';
import { type ServiceWorld, startServiceWorld } from '../service-world.ts';
import { BOX_TOLERANCE_PX, newVisualPage, openApp, openPrototype, pixelDiff, round, sideBySide, writeReport } from './harness.ts';

/**
 * Visual oracle for the "Start at login" row (M9.1, D10) against the prototype's
 * Settings → Claude Code row at 1440×900. The app runs on the real code path
 * (`service-world.ts`) with the toggle turned on, so the value reads "on" like
 * the prototype's. Gate: the row, label, description and value sizes and their
 * offsets inside the row within ±2 px, exact copy, equal computed styles. The
 * row sits elsewhere on the page until M8.2's Settings view lands (no nav column,
 * no section title), so page positions are not compared; the pixel diff of the
 * row crops is advisory (`docs/visual/start-at-login.md`).
 */

const STYLES = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'padding-top',
  'padding-bottom',
  'border-bottom-color',
  'border-bottom-width',
  'border-bottom-style',
  'text-decoration-line',
] as const;

interface Measured {
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly text: string;
  readonly style: Readonly<Record<string, string>>;
}

type Parts = Record<'row' | 'label' | 'desc' | 'value', Measured>;

/** Measures the row whose label is "Start at login": the row, label, description and value. */
async function measureRow(page: Page, valuePath: readonly number[]): Promise<Parts> {
  return page.evaluate(
    ({ props, valuePath: path }) => {
      const row = [...document.querySelectorAll<HTMLElement>('body *')].find(
        (el) => getComputedStyle(el).display === 'flex' && el.firstElementChild?.firstElementChild?.textContent === 'Start at login',
      );
      if (!row) throw new Error('no Start at login row');
      const pick = (el: Element | null | undefined) => {
        if (!el) throw new Error('missing part');
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (el.textContent ?? '').trim(), style };
      };
      let value: Element | null | undefined = row;
      for (const index of path) value = value?.children[index];
      return {
        row: pick(row),
        label: pick(row.firstElementChild?.children[0]),
        desc: pick(row.firstElementChild?.children[1]),
        value: pick(value),
      };
    },
    { props: STYLES as readonly string[], valuePath },
  );
}

async function rowShot(page: Page): Promise<Buffer> {
  const box = (await measureRow(page, [1])).row.box;
  return page.screenshot({ clip: { x: box.x, y: box.y, width: Math.round(box.width), height: Math.round(box.height) } });
}

test.describe('visual: Start at login row', () => {
  let world: ServiceWorld;

  test.beforeAll(async () => {
    world = await startServiceWorld();
  });

  test.afterAll(async () => {
    if (world) expect(await world.stop()).toBe(0);
  });

  test('matches the prototype row (Settings → Claude Code)', async ({ browser }) => {
    const proto = await newVisualPage(browser);
    await openPrototype(proto);
    await proto.getByText('Settings', { exact: true }).first().click();
    await proto.getByText('Start at login', { exact: true }).waitFor();
    const protoParts = await measureRow(proto, [1]);

    const app = await newVisualPage(browser);
    await openApp(app, world.server.baseUrl, '/settings');
    await app.getByTestId('start-at-login').click();
    await expect(app.getByTestId('start-at-login')).toHaveText('on');
    await app.mouse.move(0, 0);
    // The value is the button inside the control (`.sb-login-control > button`).
    const appParts = await measureRow(app, [1, 0]);

    const findings: string[] = [];
    for (const name of ['row', 'label', 'desc', 'value'] as const) {
      const p = protoParts[name];
      const a = appParts[name];
      for (const dim of ['width', 'height'] as const) {
        if (Math.abs(p.box[dim] - a.box[dim]) > BOX_TOLERANCE_PX) findings.push(`${name}.${dim}: prototype ${round(p.box[dim])}, app ${round(a.box[dim])}`);
      }
      if (name !== 'row') {
        for (const axis of ['x', 'y'] as const) {
          const po = p.box[axis] - protoParts.row.box[axis];
          const ao = a.box[axis] - appParts.row.box[axis];
          if (Math.abs(po - ao) > BOX_TOLERANCE_PX) findings.push(`${name}.${axis} in the row: prototype ${round(po)}, app ${round(ao)}`);
        }
        if (p.text !== a.text) findings.push(`${name} copy: prototype "${p.text}", app "${a.text}"`);
      }
      for (const prop of STYLES) {
        // Borders and paddings belong to the row; text styles to its parts.
        if (name === 'row' ? !prop.startsWith('padding') && !prop.startsWith('border') : prop.startsWith('padding') || prop.startsWith('border')) continue;
        if (p.style[prop] !== a.style[prop]) findings.push(`${name} ${prop}: prototype ${p.style[prop]}, app ${a.style[prop]}`);
      }
    }

    const protoPng = await rowShot(proto);
    const appPng = await rowShot(app);
    const diff = await pixelDiff(app, protoPng, appPng);
    const fmt = (m: Measured): string => `${round(m.box.x)},${round(m.box.y)} ${round(m.box.width)}×${round(m.box.height)}`;
    const report = [
      '# Visual oracle · Start at login row (M9.1)',
      '',
      'Generated by `tests/e2e/visual/start-at-login.spec.ts` (D10). App: real code path (no demo seed, D13), 1440×900, `/settings` with the toggle turned on (temp home, fake service manager: `tests/e2e/service-world.ts`).',
      'Prototype: `docs/handoff/prototype/Switchboard App.dc.html` offline, Settings → Claude Code, same viewport.',
      '',
      `**Gate:** ${findings.length === 0 ? 'green' : 'red'}`,
      '',
      `Pixel diff of the row crops (advisory, channel threshold 24): **${round(diff.percent)}%**. Side by side (prototype left, app right): \`start-at-login-side-by-side.png\`.`,
      '',
      '## Boxes (±2 px: sizes, and offsets inside the row), copy and computed styles',
      `Compared styles: ${STYLES.join(', ')} (paddings and borders on the row, the rest on its parts).`,
      '',
      '| Part | Prototype | App | Copy (exact) |',
      '|---|---|---|---|',
      ...(['row', 'label', 'desc', 'value'] as const).map(
        (name) => `| ${name} | ${fmt(protoParts[name])} | ${fmt(appParts[name])} | ${name === 'row' ? '' : `"${appParts[name].text}"`} |`,
      ),
      '',
      '## Known differences (not findings)',
      '- Page position: until M8.2\'s Settings view is merged, the placeholder view has no 230px section nav and no section title, so the row sits 230 px further left and higher than in the prototype (the 5th row of Claude Code there). Sizes, offsets inside the row, copy and styles are compared.',
      '',
      '## Findings',
      ...(findings.length === 0 ? ['- none'] : findings.map((f) => `- ${f}`)),
      '',
    ].join('\n');
    await writeReport({
      'start-at-login-side-by-side.png': await sideBySide(app, protoPng, appPng),
      'start-at-login.md': report,
    });
    expect(findings).toEqual([]);
  });
});
