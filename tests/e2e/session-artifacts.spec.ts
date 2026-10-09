import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import type { ArtifactSaveResult } from '../../src/core/api.ts';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';

/**
 * D89 on the real path (D13, fake-claude; `docs/artifacts.md`): the session's
 * Artifacts tab lists only artifacts saved on purpose. The agent saves through
 * the route its `switchboard` MCP tool `artifact_save` calls (with the session's
 * own token): a Markdown report rendered with the chat's renderer, a second
 * version (the version picker, Compare), an HTML mockup in a sandboxed frame whose
 * scripts run but cannot read the app's cookie or reach its API, a CSV table, a
 * file copied from the session's folder. Live over `/hub`; Delete asks first.
 * The developer saves an agent's message (⋯ → Save as artifact) and a code block.
 * A written file no longer becomes an artifact.
 */
let world: QuestionWorld;

test.beforeAll(async () => {
  world = await startQuestionWorld('artifacts-tab');
});

test.afterAll(async () => {
  await world?.stop();
});

/** What the agent's `artifact_save` does: `POST /agent/v1/artifacts` with the session's agent token. */
async function agentSaves(sessionId: string, fields: Record<string, unknown>): Promise<ArtifactSaveResult> {
  const secret = (await readFile(path.join(world.dataDir, 'sb_token'), 'utf8')).trim();
  const token = createHmac('sha256', secret).update(`switchboard-agent-todos:${sessionId}`).digest('base64url');
  const url = new URL(world.baseUrl);
  const body = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(url.port),
        path: '/agent/v1/artifacts',
        method: 'POST',
        headers: { host: url.host, authorization: `Bearer ${token}`, 'x-switchboard-session': sessionId, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 201) reject(new Error(`artifact_save answered ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          else resolve(JSON.parse(Buffer.concat(chunks).toString()) as ArtifactSaveResult);
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function waitDone(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate(async (sessionId) => ((await (await fetch(`/api/sessions/${sessionId}`)).json()) as { status: string }).status, id), { timeout: 20_000 })
    .toBe('done');
}

test('the agent saves artifacts; the tab lists them live and shows each kind', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'report-run', 'Write the notes. [fake:write notes.md]');
  await waitDone(page, id);
  await page.goto(`${world.baseUrl}/sessions/${id}/artifacts`);
  // D89: the written notes.md made no artifact.
  await expect(page.getByTestId('session-artifacts')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('artifacts-empty')).toContainText('No artifacts yet');
  await expect(page.getByTestId('session-tab-artifacts')).toHaveText('Artifacts · 0');

  // Live: the agent saves while the tab is open.
  const report = await agentSaves(id, { title: 'Weekly report', kind: 'markdown', content: '# Weekly report\n\n- **Green**: all builds\n- Red: none\n' });
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  await expect(page.getByTestId('artifact-name')).toHaveText(['Weekly report']);
  await expect(page.getByTestId('artifact-tag')).toHaveText(['DOC']);
  await expect(page.getByTestId('artifact-meta')).toHaveText([/^v1 · \d+ B · agent$/]);
  await expect(page.getByTestId('session-tab-artifacts')).toHaveText('Artifacts · 1');

  await page.getByTestId('artifact-row').first().click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/artifacts/${report.artifact.id}$`));
  const viewer = page.getByTestId('artifact-viewer');
  await expect(viewer.getByTestId('artifact-markdown').locator('h1')).toHaveText('Weekly report');
  await expect(viewer.getByTestId('artifact-markdown').locator('strong')).toHaveText('Green');
  await viewer.getByTestId('artifact-mode-source').click();
  await expect(viewer.getByTestId('artifact-source')).toHaveText('# Weekly report\n\n- **Green**: all builds\n- Red: none\n');

  // A new version: the viewer follows the newest; Compare shows the change; the picker goes back.
  await agentSaves(id, { id: report.artifact.id, title: 'Weekly report', kind: 'markdown', content: '# Weekly report\n\n- **Green**: all builds\n- Red: one flaky test\n' });
  await expect(page.getByTestId('artifact-meta')).toHaveText([/^v2 · /]);
  await expect(viewer).toHaveAttribute('data-version', '2');
  await viewer.getByTestId('artifact-mode-diff').click();
  await expect(viewer.getByTestId('artifact-diff-summary')).toHaveText('v1 → v2: +1 −1');
  await expect(viewer.locator('.sb-artv-diff-line[data-op="del"]')).toHaveText(['- - Red: none']);
  await expect(viewer.locator('.sb-artv-diff-line[data-op="add"]')).toHaveText(['+ - Red: one flaky test']);
  await viewer.getByTestId('artifact-mode-rendered').click();
  await viewer.getByTestId('artifact-version').selectOption('1');
  await expect(viewer).toHaveAttribute('data-version', '1');
  await expect(viewer.getByTestId('artifact-markdown')).toContainText('Red: none');
  await expect(viewer.getByTestId('artifact-download')).toHaveAttribute('href', `/api/sessions/${id}/artifacts/${report.artifact.id}/versions/1/raw?download`);
});

