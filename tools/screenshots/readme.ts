/**
 * `npm run screenshots`: retakes the README screenshots (`docs/screenshots/*.png`)
 * from the real app in demo mode, so they can be refreshed after UI changes.
 *
 * What runs (on a loopback test port, `SWITCHBOARD_TEST_PORTS` or 4871–4879, with
 * a throwaway data folder; never the real app's port or data):
 * - the UI is built into `.e2e-dist/web` first (the E2E global setup; skip with
 *   `--no-build`);
 * - the app with the demo seed (`SWITCHBOARD_DEMO=1`, `docs/demo.md`), fake CLIs and
 *   the setup wizard off, as every test server (`tests/helpers/server-process.ts`), plus
 *   `SWITCHBOARD_DEMO_EXTRAS=1` (screenshots only, `docs/demo.md` → *Screenshot extras*):
 *   Team and Plans can be switched on, and the footer reads the accounts' stored usage;
 * - before the start, in the throwaway database: two Claude Code accounts, "Work"
 *   (`dev@example.com`, past its weekly limit and paid from credits, Acme amounts) and
 *   "Private" (`team@example.com`, its 5-hour window at the limit), as D103's oracle
 *   (`tests/e2e/credits.spec.ts`) stores them;
 * - through its API: two pinned sessions, a "Maintenance" folder with a "Releases"
 *   subfolder in the sidebar (D54, D58) and the machine name `studio-mac` (its default is
 *   this computer's host name);
 * - through the throwaway Claude config folder (demo mode has no data for them): two example
 *   MCP servers (`acme-docs`, `example-http`) for the MCP page and the demo sign-ins.
 * After the first eight shots (Team and Plans off, as a fresh install shows them):
 * - Search (D97) for "contract" over the demo chats and artifacts;
 * - Plans (D99) switched on, with one plan "PROJ-123 Acme checkout" over seven todos of the
 *   `free-talk-feature` session. Demo mode cannot run plan items (its folders are not real),
 *   so the items' states and history are written into the throwaway `plans.db` while Plans is
 *   switched off, then Plans is switched on again; the running items point at demo sessions
 *   (a question, a working one, an idle one waiting for your merge);
 * - Team (D100) switched on: two teams ("Acme web", "Acme mobile") adopting four demo sessions
 *   through the API (`POST /api/team/members`, no charter ask, so the chats stay as seeded).
 * Not shown, because demo mode cannot: a paired machine (the demo starts no peers,
 * so Settings → Machines shows its empty state) and a live activity line (the demo
 * runs no processes). The app has one (dark) theme, so every view is shot once, as
 * `<nn>-<name>-dark.png`, at 1440×900 and device scale 2 (each file < 600 KB); a close-up
 * (`clip`) is one element at the same scale.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { type Browser, type Locator, type Page, chromium } from '@playwright/test';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { REPO_ROOT, makeTempDir, removeTempDir } from '../../tests/helpers/net.ts';
import { type PeerNode, startPeerNode } from '../../tests/helpers/peers.ts';

/** Where the screenshots go. */
export const README_SHOTS_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

/** Demo e-mail addresses of the two Claude Code accounts (reserved example domain). */
const DEMO_EMAIL = 'dev@example.com';
const DEMO_EMAIL_2 = 'team@example.com';

/** Viewport and device scale of every screenshot. */
const VIEWPORT = { width: 1440, height: 900 } as const;
const DEVICE_SCALE = 2;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One screenshot: its file stem and how to bring the page there. */
interface Shot {
  readonly name: string;
  go(page: Page, baseUrl: string): Promise<void>;
  /** A close-up: only this element is shot (same device scale). */
  readonly clip?: (page: Page) => Locator;
}

