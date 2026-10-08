import { expect, type Page, test } from '@playwright/test';
import {
  type Box,
  type DemoApp,
  type Geometry,
  type Part,
  BOX_TOLERANCE_PX,
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
import { usageRowChecks } from './usage-rows.ts';
import { rememberNewSessionMode } from '../../helpers/new-session-mode.ts';

/**
 * Full visual pass (M9.3, D10): every view and modal SPEC names, on whatever this
 * branch holds, against `docs/handoff/prototype/Switchboard App.dc.html` at
 * 1440×900 with the demo seed.
 *
 * For each surface both pages are driven to the same view, then:
 * - **Sidebar** (on every surface): brand, "+ New session", nav items with their
 *   labels, badges and selected state, TOOLS rows, SESSIONS rows (dot, name, age,
 *   mode line styles, selected state), Settings and the machine footer. Boxes ±2 px,
 *   exact copy, computed styles. Parts whose data comes from an API area this
 *   branch does not serve yet (501: tool rows, the schedules / artifacts badges,
 *   footer values) are listed as *pending* instead of gated, and the parts below
 *   them are compared by size (the vertical offset follows the missing rows).
 * - **Main area** of a view that is implemented here: the main column and the
 *   view's root box, plus its landmark copy (fixed prototype strings) present on
 *   both pages. A view that still shows its M1.4 placeholder (`docs/lanes.md`) is
 *   recorded as *pending merge* with the lane that holds it.
 * - **Modals**: the overlay and the panel chrome (box, background, border, radius,
 *   shadow) are gated even while the content is a placeholder; content landmarks
 *   once it is implemented.
 * - Advisory pixel diff of the page and of the main area / panel, and a
 *   side-by-side PNG of every surface that is implemented here.
 * - D17 / D66: the prototype's footer has one "Max" row, the app the usage grid. The
 *   footer keeps its bottom edge and grows upward, so Settings and the footer's
 *   rows above the usage rows are compared with y relative to the footer's top;
 *   the usage rows are listed and checked on the footer's own rules
 *   (`usage-rows.ts`), not against the prototype.
 * - D61: the app's nav has a sixth item, MCP, which the prototype does not. The
 *   sidebar is measured with that item hidden (so every other part keeps the
 *   prototype's place), and the item itself is gated against its neighbour
 *   Schedules & loops (same height, x, width and label styles). D68: the seventh,
 *   Todos (after History), likewise, gated against History.
 *
 * The per-view detail (every row, card and state) is gated by the view's own spec
 * in this folder, listed per surface in the report (`docs/visual/full-pass.md`).
 * A developer ruling that changes a surface on purpose (`Surface.rulings`, e.g.
 * D37: finished subagents leave the session's right panel) is listed there, and
 * its copy must show on the app. A ruling that removes a part (`Surface.removed`,
 * D86: the quick replies) names the prototype copy the app must no longer show.
 * The toast runs on the real path in `toast.spec.ts`.
 */

/** API areas the sidebar reads besides sessions / inbox / solutions (served since M2.1 / M3.2 / M6.1). */
const AREAS = {
  tools: { url: '/api/tools', item: 'M8.1' },
  schedules: { url: '/api/schedules', item: 'M7.1' },
  artifacts: { url: '/api/artifacts', item: 'M7.3' },
  system: { url: '/api/system', item: 'M5.3' },
} as const;
type Area = keyof typeof AREAS;
type Served = Readonly<Record<Area, boolean>>;

/** Where a surface lives until its lane is merged (`.loop/progress.md` → Blocked). */
const LANE_TOOLS = 'lane/w1-tools';
const LANE_NEWSESSION = 'lane/w2-newsession';
const LANE_TABS = 'lane/w2-tabs';

/** How the app shows a placeholder (M1.4, `docs/lanes.md`). */
type Placeholder =
  /** the element with the test id has no element children */
  | 'empty'
  /** Settings before M8.2: only M9.1's "Start at login" row */
  | 'settings-row';

interface Surface {
  readonly id: string;
  readonly title: string;
  readonly spec: string;
  readonly items: string;
  /** The lane that holds the implementation while it is not merged. */
  readonly lane: string;
  /** The view's own D10 spec(s), which gate its detail. */
  readonly detail: string;
  readonly kind: 'view' | 'modal';
  /** Test id of the element the placeholder check reads. */
  readonly testId: string;
  readonly placeholder: Placeholder;
  /** Fixed prototype copy that must appear in the main area (views) or the panel (modals) of both pages. */
  readonly landmarks: readonly string[];
  /**
   * Developer rulings that change the surface on purpose: copy the app must show
   * (the prototype has none) and the note the report carries (e.g. D37's "✓ 1
   * finished" line in the session's right panel). The detail is gated by the view's own spec.
   */
  readonly rulings?: readonly { readonly id: string; readonly appCopy: string; readonly note: string }[];
  /**
   * Developer rulings that remove a part on purpose (D86: the quick replies): copy
   * the prototype shows and the app must no longer show, and the note the report
   * carries. It is not a landmark any more; the detail is gated by the view's own spec.
   */
  readonly removed?: readonly { readonly id: string; readonly protoCopy: string; readonly note: string }[];
  /** Modals: the prototype panel's inline width (how the panel is found there). */
  readonly panelWidth?: string;
  /** Modals: the panel height follows its content (the palette), so it is compared only once implemented. */
  readonly contentHeight?: boolean;
  openProto(page: Page): Promise<void>;
  /** Drives the app; `false` when this branch has no way to open the surface. */
  openApp(page: Page, baseUrl: string): Promise<boolean>;
}

/** Sidebar paths from the shell grid (both pages share the structure). */
const SIDEBAR = [0];
const NAV = [...SIDEBAR, 2];
const TOOLS = [...SIDEBAR, 4];
const SESSIONS_LABEL = [...SIDEBAR, 5];
const SESSIONS = [...SIDEBAR, 6];
const SETTINGS = [...SIDEBAR, 7];
const FOOTER = [...SIDEBAR, 8];

const NAV_LABELS = ['Inbox', 'Solutions', 'Schedules & loops', 'Artifacts', 'History'] as const;
/** Nav badges whose data is not served by sessions / inbox / solutions. */
const NAV_BADGE_AREA: Readonly<Record<number, Area>> = { 2: 'schedules', 3: 'artifacts' };

/** The demo seed's sessions, in the prototype's order (`S`). */
const SESSION_COUNT = 6;
const TOOL_COUNT = 2;

/** Computed styles compared on every sidebar and main-area part. */
const COMPARED_STYLES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-transform',
  'border-radius',
] as const;

