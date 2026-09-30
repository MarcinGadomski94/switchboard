/**
 * Retakes the handoff's reference captures (`docs/handoff/screenshots/01–14-*.png`)
 * from the design prototype (`docs/handoff/prototype/Switchboard App.dc.html`),
 * opened offline the same way the visual oracle opens it
 * (`tests/e2e/visual/offline.ts`). The captures are 924×540: the prototype at
 * 1540×900 CSS pixels, shot at 60 % (device scale 0.6). Run it only after the
 * prototype changes: `node tools/screenshots/handoff.ts`.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, chromium } from '@playwright/test';
import { REPO_ROOT } from '../../tests/helpers/net.ts';
import { openPrototype } from '../../tests/e2e/visual/offline.ts';

/** Where the captures go. */
export const HANDOFF_SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'handoff', 'screenshots');

/** Clicks the element at `indexPath` below the prototype's shell grid (`256px …` columns). */
async function clickPath(page: Page, indexPath: readonly number[]): Promise<void> {
  await page.evaluate((p) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const i of p) el = el?.children[i];
    if (!(el instanceof HTMLElement)) throw new Error(`nothing at ${p.join(',')}`);
    el.click();
  }, [...indexPath]);
}

const NAV = [0, 2];
const TOOLS = [0, 4];
const SESSIONS = [0, 6];
const SETTINGS = [0, 7];

/** One capture: the file name and how to get there from the previous capture's state. */
const SHOTS: ReadonlyArray<readonly [name: string, go: (page: Page) => Promise<void>]> = [
  ['01-inbox.png', (page) => clickPath(page, [...NAV, 0])],
  ['02-session-chat.png', (page) => clickPath(page, [...SESSIONS, 0])],
  ['03-session-timeline.png', (page) => page.getByText(/^Timeline$/).first().click()],
  ['04-session-diff.png', (page) => page.getByText(/^Diff · \d+$/).first().click()],
  ['05-solutions.png', (page) => clickPath(page, [...NAV, 1])],
  ['06-schedules-loops.png', (page) => clickPath(page, [...NAV, 2])],
  ['07-artifacts.png', (page) => clickPath(page, [...NAV, 3])],
  ['08-history.png', (page) => clickPath(page, [...NAV, 4])],
  ['09-tool-codebase-memory.png', (page) => clickPath(page, [...TOOLS, 0])],
  ['10-settings-claude.png', (page) => clickPath(page, SETTINGS)],
  ['11-settings-tools.png', (page) => page.getByText('Embedded tools', { exact: true }).first().click()],
  ['12-new-session.png', (page) => page.getByText('+ New session', { exact: true }).click()],
  [
    '13-setup-wizard.png',
    async (page) => {
      await page.keyboard.press('Escape');
      await page.getByText('Claude Code', { exact: true }).first().click();
      await page.getByText('Run setup again', { exact: true }).click();
    },
  ],
  [
    '14-palette.png',
    async (page) => {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
    },
  ],
];

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1540, height: 900 }, deviceScaleFactor: 0.6 });
    const page = await context.newPage();
    await openPrototype(page, { simulateIncoming: false });
    for (const [name, go] of SHOTS) {
      await go(page);
      await page.waitForTimeout(300);
      await writeFile(path.join(HANDOFF_SHOTS_DIR, name), await page.screenshot({ type: 'png' }));
      console.log(path.join('docs', 'handoff', 'screenshots', name));
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
