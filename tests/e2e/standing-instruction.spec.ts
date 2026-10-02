import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { DEFAULT_STANDING_INSTRUCTION } from '../../src/core/settings.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D64 on the real path (D13): Settings → Sessions & worktrees → "Standing
 * instruction for agents" on by default; the default text reaches fake-claude as
 * `--append-system-prompt`; an edited text applies to the next session; Reset to
 * default and the toggle work; off passes nothing.
 */
let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-standing'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('standing-instruction', { env: { FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

/** The `--append-system-prompt` value of every fake-claude session process (they carry `--name`), in spawn order; `null` = no flag. */
async function standingPerSpawn(): Promise<Array<string | null>> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && entry.argv?.includes('--name'))
    .map((entry) => {
      const at = entry.argv?.indexOf('--append-system-prompt') ?? -1;
      return at === -1 ? null : (entry.argv?.[at + 1] ?? null);
    });
}

test('edit the instruction in Settings, start a session: fake-claude receives it; Reset and the toggle', async ({ page }) => {
  await page.goto(`${world.baseUrl}/settings/sessions`);
  const row = page.locator('[data-row="standing-instruction"]');
  const text = row.getByTestId('standing-instruction-text');
  const toggle = row.getByRole('switch');
  await expect(row).toContainText('started or resumed afterwards');
  await expect(toggle).toHaveText('on');
  await expect(text).toHaveValue(DEFAULT_STANDING_INSTRUCTION);
  await expect(row.getByTestId('standing-instruction-save')).toBeDisabled();
  await expect(row.getByTestId('standing-instruction-reset')).toBeDisabled();

  // On by default: the default text goes to a new session.
  await world.startSession(page, 'first', 'Reply with just OK.');
  await expect.poll(async () => (await standingPerSpawn()).length, { timeout: 15_000 }).toBe(1);
  expect(await standingPerSpawn()).toEqual([DEFAULT_STANDING_INSTRUCTION]);

  // Edit and Save: the next session gets the new text.
  await page.goto(`${world.baseUrl}/settings/sessions`);
  await text.fill('Write out any table before asking about it.');
  await row.getByTestId('standing-instruction-save').click();
  await expect(row.getByTestId('standing-instruction-save')).toBeDisabled();
  await expect(row.getByTestId('standing-instruction-reset')).toBeEnabled();
  await world.startSession(page, 'second', 'Reply with just OK.');
  await expect.poll(async () => (await standingPerSpawn()).length, { timeout: 15_000 }).toBe(2);
  expect((await standingPerSpawn())[1]).toBe('Write out any table before asking about it.');

  // Off: no flag. The text is kept.
  await page.goto(`${world.baseUrl}/settings/sessions`);
  await toggle.click();
  await expect(toggle).toHaveText('off');
  await world.startSession(page, 'third', 'Reply with just OK.');
  await expect.poll(async () => (await standingPerSpawn()).length, { timeout: 15_000 }).toBe(3);
  expect((await standingPerSpawn())[2]).toBeNull();

  // Reset to default (and back on): the default text again.
  await page.goto(`${world.baseUrl}/settings/sessions`);
  await expect(text).toHaveValue('Write out any table before asking about it.');
  await row.getByTestId('standing-instruction-reset').click();
  await expect(text).toHaveValue(DEFAULT_STANDING_INSTRUCTION);
  await toggle.click();
  await expect(toggle).toHaveText('on');
  await world.startSession(page, 'fourth', 'Reply with just OK.');
  await expect.poll(async () => (await standingPerSpawn()).length, { timeout: 15_000 }).toBe(4);
  expect((await standingPerSpawn())[3]).toBe(DEFAULT_STANDING_INSTRUCTION);
});
