import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';

/**
 * D89 on the real path (D13, fake-claude; `docs/artifacts.md` → *Artifacts
 * page*): the global Artifacts page lists the artifacts saved on purpose in every
 * session, newest first (kind · title · session · versions · saved by · age).
 * The kind filters and the session filter ask the service; search matches the
 * title and the session; a row opens the session's Artifacts tab on that
 * artifact; a save shows up live, and the sidebar's count follows.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  world = await startQuestionWorld('artifacts-page');
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** What the agent's `artifact_save` does (the session's agent token). */
async function agentSaves(sessionId: string, fields: Record<string, unknown>): Promise<string> {
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
        res.on('end', () => (res.statusCode === 201 ? resolve((JSON.parse(Buffer.concat(chunks).toString()) as { artifact: { id: string } }).artifact.id) : reject(new Error(`${res.statusCode}`))));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId('view-artifacts')).toHaveAttribute('aria-busy', 'false');
}

test('a fresh install: the columns, the kind filters and the empty note', async ({ page }) => {
  await page.goto(`${world.baseUrl}/artifacts`);
  const view = page.getByTestId('view-artifacts');
  await expect(view.locator('.sb-art-title')).toHaveText('Artifacts');
  await expect(page.getByTestId('artifacts-count')).toHaveText('0 of 0');
  await expect(page.getByTestId('artifacts-filter')).toHaveText(['All', 'Docs', 'Code', 'HTML', 'Diagrams', 'Images', 'Tables']);
  await expect(view.locator('.sb-art-cols > span')).toHaveText(['Kind', 'Title', 'Session', 'Versions', 'Saved by', 'Age']);
  await expect(page.getByTestId('artifacts-empty')).toContainText('No artifacts yet.');
  await expect(page.getByTestId('nav-artifacts')).toHaveAttribute('aria-current', 'page');
});

test('every session\'s artifacts; kind, session and text filters; a row opens its session\'s tab on it; live', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/artifacts`);
  const pay = await world.startSession(page, 'pay-flow', 'Hi.');
  const qa = await world.startSession(page, 'qa-pay', 'Hi.');
  ids['plan'] = await agentSaves(pay.id, { title: 'Pay plan', kind: 'markdown', content: '# Pay plan\n' });
  ids['diagram'] = await agentSaves(pay.id, { title: 'Pay flow', kind: 'mermaid', content: 'graph TD; A-->B' });
  ids['matrix'] = await agentSaves(qa.id, { title: 'Coverage', kind: 'csv', content: 'a,b\n1,2\n' });
  await expect(page.getByTestId('artifacts-count')).toHaveText('3 of 3');
  await expect(page.locator('.sb-art-name')).toHaveText(['Coverage', 'Pay flow', 'Pay plan']);
  await expect(page.locator('.sb-art-type')).toHaveText(['TABLE', 'DIAGRAM', 'DOC']);
  await expect(page.locator('.sb-art-location')).toHaveText(['qa-pay', 'pay-flow', 'pay-flow']);
  await expect(page.locator('.sb-art-meta')).toHaveText(['agent', 'agent', 'agent']);
  await expect(page.getByTestId('nav-artifacts')).toContainText('3');

  const kinds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/artifacts' && url.searchParams.has('kind')) kinds.push(url.searchParams.get('kind') ?? '');
  });
  await page.getByTestId('artifacts-filter').filter({ hasText: /^Diagrams$/ }).click();
  await settled(page);
  await expect(page.getByTestId('artifacts-count')).toHaveText('1 of 3');
  await expect(page.locator('.sb-art-name')).toHaveText(['Pay flow']);
  expect(kinds).toContain('mermaid,svg');
  await page.getByTestId('artifacts-filter').filter({ hasText: /^All$/ }).click();
  await page.getByTestId('artifacts-session').selectOption({ label: 'qa-pay' });
  await settled(page);
  await expect(page.locator('.sb-art-name')).toHaveText(['Coverage']);
  await page.getByTestId('artifacts-session').selectOption('');
  await page.getByTestId('artifacts-search').fill('PAY-FLOW');
  await settled(page);
  await expect(page.locator('.sb-art-name')).toHaveText(['Pay flow', 'Pay plan']);
  await page.getByTestId('artifacts-search').fill('');
  await settled(page);

  // Live: a new version moves the row to the top.
  await agentSaves(pay.id, { id: ids['plan'], title: 'Pay plan', kind: 'markdown', content: '# Pay plan v2\n' });
  await expect(page.locator('.sb-art-name').first()).toHaveText('Pay plan');
  await expect(page.locator('.sb-art-session').first()).toHaveText('v2');

  await page.locator('.sb-art-row').filter({ hasText: 'Coverage' }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${qa.id}/artifacts/${ids['matrix']}$`));
  await expect(page.getByTestId('artifact-viewer')).toHaveAttribute('data-artifact-id', ids['matrix']!);
  await expect(page.getByTestId('artifact-table')).toBeVisible();
});