/** Computed styles of a modal panel and its overlay. */
const PANEL_STYLES = ['background-color', 'border-top-color', 'border-top-width', 'border-radius', 'box-shadow', 'overflow'] as const;
const OVERLAY_STYLES = ['background-color', 'z-index', 'position'] as const;

async function clickPath(page: Page, path: readonly number[]): Promise<void> {
  await page.evaluate((p) => {
    const grid = [...document.querySelectorAll<HTMLElement>('body *')].find((el) => {
      const style = getComputedStyle(el);
      return style.display === 'grid' && style.gridTemplateColumns.startsWith('256px');
    });
    let el: Element | undefined = grid;
    for (const i of p) el = el?.children[i];
    if (!(el instanceof HTMLElement)) throw new Error(`nothing at ${p.join(',')}`);
    el.click();
  }, [...path]);
}

async function protoTab(page: Page, label: RegExp): Promise<void> {
  await page.getByText(label).first().click();
}

async function appRoute(page: Page, baseUrl: string, route: string): Promise<boolean> {
  await openApp(page, baseUrl, route);
  return true;
}

const SURFACES: readonly Surface[] = [
  {
    id: 'inbox',
    title: 'Inbox',
    spec: 'Inbox',
    items: 'M3.2, M3.3',
    lane: '',
    detail: 'inbox.spec.ts',
    kind: 'view',
    testId: 'view-inbox',
    placeholder: 'empty',
    landmarks: ['5 waiting on you', 'Send all answers'],
    openProto: (page) => clickPath(page, [...NAV, 0]),
    openApp: (page, base) => appRoute(page, base, '/inbox'),
  },
  {
    id: 'session-chat',
    title: 'Session · Chat',
    spec: 'Session → Chat, Right panel',
    items: 'M4.1, M4.2, M4.3',
    lane: '',
    detail: 'session-header.spec.ts, session-chat.spec.ts, session-panel.spec.ts',
    kind: 'view',
    testId: 'view-session',
    placeholder: 'empty',
    // D86: "Quick replies" was a landmark; the row is gone from the app (see `removed`).
    landmarks: ['Agents & solutions', 'Terminal handoff'],
    removed: [
      {
        id: 'D86',
        protoCopy: 'Quick replies',
        note: 'D86 (developer request 2026-10-08): the quick-replies row above the composer is gone (the 📎 moved into the field\'s row, next to Send); session-chat.spec.ts re-anchors the composer and the chat area on the prototype\'s boxes and checks the 📎 on its own',
      },
    ],
    rulings: [
      {
        id: 'D37',
        appCopy: '✓ 1 finished',
        note: 'D37 (developer ruling 2026-09-28): the done figma-extractor left the right panel (card + overview row) for "✓ 1 finished" under the cards; session-panel.spec.ts compares the remaining parts at the prototype\'s boxes and the ruled layout on its own',
      },
    ],
    openProto: (page) => clickPath(page, [...SESSIONS, 0]),
    openApp: (page, base) => appRoute(page, base, '/sessions/free-talk-feature/chat'),
  },
  {
    id: 'session-timeline',
    title: 'Session · Timeline',
    spec: 'Session → Timeline',
    items: 'M4.4',
    lane: LANE_TABS,
    detail: 'timeline.spec.ts (lane)',
    kind: 'view',
    testId: 'session-timeline',
    placeholder: 'empty',
    landmarks: ['10:02 – 10:48'],
    openProto: (page) => protoTab(page, /^Timeline$/),
    openApp: (page, base) => appRoute(page, base, '/sessions/free-talk-feature/timeline'),
  },
  {
    id: 'session-diff',
    title: 'Session · Diff',
    spec: 'Session → Diff',
    items: 'M4.5',
    lane: LANE_TABS,
    detail: 'diff.spec.ts (lane)',
    kind: 'view',
    testId: 'session-diff',
    placeholder: 'empty',
    landmarks: ['Not committed. Commit only when you approve.'],
    openProto: (page) => protoTab(page, /^Diff · \d+$/),
    openApp: (page, base) => appRoute(page, base, '/sessions/free-talk-feature/diff'),
  },
  {
    id: 'session-artifacts',
    title: 'Session · Artifacts',
    spec: 'Session → Artifacts',
    items: 'M4.6',
    lane: LANE_TABS,
    detail: 'session-artifacts.spec.ts',
    kind: 'view',
    testId: 'session-artifacts',
    placeholder: 'empty',
    landmarks: ['mobile-followups/from-acme-app-front.md'],
    openProto: (page) => protoTab(page, /^Artifacts · \d+$/),
    openApp: (page, base) => appRoute(page, base, '/sessions/free-talk-feature/artifacts'),
  },
  {
    id: 'solutions',
    title: 'Solutions',
    spec: 'Solutions',
    items: 'M6.2, M6.3, M6.4',
    lane: '',
    detail: 'solutions.spec.ts, solutions-conflict.spec.ts',
    kind: 'view',
    testId: 'view-solutions',
    placeholder: 'empty',
    landmarks: ['Branches & worktrees', 'Phase ledger', 'Move button-rollout to worktree'],
    openProto: (page) => clickPath(page, [...NAV, 1]),
    async openApp(page, base) {
      // The app selects the first row by default (docs/solutions.md); the prototype opens on `mobile`.
      await openApp(page, base, '/solutions');
      await page.locator('[data-testid="solution-row"][data-solution="mobile"]').click();
      return true;
    },
  },
  {
    id: 'schedules',
    title: 'Schedules & loops',
    spec: 'Schedules & loops',
    items: 'M7.1, M7.2',
    lane: `${LANE_NEWSESSION} (M7.1) + ${LANE_TABS} (M7.2)`,
    detail: 'schedules.spec.ts (lane w2-newsession), loops.spec.ts (lane w2-tabs)',
    kind: 'view',
    testId: 'view-schedules',
    placeholder: 'empty',
    landmarks: ['scheduled Claude Code runs + long-running loops', '+ New scheduled run', 'Last 14 runs'],
    openProto: (page) => clickPath(page, [...NAV, 2]),
    openApp: (page, base) => appRoute(page, base, '/schedules'),
  },
  {
    id: 'artifacts',
    title: 'Artifacts',
    spec: 'Artifacts',
    items: 'M7.3',
    lane: LANE_TOOLS,
    detail: 'artifacts.spec.ts (lane w1-tools)',
    kind: 'view',
    testId: 'view-artifacts',
    placeholder: 'empty',
    landmarks: ['Solution · branch'],
    openProto: (page) => clickPath(page, [...NAV, 3]),
    openApp: (page, base) => appRoute(page, base, '/artifacts'),
  },
  {
    id: 'history',
    title: 'History',
    spec: 'History',
    items: 'M7.4',
    lane: LANE_TOOLS,
    detail: 'history.spec.ts (lane)',
    kind: 'view',
    testId: 'view-history',
    placeholder: 'empty',
    landmarks: ['past sessions · searchable transcripts'],
    openProto: (page) => clickPath(page, [...NAV, 4]),
    openApp: (page, base) => appRoute(page, base, '/history'),
  },
  {
    id: 'tool',
    title: 'Tool · Codebase Memory',
    spec: 'Tools',
    items: 'M8.1',
    lane: LANE_TOOLS,
    detail: 'tools.spec.ts (lane)',
    kind: 'view',
    testId: 'view-tool',
    placeholder: 'empty',
    landmarks: ['↻ Reload', '↗ New tab'],
    openProto: (page) => clickPath(page, [...TOOLS, 0]),
    openApp: (page, base) => appRoute(page, base, '/tools/cm'),
  },
  {
    id: 'settings',
    title: 'Settings',
    spec: 'Settings',
    items: 'M8.2 (M9.1 row)',
    lane: LANE_TOOLS,
    detail: 'settings.spec.ts (lane), start-at-login.spec.ts',
    kind: 'view',
    testId: 'view-settings',
    placeholder: 'settings-row',
    landmarks: ['Run setup again', 'Background service'],
    openProto: (page) => clickPath(page, SETTINGS),
    openApp: (page, base) => appRoute(page, base, '/settings'),
  },
  {
    id: 'new-session',
    title: 'New session',
    spec: 'Modals → New session',
    items: 'M5.1 (M7.1 section 7)',
    lane: LANE_NEWSESSION,
    detail: 'new-session.spec.ts (lane)',
    kind: 'modal',
    testId: 'modal-new-session',
    placeholder: 'empty',
    panelWidth: '1080px',
    landmarks: ['Claude Code · background · Max', '1 · Task definition'],
    async openProto(page) {
      await clickPath(page, [...NAV, 0]);
      await page.getByText('+ New session', { exact: true }).click();
    },
    async openApp(page, base) {
      await openApp(page, base, '/inbox');
      // D56: the prototype's form is the Full one (Simple is the fresh-install default).
      await rememberNewSessionMode(page, 'full');
      await page.getByTestId('new-session').click();
      return true;
    },
  },
  {
    id: 'setup-wizard',
    title: 'Setup wizard',
    spec: 'Modals → Setup wizard',
    items: 'M5.3',
    lane: LANE_NEWSESSION,
    detail: 'setup-wizard.spec.ts (lane)',
    kind: 'modal',
    testId: 'modal-setup-wizard',
    placeholder: 'empty',
    panelWidth: '960px',
    landmarks: ['Set up Switchboard'],
    async openProto(page) {
      await clickPath(page, SETTINGS);
      await page.getByText('Run setup again', { exact: true }).click();
    },
    async openApp(page, base) {
      // Settings → "Run setup again" (M8.2 + M5.3); this branch may have no trigger yet.
      await openApp(page, base, '/settings');
      const trigger = page.getByText('Run setup again', { exact: true });
      if ((await trigger.count()) === 0) return false;
      await trigger.first().click();
      return true;
    },
  },
  {
    id: 'palette',
    title: 'Palette',
    spec: 'Modals → Palette',
    items: 'M8.3',
    lane: LANE_TABS,
    detail: 'palette.spec.ts (lane)',
    kind: 'modal',
    testId: 'modal-palette',
    placeholder: 'empty',
    panelWidth: '620px',
    contentHeight: true,
    landmarks: ['Schedules & loops', 'New session'],
    async openProto(page) {
      await clickPath(page, [...NAV, 0]);
      await page.keyboard.press('Control+k');
    },
    async openApp(page, base) {
      await openApp(page, base, '/inbox');
      await page.keyboard.press('Control+k');
      return true;
    },
  },
];