async function open(page: Page, baseUrl: string, route: string): Promise<void> {
  await page.goto(`${baseUrl}${route}`);
  await page.getByTestId('shell').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/** The README's first shots: Team and Plans off. */
const SHOTS: readonly Shot[] = [
  {
    name: '01-session',
    go: (page, base) => open(page, base, '/sessions/free-talk-feature/chat'),
  },
  {
    name: '02-new-session',
    async go(page, base) {
      await open(page, base, '/inbox');
      await page.getByTestId('new-session').click();
      const modal = page.getByTestId('modal-new-session');
      await modal.waitFor();
      // D56: the shot shows the Simple form (the default): folder, message, title, model, CLI and worktree.
      await page.getByTestId('ns-simple-title').fill('Fix the login redirect');
      await page.getByTestId('ns-message').fill('Users land on a blank page after signing in from the pricing page. Find the cause and fix it.');
      // D57: one attached screenshot (a 1×1 PNG with a demo name).
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const chooser = page.waitForEvent('filechooser');
      await modal.getByTestId('attach-button').click();
      await (await chooser).setFiles({ name: 'blank-page.png', mimeType: 'image/png', buffer: png });
      await page.waitForTimeout(1_000);
      // The preflight runs 800 ms after the inputs settle.
      await page.waitForTimeout(2_000);
    },
  },
  {
    name: '03-inbox',
    go: (page, base) => open(page, base, '/inbox'),
  },
  {
    name: '04-schedules',
    go: (page, base) => open(page, base, '/schedules'),
  },
  {
    name: '05-machines',
    async go(page, base) {
      await open(page, base, '/settings/machines');
    },
  },
  {
    name: '06-sidebar',
    go: (page, base) => open(page, base, '/solutions'),
  },
  {
    name: '07-mcp',
    async go(page, base) {
      await open(page, base, '/mcp');
      await page.getByTestId('view-mcp').getByTestId('mcp-server').first().waitFor();
      // The Codex / OpenCode section runs their CLIs in the demo folder (not on this computer), so it
      // would print this computer's paths and an error. It is left out of the shot.
      await page.getByTestId('mcp-cli-section').waitFor();
      await page.getByTestId('mcp-cli-section').evaluate((node) => node.remove());
    },
  },
  {
    name: '08-accounts',
    async go(page, base) {
      await open(page, base, '/settings/accounts');
      await page.getByTestId('account-profile').first().waitFor();
      await page.getByTestId('account-credits').first().waitFor();
    },
  },
  {
    // D103: the footer grid's "on credits" badge row, close up.
    name: '09-credits-footer',
    async go(page, base) {
      await open(page, base, '/inbox');
      await page.getByTestId('usage-credits').first().waitFor();
    },
    clip: (page) => page.getByTestId('machine-footer'),
  },
  {
    // D97: the Search page.
    name: '10-search',
    async go(page, base) {
      await open(page, base, '/search?q=contract');
      await page.getByTestId('search-result').first().waitFor();
    },
  },
];

/** The shots taken once Plans and Team are on (`seedExperimental`). */
const EXPERIMENTAL_SHOTS: readonly Shot[] = [
  {
    name: '11-plans-graph',
    async go(page, base) {
      await open(page, base, '/plans');
      await page.getByTestId('plan-summary').first().click();
      await page.getByTestId('plan-card').first().waitFor();
      await page.locator('[data-testid="plan-card"][data-key="PROJ-126"]').click();
      await page.getByTestId('plan-detail').waitFor();
    },
  },
  {
    name: '12-plans-timeline',
    async go(page) {
      await page.getByTestId('plan-tab-timeline').click();
      await page.getByTestId('plan-timeline-row').first().waitFor();
    },
  },
  {
    name: '13-team',
    async go(page, base) {
      await open(page, base, '/team');
      await page.getByTestId('team-card').first().waitFor();
      await page.locator('[data-testid="team-card"]').filter({ hasText: 'Backend developer' }).first().click();
      await page.waitForTimeout(1_000);
    },
  },
];

/** The two Claude Code accounts with their usage (D66 / D103), stored before the demo starts. */
async function seedAccounts(dataDir: string, root: string): Promise<void> {
  const privateDir = path.join(root, 'main', 'private-config');
  await mkdir(privateDir, { recursive: true });
  await writeFile(path.join(privateDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: DEMO_EMAIL_2, subscriptionType: 'max' }));
  const store = await openStore(storeFile(dataDir));
  try {
    const now = Date.now();
    const at = (ms: number): string => new Date(now + ms).toISOString();
    const epoch = (ms: number): number => Math.floor((now + ms) / 1000);
    await store.profiles.update('default-claude', { name: 'Work' });
    const priv = await store.profiles.create({ id: 'demo-private', cli: 'claude', name: 'Private', dir: privateDir, shareSettings: false });
    // Work: at its weekly limit and still answering, paid from credits (€12.40 left of €50).
    await store.usage.add({
      receivedAt: at(-MINUTE),
      source: 'get_usage',
      sessionId: null,
      profileId: 'default-claude',
      fiveHourPct: 62,
      fiveHourResetsAt: at(2 * HOUR),
      sevenDayPct: 100,
      sevenDayResetsAt: at(39 * HOUR),
      raw: {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 62, resets_at: at(2 * HOUR) },
          seven_day: { utilization: 100, resets_at: at(39 * HOUR) },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 3760, utilization: 75.2, currency: 'EUR', decimal_places: 2, disabled_reason: null, user_disabled: false, spend_limit_reached: false, credits_ever_enabled: true, daily: null, weekly: null },
        },
      },
    });
    await store.usage.add({
      receivedAt: at(-30_000),
      source: 'rate_limit_event',
      sessionId: null,
      profileId: 'default-claude',
      fiveHourPct: 62,
      fiveHourResetsAt: at(2 * HOUR),
      sevenDayPct: 100,
      sevenDayResetsAt: at(39 * HOUR),
      raw: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: epoch(39 * HOUR), rateLimitType: 'seven_day', overageStatus: 'allowed', overageResetsAt: epoch(400 * HOUR), isUsingOverage: true, overageInUse: true } },
    });
    // Private: its 5-hour window at the limit (back in an hour), credits off.
    await store.usage.add({
      receivedAt: at(-MINUTE),
      source: 'get_usage',
      sessionId: null,
      profileId: priv.id,
      fiveHourPct: 100,
      fiveHourResetsAt: at(HOUR),
      sevenDayPct: 52,
      sevenDayResetsAt: at(90 * HOUR),
      raw: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: at(HOUR) }, seven_day: { utilization: 52, resets_at: at(90 * HOUR) }, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null } } },
    });
  } finally {
    await store.close();
  }
}

