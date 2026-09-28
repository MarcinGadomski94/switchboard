import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { fakeClaudeBinEnv } from '../../tools/fake-claude/command.ts';
import { fakeGhBinEnv } from '../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type ServerProcess, startServer } from '../helpers/server-process.ts';

/**
 * M3.2 oracle (E2E): the Inbox view on the real code path (no demo seed, D13):
 * `node src/server/main.ts` with fake-claude as the CLI, a temp workspace and data
 * folder. Sessions start through `POST /api/sessions`; their question batch
 * (`ask-2q`) and permission request (`perm-allow`) reach the Inbox live over
 * `/hub`; the answers and the Allow once decision go back to the fake process,
 * whose stdin log shows exactly what it received.
 */
let tmp: string;
let logFile: string;
let server: ServerProcess;

test.beforeAll(async () => {
  tmp = await makeTempDir('e2e-inbox');
  const workspace = path.join(tmp, 'work space');
  const claudeConfig = path.join(tmp, 'claude-config');
  logFile = path.join(tmp, 'fake.log');
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeConfig, { recursive: true });
  server = await startServer({
    SWITCHBOARD_DATA_DIR: path.join(tmp, 'data'),
    SWITCHBOARD_WORKSPACE_ROOT: workspace,
    SWITCHBOARD_CLAUDE_BIN: fakeClaudeBinEnv(),
    SWITCHBOARD_GH_BIN: fakeGhBinEnv(),
    CLAUDE_CONFIG_DIR: claudeConfig,
    FAKE_CLAUDE_LOG: logFile,
  });
});

test.afterAll(async () => {
  if (server) expect(await server.stop()).toBe(0);
  await removeTempDir(tmp);
});

/** Starts a session through the contract route from the page (same origin, the sb_token cookie). */
async function startSession(page: Page, name: string, task: string): Promise<{ id: string }> {
  const result = await page.evaluate(
    async ({ name: sessionName, task: sessionTask }) => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: sessionName,
          task: sessionTask,
          workType: 'feature',
          mode: 'single',
          solutions: ['acme-app-front'],
          phase: 'ui-first',
          coordination: 'none',
          qa: null,
          worktrees: false,
          ultracode: false,
        }),
      });
      return { status: response.status, body: (await response.json()) as { id: string } };
    },
    { name, task },
  );
  expect(result.status).toBe(201);
  return result.body;
}

/** The `control_response` lines the fake processes received on stdin, parsed. */
async function controlResponses(): Promise<Array<{ response: { request_id: string; response: Record<string, unknown> } }>> {
  let text = '';
  try {
    text = await readFile(logFile, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { kind: string; line?: string })
    .filter((entry) => entry.kind === 'stdin' && (entry.line ?? '').includes('"control_response"'))
    .map((entry) => JSON.parse(entry.line as string) as { response: { request_id: string; response: Record<string, unknown> } });
}

async function sessionStatus(page: Page, id: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return ((await response.json()) as { status: string }).status;
  }, id);
}

