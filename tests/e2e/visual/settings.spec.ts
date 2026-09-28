import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { Schedule, Solution, SolutionGroup } from '../../../src/core/api.ts';
import { loadDemoData } from '../../../src/server/demo/data.ts';
import { createDemoProviders } from '../../../src/server/demo/providers.ts';
import { fakeClaudeBinEnv } from '../../../tools/fake-claude/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import {
  type DemoApp,
  type Geometry,
  type Part,
  compareBoxes,
  hexToRgb,
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

/**
 * Visual oracle for Settings (M8.2, D10) against the prototype's `vSettings` at
 * 1440×900 (screenshots 10 and 11 are the Claude Code and Embedded tools
 * sections). Every section is compared: nav, titles, rows (label, description,
 * value), the scan table, schedule rows and tool cards, as boxes (±2 px), copy
 * and computed styles, plus SPEC token checks and an advisory pixel diff.
 *
 * The app runs with the demo seed and a temp workspace root holding a router
 * `AGENTS.md`. `/api/system` (M5.3), `/api/schedules` (M7.1) and `/api/solutions`
 * (M6.1) are other lanes' routes that answer 501 in this lane, so the app page
 * gets them in the browser: the demo system provider's values, the demo
 * schedules, and a scan with the prototype's folders, counts and rules under the
 * temp root. Copy that differs on purpose is listed in {@link COPY_EXEMPT} with
 * the reason, and reported.
 */

interface PartSpec {
  readonly path: readonly number[];
  readonly geometry: Geometry;
  readonly copy: boolean;
}

interface SectionSpec {
  readonly key: string;
  readonly label: string;
  /** Text that marks the section as rendered in both pages. */
  readonly ready: string;
  readonly parts: Readonly<Record<string, PartSpec>>;
}

const box = (path: readonly number[], copy = true, geometry: Geometry = 'box'): PartSpec => ({ path, geometry, copy });

/**
 * A settings row at content child `i`: the row, its label, description and
 * value(s). `inner` = the geometry of the label, description and values: `none`
 * when an exempt value's width moves them (`COPY_EXEMPT`).
 */
function rowParts(
  name: string,
  i: number,
  values: number,
  options: { readonly copyDesc?: boolean; readonly copyValue?: boolean; readonly inner?: Geometry } = {},
): Record<string, PartSpec> {
  const { copyDesc = true, copyValue = true, inner = 'box' } = options;
  const parts: Record<string, PartSpec> = {
    [name]: box([1, 0, 1, i], false),
    [`${name}Label`]: box([1, 0, 1, i, 0, 0], true, inner),
    [`${name}Desc`]: box([1, 0, 1, i, 0, 1], copyDesc, inner),
  };
  for (let v = 1; v <= values; v += 1) parts[`${name}Value${values > 1 ? v : ''}`] = box([1, 0, 1, i, v], copyValue, inner);
  return parts;
}

const NAV: Record<string, PartSpec> = {
  view: box([1, 0], false),
  nav: box([1, 0, 0], false),
  navTitle: box([1, 0, 0, 0]),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`nav${i}`, box([1, 0, 0, i])])),
  content: box([1, 0, 1], false),
  title: box([1, 0, 1, 0]),
};

