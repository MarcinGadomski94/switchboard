import { type Page, type Route, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import type { SessionDraft } from '../../src/core/drafts.ts';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { PNG_1X1 } from '../helpers/attachments.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fix after 2.0 · v2 composer drafts (D88, `docs/chat.md` → *Drafts*): what is typed
 * and not sent stays with the agent in every real path: Home and back, another agent
 * opened under the 400 ms pause, a reload (shown at once, no empty field first), v2 ↔
 * classic (the same server draft), the peek vs the full view, the phone, and a draft
 * with an attachment. A real server answers a save in its own time: the specs hold the
 * save (`page.route`) the way a busy machine or a paired computer does, so coming back
 * while it travels is tested, not left to timing.
 */

let world: QuestionWorld;
let a = '';
let b = '';

test.beforeAll(async ({ browser }) => {
  world = await startQuestionWorld('e2e-v2-drafts', { env: { ...V2_SERVER_ENV } });
  const page = await browser.newPage();
  await page.goto(`${world.baseUrl}/`);
  a = (await world.startSession(page, 'drafts-a', 'Say hi.')).id;
  b = (await world.startSession(page, 'drafts-b', 'Say hello.')).id;
  for (const id of [a, b]) await expect.poll(async () => (await detail(page, id)).status, { timeout: 20_000 }).toMatch(/^(done|idle)$/);
  await page.close();
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

test.afterEach(async ({ page }) => {
  // Each spec starts from no draft on the server, whatever the page did.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page
    .evaluate(async (ids) => {
      for (const id of ids) await fetch(`/api/sessions/${encodeURIComponent(id)}/drafts/composer`, { method: 'DELETE' });
    }, [a, b])
    .catch(() => undefined);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

async function composer(page: Page, id: string): Promise<{ text: string; attachments: unknown[] } | null> {
  const all = await page.evaluate(async (sid) => (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}/drafts`)).json()) as SessionDraft[], id);
  return (all.find((draft) => draft.field === 'composer')?.value as { text: string; attachments: unknown[] } | undefined) ?? null;
}

/** In-app navigation (the v2 router follows `popstate`), as a rail link or Back does. */
async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/** Holds every composer save (PUT) for `ms`, as a busy server or a paired computer answers. */
async function slowSaves(page: Page, ms = 1_500): Promise<void> {
  await page.route('**/api/sessions/*/drafts/composer*', async (route: Route) => {
    if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, ms));
    await route.continue().catch(() => undefined);
  });
}

function input(page: Page) {
  return page.getByTestId('v2-agent-view').getByTestId('v2-agent-input');
}

async function typeInto(page: Page, text: string): Promise<void> {
  await expect(input(page)).toBeEnabled();
  await input(page).click();
  await input(page).pressSequentially(text);
}

/** The field keeps `text` (now, and once the save and the read are over), and the server has it. */
async function kept(page: Page, id: string, text: string, attachments = 0): Promise<void> {
  await expect(input(page)).toHaveValue(text);
  await page.waitForTimeout(2_500);
  await expect(input(page)).toHaveValue(text);
  await expect.poll(async () => (await composer(page, id))?.text ?? null).toBe(text);
  await expect.poll(async () => (await composer(page, id))?.attachments.length ?? 0).toBe(attachments);
}

test('type, go Home at once, come back: kept (the save made on the way out still travelling)', async ({ page }) => {
  await slowSaves(page);
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'back from Home');
  await go(page, '/');
  await expect(page.getByTestId('v2-agent-view')).toHaveCount(0);
  await page.waitForTimeout(200);
  await go(page, `/agents/${a}`);
  await kept(page, a, 'back from Home');
  // The Agents page's Drafts card and the List row's marker say so.
  await go(page, '/agents');
  await expect(page.getByTestId('v2-drafts-card').getByTestId('v2-draft-row')).toHaveAttribute('data-session', a);
  await expect(page.getByTestId('v2-drafts-card')).toContainText('back from Home');
});

test('type, open another agent under the pause, come back: kept, and the other agent stays empty', async ({ page }) => {
  await slowSaves(page);
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'switch quick');
  await go(page, `/agents/${b}`);
  await expect(page.getByTestId('v2-agent-view')).toHaveAttribute('data-session-id', b);
  await expect(input(page)).toHaveValue('');
  await go(page, `/agents/${a}`);
  await kept(page, a, 'switch quick');
  expect(await composer(page, b)).toBeNull();
});

test('type, reload: the draft shows at once (no empty field while the server answers)', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'reload me');
  await expect.poll(() => composer(page, a)).toEqual({ text: 'reload me', attachments: [] });
  // The reload's draft read answers late: the field must not sit empty meanwhile.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/sessions/*/drafts', async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await page.reload();
  try {
    await expect(input(page)).toHaveValue('reload me', { timeout: 3_000 });
  } finally {
    release();
  }
  await kept(page, a, 'reload me');
});

test('type, reload at once (under the pause): kept', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'reload at once');
  await page.reload();
  await kept(page, a, 'reload at once');
});

test('v2 → classic → v2: the same server draft both ways', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'from v2');
  await expect.poll(() => composer(page, a)).toEqual({ text: 'from v2', attachments: [] });
  await page.evaluate((key) => window.localStorage.setItem(key, 'classic'), THEME_STORAGE_KEY);
  await openWithHub(page, `${world.baseUrl}/sessions/${a}`);
  const classic = page.getByTestId('chat-input');
  await expect(classic).toHaveValue('from v2');
  await classic.fill('from classic');
  await expect.poll(() => composer(page, a)).toEqual({ text: 'from classic', attachments: [] });
  await page.evaluate((key) => window.localStorage.setItem(key, 'v2'), THEME_STORAGE_KEY);
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await kept(page, a, 'from classic');
});

test('the peek and the full view share the draft', async ({ page }) => {
  await slowSaves(page);
  await openWithHub(page, `${world.baseUrl}/`);
  await page.evaluate((sessionId) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(sessionId), a);
  const sheet = page.getByTestId('v2-agent-peek');
  const peekInput = sheet.getByTestId('v2-agent-input');
  await expect(peekInput).toBeEnabled();
  await peekInput.click();
  await peekInput.pressSequentially('typed in the peek');
  await sheet.getByTestId('v2-agent-peek-full').click();
  await kept(page, a, 'typed in the peek');
  // And back: typed in the full view, the peek shows it.
  await input(page).fill('typed in the full view');
  await go(page, '/');
  await page.evaluate((sessionId) => (window as unknown as { __sbV2Peek: (id: string) => void }).__sbV2Peek(sessionId), a);
  const again = page.getByTestId('v2-agent-peek').getByTestId('v2-agent-input');
  await expect(again).toHaveValue('typed in the full view');
  await page.waitForTimeout(2_500);
  await expect(again).toHaveValue('typed in the full view');
});

test('phone (390 × 844): type, Home, back, reload: kept', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await slowSaves(page);
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'on the phone');
  await go(page, '/');
  await page.waitForTimeout(200);
  await go(page, `/agents/${a}`);
  await kept(page, a, 'on the phone');
  await page.reload();
  await kept(page, a, 'on the phone');
});

test('a draft with an attachment: the text and the chip come back after leaving and a reload', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await expect(input(page)).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('v2-agent-attach').click();
  await (await chooser).setFiles({ name: 'mock.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1, 'base64') });
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveAttribute('data-state', 'ready');
  await slowSaves(page);
  await typeInto(page, 'with a file');
  await go(page, '/');
  await page.waitForTimeout(200);
  await go(page, `/agents/${a}`);
  await kept(page, a, 'with a file', 1);
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveCount(1);
  await page.reload();
  await kept(page, a, 'with a file', 1);
  await expect(page.getByTestId('v2-agent-draft-chip')).toHaveCount(1);
});

test('only sending or emptying the field clears it', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/agents/${a}`);
  await typeInto(page, 'to be emptied');
  await expect.poll(() => composer(page, a)).toEqual({ text: 'to be emptied', attachments: [] });
  await input(page).fill('');
  await expect.poll(() => composer(page, a)).toBeNull();
  await go(page, '/');
  await go(page, `/agents/${a}`);
  await expect(input(page)).toHaveValue('');
});