test('a question batch: list + detail, Send stays disabled at 45% until every question is answered, the answers reach the process, Inbox zero', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('view-inbox')).toBeVisible();

  // Nothing waits yet: the empty states (prototype copy), no badge.
  await expect(page.getByTestId('inbox-count')).toHaveText('0 waiting on you');
  await expect(page.getByTestId('inbox-all-clear')).toHaveText('All clear. Nothing is waiting on you.');
  await expect(page.getByTestId('inbox-zero')).toHaveText('Inbox zeroNew questions, approvals and failed runs show up here with a toast and sound.');
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('');

  // A real session asks two questions: the batch arrives live (inboxChanged), without a reload.
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documents.push(request.url());
  });
  const session = await startSession(page, 'asker', '[fake:ask-2q] Ask me two questions.');
  const cards = page.getByTestId('inbox-item');
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId('inbox-zero')).toHaveCount(0);
  await expect(page.getByTestId('inbox-all-clear')).toHaveCount(0);
  await expect(page.getByTestId('inbox-count')).toHaveText('1 waiting on you');
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('1');
  const card = cards.first();
  await expect(card).toHaveAttribute('data-selected', 'true');
  await expect(card.locator('.sb-inbox__card-source')).toHaveText('asker');
  await expect(card.locator('.sb-inbox__card-age')).toHaveText('now');
  await expect(card.locator('.sb-inbox__card-title')).toHaveText('2 questions from acme-app-front');
  await expect(card.locator('.sb-inbox__card-kind')).toHaveText('2 questions');

  // Detail: meta line with the session link, the 24px title, the question card.
  await expect(page.getByTestId('inbox-meta')).toHaveText('asker·2 questions·nowOpen session →');
  await expect(page.getByTestId('inbox-open-session')).toHaveAttribute('href', `/sessions/${session.id}`);
  await expect(page.getByTestId('inbox-title')).toHaveText('2 questions from acme-app-front');
  await expect(page.getByTestId('inbox-title')).toHaveCSS('font-size', '24px');
  await expect(page.getByTestId('inbox-branches').locator('*')).toHaveCount(0);
  await expect(page.getByTestId('inbox-text')).toHaveCount(0);
  const questionCard = page.getByTestId('question-card');
  await expect(questionCard.locator('.sb-qcard__head')).toHaveText('2 questions · relayed verbatim');
  const questions = questionCard.getByTestId('question');
  await expect(questions).toHaveCount(2);
  await expect(questions.locator('.sb-qcard__source')).toHaveText(['acme-app-front', 'acme-app-front']);
  await expect(questions.locator('.sb-qcard__quote')).toHaveText(['“Which color should the button be?”', '“Which size should it be?”']);
  await expect(questions.nth(0).getByTestId('question-option')).toHaveText(['Red', 'Green', 'Blue']);
  await expect(questions.nth(1).getByTestId('question-option')).toHaveText(['Small', 'Large']);

  const send = page.getByTestId('question-send');
  const status = page.getByTestId('question-status');
  await expect(send).toHaveText('Send all answers');
  await expect(status).toHaveText('0 of 2 answered');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('opacity', '0.45');

  // One of two: still disabled at 45%, nothing written to the process.
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Green' }).click();
  await expect(questions.nth(0).getByTestId('question-option').filter({ hasText: 'Green' })).toHaveAttribute('data-selected', 'true');
  await expect(status).toHaveText('1 of 2 answered');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('opacity', '0.45');
  await send.click({ force: true });
  expect(await controlResponses()).toEqual([]);
  await expect(cards).toHaveCount(1);

  // A pick can change before sending.
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Red' }).click();
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Green' }).click();
  await questions.nth(1).getByTestId('question-option').filter({ hasText: 'Small' }).click();
  await expect(status).toHaveText('All answered. Each answer is written into the blocked brief word for word.');
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS('opacity', '1');

  await send.click();
  await expect(cards).toHaveCount(0);
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await expect(page.getByTestId('inbox-all-clear')).toBeVisible();
  await expect(page.getByTestId('inbox-count')).toHaveText('0 waiting on you');
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('');

  // The process got exactly one control_response: allow, input unchanged + the answers by question text.
  await expect.poll(async () => (await controlResponses()).length).toBe(1);
  const [reply] = await controlResponses();
  expect(reply?.response.response).toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { 'Which color should the button be?': 'Green', 'Which size should it be?': 'Small' } },
  });
  await expect.poll(() => sessionStatus(page, session.id)).toBe('done');
  expect(documents).toEqual([]);
});

