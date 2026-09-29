import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type ServerProcess, startServer } from '../../helpers/server-process.ts';
import {
  type DemoApp,
  type Geometry,
  type Part,
  compareBoxes,
  measure,
  newVisualPage,
  openApp,
  openPrototype,
  pixelDiff,
  round,
  sideBySide,
  startDemoApp,
  writeReport,
} from './harness.ts';
import { type OtherPillCheck, checkOtherPills, sameCopyBesidesOther } from './own-answer.ts';

/**
 * Visual oracle for the Inbox (M3.2, D10): the app (demo seed) against the
 * prototype at 1440×900, both with `simulateIncoming` off. Three states:
 * 1. the default view (first item selected: a 3-question batch),
 * 2. a system item picked (actions: first primary, the rest outlined),
 * 3. the empty state ("Inbox zero"): the prototype after answering and dismissing
 *    every item, the app on the real code path with nothing waiting (no demo seed).
 * Gate: boxes within ±2 px, copy exact, computed styles equal, plus the advisory
 * pixel diff and side-by-side PNGs (`docs/visual/inbox.md`).
 * D39 (an addition, checked on its own like D18's Name row): each question's
 * options end with an **Other…** pill the prototype does not have. The prototype's
 * parts keep their boxes; a question's text differs only by that pill at its end
 * (`sameCopyBesidesOther`), and the pill is gated on its own (`own-answer.ts`).
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

/** Paths from the shell grid (harness.measure): [1] main, [1,0] the Inbox grid. */
const LIST = [1, 0, 0] as const;
const DETAIL = [1, 0, 1] as const;

function card(index: number, name: string): Record<string, PartSpec> {
  const base = [...LIST, 1, index];
  return {
    [`${name}`]: { path: base, geometry: 'box', copy: false },
    [`${name}Head`]: { path: [...base, 0], geometry: 'box', copy: false },
    [`${name}Dot`]: { path: [...base, 0, 0], geometry: 'box', copy: false },
    [`${name}Source`]: { path: [...base, 0, 1], geometry: 'box', copy: true },
    [`${name}Age`]: { path: [...base, 0, 2], geometry: 'box', copy: true },
    [`${name}Title`]: { path: [...base, 1], geometry: 'box', copy: true },
    [`${name}Kind`]: { path: [...base, 2], geometry: 'box', copy: true },
  };
}

/** Parts of the default view (first item: free-talk-feature, 3 questions). */
const DEFAULT_PARTS: Readonly<Record<string, PartSpec>> = {
  inbox: { path: [1, 0], geometry: 'box', copy: false },
  listColumn: { path: LIST, geometry: 'box', copy: false },
  listHead: { path: [...LIST, 0], geometry: 'box', copy: false },
  heading: { path: [...LIST, 0, 0], geometry: 'box', copy: true },
  count: { path: [...LIST, 0, 1], geometry: 'box', copy: true },
  list: { path: [...LIST, 1], geometry: 'box', copy: false },
  ...card(0, 'card0'),
  ...card(1, 'card1'),
  ...card(2, 'card2'),
  ...card(3, 'card3'),
  ...card(4, 'card4'),
  detail: { path: DETAIL, geometry: 'box', copy: false },
  meta: { path: [...DETAIL, 0], geometry: 'box', copy: true },
  metaDot: { path: [...DETAIL, 0, 0], geometry: 'box', copy: false },
  metaSource: { path: [...DETAIL, 0, 1], geometry: 'box', copy: true },
  metaKind: { path: [...DETAIL, 0, 3], geometry: 'box', copy: true },
  metaAge: { path: [...DETAIL, 0, 5], geometry: 'box', copy: true },
  openSession: { path: [...DETAIL, 0, 6], geometry: 'box', copy: true },
  title: { path: [...DETAIL, 1], geometry: 'box', copy: true },
  branches: { path: [...DETAIL, 2], geometry: 'box', copy: false },
  branch0: { path: [...DETAIL, 2, 0], geometry: 'box', copy: true },
  branch0Name: { path: [...DETAIL, 2, 0, 1], geometry: 'box', copy: true },
  branch1: { path: [...DETAIL, 2, 1], geometry: 'box', copy: true },
  card: { path: [...DETAIL, 3], geometry: 'box', copy: false },
  cardHead: { path: [...DETAIL, 3, 0], geometry: 'box', copy: true },
  q0: { path: [...DETAIL, 3, 1], geometry: 'box', copy: false },
  q0Source: { path: [...DETAIL, 3, 1, 0], geometry: 'box', copy: true },
  q0Quote: { path: [...DETAIL, 3, 1, 1], geometry: 'box', copy: true },
  q0Options: { path: [...DETAIL, 3, 1, 2], geometry: 'box', copy: false },
  q0Option0: { path: [...DETAIL, 3, 1, 2, 0], geometry: 'box', copy: true },
  q0Option1: { path: [...DETAIL, 3, 1, 2, 1], geometry: 'box', copy: true },
  q0Option2: { path: [...DETAIL, 3, 1, 2, 2], geometry: 'box', copy: true },
  q1: { path: [...DETAIL, 3, 2], geometry: 'box', copy: true },
  q2: { path: [...DETAIL, 3, 3], geometry: 'box', copy: true },
  cardFoot: { path: [...DETAIL, 3, 4], geometry: 'box', copy: false },
  cardStatus: { path: [...DETAIL, 3, 4, 0], geometry: 'box', copy: true },
  send: { path: [...DETAIL, 3, 4, 1], geometry: 'box', copy: true },
};

