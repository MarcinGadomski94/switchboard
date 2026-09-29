import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { SessionDetail } from '../../src/core/api.ts';
import { MODEL_APPLIES_AT_START } from '../../src/web/modals/new-session.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D42 on the real path (D13, no demo seed): `node src/server/main.ts` with
 * fake-claude as the CLI (its `initialize` lists the recorded models,
 * `FAKE_CLAUDE_LOG` records each spawn's argv). The New-session form's Model row
 * offers the CLI's aliases until a process has reported its models, then that
 * list with the chosen model's effort levels; a start with a chosen model and
 * effort spawns with `--model` / `--effort`; the form opens again on that
 * choice, and on the choice made later in a running session's header picker.
 */

let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-model-at-start'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('model-at-start', { env: { FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

async function detail(page: Page, id: string): Promise<SessionDetail> {
  return page.evaluate(async (sessionId) => (await (await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)).json()) as SessionDetail, id);
}

/** The argv of every fake-claude session process (they carry `--name`), in spawn order. */
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

async function openForm(page: Page) {
  await page.getByTestId('new-session').click();
  const modal = page.getByTestId('modal-new-session');
  await expect(modal).toBeVisible();
  const button = modal.getByTestId('ns-model-button');
  await expect(button).toBeEnabled();
  return { modal, button };
}

test('the Model row: aliases first, then the reported list; a start with a choice spawns with it; the form starts on the last choice, also one made in a header', async ({ page }) => {
  await page.goto(`${world.baseUrl}/`);

  // No claude process has reported its models yet: the CLI's aliases, no effort levels, on the CLI default.
  let { modal, button } = await openForm(page);
  await expect(button).toHaveText('Default▾');
  await expect(modal.locator('[data-testid="ns-summary-line"]').filter({ hasText: /^model / })).toHaveText('model     Default');
  await button.click();
  const aliases = await modal.getByTestId('model-option').evaluateAll((els) => els.map((el) => el.getAttribute('data-value')));
  expect(aliases).toEqual(['default', 'opus', 'sonnet', 'haiku']);
  await expect(modal.locator('[data-testid="model-option"][data-value="default"]')).toHaveAttribute('aria-checked', 'true');
  await expect(modal.getByTestId('effort-list')).toHaveCount(0);
  await expect(modal.getByTestId('model-note')).toHaveText(MODEL_APPLIES_AT_START);
  // Esc closes the popover only; the second one the form.
  await page.keyboard.press('Escape');
  await expect(modal.getByTestId('model-popover')).toHaveCount(0);
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // A session started without a choice reports the models (its first spawn has neither flag).
  const { id: firstId } = await world.startSession(page, 'reporter', 'Reply with just OK.');
  await expect.poll(async () => ((await detail(page, firstId)).model?.available ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect([flag((await sessionArgv(log))[0] ?? [], '--model'), flag((await sessionArgv(log))[0] ?? [], '--effort')]).toEqual([null, null]);

  // The form now offers the reported list; pick Opus 5.5 · high and start.
  ({ modal, button } = await openForm(page));
  await expect(button).toHaveText('Default▾');
  await button.click();
  await expect(modal.getByTestId('model-option')).toHaveCount(11);
  await modal.locator('[data-testid="model-option"][data-value="opus"]').click();
  await expect(modal.getByTestId('effort-option')).toHaveText(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
  await modal.locator('[data-testid="effort-option"][data-value="high"]').click();
  await expect(button).toHaveText('Opus 5.5 · high▾');
  // Sonnet 4.6 has no xhigh, Haiku no levels at all.
  await modal.locator('[data-testid="model-option"][data-value="claude-sonnet-4-6"]').click();
  await expect(modal.getByTestId('effort-option')).toHaveText(['Default', 'low', 'medium', 'high', 'max']);
  await modal.locator('[data-testid="model-option"][data-value="haiku"]').click();
  await expect(modal.getByTestId('effort-list')).toHaveCount(0);
  await modal.locator('[data-testid="model-option"][data-value="opus"]').click();
  await modal.locator('[data-testid="effort-option"][data-value="high"]').click();
  await page.keyboard.press('Escape');
  await expect(modal.locator('[data-testid="ns-summary-line"]').filter({ hasText: /^model / })).toHaveText('model     Opus 5.5 · high');
  await modal.getByTestId('ns-name').fill('model-at-start');
  await modal.getByTestId('ns-task').fill('Reply with just OK.');
  await modal.getByTestId('ns-switch-worktrees').click();
  await modal.getByTestId('ns-start').click();
  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/[^/]+/);
  const id = new URL(page.url()).pathname.split('/')[2] ?? '';
  await expect.poll(async () => (await sessionArgv(log)).length, { timeout: 15_000 }).toBe(2);
  const started = (await sessionArgv(log))[1] ?? [];
  expect([flag(started, '--model'), flag(started, '--effort')]).toEqual(['opus', 'high']);
  expect((await detail(page, id)).model).toMatchObject({ current: 'opus', effort: 'high' });

  // The form opens again on that choice.
  ({ modal, button } = await openForm(page));
  await expect(button).toHaveText('Opus 5.5 · high▾');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // A change in the running session's header is the last choice from then on.
  await openWithHub(page, `${world.baseUrl}/sessions/${id}`);
  await expect.poll(async () => ((await detail(page, id)).model?.available ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const header = page.getByTestId('session-model-button');
  await expect(header).toHaveText('Opus 5.5 · high▾');
  await header.click();
  await page.locator('[data-testid="session-model"] [data-testid="model-option"][data-value="claude-sonnet-4-6"]').click();
  await expect(header).toHaveText('Sonnet 4.6 · high▾');
  await page.keyboard.press('Escape');
  ({ modal, button } = await openForm(page));
  await expect(button).toHaveText('Sonnet 4.6 · high▾');
  await expect(modal.locator('[data-testid="ns-summary-line"]').filter({ hasText: /^model / })).toHaveText('model     Sonnet 4.6 · high');
  await page.keyboard.press('Escape');
});