/** The demo instance with its sidebar pinned and foldered (D54), a neutral machine name and two accounts. */
async function startWorld(root: string): Promise<PeerNode> {
  // Demo mode has no MCP or account data of its own, so the throwaway Claude config folder
  // holds two harmless example MCP servers and the fake CLI's signed-in marker (a demo email).
  const configDir = path.join(root, 'main', 'claude-config');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'acme-docs': { type: 'stdio', command: 'npx', args: ['-y', '@acme/docs-mcp'], env: { ACME_DOCS_TOKEN: 'demo' } },
        'example-http': { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer demo' } },
      },
    }),
  );
  await writeFile(path.join(configDir, '.fake-auth.json'), JSON.stringify({ loggedIn: true, email: DEMO_EMAIL, subscriptionType: 'max' }));
  const main = await startPeerNode(root, 'main', {
    env: { SWITCHBOARD_DEMO: '1', SWITCHBOARD_DEMO_EXTRAS: '1', FAKE_CLAUDE_AUTH_REQUIRED: '1' },
    prepare: ({ dataDir }) => seedAccounts(dataDir, root),
  });
  try {
    // The default is this computer's host name.
    await main.call('PUT', '/api/machines/self', { name: 'studio-mac' });
    const place = async (sessionId: string, where: Record<string, unknown>) => {
      const answer = await main.call('POST', '/api/sidebar/place', { sessionId, ...where });
      if (answer.status !== 200) throw new Error(`place ${sessionId}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
    };
    await place('free-talk-feature', { place: 'pinned' });
    await place('notifications-integration', { place: 'pinned' });
    const folder = await main.call('POST', '/api/sidebar/folders', { name: 'Maintenance' });
    if (folder.status !== 201) throw new Error(`folder: HTTP ${folder.status}`);
    const folderId = (folder.body.folders as Array<{ id: string; name: string }>).find((f) => f.name === 'Maintenance')?.id;
    await place('calendar-func-fix', { place: 'folder', folderId });
    await place('prod-monitoring', { place: 'folder', folderId });
    // D58: a subfolder of Maintenance.
    const sub = await main.call('POST', '/api/sidebar/folders', { name: 'Releases', parentId: folderId });
    if (sub.status !== 201) throw new Error(`subfolder: HTTP ${sub.status}`);
    const subId = (sub.body.folders as Array<{ id: string; name: string }>).find((f) => f.name === 'Releases')?.id;
    await place('button-rollout', { place: 'folder', folderId: subId });
    return main;
  } catch (error) {
    await main.server.stop();
    throw error;
  }
}

async function expectStatus(answer: { readonly status: number; readonly body: unknown }, what: string): Promise<any> {
  if (answer.status >= 300) throw new Error(`${what}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** One plan item of the demo plan: its todo, dependencies and the state written into plans.db. */
interface DemoItem {
  readonly key: string;
  readonly title: string;
  readonly minutes: number;
  readonly after: readonly string[];
  readonly hold: boolean;
  /** `done`, `running` (+ the demo session it runs in, and what it waits on) or `pending`. */
  readonly state: 'done' | 'running' | 'pending';
  readonly run?: string;
  readonly waitingOn?: 'review' | 'question';
  /** Its history as spans, minutes before now (`to` null = open). */
  readonly spans: ReadonlyArray<{ readonly kind: 'running' | 'waiting-you' | 'waiting-dependency'; readonly from: number; readonly to: number | null }>;
}

const PLAN_SOURCE = 'free-talk-feature';
const PLAN_ITEMS: readonly DemoItem[] = [
  { key: 'PROJ-124', title: 'Checkout API contract (ADR)', minutes: 45, after: [], hold: true, state: 'done', spans: [{ kind: 'running', from: 200, to: 160 }, { kind: 'waiting-you', from: 160, to: 150 }] },
  { key: 'PROJ-125', title: 'Receipt e-mail template', minutes: 30, after: [], hold: false, state: 'done', spans: [{ kind: 'running', from: 200, to: 170 }] },
  { key: 'PROJ-126', title: 'Checkout screen', minutes: 90, after: ['PROJ-124'], hold: true, state: 'running', run: 'prod-monitoring', waitingOn: 'review', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: 45 }, { kind: 'waiting-you', from: 45, to: null }] },
  { key: 'PROJ-127', title: 'Payment form', minutes: 60, after: ['PROJ-124'], hold: false, state: 'running', run: 'button-rollout', waitingOn: 'question', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: 20 }, { kind: 'waiting-you', from: 20, to: null }] },
  { key: 'PROJ-128', title: 'Order summary', minutes: 120, after: ['PROJ-124'], hold: false, state: 'running', run: 'calendar-func-fix', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: null }] },
  { key: 'PROJ-129', title: 'Wire checkout to the API', minutes: 60, after: ['PROJ-126', 'PROJ-127'], hold: false, state: 'pending', spans: [{ kind: 'waiting-dependency', from: 200, to: null }] },
  { key: 'PROJ-130', title: 'Checkout E2E', minutes: 45, after: ['PROJ-129', 'PROJ-128'], hold: false, state: 'pending', spans: [{ kind: 'waiting-dependency', from: 200, to: null }] },
];