test('an HTML artifact runs sandboxed: its script runs, the app\'s cookie and API stay out of reach', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'mockup-run', 'Hi.');
  await waitDone(page, id);
  const html = await agentSaves(id, {
    title: 'Mockup',
    kind: 'html',
    content: `<!doctype html><body><p id="out">waiting</p><script>
      let cookie; try { cookie = document.cookie; } catch (e) { cookie = 'blocked: ' + e.name; }
      document.getElementById('out').textContent = 'ran · ' + cookie + ' · ' + self.origin;
      fetch('/api/sessions').then(() => { document.body.dataset.api = 'reached'; }, () => { document.body.dataset.api = 'refused'; });
    </script></body>`,
  });
  await page.goto(`${world.baseUrl}/sessions/${id}/artifacts/${html.artifact.id}`);
  const frame = page.getByTestId('artifact-frame');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const inner = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(inner.locator('#out')).toHaveText(/^ran · blocked: SecurityError · null$/);
  await expect(inner.locator('body')).toHaveAttribute('data-api', 'refused');
  // Served under the sandbox CSP, also when opened on its own.
  const raw = await page.request.get(`${world.baseUrl}/api/sessions/${id}/artifacts/${html.artifact.id}/versions/1/raw`);
  expect(raw.headers()['content-security-policy']).toMatch(/^sandbox allow-scripts;/);
});

test('a Mermaid diagram is drawn inside its sandboxed frame; one Mermaid cannot parse shows its source', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'mermaid-run', 'Hi.');
  await waitDone(page, id);
  const good = await agentSaves(id, { title: 'Flow', kind: 'mermaid', content: 'flowchart LR\n  A[Lobby] --> B{Partner?}\n  B -- yes --> C[Talk]\n' });
  const bad = await agentSaves(id, { title: 'Broken', kind: 'mermaid', content: 'flowchart LR\n  A --> --> {{\n' });
  await page.goto(`${world.baseUrl}/sessions/${id}/artifacts/${good.artifact.id}`);
  const frame = page.getByTestId('artifact-mermaid');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const inner = page.frameLocator('[data-testid="artifact-mermaid"]');
  await expect(inner.locator('body')).toHaveAttribute('data-state', 'drawn', { timeout: 15_000 });
  await expect(inner.locator('#d svg')).toBeVisible();
  await expect(inner.locator('#d svg')).toContainText('Lobby');
  await expect(page.getByTestId('artifact-download')).toHaveAttribute('href', `/api/sessions/${id}/artifacts/${good.artifact.id}/versions/1/raw?download`);
  await page.getByTestId('artifact-mode-source').click();
  await expect(page.getByTestId('artifact-source')).toContainText('A[Lobby] --> B{Partner?}');

  await page.goto(`${world.baseUrl}/sessions/${id}/artifacts/${bad.artifact.id}`);
  const broken = page.frameLocator('[data-testid="artifact-mermaid"]');
  await expect(broken.locator('body')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  await expect(broken.locator('#src')).toBeVisible();
  await expect(broken.locator('#src')).toContainText('A --> --> {{');
  await expect(broken.locator('#err')).toContainText('could not be drawn');
});

