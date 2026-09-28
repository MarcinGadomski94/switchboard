import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Locator, type Page, expect, test } from '@playwright/test';
import type { InboxItem, SessionDetail } from '../../src/core/api.ts';
import { slugForCwd } from '../../src/core/transcript.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D24 Remote Control on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI (its `remote_control` answers the R.6 reply shape).
 * The header's Remote toggle turns it on: the popover shows the claude.ai link (new
 * tab, noopener noreferrer), its QR code and the transcript note; the sidebar row
 * shows the phone glyph; pause keeps it on (disabled, with the reason), resume
 * reattaches the same link; a question "answered on the phone" closes as answered on
 * claude.ai; turning it off clears the glyph. A server whose CLI reports Remote
 * unavailable shows the toggle disabled with the reason. History badges a terminal
 * conversation with a `bridge-session` line.
 */

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('remote-control');
});

test.afterAll(async () => {
  await world?.stop();
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return (await response.json()) as SessionDetail;
  }, id);
}

async function send(page: Page, id: string, text: string): Promise<void> {
  const status = await page.evaluate(
    async ({ sessionId, body }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      return response.status;
    },
    { sessionId: id, body: text },
  );
  expect(status).toBe(202);
}

/** The computed color of a SPEC token (a probe element in the page). */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

function sidebarRow(page: Page, name: string): Locator {
  return page.getByTestId('sidebar-sessions').locator('a').filter({ hasText: name });
}