/** Parts once the system item (card 3, nightly-build-verify) is picked. */
const SYSTEM_PARTS: Readonly<Record<string, PartSpec>> = {
  card3: { path: [...LIST, 1, 3], geometry: 'box', copy: false },
  card0: { path: [...LIST, 1, 0], geometry: 'box', copy: false },
  meta: { path: [...DETAIL, 0], geometry: 'box', copy: true },
  metaSource: { path: [...DETAIL, 0, 1], geometry: 'box', copy: true },
  title: { path: [...DETAIL, 1], geometry: 'box', copy: true },
  branches: { path: [...DETAIL, 2], geometry: 'box', copy: false },
  branch0: { path: [...DETAIL, 2, 0], geometry: 'box', copy: true },
  text: { path: [...DETAIL, 3], geometry: 'box', copy: true },
  actions: { path: [...DETAIL, 4], geometry: 'box', copy: false },
  action0: { path: [...DETAIL, 4, 0], geometry: 'box', copy: true },
  action1: { path: [...DETAIL, 4, 1], geometry: 'box', copy: true },
  action2: { path: [...DETAIL, 4, 2], geometry: 'box', copy: true },
};

/** Parts of the empty state. */
const EMPTY_PARTS: Readonly<Record<string, PartSpec>> = {
  inbox: { path: [1, 0], geometry: 'box', copy: false },
  listColumn: { path: LIST, geometry: 'box', copy: false },
  heading: { path: [...LIST, 0, 0], geometry: 'box', copy: true },
  count: { path: [...LIST, 0, 1], geometry: 'box', copy: true },
  list: { path: [...LIST, 1], geometry: 'box', copy: false },
  allClear: { path: [...LIST, 1, 0], geometry: 'box', copy: true },
  detail: { path: DETAIL, geometry: 'box', copy: false },
  zero: { path: [...DETAIL, 0], geometry: 'box', copy: true },
  zeroTitle: { path: [...DETAIL, 0, 0], geometry: 'box', copy: true },
  zeroHint: { path: [...DETAIL, 0, 1], geometry: 'box', copy: true },
};

/**
 * Known differences, not findings: the prototype labels a batch "Loop paused" when
 * its one question comes from the mock source "circuit breaker"; a real batch's
 * source is always the session's main agent (M0.2), so the app labels it
 * "Question" and never reads prototype mock data (D13). See docs/inbox.md.
 */