/** One gated or listed part. */
interface Row {
  readonly surface: string;
  /** Which part of the page (the report prints the sidebar once in full). */
  readonly group?: 'sidebar' | 'content';
  readonly part: string;
  readonly geometry: Geometry | 'relative' | 'listed' | 'D66 rules';
  readonly proto: string;
  readonly app: string;
  readonly result: 'ok' | 'FAIL' | 'pending' | 'listed';
  readonly note: string;
}

/** Gated / failed counts of one group of parts. */
interface Tally {
  checks: number;
  failures: number;
}

/** Per-surface summary for the report. */
interface Summary {
  readonly surface: Surface;
  readonly state: 'gated' | 'pending merge' | 'chrome only';
  readonly sidebar: Tally | null;
  readonly content: Tally;
  readonly pageDiff: number | null;
  readonly areaDiff: number | null;
  readonly png: string | null;
  readonly notes: readonly string[];
}

let app: DemoApp;

test.beforeAll(async () => {
  app = await startDemoApp();
});

test.afterAll(async () => {
  await app?.stop();
});

/** `true` when the app answers the area's route (not 501). */
async function servedAreas(page: Page): Promise<Served> {
  const out = {} as Record<Area, boolean>;
  for (const [area, { url }] of Object.entries(AREAS) as Array<[Area, (typeof AREAS)[Area]]>) {
    const status = await page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).status, url);
    out[area] = status === 200;
  }
  return out;
}