test('CSV as a table, a file copied from the session\'s folder, Full screen and Delete', async ({ page }) => {
  await writeFile(path.join(world.workspace, 'plan.md'), '# Plan from a file\n');
  await openWithHub(page, `${world.baseUrl}/`);
  const { id } = await world.startSession(page, 'table-run', 'Hi.');
  await waitDone(page, id);
  const csv = await agentSaves(id, { title: 'Coverage', kind: 'csv', content: 'Requirement,State\n"FT-1, lobby",covered\nFT-2,open\n' });
  const file = await agentSaves(id, { title: 'Plan', kind: 'markdown', path: 'plan.md' });
  await page.goto(`${world.baseUrl}/sessions/${id}/artifacts/${csv.artifact.id}`);
  const table = page.getByTestId('artifact-table');
  await expect(table.locator('th')).toHaveText(['Requirement', 'State']);
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText(['FT-1, lobby', 'covered']);
  await page.getByTestId('artifact-fullscreen').click();
  await expect(page.getByTestId('artifact-fullscreen-view').getByTestId('artifact-table')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('artifact-fullscreen-view')).toHaveCount(0);

  await page.getByTestId('artifact-row').filter({ hasText: 'Plan' }).click();
  await expect(page).toHaveURL(new RegExp(`/artifacts/${file.artifact.id}$`));
  await expect(page.getByTestId('artifact-markdown').locator('h1')).toHaveText('Plan from a file');
  await page.getByTestId('artifact-delete').click();
  await expect(page.getByTestId('artifact-delete-confirm')).toContainText('Delete “Plan” and all its versions?');
  await page.getByTestId('artifact-delete-cancel').click();
  await expect(page.getByTestId('artifact-row')).toHaveCount(2);
  await page.getByTestId('artifact-delete').click();
  await page.getByTestId('artifact-delete-yes').click();
  await expect(page.getByTestId('artifact-row')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/artifacts$`));
});

test('the developer saves an agent message (⋯) and a code block from the chat', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/`);
  const reply = '## Release plan\n\nShip it on Friday.\n\n```ts\nexport const day = "Friday";\n```\n';
  const { id } = await world.startSession(page, 'chat-save', `Plan. [fake:say ${JSON.stringify(reply)}]`);
  await waitDone(page, id);
  await page.goto(`${world.baseUrl}/sessions/${id}`);
  const message = page.getByTestId('chat-message').filter({ has: page.locator('h2', { hasText: 'Release plan' }) });
  // The ⋯ and the code block's button stay out of the message's text.
  await expect(message.getByTestId('chat-text')).not.toContainText('Save as artifact');
  await message.hover();
  await message.getByTestId('chat-message-menu').click();
  await page.getByTestId('chat-save-artifact').click();
  const dialog = page.getByTestId('save-artifact');
  await expect(dialog.getByTestId('save-artifact-title')).toHaveValue('Release plan');
  await expect(dialog.getByTestId('save-artifact-kind')).toHaveValue('markdown');
  await dialog.getByTestId('save-artifact-title').fill('Friday release plan');
  await dialog.getByTestId('save-artifact-save').click();
  await expect(dialog.getByTestId('save-artifact-done')).toHaveText('Saved “Friday release plan” to this session\'s Artifacts.');
  await dialog.getByTestId('save-artifact-close').click();

  await message.locator('.sb-md-code').hover();
  await message.getByTestId('chat-code-save').click();
  await expect(dialog.getByTestId('save-artifact-kind')).toHaveValue('code');
  await expect(dialog.getByTestId('save-artifact-language')).toHaveValue('ts');
  await expect(dialog.getByTestId('save-artifact-content')).toHaveValue('export const day = "Friday";');
  await dialog.getByTestId('save-artifact-save').click();
  await dialog.getByTestId('save-artifact-open').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${id}/artifacts/[a-f0-9]{10}$`));
  await expect(page.getByTestId('artifact-tag')).toHaveText(['CODE · ts', 'DOC']);
  await expect(page.getByTestId('artifact-meta')).toHaveText([/ · you$/, / · you$/]);
  await expect(page.getByTestId('artifact-viewer').getByTestId('artifact-markdown').locator('code')).toContainText('export const day');
});