const KNOWN_COPY: Readonly<Record<string, { readonly prototype: string; readonly app: string }>> = {
  card2Kind: { prototype: 'Loop paused', app: 'Question' },
};

/** Computed styles compared between the two pages for every part. */
const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
] as const;

interface Compared {
  readonly rows: string[];
  readonly failures: string[];
}

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

async function compare(protoPage: Page, appPage: Page, parts: Readonly<Record<string, PartSpec>>, state: string): Promise<Compared> {
  const paths = Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.path]));
  const proto = await measure(protoPage, paths);
  const app = await measure(appPage, paths);
  const rows: string[] = [];
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(parts)) {
    const p = proto[name];
    const a = app[name];
    if (!p || !a) {
      failures.push(`${state} ${name}: missing (${p ? 'app' : 'prototype'})`);
      rows.push(`| ${name} | ${spec.geometry} | ${p ? fmtBox(p) : '—'} | ${a ? fmtBox(a) : '—'} | FAIL | |`);
      continue;
    }
    const issues = compareBoxes(`${state} ${name}`, p.box, a.box, spec.geometry);
    let copyNote = '';
    if (spec.copy) {
      const known = KNOWN_COPY[name];
      if (known && p.text === known.prototype && a.text === known.app) {
        copyNote = `${JSON.stringify(a.text)} (prototype ${JSON.stringify(p.text)}: known difference, D13)`;
      } else if (p.text !== a.text && sameCopyBesidesOther(p.text, a.text)) {
        copyNote = `${JSON.stringify(p.text)} + "Other…" (D39, checked on its own)`;
      } else {
        if (p.text !== a.text) issues.push(`${state} ${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
        copyNote = JSON.stringify(a.text);
      }
    }
    for (const prop of COMPARED_STYLES) {
      if (p.style[prop] !== a.style[prop]) issues.push(`${state} ${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    }
    failures.push(...issues);
    rows.push(`| ${name} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${issues.length ? 'FAIL' : 'ok'} | ${copyNote} |`);
  }
  return { rows, failures };
}

/** The computed opacity of the element at `path` from the shell grid. */
async function opacityAt(page: Page, indexes: readonly number[]): Promise<string | null> {
  return page.evaluate((wanted) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const index of wanted) el = el?.children[index];
    return el ? getComputedStyle(el).opacity : null;
  }, indexes);
}

/** Clicks the element at `path` from the shell grid (both pages share the structure). */
async function clickAt(page: Page, indexes: readonly number[]): Promise<void> {
  const box = await page.evaluate((wanted) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const index of wanted) el = el?.children[index];
    const rect = el?.getBoundingClientRect();
    return rect ? { x: rect.x + 20, y: rect.y + 10 } : null;
  }, indexes);
  if (!box) throw new Error(`nothing at ${indexes.join(',')}`);
  await page.mouse.click(box.x, box.y);
}

/** Answers and dismisses every item of the prototype's Inbox (simulateIncoming off). */
async function emptyPrototype(page: Page): Promise<void> {
  for (let guard = 0; guard < 12; guard += 1) {
    if ((await page.getByText('Inbox zero', { exact: true }).count()) > 0) return;
    const send = page.getByText(/^Send (all answers|answer)$/);
    if ((await send.count()) > 0) {
      // Pick the first option of every question: the option pills follow each quote.
      const quotes = await page.getByText(/^“[\s\S]*”$/).all();
      for (const quote of quotes) {
        await quote.locator('xpath=following-sibling::div[1]/span[1]').click();
      }
      await send.click();
      continue;
    }
    for (const label of ['Dismiss', 'Keep']) {
      const action = page.getByText(label, { exact: true });
      if ((await action.count()) > 0) {
        await action.first().click();
        break;
      }
    }
  }
  await page.getByText('Inbox zero', { exact: true }).waitFor();
}

let demo: DemoApp;
let emptyTmp: string;
let empty: ServerProcess;