/** Waits until the sidebar shows the demo seed's sessions and Inbox count. */
async function waitForSidebar(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-sessions').locator(':scope > *')).toHaveCount(SESSION_COUNT);
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('5');
  await expect(page.getByTestId('nav-solutions').locator('.sb-badge')).toHaveText('1 conflict');
}

/** `true` while the app shows the surface's M1.4 placeholder. */
async function isPlaceholder(page: Page, surface: Surface): Promise<boolean> {
  const root = page.getByTestId(surface.testId);
  await root.waitFor({ state: 'attached' });
  return root.evaluate((el, kind) => {
    if (kind === 'settings-row') return el.children.length === 1 && el.children[0]!.classList.contains('sb-login-content');
    return el.children.length === 0;
  }, surface.placeholder);
}

function fmt(box: Box | undefined): string {
  if (!box) return '—';
  return `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}`;
}

interface PartCheck {
  readonly name: string;
  readonly path: readonly number[];
  readonly geometry: Geometry | 'relative';
  readonly copy: boolean;
  readonly styles: readonly string[];
  /** `relative`: compared with y relative to this part (both pages). */
  readonly anchor?: readonly number[];
  /** How the report names the anchor (default: the SESSIONS label). */
  readonly anchorName?: string;
  /** Listed, not gated (data this branch does not serve, or derived copy). */
  readonly pending?: string;
  /** Copy listed only (known data difference), the box and styles still gated. */
  readonly copyNote?: string;
}

/** The sidebar parts, gated or pending according to the served API areas. */
function sidebarChecks(served: Served): PartCheck[] {
  const text = COMPARED_STYLES;
  const out: PartCheck[] = [
    { name: 'sidebar', path: SIDEBAR, geometry: 'box', copy: false, styles: ['background-color', 'border-right-color'] },
    { name: 'brand', path: [...SIDEBAR, 0], geometry: 'box', copy: true, styles: text },
    { name: 'paletteKey', path: [...SIDEBAR, 0, 2], geometry: 'box', copy: true, styles: text },
    { name: 'newSession', path: [...SIDEBAR, 1, 0], geometry: 'box', copy: true, styles: text },
  ];
  NAV_LABELS.forEach((label, i) => {
    out.push({ name: `nav:${label}`, path: [...NAV, i], geometry: 'box', copy: false, styles: text });
    out.push({ name: `nav:${label}:label`, path: [...NAV, i, 0], geometry: 'box', copy: true, styles: text });
    const area = NAV_BADGE_AREA[i];
    const pending = area && !served[area] ? `${AREAS[area].url} answers 501 (${AREAS[area].item})` : undefined;
    // The prototype hard-codes the Artifacts badge "14" over its 13 `ART.slice(1)` rows; the app counts the API (D13).
    const copyNote = label === 'Artifacts' ? 'the prototype hard-codes "14" over 13 rows; the app counts GET /api/artifacts (D13)' : undefined;
    out.push({ name: `nav:${label}:badge`, path: [...NAV, i, 1], geometry: 'box', copy: copyNote === undefined, styles: text, pending, copyNote });
  });
  out.push({ name: 'toolsLabel', path: [...SIDEBAR, 3], geometry: 'box', copy: true, styles: text });
  const toolsPending = served.tools ? undefined : `${AREAS.tools.url} answers 501 (${AREAS.tools.item})`;
  for (let i = 0; i < TOOL_COUNT; i++) {
    const row = [...TOOLS, i];
    out.push({ name: `tool${i}`, path: row, geometry: 'box', copy: false, styles: text, pending: toolsPending });
    // Developer ruling 2026-09-28: the name stays whole on the first line and a URL that does not fit moves
    // to its own line (cut with …), where the prototype wraps the name next to the URL. The row keeps the
    // prototype's box (checked above); the name and URL boxes inside it differ by design, so only their copy
    // and styles are compared here (the ruled layout is checked in tools.spec.ts → sidebarRuling).
    out.push({ name: `tool${i}:name`, path: [...row, 1], geometry: 'none', copy: true, styles: text, pending: toolsPending });
    out.push({ name: `tool${i}:host`, path: [...row, 2], geometry: 'none', copy: true, styles: text, pending: toolsPending });
  }
  // Without tool rows everything from SESSIONS down sits higher: compared by size / relative to the label.
  const sessionsGeometry: Geometry = served.tools ? 'box' : 'size';
  out.push({ name: 'sessionsLabel', path: SESSIONS_LABEL, geometry: sessionsGeometry, copy: true, styles: text });
  for (let i = 0; i < SESSION_COUNT; i++) {
    const row = [...SESSIONS, i];
    const rel = { geometry: served.tools ? ('box' as const) : ('relative' as const), anchor: SESSIONS_LABEL };
    out.push({ name: `session${i}`, path: row, ...rel, copy: false, styles: ['background-color', 'border-radius'] });
    out.push({ name: `session${i}:dot`, path: [...row, 0], ...rel, copy: false, styles: ['background-color', 'border-radius'] });
    out.push({ name: `session${i}:name`, path: [...row, 1, 0, 0], ...rel, copy: true, styles: text });
    out.push({ name: `session${i}:age`, path: [...row, 1, 0, 1], ...rel, copy: true, styles: text });
    out.push({
      name: `session${i}:mode`,
      path: [...row, 1, 1],
      ...rel,
      copy: false,
      styles: text,
      copyNote: 'mode line derived from the stored work type · mode · phase (D13, docs/derivations.md → Session chips); the prototype hand-writes it',
    });
  }
  const systemPending = served.system ? undefined : `${AREAS.system.url} answers 501 (${AREAS.system.item})`;
  // D17 / D66: the footer keeps its bottom edge and grows upward by the usage grid (usage-rows.ts gates by how much), so
  // Settings and the footer's rows are compared with y relative to the footer's top.
  const inFooter = { geometry: 'relative' as const, anchor: FOOTER, anchorName: "the footer's top (D17)" };
  out.push({ name: 'settings', path: SETTINGS, ...(served.tools && served.system ? inFooter : { geometry: 'size' as const }), copy: true, styles: text });
  out.push({ name: 'footer', path: FOOTER, geometry: 'bottom', copy: false, styles: ['background-color', 'border-top-color'] });
  out.push({ name: 'footer:service', path: [...FOOTER, 0], ...(served.system ? inFooter : { geometry: 'bottom' as const }), copy: false, styles: text });
  out.push({ name: 'footer:label', path: [...FOOTER, 0, 1], ...(served.system ? inFooter : { geometry: 'none' as const }), copy: true, styles: text });
  out.push({ name: 'footer:processes', path: [...FOOTER, 0, 2], ...inFooter, copy: true, styles: text, pending: systemPending });
  // The prototype's third meter, "Max", has no counterpart: D66's usage grid (usage-rows.ts).
  ['CPU', 'RAM'].forEach((label, i) => {
    const meter = [...FOOTER, i + 1];
    out.push({ name: `footer:${label}`, path: [...meter, 0], ...inFooter, copy: true, styles: text });
    out.push({ name: `footer:${label}:track`, path: [...meter, 1], ...inFooter, copy: false, styles: ['background-color', 'border-radius'] });
    out.push({ name: `footer:${label}:value`, path: [...meter, 2], ...inFooter, copy: true, styles: text, pending: systemPending });
  });
  return out;
}

