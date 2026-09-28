import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from '../question-world.ts';
import { type Box, type Part, STYLE_PROPS, newVisualPage, openPrototype, pixelDiff, round, sideBySide, writeReport } from './harness.ts';

/**
 * Visual oracle for the toast (M3.4, D10): the prototype with `simulateIncoming`
 * on (its `arrive()` toast after 9 s: qa-free-talk, one question) against the app
 * on the real code path (no demo seed, D13): a fake-claude session named
 * `qa-free-talk` with a worktree in a temp `acme-app-front` repo asks one question
 * (`ask-delay`), and the `/hub` `questionBatch` raises the toast. Gate: boxes within
 * ±2 px, copy exact where the data allows, computed styles equal; the pixel diff of
 * the toast crops is advisory (`docs/visual/toast.md`).
 */

/** Which edges of a part are compared. `shift` = x, width, height, and y after the text's height difference. */
type Edges = 'box' | 'top' | 'shift';

interface PartSpec {
  /** Child indexes from the toast's root element. */
  readonly path: readonly number[];
  readonly edges: Edges;
  readonly copy: boolean;
}

const PARTS: Readonly<Record<string, PartSpec>> = {
  toast: { path: [], edges: 'top', copy: false },
  head: { path: [0], edges: 'box', copy: false },
  dot: { path: [0, 0], edges: 'box', copy: false },
  title: { path: [0, 1], edges: 'box', copy: true },
  sub: { path: [0, 2], edges: 'box', copy: true },
  close: { path: [0, 3], edges: 'box', copy: true },
  branch: { path: [1], edges: 'box', copy: true },
  text: { path: [2], edges: 'top', copy: true },
  actions: { path: [3], edges: 'shift', copy: false },
  jump: { path: [3, 0], edges: 'shift', copy: true },
  later: { path: [3, 1], edges: 'shift', copy: true },
};

/**
 * Known differences, not findings. The prototype's toast carries hand-written mock
 * copy: a branch the demo made up and a one-line summary of its question. The app
 * shows real data (D13): the session's worktree branch (gap #1: `session/<name>`)
 * and the question verbatim (SPEC → Copy rules), which is one line shorter here, so
 * the toast and its text are shorter and the actions sit that much higher.
 */
const KNOWN_COPY: Readonly<Record<string, { readonly prototype: string; readonly app: string }>> = {
  branch: { prototype: 'acme-app-front ⎇ qa/free-talk-e2e', app: 'acme-app-front ⎇ session/qa-free-talk' },
  text: { prototype: 'Confluence AC-7 and Figma disagree on the empty-state copy. Which one is the contract?', app: 'Which environment should I target?' },
};

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
  'box-shadow',
  'width',
  'gap',
] as const;

/** Measures the toast's parts (the toast = the absolutely positioned 360px box holding "Jump to session"). */
async function measureToast(page: Page): Promise<Record<string, Part | null>> {
  const paths = Object.fromEntries(Object.entries(PARTS).map(([name, spec]) => [name, spec.path]));
  return page.evaluate(
    ({ wanted, props }) => {
      const root = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
        const style = getComputedStyle(el);
        return style.position === 'absolute' && style.width === '360px' && (el.textContent ?? '').includes('Jump to session');
      });
      const out: Record<string, { box: { x: number; y: number; width: number; height: number }; text: string; style: Record<string, string> } | null> = {};
      for (const [name, indexes] of Object.entries(wanted)) {
        let el: Element | undefined = root;
        for (const index of indexes) el = el?.children[index];
        if (!el) {
          out[name] = null;
          continue;
        }
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = computed.getPropertyValue(prop);
        out[name] = { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: (el.textContent ?? '').trim(), style };
      }
      return out;
    },
    { wanted: paths, props: [...new Set<string>([...STYLE_PROPS, ...COMPARED_STYLES])] },
  );
}

function fmt(box: Box): string {
  return `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}`;
}

function edgeIssues(name: string, p: Box, a: Box, edges: Edges, shift: number): string[] {
  const checks: Array<[string, number, number]> = [
    ['x', p.x, a.x],
    ['width', p.width, a.width],
  ];
  if (edges === 'box' || edges === 'top') checks.push(['y', p.y, a.y]);
  if (edges === 'box' || edges === 'shift') checks.push(['height', p.height, a.height]);
  if (edges === 'shift') checks.push(['y (shifted by the text height difference)', p.y - shift, a.y]);
  return checks.filter(([, pv, av]) => Math.abs(pv - av) > 2).map(([edge, pv, av]) => `${name}.${edge}: prototype ${round(pv)} vs app ${round(av)}`);
}

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('visual-toast');
});

test.afterAll(async () => {
  await world?.stop();
});

