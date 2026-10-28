import { type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D106 follow-up (2026-10-28, "chats should have access to write artifacts"), real path:
 * `node src/server/main.ts` with fake-claude as the CLI and its `switchboard` MCP server
 * really running (`FAKE_CLAUDE_MCP_RUN=1`). A chat (plan mode) whose agent calls
 * `artifact_save` with content gets the artifact: in v2 it shows in the chat's Results tab
 * (with its count) and on the Results page. With `FAKE_CLAUDE_PLAN_ASK_MCP=1` the fake asks
 * first, as plan mode might: Switchboard allows its own tool, so the result is the same.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('v2-chat-artifacts', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_MCP_RUN: '1', FAKE_CLAUDE_PLAN_ASK_MCP: '1' } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function call(page: Page, method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method: m, url: u, body: b }) => {
      const response = await fetch(u, { method: m, ...(b === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
    },
    { method, url, body },
  );
}

test("a chat's artifact_save (content) shows in the chat's Results and on the Results page", async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);
  const message = 'Plan the billing split. [fake:tool mcp__switchboard__artifact_save {"title":"Billing split plan","kind":"markdown","content":"# Billing split\\n\\n1. Move invoices"}]';
  const started = await call(page, 'POST', '/api/chats', { message });
  expect(started.status).toBe(201);
  const chat = started.body as { id: string; kind: string };
  expect(chat.kind).toBe('chat');
  await expect
    .poll(async () => ((await call(page, 'GET', `/api/sessions/${chat.id}/artifacts`)).body as Array<{ title: string }>).map((artifact) => artifact.title), { timeout: 20_000 })
    .toEqual(['Billing split plan']);
  // Nothing was refused in the chat.
  const events = (await call(page, 'GET', `/api/sessions/${chat.id}/events?limit=200`)).body as { items?: Array<{ label: string }> } | Array<{ label: string }>;
  const labels = (Array.isArray(events) ? events : (events.items ?? [])).map((event) => event.label);
  expect(labels.some((label) => label.startsWith('Refused in a chat'))).toBe(false);

  // The chat's Results tab (a chat has Chat · Results), with the count.
  await openWithHub(page, `${world.baseUrl}/agents/${chat.id}/results`);
  const tab = page.getByTestId('v2-agent-results');
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId('v2-agent-result-card')).toHaveCount(1);
  await expect(tab.getByTestId('v2-agent-result-card')).toContainText('Billing split plan');

  // The Results page lists it too.
  await openWithHub(page, `${world.baseUrl}/results`);
  await expect(page.getByTestId('v2-result-card').filter({ hasText: 'Billing split plan' })).toHaveCount(1);
});