test.beforeAll(async () => {
  demo = await startDemoApp();
  emptyTmp = await makeTempDir('visual-inbox-empty');
  empty = await startServer({ SWITCHBOARD_DATA_DIR: path.join(emptyTmp, 'data') });
});

test.afterAll(async () => {
  await demo?.stop();
  await empty?.stop();
  if (emptyTmp) await removeTempDir(emptyTmp);
});

test('Inbox matches the prototype: list, cards, detail, question card, system actions, Inbox zero (boxes ±2 px, copy, styles)', async ({ browser }) => {
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await openApp(appPage, demo.baseUrl, '/inbox');
  await appPage.getByTestId('inbox-item').nth(4).waitFor();
  await appPage.getByTestId('question-card').waitFor();

  // 1. Default view.
  const first = await compare(protoPage, appPage, DEFAULT_PARTS, 'default');
  const failures = [...first.failures];
  // D39: the Other… pill of each question, on its own.
  const otherPills = await checkOtherPills(
    protoPage,
    appPage,
    'default',
    { q0Options: [...DETAIL, 3, 1, 2], q1Options: [...DETAIL, 3, 2, 2], q2Options: [...DETAIL, 3, 3, 2] },
    failures,
  );
  const sendPath = [...DETAIL, 3, 4, 1];
  const sendOpacity = { prototype: await opacityAt(protoPage, sendPath), app: await opacityAt(appPage, sendPath) };
  if (sendOpacity.prototype !== '0.45' || sendOpacity.app !== '0.45') failures.push(`default send.opacity: prototype ${sendOpacity.prototype} vs app ${sendOpacity.app}`);
  const protoDefault = await protoPage.screenshot();
  const appDefault = await appPage.screenshot();
  const mainClip = { x: 256, y: 0, width: 1184, height: 900 };
  const protoDefaultMain = await protoPage.screenshot({ clip: mainClip });
  const appDefaultMain = await appPage.screenshot({ clip: mainClip });

  // Partial answers keep Send at 45% in both; the status line follows.
  await clickAt(protoPage, [...DETAIL, 3, 1, 2, 0]);
  await clickAt(appPage, [...DETAIL, 3, 1, 2, 0]);
  const partial = await compare(
    protoPage,
    appPage,
    {
      q0Option0: { path: [...DETAIL, 3, 1, 2, 0], geometry: 'box', copy: true },
      cardStatus: { path: [...DETAIL, 3, 4, 0], geometry: 'box', copy: true },
    },
    'one-answered',
  );
  failures.push(...partial.failures);
  const partialOpacity = { prototype: await opacityAt(protoPage, sendPath), app: await opacityAt(appPage, sendPath) };
  if (partialOpacity.prototype !== '0.45' || partialOpacity.app !== '0.45') failures.push(`one-answered send.opacity: prototype ${partialOpacity.prototype} vs app ${partialOpacity.app}`);

  // 2. The system item (card 3).
  await clickAt(protoPage, [...LIST, 1, 3]);
  await clickAt(appPage, [...LIST, 1, 3]);
  await appPage.getByTestId('inbox-actions').waitFor();
  const system = await compare(protoPage, appPage, SYSTEM_PARTS, 'system');
  failures.push(...system.failures);
  const protoSystemMain = await protoPage.screenshot({ clip: mainClip });
  const appSystemMain = await appPage.screenshot({ clip: mainClip });

  // 3. Inbox zero: the prototype emptied by hand, the app with nothing waiting (real path).
  await emptyPrototype(protoPage);
  const emptyPage = await newVisualPage(browser);
  await openApp(emptyPage, empty.baseUrl, '/inbox');
  await emptyPage.getByTestId('inbox-zero').waitFor();
  const zero = await compare(protoPage, emptyPage, EMPTY_PARTS, 'empty');
  failures.push(...zero.failures);
  const protoEmptyMain = await protoPage.screenshot({ clip: mainClip });
  const appEmptyMain = await emptyPage.screenshot({ clip: mainClip });

  // Advisory pixel diffs + side-by-side captures.
  const diffFull = await pixelDiff(appPage, protoDefault, appDefault);
  const diffMain = await pixelDiff(appPage, protoDefaultMain, appDefaultMain);
  const diffSystem = await pixelDiff(appPage, protoSystemMain, appSystemMain);
  const diffEmpty = await pixelDiff(appPage, protoEmptyMain, appEmptyMain);
  await writeReport({
    'inbox.md': report({
      sections: [
        ['Default view (first item selected)', first.rows],
        ['One of three answered', partial.rows],
        ['System item picked (nightly-build-verify)', system.rows],
        ['Inbox zero', zero.rows],
      ],
      otherPills,
      failures,
      opacity: { default: sendOpacity, partial: partialOpacity },
      diffs: { full: diffFull.percent, main: diffMain.percent, system: diffSystem.percent, empty: diffEmpty.percent },
    }),
    'inbox-side-by-side.png': await sideBySide(appPage, protoDefault, appDefault),
    'inbox-main-side-by-side.png': await sideBySide(appPage, protoDefaultMain, appDefaultMain),
    'inbox-system-side-by-side.png': await sideBySide(appPage, protoSystemMain, appSystemMain),
    'inbox-empty-side-by-side.png': await sideBySide(appPage, protoEmptyMain, appEmptyMain),
  });

  expect(failures).toEqual([]);
});