const SECTIONS: readonly SectionSpec[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    ready: 'Run setup again',
    parts: {
      ...NAV,
      ...rowParts('cli', 1, 1),
      ...rowParts('account', 2, 1, { copyValue: false, inner: 'none' }),
      ...rowParts('service', 3, 1, { copyValue: false }),
      ...rowParts('bind', 4, 1),
      ...rowParts('login', 5, 1),
      ...rowParts('permissions', 6, 1, { copyDesc: false }),
      actions: box([1, 0, 1, 7], false),
      runSetup: box([1, 0, 1, 7, 0]),
    },
  },
  {
    key: 'workspace',
    label: 'Workspace & solutions',
    ready: 'infrastructure/',
    parts: {
      ...NAV,
      // The temp root path is longer than D:\\acme and wraps: the row is taller, so
      // everything below keeps x, width and height but moves down (geometry `size`).
      ...rowParts('root', 1, 1, { copyDesc: false, inner: 'size' }),
      root: box([1, 0, 1, 1], false, 'none'),
      rootDesc: box([1, 0, 1, 1, 0, 1], false, 'none'),
      scan: box([1, 0, 1, 2], false, 'size'),
      ...Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6, 7].flatMap((r) => [
          [`scan${r}`, box([1, 0, 1, 2, r], false, 'size')],
          [`scan${r}Folder`, box([1, 0, 1, 2, r, 0], true, 'size')],
          [`scan${r}Count`, box([1, 0, 1, 2, r, 1], true, 'size')],
          [`scan${r}Examples`, box([1, 0, 1, 2, r, 2], false, 'size')],
          [`scan${r}Rule`, box([1, 0, 1, 2, r, 3], true, 'size')],
        ]),
      ),
    },
  },
  {
    key: 'sessions',
    label: 'Sessions & worktrees',
    ready: 'Session-start questions',
    parts: {
      ...NAV,
      ...rowParts('folder', 1, 1),
      ...rowParts('worktrees', 2, 1),
      ...rowParts('location', 3, 1),
      ...rowParts('cleanup', 4, 1),
      ...rowParts('ultracode', 5, 1),
      ...rowParts('questions', 6, 1),
    },
  },
  {
    key: 'notify',
    label: 'Notifications & usage',
    ready: 'Near the limit',
    parts: {
      ...NAV,
      ...rowParts('toast', 1, 1),
      ...rowParts('os', 2, 2),
      // A <select> in the app: its text is every option, so its copy is checked apart ("90%").
      ...rowParts('warn', 3, 1, { copyValue: false }),
      ...rowParts('limit', 4, 1),
    },
  },
  {
    key: 'schedules',
    label: 'Schedules',
    ready: 'dependency-audit',
    parts: {
      ...NAV,
      ...Object.fromEntries(
        [1, 2, 3, 4].flatMap((r) => [
          [`sched${r}`, box([1, 0, 1, r], false)],
          [`sched${r}Dot`, box([1, 0, 1, r, 0], false)],
          [`sched${r}Name`, box([1, 0, 1, r, 1])],
          [`sched${r}Cron`, box([1, 0, 1, r, 2])],
          [`sched${r}Desc`, box([1, 0, 1, r, 3])],
        ]),
      ),
    },
  },
  {
    key: 'tools',
    label: 'Embedded tools',
    ready: 'AI chat connected to other tools',
    parts: {
      ...NAV,
      lede: box([1, 0, 1, 1], false),
      // Taller by the "Add a tool" card (gap #14).
      list: box([1, 0, 1, 2], false, 'none'),
      ...Object.fromEntries(
        [0, 1].flatMap((c) => [
          [`card${c}`, box([1, 0, 1, 2, c], false)],
          [`card${c}Dot`, box([1, 0, 1, 2, c, 0, 0], false)],
          [`card${c}Name`, box([1, 0, 1, 2, c, 0, 1])],
          [`card${c}Desc`, box([1, 0, 1, 2, c, 0, 2])],
          // Moved left by the Remove action (gap #14): copy and styles only.
          [`card${c}State`, { path: [1, 0, 1, 2, c, 0, 3], geometry: 'none', copy: true }],
          [`card${c}Url`, box([1, 0, 1, 2, c, 1, 0], false)],
          [`card${c}Test`, box([1, 0, 1, 2, c, 1, 1])],
          [`card${c}Open`, box([1, 0, 1, 2, c, 1, 2])],
        ]),
      ),
    },
  },
  {
    key: 'github',
    label: 'GitHub',
    ready: 'Repositories',
    parts: {
      ...NAV,
      ...rowParts('ghLogin', 1, 1),
      ...rowParts('prDetection', 2, 1, { copyValue: false, inner: 'none' }),
      ...rowParts('repos', 3, 1, { copyValue: false, inner: 'none' }),
    },
  },
];