test('two items: newest first and selected; picking switches the detail; a permission request shows tool + input verbatim and Allow once continues the process', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/inbox`);
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  const before = (await controlResponses()).length;

  const asker = await startSession(page, 'asker-two', '[fake:ask-2q] Ask me two questions.');
  const cards = page.getByTestId('inbox-item');
  await expect(cards).toHaveCount(1);
  const runner = await startSession(page, 'runner', '[fake:perm-allow] Run the command.');
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId('inbox-count')).toHaveText('2 waiting on you');
  await expect(page.getByTestId('nav-inbox').locator('.sb-badge')).toHaveText('2');

  // Newest first; the first is selected until another is picked.
  await expect(cards.locator('.sb-inbox__card-source')).toHaveText(['runner', 'asker-two']);
  await expect(cards.locator('.sb-inbox__card-kind')).toHaveText(['Permission', '2 questions']);
  await expect(cards.nth(0)).toHaveAttribute('data-selected', 'true');
  await expect(cards.nth(1)).toHaveAttribute('data-selected', 'false');
  await expect(cards.nth(0)).toHaveCSS('border-top-color', 'rgb(58, 59, 65)');
  await expect(cards.nth(0)).toHaveCSS('background-color', 'rgb(28, 29, 33)');
  await expect(cards.nth(1)).toHaveCSS('border-top-color', 'rgb(31, 32, 36)');

  // The permission request (D6): title = the tool's one-line label, detail = the model's description,
  // the tool + input verbatim, Allow once (primary) / Deny.
  await expect(page.getByTestId('inbox-title')).toHaveText('Bash · node -e "console.log(6*7)"');
  await expect(page.getByTestId('inbox-meta')).toHaveText('runner·Permission·nowOpen session →');
  await expect(page.getByTestId('inbox-text')).toHaveText('Run Node.js calculation');
  const request = page.getByTestId('permission-request');
  await expect(request.locator('.sb-inbox__request-agent')).toHaveText('acme-app-front');
  await expect(request.locator('.sb-inbox__request-tool')).toHaveText('Bash');
  const input = JSON.parse((await page.getByTestId('permission-input').textContent()) ?? 'null') as unknown;
  expect(input).toEqual({ command: 'node -e "console.log(6*7)"', description: 'Run Node.js calculation' });
  const actions = page.getByTestId('inbox-action');
  await expect(actions).toHaveText(['Allow once', 'Deny']);
  await expect(actions.nth(0)).toHaveAttribute('data-primary', 'true');
  await expect(actions.nth(0)).toHaveCSS('background-color', 'rgb(232, 231, 227)');
  await expect(actions.nth(1)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(actions.nth(1)).toHaveCSS('border-top-color', 'rgb(44, 45, 50)');
  await expect(page.getByTestId('question-card')).toHaveCount(0);

  // Picking the other card switches the detail (and back).
  await cards.nth(1).click();
  await expect(cards.nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(cards.nth(0)).toHaveAttribute('data-selected', 'false');
  await expect(page.getByTestId('inbox-title')).toHaveText('2 questions from acme-app-front');
  await expect(page.getByTestId('question-card')).toBeVisible();
  await expect(page.getByTestId('permission-request')).toHaveCount(0);
  await expect(page.getByTestId('inbox-actions')).toHaveCount(0);
  await cards.nth(0).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inbox-title')).toHaveText('Bash · node -e "console.log(6*7)"');

  // Allow once: the item leaves, the remaining one is selected; the process got allow + the input unchanged.
  await actions.filter({ hasText: 'Allow once' }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('inbox-title')).toHaveText('2 questions from acme-app-front');
  await expect.poll(async () => (await controlResponses()).length).toBe(before + 1);
  const allow = (await controlResponses())[before];
  expect(allow?.response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'node -e "console.log(6*7)"', description: 'Run Node.js calculation' } });
  await expect.poll(() => sessionStatus(page, runner.id)).toBe('done');

  // "Open session →" goes to the session view.
  await page.getByTestId('inbox-open-session').click();
  await expect(page).toHaveURL(`${server.baseUrl}/sessions/${asker.id}`);
  await expect(page.getByTestId('view-session')).toHaveAttribute('data-session-id', asker.id);
  await page.getByTestId('nav-inbox').click();
  await expect(cards).toHaveCount(1);

  // Answer the last one → Inbox zero.
  const questions = page.getByTestId('question');
  await questions.nth(0).getByTestId('question-option').filter({ hasText: 'Blue' }).click();
  await questions.nth(1).getByTestId('question-option').filter({ hasText: 'Large' }).click();
  await page.getByTestId('question-send').click();
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await expect.poll(async () => (await controlResponses()).length).toBe(before + 2);
  expect((await controlResponses())[before + 1]?.response.response).toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { 'Which color should the button be?': 'Blue', 'Which size should it be?': 'Large' } },
  });
  await expect.poll(() => sessionStatus(page, asker.id)).toBe('done');
});