function report(input: {
  sections: Array<[string, string[]]>;
  otherPills: readonly OtherPillCheck[];
  failures: string[];
  opacity: Record<string, { prototype: string | null; app: string | null }>;
  diffs: { full: number; main: number; system: number; empty: number };
}): string {
  const sections = input.sections
    .map(
      ([title, rows]) => `### ${title}
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${rows.join('\n')}`,
    )
    .join('\n\n');
  return `# Visual oracle · Inbox (M3.2)

Generated by \`tests/e2e/visual/inbox.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900, \`/inbox\`; the empty state from an app with nothing waiting (real path, no demo seed).
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, same viewport; its empty state after answering and dismissing every item.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24): full page **${input.diffs.full.toFixed(2)}%**, main area (256,0 1184×900) **${input.diffs.main.toFixed(2)}%**, main area with the system item picked **${input.diffs.system.toFixed(2)}%**, main area empty **${input.diffs.empty.toFixed(2)}%**.

Side by side (prototype left, app right): \`inbox-side-by-side.png\`, \`inbox-main-side-by-side.png\`, \`inbox-system-side-by-side.png\`, \`inbox-empty-side-by-side.png\`.

Send opacity (SPEC: 45% until everything is answered): default prototype ${input.opacity['default']?.prototype} / app ${input.opacity['default']?.app}; one of three answered prototype ${input.opacity['partial']?.prototype} / app ${input.opacity['partial']?.app}.

## Boxes (±2 px), copy and computed styles
Every part also compares these computed styles: ${COMPARED_STYLES.join(', ')}.

${sections}

### D39 · Other… (an addition, checked on its own)
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${input.otherPills.map((check) => `| ${check.part} | addition | — | ${check.note.replaceAll('|', '\\|')} | ${check.ok ? 'ok' : 'FAIL'} | |`).join('\n')}

## Known differences (not findings)
- D39: every question ends its options with an **Other…** pill (the developer's own answer), which the prototype does not have. It is the options row's last child, on the options' line, so every prototype part keeps its box; the text of a question (\`q1\`, \`q2\`) is the prototype's plus "Other…" at its end, and the pill is checked on its own (the D39 section above: after the prototype's options, on their line, one gap after the last option, as high as them, styled like an unpicked option).
- \`card2Kind\`: the prototype shows "Loop paused" for button-rollout because its one question comes from the mock source "circuit breaker"; a real batch's source is the session's main agent (M0.2), the app shows "Question" and never reads prototype mock data (D13). \`docs/inbox.md\`.

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
