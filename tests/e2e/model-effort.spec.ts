import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { MODELS_UNKNOWN_REASON, MODEL_APPLIES_LATER, MODEL_APPLIES_LIVE } from '../../src/web/views/session/session-header.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D31 model and effort on the real path (D13, no demo seed): `node src/server/main.ts`
 * with fake-claude as the CLI (its `initialize` lists the recorded models; it takes
 * `set_model` and `apply_flag_settings {effortLevel}`; `FAKE_CLAUDE_LOG` records each
 * spawn's argv). In a running session the header's picker (first header action, in
 * their style) opens the model and effort pickers; a pick changes the running
 * process and shows a chat step line; the effort pills are the chosen model's own
 * levels and hide for a model without any; the header keeps every action left of the
 * right panel with a long temp root path; pause / resume spawns with `--model` /
 * `--effort`. A CLI refusal shows its text; a CLI that lists no models leaves the
 * picker disabled with the reason.
 */

let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-model-effort'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('model-effort', { env: { FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

/** The argv of every fake-claude session process (they carry `--name`; the usage meter's own `claude -p` does not), in spawn order. */
async function sessionArgv(file: string): Promise<string[][]> {
  const text = await readFile(file, 'utf8').catch(() => '');
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

/** Starts a session with one finished turn (a transcript to resume), waits until its process listed its models, and opens it with the hub. */
async function startSession(page: Page, name: string, w: QuestionWorld, models = true): Promise<string> {
  await page.goto(`${w.baseUrl}/`);
  const { id } = await w.startSession(page, name, 'Reply with just OK.');
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  if (models) await expect.poll(async () => ((await detail(page, id)).model?.available ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
  else await expect.poll(async () => (await detail(page, id)).remote?.available, { timeout: 15_000 }).toBe(true);
  await openWithHub(page, `${w.baseUrl}/sessions/${id}`);
  return id;
}

test('pick a model and an effort in a running session: step lines, the chosen model’s levels only; pause/resume passes --model / --effort', async ({ page }) => {
  const id = await startSession(page, 'model-e2e', world);
  const button = page.getByTestId('session-model-button');
  // The CLI's defaults at first; the first header action, in the header actions' style.
  await expect(button).toHaveText('Default▾');
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('title', `Model and effort. ${MODEL_APPLIES_LIVE}`);
  const actions = await page.locator('.sb-sv-actions > *').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  // D62 P5: the CLI switcher comes first.
  expect(actions).toEqual(['session-cli', 'session-model', 'session-close', 'session-remote', 'session-pause', 'session-handoff']);
  await expect(button).toHaveCSS('font-size', '12px');
  await expect(button).toHaveCSS('border-top-left-radius', '6px');
  const pause = page.getByTestId('session-pause');
  expect(await button.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(await pause.evaluate((el) => getComputedStyle(el).borderTopColor));
  expect((await button.boundingBox())?.height).toBe((await pause.boundingBox())?.height);

  // The popover: the models the process reported, the default one chosen; the effort pills of that model.
  await button.click();
  const popover = page.getByTestId('model-popover');
  await expect(popover).toBeVisible();
  const models = page.getByTestId('model-option');
  await expect(models).toHaveCount(11);
  await expect(models.first()).toHaveAttribute('aria-checked', 'true');
  await expect(models.first()).toContainText('Default (recommended)');
  const efforts = page.getByTestId('effort-option');
  await expect(efforts).toHaveText(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
  await expect(page.getByTestId('model-note')).toHaveText(MODEL_APPLIES_LIVE);

  // Another model, then an effort: each goes to the running process and shows as a step line.
  await page.locator('[data-testid="model-option"][data-value="opus"]').click();
  await expect(page.getByTestId('chat-step').filter({ hasText: 'Model: Opus 5.5 · effort: default' })).toHaveCount(1);
  await expect(button).toHaveText('Opus 5.5▾');
  await page.locator('[data-testid="effort-option"][data-value="high"]').click();
  await expect(page.getByTestId('chat-step').filter({ hasText: 'Model: Opus 5.5 · effort: high' })).toHaveCount(1);
  await expect(button).toHaveText('Opus 5.5 · high▾');
  await expect(page.locator('[data-testid="effort-option"][data-value="high"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="model-option"][data-value="opus"]')).toHaveAttribute('aria-checked', 'true');
  expect((await detail(page, id)).model).toMatchObject({ current: 'opus', effort: 'high' });

  // Sonnet 4.6 has no xhigh: its pills say so (high is kept); Haiku has no levels: the effort picker hides.
  await page.locator('[data-testid="model-option"][data-value="claude-sonnet-4-6"]').click();
  await expect(button).toHaveText('Sonnet 4.6 · high▾');
  await expect(efforts).toHaveText(['Default', 'low', 'medium', 'high', 'max']);
  await page.locator('[data-testid="model-option"][data-value="haiku"]').click();
  await expect(button).toHaveText('Haiku 4.5▾');
  await expect(page.getByTestId('effort-list')).toHaveCount(0);
  await expect(page.getByTestId('chat-step').filter({ hasText: 'Model: Haiku 4.5 · effort: default' })).toHaveCount(1);
  // Back to Opus 5.5 · xhigh (the widest label here).
  await page.locator('[data-testid="model-option"][data-value="opus"]').click();
  await page.locator('[data-testid="effort-option"][data-value="xhigh"]').click();
  await expect(button).toHaveText('Opus 5.5 · xhigh▾');

  // Esc closes the popover.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  // With Remote on as well (the widest header) and this long temp path, every header action stays left of the right panel.
  await page.getByTestId('session-remote-toggle').click();
  await expect(page.getByTestId('session-remote-link')).toBeVisible();
  await page.keyboard.press('Escape');
  const lastAction = await page.getByTestId('session-handoff').boundingBox();
  const panel = await page.getByTestId('session-right-panel').boundingBox();
  expect((lastAction?.x ?? 0) + (lastAction?.width ?? 0)).toBeLessThanOrEqual(panel?.x ?? 0);
  const top = await page.locator('.sb-sv-top').boundingBox();
  const picker = await button.boundingBox();
  expect(picker?.y ?? 0).toBeGreaterThanOrEqual(top?.y ?? 0);
  expect((picker?.y ?? 0) + (picker?.height ?? 0)).toBeLessThanOrEqual((top?.y ?? 0) + (top?.height ?? 0));

  // Pause: the choice stays and applies at the next start (the picker still works: the models are known).
  const spawnsBefore = (await sessionArgv(log)).length;
  await pause.click();
  await expect.poll(async () => (await detail(page, id)).status).toBe('paused');
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Opus 5.5 · xhigh▾');
  await expect(button).toHaveAttribute('title', `Model and effort. ${MODEL_APPLIES_LATER}`);
  // Resume: the new process gets --model / --effort from the stored choice.
  await page.getByTestId('session-pause').click();
  await expect.poll(async () => (await sessionArgv(log)).length, { timeout: 15_000 }).toBe(spawnsBefore + 1);
  const resumed = (await sessionArgv(log)).at(-1) ?? [];
  expect(resumed).toContain('--resume');
  expect([flag(resumed, '--model'), flag(resumed, '--effort')]).toEqual(['opus', 'xhigh']);
  await expect.poll(async () => (await detail(page, id)).status, { timeout: 15_000 }).toBe('done');
  await expect(button).toHaveText('Opus 5.5 · xhigh▾');
  // The first spawn had no choice yet: neither flag.
  const first = (await sessionArgv(log))[0] ?? [];
  expect([flag(first, '--model'), flag(first, '--effort')]).toEqual([null, null]);
});

test.describe('the CLI refuses the change', () => {
  let refusing: QuestionWorld;
  const text = 'Model switch blocked by a PreModelSwitch hook: not during release week';

  test.beforeAll(async () => {
    refusing = await startQuestionWorld('model-refused', { env: { FAKE_CLAUDE_SET_MODEL_ERROR: text } });
  });

  test.afterAll(async () => {
    await refusing?.stop();
  });

  test('its text shows in the popover and a ✕ step line; the choice stays', async ({ page }) => {
    const id = await startSession(page, 'model-refused-e2e', refusing);
    const button = page.getByTestId('session-model-button');
    await button.click();
    await page.locator('[data-testid="model-option"][data-value="opus"]').click();
    await expect(page.getByTestId('model-error')).toHaveText(text);
    await expect(page.getByTestId('chat-step').filter({ hasText: `Could not change the model: ${text}` })).toHaveCount(1);
    await expect(button).toHaveText('Default▾');
    await expect(page.locator('[data-testid="model-option"][data-value="default"]')).toHaveAttribute('aria-checked', 'true');
    expect((await detail(page, id)).model).toMatchObject({ current: null, effort: null });
  });
});

test.describe('the CLI lists no models', () => {
  let unlisted: QuestionWorld;

  test.beforeAll(async () => {
    unlisted = await startQuestionWorld('model-unknown', { env: { FAKE_CLAUDE_MODELS: 'none' } });
  });

  test.afterAll(async () => {
    await unlisted?.stop();
  });

  test('the picker is disabled and its tooltip says why', async ({ page }) => {
    const id = await startSession(page, 'model-unknown-e2e', unlisted, false);
    const button = page.getByTestId('session-model-button');
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Default▾');
    await expect(button).toHaveAttribute('title', MODELS_UNKNOWN_REASON);
    await expect(button).toHaveAttribute('data-reason', MODELS_UNKNOWN_REASON);
    await expect(button).toHaveCSS('opacity', '0.45');
    expect((await detail(page, id)).model).toEqual({ current: null, effort: null, available: null });
  });
});
