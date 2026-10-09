import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';
import { type QuestionWorld, startQuestionWorld } from './question-world.ts';

/**
 * D91 on the real path (D13): two sessions run on the old standing instruction;
 * Settings → Sessions & worktrees shows "2 open sessions use an older instruction",
 * Apply to open sessions restarts them (fake-claude gets `--resume` + the new
 * `--append-system-prompt`), the result line says so, and each chat shows the
 * "Standing instruction updated" divider. A session's ⋯ → Reload instruction does
 * the same for one.
 */
let tmp: string;
let log: string;
let world: QuestionWorld;

test.beforeAll(async () => {
  tmp = await realpath(await makeTempDir('e2e-apply-instruction'));
  log = path.join(tmp, 'fake.log');
  world = await startQuestionWorld('apply-instruction', { env: { FAKE_CLAUDE_LOG: log } });
});

test.afterAll(async () => {
  await world?.stop();
  if (tmp) await removeTempDir(tmp);
});

interface Spawn {
  readonly pid: number;
  readonly argv: string[];
}

/** fake-claude's session processes (they carry `--name`), in spawn order. */
async function spawns(): Promise<Spawn[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string; pid: number; argv?: string[] })
    .filter((entry) => entry.kind === 'argv' && entry.argv?.includes('--name'))
    .map((entry) => ({ pid: entry.pid, argv: entry.argv ?? [] }));
}

function instructionOf(spawn: Spawn | undefined): string | null {
  const at = spawn?.argv.indexOf('--append-system-prompt') ?? -1;
  return at === -1 ? null : (spawn?.argv[at + 1] ?? null);
}

test('Settings: the count, Apply to open sessions, the result line and the divider; ⋯ → Reload instruction', async ({ page }) => {
  await page.goto(`${world.baseUrl}/settings/sessions`);
  const row = page.locator('[data-row="standing-instruction"]');
  await row.getByTestId('standing-instruction-text').fill('Old rule.');
  await row.getByTestId('standing-instruction-save').click();
  await expect(row.getByTestId('standing-instruction-save')).toBeDisabled();

  const first = await world.startSession(page, 'first', 'Reply with just OK.');
  const second = await world.startSession(page, 'second', 'Reply with just OK.');
  await expect.poll(async () => (await spawns()).length, { timeout: 15_000 }).toBe(2);
  // Both turns end (idle, process kept).
  await expect
    .poll(async () => page.evaluate(async () => ((await (await fetch('/api/sessions')).json()) as Array<{ status: string }>).filter((s) => s.status === 'done' || s.status === 'idle').length), { timeout: 15_000 })
    .toBe(2);

  const apply = row.getByTestId('standing-apply-button');
  await expect(row.getByTestId('standing-apply-count')).toHaveText('Every open session uses this instruction');
  await expect(apply).toBeDisabled();

  // A new text: the two running sessions use an older one now.
  await row.getByTestId('standing-instruction-text').fill('New rule.');
  await row.getByTestId('standing-instruction-save').click();
  await expect(row.getByTestId('standing-apply-count')).toHaveText('2 open sessions use an older instruction', { timeout: 10_000 });
  await expect(apply).toBeEnabled();
  await page.screenshot({ path: path.join('test-results', 'apply-instruction-settings.png') });

  await apply.click();
  await expect(row.getByTestId('standing-apply-result')).toHaveText('Applied to 2 sessions (2 restarted)', { timeout: 30_000 });
  await expect(row.getByTestId('standing-apply-count')).toHaveText('Every open session uses this instruction', { timeout: 10_000 });
  await expect.poll(async () => (await spawns()).length, { timeout: 15_000 }).toBe(4);
  for (const spawn of (await spawns()).slice(2)) {
    expect(spawn.argv).toContain('--resume');
    expect(instructionOf(spawn)).toBe('New rule.');
  }

  // The chat's divider.
  await page.goto(`${world.baseUrl}/sessions/${first.id}`);
  await expect(page.getByTestId('chat-divider').last()).toHaveText('Standing instruction updated', { timeout: 10_000 });

  // One session at a time: ⋯ → Reload instruction (shown only while that session is on an older one).
  await page.goto(`${world.baseUrl}/settings/sessions`);
  await row.getByTestId('standing-instruction-text').fill('Third rule.');
  await row.getByTestId('standing-instruction-save').click();
  await expect(row.getByTestId('standing-apply-count')).toHaveText('2 open sessions use an older instruction', { timeout: 10_000 });
  const sidebarRow = page.locator(`a.sb-session[data-session-id="${second.id}"]`);
  await sidebarRow.hover();
  await sidebarRow.getByTestId('sidebar-session-menu').click();
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('sidebar-menu-reload-instruction').click();
  await expect(row.getByTestId('standing-apply-count')).toHaveText('1 open session uses an older instruction', { timeout: 15_000 });
  await expect.poll(async () => instructionOf((await spawns()).at(-1)), { timeout: 15_000 }).toBe('Third rule.');
});