/** Copy that differs from the prototype on purpose (not compared), with the reason. */
const COPY_EXEMPT: ReadonlyArray<readonly [part: string, reason: string]> = [
  ['claude.accountValue', '"Max · signed in": the plan is not in `/api/system`, so the app shows "signed in" (never invented)'],
  ['claude.serviceValue', 'the address carries the test port (127.0.0.1:49xx) instead of 4870'],
  ['claude.permissionsDesc', 'D6: permission requests also surface in the Inbox ("Only agent questions and permission requests surface here.")'],
  ['workspace.rootDesc', 'the temp workspace path instead of D:\\acme (gap #17: OS paths); the router title matches'],
  ['workspace.scan*Examples', 'examples are solution names from the scan; the prototype writes prose ("MAUI app + Mobile Gateway BFF")'],
  ['notify.warnValue', 'a <select>; its shown value is checked apart ("90%")'],
  ['tools.lede', 'gap #13: "URLs are saved in Switchboard." instead of "in this browser"'],
  ['github.prDetectionValue', 'the worktree manager polls every 5 min (`DEFAULT_PR_POLL_MS`); the prototype says 10'],
  ['github.reposValue', 'counts the scan (18 in the stubbed scan); the prototype says 16 next to an 18-solution scan table'],
];

/** Computed styles compared between the two pages for every part. */
const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'border-radius',
  'border-top-color',
  'border-top-width',
  'padding-top',
  'padding-left',
] as const;

let app: DemoApp;
let tmp: string;
let root: string;

test.beforeAll(async () => {
  tmp = await makeTempDir('visual-settings');
  root = path.join(tmp, 'ws');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
  // D14: the temp root is the default saved folder (Settings reports it as the workspace root).
  app = await startDemoApp({ SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv() }, { folder: root });
});

test.afterAll(async () => {
  await app?.stop();
  await removeTempDir(tmp);
});

/** Answers the other lanes' routes in the app page (see the module comment). */
async function stubOtherLanes(page: Page): Promise<void> {
  const data = await loadDemoData();
  const system = await createDemoProviders(data).system.system();
  const schedules: Schedule[] = data.schedules.map((s, i) => ({
    id: `demo-${i}`,
    name: s.name,
    description: s.description,
    cron: s.cron,
    paused: false,
    template: null,
    runs: s.runs.map((result, r) => ({ ts: new Date(Date.UTC(2026, 8, 1 + r)).toISOString(), result, summary: null })),
    nextRunAt: null,
  }));
  // The prototype's scan rows (folder, count, rule) as a scan under the temp root.
  const groups: SolutionGroup[] = [];
  const readOnly: Solution[] = [];
  for (const row of data.setup.scan) {
    const rule = row.rule === 'editable' ? 'editable' : row.rule === 'read-only' ? 'read-only' : 'on-request';
    const folder = row.folder.replace(/\/$/, '');
    const solutions = Array.from({ length: row.count }, (_, i): Solution => {
      const name = row.count === 1 && (folder === 'mobile' || folder === 'infrastructure') ? folder : `${folder}-${i + 1}`;
      const full = name === folder ? path.join(root, folder) : path.join(root, folder, name);
      return {
        name,
        path: full,
        relativePath: path.relative(root, full).split(path.sep).join('/'),
        type: 'Web',
        status: 'idle',
        rule,
        phase: '—',
        changes: '—',
        flag: '',
        conflict: false,
        conflictSessions: [],
        branches: [],
        ledger: null,
        artifacts: [],
        codebaseMemory: 'fresh',
      };
    });
    if (rule === 'read-only') readOnly.push(...solutions);
    else groups.push({ folder: row.folder, note: rule === 'on-request' ? 'on request only' : '', rule, solutions });
  }
  groups.push({ folder: 'read-only', note: 'deprecated/ · infrastructure/ · never edited', rule: 'read-only', solutions: readOnly });
  await page.route('**/api/system', (route) => route.fulfill({ json: system }));
  await page.route('**/api/schedules', (route) => route.fulfill({ json: schedules }));
  await page.route('**/api/solutions', (route) => route.fulfill({ json: groups }));
}