/** Starts a session with one finished turn (so it has a transcript to resume) and opens it with the hub connected. */
async function startSession(page: Page, name: string, w: QuestionWorld = world): Promise<string> {
  await page.goto(`${w.baseUrl}/`);
  const { id } = await w.startSession(page, name, 'Reply with just OK.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await openWithHub(page, `${w.baseUrl}/sessions/${id}`);
  return id;
}

test('Remote on: link + QR + note, the sidebar glyph; pause keeps it on, resume reattaches; a phone answer; off', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const id = await startSession(page, 'remote-e2e');
  const { claudeSessionId } = await detail(page, id);
  const url = `https://claude.ai/code/session_FAKE${claudeSessionId.replace(/-/g, '')}`;

  // Off by default, enabled once the process's initialize said Remote Control is available.
  const toggle = page.getByTestId('session-remote-toggle');
  await expect(toggle).toHaveText('Remote');
  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toBeEnabled();
  await expect(page.getByTestId('session-remote-link')).toHaveCount(0);
  // It sits with the header actions, before Pause (after D31's model picker), in their style.
  const actions = await page.locator('.sb-sv-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(actions).toEqual(['session-model', 'session-remote', 'session-pause', 'session-handoff']);
  await expect(toggle).toHaveCSS('font-size', '12px');
  await expect(toggle).toHaveCSS('border-top-left-radius', '6px');
  const pause = page.getByTestId('session-pause');
  expect(await toggle.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(await pause.evaluate((el) => getComputedStyle(el).borderTopColor));

  // On: the popover opens with the link (new tab, noopener noreferrer), the QR code and the note.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveCSS('color', await tokenColor(page, '--status-done'));
  const popover = page.getByTestId('remote-popover');
  await expect(popover).toBeVisible();
  const link = page.getByTestId('remote-link');
  await expect(link).toHaveText(url);
  await expect(link).toHaveAttribute('href', url);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByTestId('remote-open')).toHaveAttribute('rel', 'noopener noreferrer');
  const qr = page.getByTestId('remote-qr');
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute('data-text', url);
  expect(await qr.evaluate((el) => (el as unknown as SVGSVGElement).getBoundingClientRect().width)).toBe(168);
  expect((await qr.locator('path').getAttribute('d'))?.length ?? 0).toBeGreaterThan(100);
  await expect(page.getByTestId('remote-note')).toHaveText("While Remote is on, the transcript is stored on Anthropic's servers.");
  await page.getByTestId('remote-copy').click();
  await expect(page.getByTestId('remote-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  expect((await detail(page, id)).remote).toEqual({ available: true, enabled: true, url });

  // Esc closes it; "Link & QR" opens it again.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await page.getByTestId('session-remote-link').click();
  await expect(page.getByTestId('remote-popover')).toBeVisible();
  await page.getByTestId('remote-close').click();
  await expect(page.getByTestId('remote-popover')).toHaveCount(0);
  // With Remote on (its widest: Remote + Link & QR) and this long temp path, every header action stays left of the right panel.
  const lastAction = await page.getByTestId('session-handoff').boundingBox();
  const panel = await page.getByTestId('session-right-panel').boundingBox();
  expect((lastAction?.x ?? 0) + (lastAction?.width ?? 0)).toBeLessThanOrEqual(panel?.x ?? 0);

  // The sidebar row: the phone glyph while the session runs with Remote on.
  const glyph = sidebarRow(page, 'remote-e2e').getByTestId('session-remote-glyph');
  await expect(glyph).toBeVisible();
  await expect(glyph).toHaveCSS('color', await tokenColor(page, '--status-done'));
  // The chat records it.
  await expect(page.getByTestId('chat-step').filter({ hasText: `Remote Control on · ${url}` })).toHaveCount(1);

  // Pause: Remote stays on (reconnects on resume); the toggle is disabled with the reason; no glyph (no process).
  await pause.click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveCSS('opacity', '0.45');
  await expect(toggle).toHaveAttribute('title', 'Remote is on and reconnects when the session resumes: it needs a running claude process.');
  await expect(glyph).toHaveCount(0);
  expect((await detail(page, id)).remote).toEqual({ available: false, enabled: true, url });

  // Resume: the new process reattaches the same claude.ai entry (same link).
  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await detail(page, id)).remote?.available, { timeout: 15_000 }).toBe(true);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect((await detail(page, id)).remote).toEqual({ available: true, enabled: true, url });
  await expect(page.getByTestId('chat-step').filter({ hasText: `Remote Control on again · ${url}` })).toHaveCount(1);
  await expect(glyph).toBeVisible();
  await page.getByTestId('session-remote-link').click();
  await expect(page.getByTestId('remote-link')).toHaveText(url);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');

  // A question answered on the phone first: the card turns into "Answered on claude.ai"; it never reaches the Inbox list.
  await send(page, id, '[fake:ask-2q] [fake:remote-answer 1500] Ask me two questions.');
  await expect(page.getByTestId('question-card')).toBeVisible();
  const answered = page.locator('[data-testid="chat-answers"][data-answered-on="claude.ai"]');
  await expect(answered).toHaveCount(1, { timeout: 10_000 });
  await expect(answered.getByTestId('chat-answer')).toHaveText('Answered on claude.ai');
  await expect(page.getByTestId('question-card')).toHaveCount(0);
  await expect.poll(async () => (await detail(page, id)).questions.map((q) => q.answeredOn)).toEqual(['claude.ai', 'claude.ai']);
  const inbox = await page.evaluate(async () => (await (await fetch('/api/inbox')).json()) as InboxItem[]);
  expect(inbox.filter((item) => item.kind === 'questions' && item.sessionId === id)).toEqual([]);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');

  // Off: the toggle, the glyph and the popover button go; the link is kept on the session for a later reattach.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('session-remote-link')).toHaveCount(0);
  await expect(glyph).toHaveCount(0);
  await expect(page.getByTestId('chat-step').filter({ hasText: 'Remote Control off' })).toHaveCount(1);
  expect((await detail(page, id)).remote).toEqual({ available: true, enabled: false, url });
});

test('History: a terminal conversation that had Remote Control on carries the badge', async ({ page }) => {
  const sessionId = randomUUID();
  const folder = path.join(world.configDir, 'projects', slugForCwd(world.workspace));
  await mkdir(folder, { recursive: true });
  const ts = '2026-09-28T09:00:00.000Z';
  const lines = [
    { type: 'user', uuid: randomUUID(), parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: world.workspace, sessionId, version: '2.1.283', gitBranch: 'HEAD', timestamp: ts, message: { role: 'user', content: 'Look at the flaky test from my phone' } },
    { type: 'bridge-session', sessionId, bridgeSessionId: 'cse_01TerminalRemote', lastSequenceNum: 3, ownerAccountUuid: 'owner', ownerOrganizationUuid: 'org' },
  ];
  await writeFile(path.join(folder, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  await page.goto(`${world.baseUrl}/history`);
  const row = page.locator(`[data-testid="history-row"][data-claude-session-id="${sessionId}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('history-remote-badge')).toHaveText('Remote Control');
  // The stored session's row (Remote on through Switchboard) has no badge: D24 marks terminal conversations.
  await expect(page.locator('[data-testid="history-row"][data-session-id]').getByTestId('history-remote-badge')).toHaveCount(0);
});

test.describe('Remote Control unavailable', () => {
  let unavailable: QuestionWorld;

  test.beforeAll(async () => {
    unavailable = await startQuestionWorld('remote-unavailable', { env: { FAKE_CLAUDE_REMOTE_CONTROL: 'unavailable' } });
  });

  test.afterAll(async () => {
    await unavailable?.stop();
  });

  test('initialize reports it unavailable: the toggle stays off and disabled, the tooltip says why', async ({ page }) => {
    const id = await startSession(page, 'remote-off-e2e', unavailable);
    const toggle = page.getByTestId('session-remote-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeDisabled();
    const reason = "Remote Control is not available here: claude's initialize did not report remote_control_available (it needs a claude.ai subscription login).";
    await expect(toggle).toHaveAttribute('title', reason);
    await expect(toggle).toHaveAttribute('data-reason', reason);
    expect((await detail(page, id)).remote).toEqual({ available: false, enabled: false, url: null });
    await expect(sidebarRow(page, 'remote-off-e2e').getByTestId('session-remote-glyph')).toHaveCount(0);
  });
});