test('the toast matches the prototype (boxes ±2 px, copy, computed styles)', async ({ browser }) => {
  test.setTimeout(90_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);

  await openPrototype(protoPage, { simulateIncoming: true });
  await protoPage.getByText('Jump to session', { exact: true }).waitFor({ timeout: 30_000 });

  await openWithHub(appPage, `${world.baseUrl}/inbox`);
  await appPage.evaluate(async () => {
    await document.fonts.ready;
  });
  await world.startSession(appPage, 'qa-free-talk', '[fake:ask-delay] Ask me where to deploy.', true);
  await appPage.getByTestId('toast').waitFor();
  await expect(appPage.getByTestId('toast').locator('.sb-toast-branch')).toHaveText('acme-app-front ⎇ session/qa-free-talk');

  const proto = await measureToast(protoPage);
  const app = await measureToast(appPage);
  const shift = (proto['text']?.box.height ?? 0) - (app['text']?.box.height ?? 0);
  const rows: string[] = [];
  const failures: string[] = [];
  for (const [name, spec] of Object.entries(PARTS)) {
    const p = proto[name];
    const a = app[name];
    if (!p || !a) {
      failures.push(`${name}: missing (${p ? 'app' : 'prototype'})`);
      rows.push(`| ${name} | ${spec.edges} | ${p ? fmt(p.box) : '—'} | ${a ? fmt(a.box) : '—'} | FAIL | |`);
      continue;
    }
    const issues = edgeIssues(name, p.box, a.box, spec.edges, shift);
    let copyNote = '';
    if (spec.copy) {
      const known = KNOWN_COPY[name];
      if (known && p.text === known.prototype && a.text === known.app) {
        copyNote = `${JSON.stringify(a.text)} (prototype ${JSON.stringify(p.text)}: known difference, D13)`;
      } else {
        if (p.text !== a.text) issues.push(`${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
        copyNote = JSON.stringify(a.text);
      }
    }
    for (const prop of COMPARED_STYLES) {
      if (p.style[prop] !== a.style[prop]) issues.push(`${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    }
    failures.push(...issues);
    rows.push(`| ${name} | ${spec.edges} | ${fmt(p.box)} | ${fmt(a.box)} | ${issues.length ? 'FAIL' : 'ok'} | ${copyNote} |`);
  }

  // Advisory: pixel diff of the toast crops (the same size: the prototype's box), side by side.
  const pBox = proto['toast']?.box;
  const aBox = app['toast']?.box;
  let diff = Number.NaN;
  const files: Record<string, string | Buffer> = {};
  if (pBox && aBox) {
    const margin = 12;
    const clip = (box: Box, height: number) => ({ x: box.x - margin, y: Math.max(0, box.y - margin), width: box.width + 2 * margin, height: height + 2 * margin });
    const height = Math.max(pBox.height, aBox.height);
    const protoShot = await protoPage.screenshot({ clip: clip(pBox, height) });
    const appShot = await appPage.screenshot({ clip: clip(aBox, height) });
    diff = (await pixelDiff(appPage, protoShot, appShot)).percent;
    files['toast-side-by-side.png'] = await sideBySide(appPage, protoShot, appShot);
    files['toast-page-side-by-side.png'] = await sideBySide(appPage, await protoPage.screenshot(), await appPage.screenshot());
  }
  files['toast.md'] = report(rows, failures, diff, shift);
  await writeReport(files);

  expect(failures).toEqual([]);
});

function report(rows: string[], failures: string[], diff: number, shift: number): string {
  return `# Visual oracle · Toast (M3.4)

Generated by \`tests/e2e/visual/toast.spec.ts\` (D10). App: real code path (no demo seed, D13), 1440×900, \`/inbox\`; a fake-claude session \`qa-free-talk\` with a worktree in a temp \`acme-app-front\` repo asks one question (\`ask-delay\`), the \`/hub\` \`questionBatch\` raises the toast.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline with \`simulateIncoming\` on (the \`arrive()\` toast after 9 s), same viewport.

**Gate:** ${failures.length === 0 ? 'green' : `red (${failures.length} findings)`}

Pixel diff of the toast crops (advisory, channel threshold 24): **${Number.isNaN(diff) ? '—' : `${diff.toFixed(2)}%`}**. Side by side (prototype left, app right): \`toast-side-by-side.png\` (the toast), \`toast-page-side-by-side.png\` (the page; the main area behind the toast is the demo Inbox in the prototype and a one-item real Inbox in the app).

Text height difference (prototype − app): ${round(shift)} px; parts marked \`shift\` compare their y after it.

## Boxes (±2 px), copy and computed styles
Edges: \`box\` = x, y, width, height; \`top\` = x, y, width (the height follows the text); \`shift\` = x, width, height and y minus the text height difference.
Every part also compares these computed styles: ${COMPARED_STYLES.join(', ')}.

| Part | Edges | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${rows.join('\n')}

## Known differences (not findings)
- \`branch\`: the prototype's mock branch \`qa/free-talk-e2e\`; the app shows the session's real worktree branch (\`session/qa-free-talk\`, gap #1).
- \`text\`: the prototype shows a hand-written summary of its question; the app shows the question verbatim (SPEC → Copy rules, D13), one line here, so the toast is ${round(shift)} px shorter.

## Findings
${failures.length ? failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