/** Main-area parts of an implemented view. */
function mainChecks(): PartCheck[] {
  return [
    { name: 'main', path: [1], geometry: 'box', copy: false, styles: ['background-color'] },
    { name: 'view', path: [1, 0], geometry: 'box', copy: false, styles: ['background-color'] },
  ];
}

/** Compares measured parts; returns report rows and failure messages. */
function compare(surface: string, checks: readonly PartCheck[], proto: Record<string, Part | null>, appParts: Record<string, Part | null>) {
  const rows: Row[] = [];
  const failures: string[] = [];
  const anchors = new Map<string, { proto: Part | null; app: Part | null }>();
  for (const check of checks) {
    const p = proto[check.name] ?? null;
    const a = appParts[check.name] ?? null;
    if (check.pending) {
      rows.push({ surface, part: check.name, geometry: 'listed', proto: p ? JSON.stringify(p.text) : '—', app: a ? JSON.stringify(a.text) : '—', result: 'pending', note: check.pending });
      continue;
    }
    if (!p || !a) {
      failures.push(`${surface} · ${check.name}: missing (${p ? 'app' : 'prototype'})`);
      rows.push({ surface, part: check.name, geometry: check.geometry, proto: fmt(p?.box), app: fmt(a?.box), result: 'FAIL', note: 'missing' });
      continue;
    }
    const issues: string[] = [];
    if (check.geometry === 'relative') {
      const key = (check.anchor ?? []).join('.');
      const anchor = anchors.get(key) ?? { proto: proto[`@${key}`] ?? null, app: appParts[`@${key}`] ?? null };
      anchors.set(key, anchor);
      if (!anchor.proto || !anchor.app) {
        issues.push(`${check.name}: anchor missing`);
      } else {
        const rel = (part: Part, base: Part): Box => ({ ...part.box, y: part.box.y - base.box.y });
        issues.push(...compareBoxes(check.name, rel(p, anchor.proto), rel(a, anchor.app), 'box').map((m) => `${m} (y relative to ${check.anchorName ?? 'the SESSIONS label'})`));
      }
    } else {
      issues.push(...compareBoxes(check.name, p.box, a.box, check.geometry));
    }
    if (check.copy && p.text !== a.text) issues.push(`${check.name}.text: prototype ${JSON.stringify(p.text)} vs app ${JSON.stringify(a.text)}`);
    for (const prop of check.styles) {
      if (p.style[prop] !== a.style[prop]) issues.push(`${check.name}.${prop}: prototype ${p.style[prop]} vs app ${a.style[prop]}`);
    }
    failures.push(...issues.map((issue) => `${surface} · ${issue}`));
    const notes: string[] = [];
    if (check.copy) notes.push(`copy ${JSON.stringify(a.text)}`);
    if (check.copyNote && p.text !== a.text) notes.push(`copy listed: prototype ${JSON.stringify(p.text)} · app ${JSON.stringify(a.text)} (${check.copyNote})`);
    rows.push({
      surface,
      part: check.name,
      geometry: check.geometry,
      proto: fmt(p.box),
      app: fmt(a.box),
      result: issues.length ? 'FAIL' : 'ok',
      note: [...notes, ...issues].join('; '),
    });
  }
  return { rows, failures };
}

/** D61: the app's MCP nav item is its 4th: the app's later nav items are one child further on. */
const MCP_NAV_INDEX = 3;

/** D61: `paths` for the app: a nav item from the 4th on is one index later (the hidden MCP item keeps its place in the DOM). */
function appNavPaths(paths: Record<string, readonly number[]>): Record<string, readonly number[]> {
  const shift = (p: readonly number[]): readonly number[] =>
    p.length > NAV.length && NAV.every((n, i) => p[i] === n) && (p[NAV.length] as number) >= MCP_NAV_INDEX ? [...NAV, (p[NAV.length] as number) + 1, ...p.slice(NAV.length + 1)] : p;
  return Object.fromEntries(Object.entries(paths).map(([name, p]) => [name, shift(p)]));
}

/** D61 / D68: hides (or shows again) the app's MCP and Todos nav items, which the prototype does not have. */
async function setMcpNavHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hide) => {
    for (const id of ['nav-mcp', 'nav-todos']) {
      const item = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (item) item.style.display = hide ? 'none' : '';
    }
  }, hidden);
}

/**
 * D61: the MCP nav item against Schedules & loops; D68: the Todos item against History. Same x, width,
 * height; directly below it; label styles as an unselected neighbour's.
 */