test('Settings matches the prototype in every section (tokens, boxes ±2 px, copy)', async ({ browser }) => {
  test.setTimeout(120_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await stubOtherLanes(appPage);
  await openPrototype(protoPage, { simulateIncoming: false });
  await protoPage.getByText('Settings', { exact: true }).last().click();

  const failures: string[] = [];
  const sections: Array<{ key: string; label: string; rows: string[]; main: number; full: number }> = [];
  const shots: Record<string, Buffer> = {};
  const exempt = (key: string, name: string): boolean =>
    COPY_EXEMPT.some(([part]) => new RegExp(`^${part.replace('.', '\\.').replace('*', '\\d+')}$`).test(`${key}.${name}`));

  for (const section of SECTIONS) {
    await protoPage.getByText(section.label, { exact: true }).first().click();
    await protoPage.getByText(section.ready, { exact: true }).first().waitFor();
    await openApp(appPage, app.baseUrl, `/settings/${section.key}`);
    await appPage.getByText(section.ready, { exact: true }).first().waitFor();

    const paths = Object.fromEntries(Object.entries(section.parts).map(([name, part]) => [name, part.path]));
    const proto = await measure(protoPage, paths);
    const view = await measure(appPage, paths);
    const rows: string[] = [];
    for (const [name, spec] of Object.entries(section.parts)) {
      const p = proto[name];
      const a = view[name];
      if (!p || !a) {
        failures.push(`${section.key}.${name}: missing (${p ? 'app' : 'prototype'})`);
        continue;
      }
      const issues = compareBoxes(`${section.key}.${name}`, p.box, a.box, spec.geometry);
      let copyNote = '';
      if (spec.copy && !exempt(section.key, name)) {
        if (p.text !== a.text) issues.push(`${section.key}.${name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
        copyNote = JSON.stringify(a.text);
      } else if (spec.copy || exempt(section.key, name)) {
        copyNote = `exempt: ${JSON.stringify(p.text)} → ${JSON.stringify(a.text)}`;
      }
      for (const prop of COMPARED_STYLES) {
        if (p.style[prop] !== a.style[prop]) issues.push(`${section.key}.${name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
      }
      failures.push(...issues);
      rows.push(`| ${name} | ${spec.geometry} | ${fmtBox(p)} | ${fmtBox(a)} | ${issues.length ? 'FAIL' : 'ok'} | ${copyNote.replaceAll('|', '\\|')} |`);
    }

    if (section.key === 'notify') {
      const shown = await appPage.locator('.sb-set-select').evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
      if (shown !== '90%') failures.push(`notify.warnValue shown: expected "90%", got ${JSON.stringify(shown)}`);
      rows.push(`| warnValue (shown option) | — | — | — | ${shown === '90%' ? 'ok' : 'FAIL'} | ${JSON.stringify(shown)} |`);
    }

    const clip = { x: 256, y: 0, width: 1184, height: 900 };
    const protoShot = await protoPage.screenshot();
    const appShot = await appPage.screenshot();
    const protoMain = await protoPage.screenshot({ clip });
    const appMain = await appPage.screenshot({ clip });
    const full = await pixelDiff(appPage, protoShot, appShot);
    const main = await pixelDiff(appPage, protoMain, appMain);
    shots[`settings-${section.key}-side-by-side.png`] = await sideBySide(appPage, protoMain, appMain);
    sections.push({ key: section.key, label: section.label, rows, main: main.percent, full: full.percent });
  }

  // SPEC token checks on the app (Embedded tools is the last section with cards; switch back to it).
  await openApp(appPage, app.baseUrl, '/settings/tools');
  await appPage.getByText('AI chat connected to other tools', { exact: true }).waitFor();
  const computed = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      navBg: style('.sb-set-nav').backgroundColor,
      navBorder: style('.sb-set-nav').borderRightColor,
      navSelectedBg: style('.sb-set-nav-item[aria-current="page"]').backgroundColor,
      navSelectedFg: style('.sb-set-nav-item[aria-current="page"]').color,
      navFg: style('.sb-set-nav-item:not([aria-current])').color,
      titleFont: `${style('.sb-set-title').fontWeight} ${style('.sb-set-title').fontSize}`,
      contentMaxWidth: style('.sb-set-content').maxWidth,
      cardBg: style('.sb-set-tool').backgroundColor,
      cardBorder: style('.sb-set-tool').borderTopColor,
      cardRadius: style('.sb-set-tool').borderRadius,
      inputBg: style('.sb-set-input').backgroundColor,
      inputBorder: style('.sb-set-input').borderTopColor,
      inputFont: `${style('.sb-set-input').fontWeight} ${style('.sb-set-input').fontSize} ${style('.sb-set-input').fontFamily}`,
      openBg: style('.sb-set-tool-open').backgroundColor,
      openFg: style('.sb-set-tool-open').color,
    };
  });
  await openApp(appPage, app.baseUrl, '/settings/claude');
  await appPage.getByText('Run setup again', { exact: true }).waitFor();
  const rowStyles = await appPage.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    return {
      rowDivider: style('.sb-set-row').borderBottomColor,
      valueFont: `${style('.sb-set-value').fontWeight} ${style('.sb-set-value').fontSize} ${style('.sb-set-value').fontFamily}`,
      valueColor: style('.sb-set-value').color,
      descColor: style('.sb-set-row-desc').color,
    };
  });
  const expected: Record<string, string> = {
    navBg: hexToRgb('#121315'),
    navBorder: hexToRgb('#232428'),
    navSelectedBg: hexToRgb('#212227'),
    navSelectedFg: hexToRgb('#f0efeb'),
    navFg: hexToRgb('#a9a8a3'),
    titleFont: '600 20px',
    contentMaxWidth: '860px',
    cardBg: hexToRgb('#16171a'),
    cardBorder: hexToRgb('#26272c'),
    cardRadius: '10px',
    inputBg: hexToRgb('#111214'),
    inputBorder: hexToRgb('#3a3b41'),
    inputFont: '400 12.5px "Geist Mono", monospace',
    openBg: hexToRgb('#e8e7e3'),
    openFg: hexToRgb('#111214'),
    rowDivider: hexToRgb('#1f2024'),
    valueFont: '400 12px "Geist Mono", monospace',
    valueColor: hexToRgb('#c9c8c3'),
    descColor: hexToRgb('#8d8c87'),
  };
  const all = { ...computed, ...rowStyles } as Record<string, string>;
  const computedRows: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = all[key];
    if (got !== want) failures.push(`computed ${key}: expected ${want}, got ${String(got)}`);
    computedRows.push(`| ${key} | ${want} | ${String(got)} | ${got === want ? 'ok' : 'FAIL'} |`);
  }

  await writeReport({ 'settings.md': report({ sections, computedRows, failures }), ...shots });
  expect(failures).toEqual([]);
});