/**
 * D99 · one running plan. Its todos go in through the API; the plan, its items, edges and
 * history are written into `plans.db` while Plans is off (demo mode cannot run items: its
 * folders are not real), then Plans is switched on again and reads them.
 */
async function seedPlan(main: PeerNode): Promise<void> {
  const setPlans = (on: boolean) => main.call('PUT', '/api/settings', { 'experimental.plans': on }).then((a) => expectStatus(a, `plans ${on}`));
  await setPlans(true);
  await setPlans(false);
  const todoIds = new Map<string, string>();
  for (const item of PLAN_ITEMS) {
    const title = item.title;
    const list = await expectStatus(
      await main.call('POST', `/api/sessions/${PLAN_SOURCE}/todos`, { title, description: `Acme checkout: ${item.title.toLowerCase()}.`, plan: 'No plan: demo item.', priority: 'medium', estimateMinutes: item.minutes }),
      `todo ${item.key}`,
    );
    const todo = (list.todos as Array<{ id: string; title: string }>).find((entry) => entry.title === title);
    if (!todo) throw new Error(`no todo ${title}`);
    todoIds.set(item.key, todo.id);
  }
  const now = Date.now();
  const iso = (minutesAgo: number): string => new Date(now - minutesAgo * MINUTE).toISOString();
  const db = new DatabaseSync(path.join(main.dataDir, 'plans.db'));
  try {
    const planId = 'demo-plan';
    db.prepare(
      `INSERT INTO plans (id, title, source_session_id, target_branch, repos, base_branch, merge_mode, max_concurrency, usage_threshold, answers, state, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, 'dev', 'agents-with-holds', 3, 85, NULL, 'running', ?, ?, ?)`,
    ).run(planId, 'PROJ-123 Acme checkout', PLAN_SOURCE, 'feature/PROJ-123-acme-checkout', JSON.stringify(['web']), iso(210), iso(1), iso(200));
    const itemIds = new Map<string, string>();
    PLAN_ITEMS.forEach((item, position) => {
      const id = `demo-item-${item.key.toLowerCase()}`;
      itemIds.set(item.key, id);
      const started = item.state === 'pending' ? null : iso(item.spans.find((span) => span.kind === 'running')?.from ?? 200);
      const done = item.state === 'done' ? iso(item.spans.at(-1)?.to ?? 150) : null;
      const waitingSince = item.waitingOn ? iso(item.spans.at(-1)?.from ?? 20) : null;
      db.prepare(
        `INSERT INTO plan_items (id, plan_id, todo_id, key, title, estimate_minutes, hold, solutions, state, waiting_on, run_session_id, branch, position, created_at, updated_at, started_at, waiting_since, merged_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        planId,
        todoIds.get(item.key) as string,
        item.key,
        item.title,
        item.minutes,
        item.hold ? 1 : 0,
        item.state,
        item.waitingOn ?? null,
        item.run ?? null,
        item.state === 'pending' ? null : `${item.key}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`,
        position,
        iso(210),
        iso(1),
        started,
        waitingSince,
        done,
        done,
      );
      for (const span of item.spans) db.prepare('INSERT INTO plan_item_spans (plan_id, item_id, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(planId, id, span.kind, iso(span.from), span.to === null ? null : iso(span.to));
    });
    for (const item of PLAN_ITEMS) {
      for (const before of item.after) db.prepare('INSERT INTO plan_edges (plan_id, from_item, to_item) VALUES (?, ?, ?)').run(planId, itemIds.get(before) as string, itemIds.get(item.key) as string);
    }
  } finally {
    db.close();
  }
  await setPlans(true);
}

/** D100 · two teams adopting four demo sessions (no charter ask: the chats stay as seeded). */
async function seedTeam(main: PeerNode): Promise<void> {
  await expectStatus(await main.call('PUT', '/api/settings', { 'experimental.team': true }), 'team on');
  await expectStatus(await main.call('PUT', '/api/team', { name: 'Acme web' }), 'rename team');
  const mobile = await expectStatus(await main.call('POST', '/api/team/teams', { name: 'Acme mobile' }), 'new team');
  const adopt = async (sessionId: string, name: string, templateId: string, teamId?: string) =>
    expectStatus(await main.call('POST', '/api/team/members', { sessionId, name, templateId, ...(teamId ? { teamId } : {}) }), `adopt ${sessionId}`);
  await adopt('notifications-integration', 'Backend developer', 'developer');
  await adopt('qa-free-talk', 'QA', 'reviewer');
  await adopt('calendar-func-fix', 'Developer', 'developer');
  await adopt('prod-monitoring', 'On-call', 'on-call');
  await adopt('button-rollout', 'Design system', 'developer', mobile.id as string);
}

async function shoot(browser: Browser, main: PeerNode): Promise<void> {
  await mkdir(README_SHOTS_DIR, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    const take = async (shot: Shot) => {
      await shot.go(page, main.baseUrl);
      // Lets the live rows tick and late API answers settle.
      await page.waitForTimeout(1_500);
      await page.mouse.move(0, 0);
      const file = path.join(README_SHOTS_DIR, `${shot.name}-dark.png`);
      const png = shot.clip ? await shot.clip(page).screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });
      await writeFile(file, png);
      console.log(path.relative(REPO_ROOT, file));
    };
    for (const shot of SHOTS) await take(shot);
    await seedPlan(main);
    await seedTeam(main);
    for (const shot of EXPERIMENTAL_SHOTS) await take(shot);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--no-build')) await globalSetup();
  const root = await makeTempDir('readme-shots');
  try {
    const main = await startWorld(root);
    const browser = await chromium.launch();
    try {
      await shoot(browser, main);
    } finally {
      await browser.close();
      await main.server.stop();
    }
  } finally {
    await removeTempDir(root);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