async function extraNavIssues(page: Page, item: { readonly id: string; readonly label: string; readonly above: string; readonly aboveName: string }): Promise<string[]> {
  return page.evaluate(
    ({ props, item }) => {
      const mine = document.querySelector<HTMLElement>(`[data-testid="${item.id}"]`);
      const above = document.querySelector<HTMLElement>(`[data-testid="${item.above}"]`);
      const tag = `nav:${item.label}`;
      if (!mine || !above) return [`${tag}: missing`];
      const issues: string[] = [];
      const a = mine.getBoundingClientRect();
      const b = above.getBoundingClientRect();
      for (const edge of ['x', 'width', 'height'] as const) if (Math.abs(a[edge] - b[edge]) > 0.5) issues.push(`${tag}.${edge}: ${a[edge]} vs ${item.aboveName} ${b[edge]}`);
      if (Math.abs(a.y - (b.y + b.height)) > 3) issues.push(`${tag}.y: ${a.y}, not under ${item.aboveName} (${b.y + b.height})`);
      // Label styles against a neighbour that is not the selected item (the selected one is brighter).
      const reference = ['nav-schedules', 'nav-artifacts', 'nav-history'].map((id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)).find((el) => el && el.getAttribute('aria-current') !== 'page');
      const la = mine.children[0];
      const lb = reference?.children[0];
      if (!la || !lb) return [...issues, `${tag}: label missing`];
      if (la.textContent !== item.label) issues.push(`${tag}.text: ${JSON.stringify(la.textContent)}`);
      const sa = getComputedStyle(la);
      const sb = getComputedStyle(lb);
      for (const prop of props) if (sa.getPropertyValue(prop) !== sb.getPropertyValue(prop)) issues.push(`${tag}:label.${prop}: ${sa.getPropertyValue(prop)} vs ${sb.getPropertyValue(prop)}`);
      return issues;
    },
    { props: ['color', 'font-family', 'font-size', 'font-weight', 'letter-spacing'], item },
  );
}

/** D61: the MCP nav item against Schedules & loops. */
function mcpNavIssues(page: Page): Promise<string[]> {
  return extraNavIssues(page, { id: 'nav-mcp', label: 'MCP', above: 'nav-schedules', aboveName: 'Schedules' });
}

/** D68: the Todos nav item against History (the item above it). */
function todosNavIssues(page: Page): Promise<string[]> {
  return extraNavIssues(page, { id: 'nav-todos', label: 'Todos', above: 'nav-history', aboveName: 'History' });
}

/** Paths to measure for `checks`, anchors included (`@<path>`). */
function pathsOf(checks: readonly PartCheck[]): Record<string, readonly number[]> {
  const out: Record<string, readonly number[]> = {};
  for (const check of checks) {
    out[check.name] = check.path;
    if (check.anchor) out[`@${check.anchor.join('.')}`] = check.anchor;
  }
  return out;
}

/** Text content of the main area (views) or the panel (modals). */
async function landmarkScope(page: Page, surface: Surface, side: 'proto' | 'app'): Promise<string> {
  if (surface.kind === 'modal') {
    return page.evaluate(
      ({ side: s, testId, width }) => {
        const panel =
          s === 'app'
            ? document.querySelector(`[data-testid="${testId}"]`)
            : [...document.querySelectorAll<HTMLElement>('div')].find((el) => el.style.width === width);
        return panel?.textContent ?? '';
      },
      { side, testId: surface.testId, width: surface.panelWidth ?? '' },
    );
  }
  const main = await measure(page, { main: [1] });
  return main['main']?.text ?? '';
}

/** A modal's panel + overlay: boxes and computed styles. */
async function measurePanel(page: Page, surface: Surface, side: 'proto' | 'app') {
  return page.evaluate(
    ({ side: s, testId, width, panelProps, overlayProps }) => {
      const panel =
        s === 'app'
          ? document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
          : [...document.querySelectorAll<HTMLElement>('div')].find((el) => el.style.width === width);
      if (!panel || !panel.parentElement) return null;
      const read = (el: Element, props: readonly string[]) => {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const style: Record<string, string> = {};
        for (const prop of props) style[prop] = cs.getPropertyValue(prop);
        return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, text: '', style };
      };
      return { panel: read(panel, panelProps), overlay: read(panel.parentElement, overlayProps) };
    },
    { side, testId: surface.testId, width: surface.panelWidth ?? '', panelProps: [...PANEL_STYLES], overlayProps: [...OVERLAY_STYLES] },
  );
}