function fmtBox(part: Part): string {
  const { x, y, width, height } = part.box;
  return `${round(x)},${round(y)} ${round(width)}×${round(height)}`;
}

function report(input: {
  sections: Array<{ key: string; label: string; rows: string[]; main: number; full: number }>;
  computedRows: string[];
  failures: string[];
}): string {
  return `# Visual oracle · Settings (M8.2)

Generated by \`tests/e2e/visual/settings.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`) with a temp workspace root holding a router \`AGENTS.md\`, 1440×900, \`/settings/<section>\`.
Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, sidebar → Settings → each section.
\`/api/system\` (M5.3), \`/api/schedules\` (M7.1) and \`/api/solutions\` (M6.1) answer 501 in this lane; the app page gets the demo system provider's values, the demo schedules and a scan with the prototype's folders, counts and rules in the browser.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`}

Pixel diff (advisory, channel threshold 24), main area (256,0 1184×900) / full page:
${input.sections.map((s) => `- ${s.label}: **${s.main.toFixed(2)}%** / ${s.full.toFixed(2)}%`).join('\n')}

Side by side (main area, prototype left, app right): ${input.sections.map((s) => `\`settings-${s.key}-side-by-side.png\``).join(', ')}.

## Copy that differs on purpose
${COPY_EXEMPT.map(([part, reason]) => `- \`${part}\`: ${reason}`).join('\n')}

${input.sections
  .map(
    (s) => `## ${s.label}
| Part | Geometry | Prototype | App | Result | Copy (exact) |
|---|---|---|---|---|---|
${s.rows.join('\n')}
`,
  )
  .join('\n')}
## Computed styles (SPEC tokens)
| Check | Expected | App | Result |
|---|---|---|---|
${input.computedRows.join('\n')}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
