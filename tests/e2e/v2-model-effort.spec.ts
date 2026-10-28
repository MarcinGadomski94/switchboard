import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { stubToolProbes } from './probes.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * Fixes after 2.0 · **Model and Effort in v2** (`docs/v2.md` → *Model and effort*)
 * on the real path: a server with fake claude (its `initialize` lists the
 * recorded 11 models; `FAKE_CLAUDE_LOG` records each spawn's argv). + New offers
 * the CLI's own models and the chosen model's own effort levels; a start spawns
 * with `--model` / `--effort`; the agent's ⓘ line names them and How it works
 * changes them; the phone's full-screen sheet has the same pickers.
 */

let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-v2-model-effort'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('e2e-v2-model-effort', { env: { ...V2_SERVER_ENV, FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

/** The argv of every fake-claude session process (they carry `--name`), in spawn order. */
async function sessionArgv(): Promise<string[][]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && entry.argv?.includes('--name'))
    .map((entry) => entry.argv ?? []);
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
}

const CLAUDE_MODELS = ['Default (the CLI’s)', 'Opus 5.5', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6'];

test('+ New: the CLI’s models and effort levels; the start spawns with them; the agent’s ⓘ names them and How it works changes them', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  // A first agent reports the CLI's models (started without a choice).
  const reporter = await world.startSession(page, 'reporter', 'Reply with just OK.');
  await expect.poll(async () => ((await detail(page, reporter.id)).model?.available ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);

  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await expect(sheet).toBeVisible();
  // No Smart / Fast, no Thinking depth.
  await expect(sheet.getByTestId('v2-new-speed')).toHaveCount(0);
  await expect(sheet.getByText('Thinking depth')).toHaveCount(0);
  const model = sheet.getByTestId('v2-new-model');
  await expect(model).toBeEnabled();
  await expect(model.locator('option')).toHaveText(CLAUDE_MODELS);
  await expect(model).toHaveValue('default');
  await expect(sheet.getByTestId('v2-new-effort').locator('option')).toHaveText(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Haiku has no effort levels: Effort gives way to a reason.
  await model.selectOption('haiku');
  await expect(sheet.getByTestId('v2-new-effort')).toHaveCount(0);
  await expect(sheet.getByTestId('v2-new-effort-none')).toHaveText('Effort: Haiku 4.5 has no effort levels.');
  // Sonnet 4.6 has no xhigh.
  await model.selectOption('claude-sonnet-4-6');
  await expect(sheet.getByTestId('v2-new-effort').locator('option')).toHaveText(['Default', 'low', 'medium', 'high', 'max']);
  await model.selectOption('opus');
  await sheet.getByTestId('v2-new-effort').selectOption('xhigh');

  await sheet.getByTestId('v2-new-message').fill('Reply with just OK.');
  await sheet.getByTestId('v2-new-go').click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
  await expect.poll(async () => (await sessionArgv()).length, { timeout: 15_000 }).toBe(2);
  const started = (await sessionArgv())[1] ?? [];
  expect([flag(started, '--model'), flag(started, '--effort')]).toEqual(['opus', 'xhigh']);
  await expect.poll(async () => (await detail(page, id)).model?.available?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await detail(page, id)).model).toMatchObject({ current: 'opus', effort: 'xhigh' });

  // The header's ⓘ names the model and effort by the CLI's words.
  await page.getByTestId('v2-agent-info').click();
  await expect(page.getByTestId('v2-agent-model-line')).toHaveText('Opus 5.5 · xhigh');
  await page.keyboard.press('Escape');

  // How it works: Model and Effort selects on the agent's own list.
  const how = page.getByTestId('v2-agent-side').getByTestId('v2-agent-group-how');
  await expect(how.locator('summary')).toContainText('Opus 5.5 · xhigh');
  const agentModel = how.getByTestId('v2-agent-model');
  await expect(agentModel).toHaveValue('opus');
  await expect(agentModel.locator('option')).toHaveText(CLAUDE_MODELS);
  await expect(how.getByTestId('v2-agent-effort')).toHaveValue('xhigh');
  // Sonnet 4.6 has no xhigh: the effort goes back to Default (classic's rule).
  await agentModel.selectOption('claude-sonnet-4-6');
  await expect(page.getByTestId('v2-toast').filter({ hasText: 'Sonnet 4.6 from the next reply.' })).toBeVisible();
  await expect.poll(async () => (await detail(page, id)).model, { timeout: 15_000 }).toMatchObject({ current: 'claude-sonnet-4-6', effort: null });
  await expect(how.getByTestId('v2-agent-effort')).toHaveValue('');
  await how.getByTestId('v2-agent-effort').selectOption('max');
  await expect.poll(async () => (await detail(page, id)).model, { timeout: 15_000 }).toMatchObject({ current: 'claude-sonnet-4-6', effort: 'max' });
  await expect(how.locator('summary')).toContainText('Sonnet 4.6 · max');
  await page.getByTestId('v2-agent-info').click();
  await expect(page.getByTestId('v2-agent-model-line')).toHaveText('Sonnet 4.6 · max');
});

test('phone (390 × 844): + New’s Model and Effort fit the screen and start with the choice', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWithHub(page, `${world.baseUrl}/`);
  await page.getByTestId('v2-new').click();
  const sheet = page.getByTestId('v2-new-sheet');
  await expect(sheet).toBeVisible();
  const model = sheet.getByTestId('v2-new-model');
  await model.scrollIntoViewIfNeeded();
  await expect(model).toBeEnabled();
  await model.selectOption('sonnet');
  const effort = sheet.getByTestId('v2-new-effort');
  await effort.selectOption('low');
  for (const select of [model, effort]) {
    const box = await select.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
  }
  // Stacked: Effort under Model.
  expect((await effort.boundingBox())?.y ?? 0).toBeGreaterThan((await model.boundingBox())?.y ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  const before = (await sessionArgv()).length;
  await sheet.getByTestId('v2-new-message').fill('Reply with just OK.');
  await sheet.getByTestId('v2-new-go').click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(async () => (await sessionArgv()).length, { timeout: 15_000 }).toBe(before + 1);
  const started = (await sessionArgv())[before] ?? [];
  expect([flag(started, '--model'), flag(started, '--effort')]).toEqual(['sonnet', 'low']);
});