test('full visual pass: every SPEC view and modal against the prototype (sidebar, main area, modal chrome; pending lanes listed)', async ({ browser }) => {
  test.setTimeout(180_000);
  const protoPage = await newVisualPage(browser);
  const appPage = await newVisualPage(browser);
  await openPrototype(protoPage, { simulateIncoming: false });
  await openApp(appPage, app.baseUrl, '/inbox');
  const served = await servedAreas(appPage);

  const rows: Row[] = [];
  const failures: string[] = [];
  const summaries: Summary[] = [];
  const files: Record<string, string | Buffer> = {};

  for (const surface of SURFACES) {
    await surface.openProto(protoPage);
    const opened = await surface.openApp(appPage, app.baseUrl);
    await waitForSidebar(appPage);
    // The prototype renders synchronously; its fixed copy is present at once.
    for (const text of surface.landmarks) {
      await expect.poll(() => landmarkScope(protoPage, surface, 'proto'), { message: `prototype ${surface.id}: ${text}` }).toContain(text);
    }

    const pending = !opened || (await isPlaceholder(appPage, surface));
    const notes: string[] = [];
    const content: Tally = { checks: 0, failures: 0 };
    let sidebarTally: Tally | null = null;
    const track = (result: { rows: Row[]; failures: string[] }, tally: Tally, group: Row['group']) => {
      rows.push(...result.rows.map((row) => ({ ...row, group })));
      failures.push(...result.failures);
      tally.checks += result.rows.filter((row) => row.result === 'ok' || row.result === 'FAIL').length;
      tally.failures += result.failures.length;
    };

    // Sidebar, on every surface that opened (its selected state follows the view).
    if (opened) {
      const sidebar = sidebarChecks(served);
      const paths = pathsOf(sidebar);
      sidebarTally = { checks: 0, failures: 0 };
      // D61: the MCP nav item (not in the prototype) is checked against its neighbour, then hidden while the rest is measured.
      const mcpIssues = await mcpNavIssues(appPage);
      failures.push(...mcpIssues.map((issue) => `${surface.id} · ${issue}`));
      sidebarTally.checks += 1;
      sidebarTally.failures += mcpIssues.length;
      rows.push({ surface: surface.id, group: 'sidebar', part: 'nav:MCP (D61)', geometry: 'relative', proto: '—', app: 'vs nav:Schedules & loops', result: mcpIssues.length ? 'FAIL' : 'ok', note: mcpIssues.join('; ') });
      // D68: likewise the Todos nav item, against History.
      const todosIssues = await todosNavIssues(appPage);
      failures.push(...todosIssues.map((issue) => `${surface.id} · ${issue}`));
      sidebarTally.checks += 1;
      sidebarTally.failures += todosIssues.length;
      rows.push({ surface: surface.id, group: 'sidebar', part: 'nav:Todos (D68)', geometry: 'relative', proto: '—', app: 'vs nav:History', result: todosIssues.length ? 'FAIL' : 'ok', note: todosIssues.join('; ') });
      await setMcpNavHidden(appPage, true);
      track(compare(surface.id, sidebar, await measure(protoPage, paths), await measure(appPage, appNavPaths(paths))), sidebarTally, 'sidebar');
      // D66: the usage grid, listed next to the prototype's Max row and gated on the footer's own rules.
      const usage = await usageRowChecks(protoPage, appPage, surface.id);
      await setMcpNavHidden(appPage, false);
      track(
        {
          rows: usage.checks.map((c) => ({ surface: surface.id, part: c.part, geometry: c.result === 'listed' ? 'listed' : 'D66 rules', proto: c.proto, app: c.app, result: c.result, note: c.note })),
          failures: usage.failures,
        },
        sidebarTally,
        'sidebar',
      );
    } else {
      notes.push('no trigger on this branch (Settings → "Run setup again" arrives with M8.2 + M5.3)');
    }

    let areaDiff: number | null = null;
    let png: string | null = null;
    const protoShot = await protoPage.screenshot();
    const appShot = await appPage.screenshot();
    const pageDiff = opened ? (await pixelDiff(appPage, protoShot, appShot)).percent : null;

    if (surface.kind === 'modal' && opened) {
      const p = await measurePanel(protoPage, surface, 'proto');
      const a = await measurePanel(appPage, surface, 'app');
      const panelChecks: PartCheck[] = [];
      const protoParts: Record<string, Part | null> = { panel: p?.panel ?? null, overlay: p?.overlay ?? null };
      const appParts: Record<string, Part | null> = { panel: a?.panel ?? null, overlay: a?.overlay ?? null };
      panelChecks.push({ name: 'overlay', path: [], geometry: 'box', copy: false, styles: OVERLAY_STYLES });
      panelChecks.push({ name: 'panel', path: [], geometry: pending && surface.contentHeight ? 'none' : 'box', copy: false, styles: PANEL_STYLES });
      const result = compare(surface.id, panelChecks, protoParts, appParts);
      if (pending && surface.contentHeight && p && a) {
        // The palette's height follows its results: only x, y and width while the content is a placeholder.
        const issues = compareBoxes('panel', { ...p.panel.box, height: 0 }, { ...a.panel.box, height: 0 }, 'box');
        result.failures.push(...issues.map((issue) => `${surface.id} · ${issue}`));
        result.rows.push({
          surface: surface.id,
          part: 'panel (x, y, width)',
          geometry: 'box',
          proto: fmt(p.panel.box),
          app: fmt(a.panel.box),
          result: issues.length ? 'FAIL' : 'ok',
          note: issues.join('; ') || 'height follows the content (fit-content): compared once the content is implemented',
        });
      }
      track(result, content, 'content');
      if (p) {
        const clip = { x: Math.max(0, Math.floor(p.panel.box.x)), y: Math.max(0, Math.floor(p.panel.box.y)), width: Math.ceil(p.panel.box.width), height: Math.ceil(p.panel.box.height) };
        if (clip.width > 0 && clip.height > 0) {
          areaDiff = (await pixelDiff(appPage, await protoPage.screenshot({ clip }), await appPage.screenshot({ clip }))).percent;
        }
      }
    } else if (surface.kind === 'view' && opened) {
      const clip = { x: 256, y: 0, width: 1184, height: 900 };
      areaDiff = (await pixelDiff(appPage, await protoPage.screenshot({ clip }), await appPage.screenshot({ clip }))).percent;
    }

    if (!pending) {
      for (const text of surface.landmarks) {
        await expect.poll(() => landmarkScope(appPage, surface, 'app'), { message: `app ${surface.id}: ${text}` }).toContain(text);
      }
      rows.push({
        surface: surface.id,
        group: 'content',
        part: 'landmarks',
        geometry: 'none',
        proto: 'present',
        app: 'present',
        result: 'ok',
        note: surface.landmarks.map((t) => JSON.stringify(t)).join(', '),
      });
      content.checks += 1;
      // D86: a removal ruling: the prototype shows the copy, the app no longer does.
      for (const removal of surface.removed ?? []) {
        await expect.poll(() => landmarkScope(protoPage, surface, 'proto'), { message: `prototype ${surface.id}: ${removal.protoCopy}` }).toContain(removal.protoCopy);
        await expect.poll(() => landmarkScope(appPage, surface, 'app'), { message: `app ${surface.id}: ${removal.id} no ${removal.protoCopy}` }).not.toContain(removal.protoCopy);
        rows.push({
          surface: surface.id,
          group: 'content',
          part: `${removal.id} ruling (removed in the app)`,
          geometry: 'none',
          proto: JSON.stringify(removal.protoCopy),
          app: 'absent',
          result: 'ok',
          note: removal.note,
        });
        content.checks += 1;
        notes.push(removal.note);
      }
      // Developer rulings: the app shows the ruled copy (the prototype has none), noted in the report.
      for (const ruling of surface.rulings ?? []) {
        await expect.poll(() => landmarkScope(appPage, surface, 'app'), { message: `app ${surface.id}: ${ruling.id} ${ruling.appCopy}` }).toContain(ruling.appCopy);
        rows.push({
          surface: surface.id,
          group: 'content',
          part: `${ruling.id} ruling (app only)`,
          geometry: 'none',
          proto: '—',
          app: JSON.stringify(ruling.appCopy),
          result: 'ok',
          note: ruling.note,
        });
        content.checks += 1;
        notes.push(ruling.note);
      }
      if (surface.kind === 'view') {
        const main = mainChecks();
        const paths = pathsOf(main);
        track(compare(surface.id, main, await measure(protoPage, paths), await measure(appPage, paths)), content, 'content');
      }
      png = `full-pass-${surface.id}-side-by-side.png`;
      files[png] = await sideBySide(appPage, protoShot, appShot);
    } else {
      notes.push(`${opened ? 'content: M1.4 placeholder on this branch; ' : ''}implemented in ${surface.lane}, gated there by ${surface.detail}`);
    }

    summaries.push({
      surface,
      state: pending ? (surface.kind === 'modal' && opened ? 'chrome only' : 'pending merge') : 'gated',
      sidebar: sidebarTally,
      content,
      pageDiff,
      areaDiff,
      png,
      notes,
    });

    if (surface.kind === 'modal') {
      await protoPage.keyboard.press('Escape');
      if (opened) await appPage.keyboard.press('Escape');
    }
  }

  files['full-pass.md'] = report({ served, summaries, rows, failures });
  await writeReport(files);
  expect(failures).toEqual([]);
});

function pct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`;
}

function tallyText(tally: Tally | null, pendingLabel: string): string {
  if (!tally) return pendingLabel;
  return tally.failures ? `**red** (${tally.failures} of ${tally.checks})` : `green (${tally.checks})`;
}

function rowLine(row: Row): string {
  return `| ${row.surface} | ${row.part} | ${row.geometry} | ${row.proto} | ${row.app} | ${row.result} | ${row.note.replaceAll('|', '\\|')} |`;
}

function report(input: { served: Served; summaries: readonly Summary[]; rows: readonly Row[]; failures: readonly string[] }): string {
  const areaLines = (Object.entries(AREAS) as Array<[Area, (typeof AREAS)[Area]]>).map(
    ([area, { url, item }]) => `- \`${url}\` (${item}): ${input.served[area] ? 'served' : '**501**: its sidebar data is listed as pending, and the parts below it are compared by size'}`,
  );
  const table = input.summaries.map(({ surface, state, sidebar, content, pageDiff, areaDiff, png, notes }) => {
    const contentText = state === 'pending merge' ? 'pending merge' : `${tallyText(content, '—')}${state === 'chrome only' ? ', content pending merge' : ''}`;
    return `| ${surface.title} | ${surface.spec} | ${surface.items} | ${state} | ${tallyText(sidebar, 'not opened')} | ${contentText} | ${pct(pageDiff)} | ${pct(areaDiff)} | ${surface.detail} | ${png ? `\`${png}\`` : '—'} | ${notes.join(' · ') || '—'} |`;
  });
  const first = input.summaries.find((summary) => summary.sidebar)?.surface.id;
  const sidebarRows = input.rows.filter((row) => row.group === 'sidebar' && row.surface === first).map(rowLine);
  const otherRows = input.rows.filter((row) => row.group === 'content' || (row.group === 'sidebar' && row.surface !== first && row.result === 'FAIL')).map(rowLine);
  return `# Visual oracle · full pass (M9.3)

Generated by \`tests/e2e/visual/full-pass.spec.ts\` (D10). App: demo seed (\`SWITCHBOARD_DEMO=1\`), 1440×900. Prototype: \`docs/handoff/prototype/Switchboard App.dc.html\` offline, \`simulateIncoming\` off, same viewport.

**Gate:** ${input.failures.length === 0 ? 'green' : `red (${input.failures.length} findings)`} · boxes ±${BOX_TOLERANCE_PX} px, exact copy, computed styles equal to the prototype's.

On every surface this pass gates the sidebar (boxes, copy, computed styles; the selected nav item, session row or Settings row follows the view), the main column, the view box and fixed landmark copy of every implemented view, and the overlay + panel chrome of every modal. The detail of each view (every row, card and state) is gated by the view's own spec named in the table. The toast is gated on the real path by \`toast.spec.ts\` (\`toast.md\`).

API areas the sidebar reads besides sessions / Inbox / solutions:
${areaLines.join('\n')}

## Surfaces
State: **gated** = implemented on this branch and compared · **chrome only** = a modal whose overlay and panel are compared while its content is still the M1.4 placeholder · **pending merge** = the content lives in an unmerged lane (\`.loop/progress.md\` → Blocked). Pixel diffs are advisory (channel threshold 24): page = 1440×900, area = the main column (256,0 1184×900) or the modal panel.

| Surface | SPEC | Items | State | Sidebar | Content | Pixel diff page | Pixel diff area | Detail spec | Side by side | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
${table.join('\n')}

## Sidebar
The same parts are gated on every surface that opened; listed here as measured on \`${first ?? '—'}\`. A part that fails on another surface is listed under *Content and chrome* and *Findings*.
Geometry: \`box\` = x, y, width, height · \`size\` = x, width, height · \`bottom\` = x, width, bottom edge · \`relative\` = box with y relative to its anchor: the SESSIONS label (while the tool rows above it are pending) or the footer's top (D17 / D66: the footer is taller by the usage grid and keeps its bottom edge) · \`none\` = copy and styles only · \`listed\` = recorded, not gated · \`D66 rules\` = the usage grid gated on the footer's own rules (the 5h / Week header, one fixed line height, text styles = the RAM row, the prototype Max bar's height / radius / colors, D23 / D46: status done / need and the allowance marker on a bar with a pace, the header 7 px below the RAM row and 6 px between grid rows, the Week % ending at the RAM value, the bars lined up, the footer growing by exactly the grid less the Max row), not against the prototype, which has one "Max" row there.

| Surface | Part | Geometry | Prototype | App | Result | Notes |
|---|---|---|---|---|---|---|
${sidebarRows.join('\n')}

## Content and chrome
| Surface | Part | Geometry | Prototype | App | Result | Notes |
|---|---|---|---|---|---|---|
${otherRows.join('\n') || '| — | | | | | | |'}

## Findings
${input.failures.length ? input.failures.map((f) => `- ${f}`).join('\n') : '- (none)'}
`;
}
