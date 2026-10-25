import { type Page, expect, test } from '@playwright/test';
import { type QuestionWorld, openWithHub, startQuestionWorld } from './question-world.ts';
import { stubToolProbes } from './probes.ts';
import { V2_SERVER_ENV } from './v2-world.ts';

/**
 * D131 · lane R · v2 Results on the real path (fake-claude, saved artifacts):
 * the grid / list, the type filters with counts, search within, the drawer
 * (preview by kind, versions, Compare side by side, Source / Rendered, Open
 * agent), delete with Undo (D111: nothing is sent during the Undo window) and
 * for real, the deep link `/results?open=…`, and the phone layout.
 */
test.describe.configure({ mode: 'serial' });

let world: QuestionWorld;
const ids: Record<string, string> = {};
let agentId = '';

test.beforeAll(async () => {
  world = await startQuestionWorld('v2-results', { env: { ...V2_SERVER_ENV } });
});

test.afterAll(async () => {
  await world?.stop();
});

test.beforeEach(async ({ page }) => {
  await stubToolProbes(page);
});

/** The developer's Save as artifact (with `id`: a new version). */
async function save(page: Page, sessionId: string, body: Record<string, unknown>): Promise<string> {
  const result = await page.evaluate(
    async ({ sessionId: id, body: payload }) => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: (await response.json()) as { artifact: { id: string } } };
    },
    { sessionId, body },
  );
  expect([200, 201]).toContain(result.status);
  return result.body.artifact.id;
}

function card(page: Page, title: string) {
  return page.getByTestId('v2-result-card').filter({ hasText: title });
}

test('an empty install says so, with every type filter', async ({ page }) => {
  await page.goto(`${world.baseUrl}/results`);
  await expect(page.getByTestId('v2-page-results')).toBeVisible();
  await expect(page.getByTestId('v2-results-empty')).toContainText('No results yet');
  await expect(page.getByTestId('v2-results-filter')).toHaveText(['All0', 'Documents0', 'PDFs0', 'Diagrams0', 'Images0', 'Tables0', 'Web pages0', 'Code0']);
});

test('filters, search within, grid / list; the drawer previews by kind, compares versions and shows the source', async ({ page }) => {
  await openWithHub(page, `${world.baseUrl}/results`);
  const session = await world.startSession(page, 'pay-flow', 'Hi.');
  agentId = session.id;
  ids['notes'] = await save(page, agentId, { title: 'Release notes', kind: 'markdown', content: '# Release notes\n\n- First fix\n' });
  await save(page, agentId, { id: ids['notes'], title: 'Release notes', kind: 'markdown', content: '# Release notes\n\n- First fix\n- Second fix\n' });
  ids['flow'] = await save(page, agentId, { title: 'Checkout flow', kind: 'mermaid', content: 'graph TD; Cart-->Pay' });
  ids['table'] = await save(page, agentId, { title: 'Test results', kind: 'csv', content: 'test,result\nsummary,pass\ncoupon,fail\n' });
  ids['page'] = await save(page, agentId, { title: 'Landing mockup', kind: 'html', content: '<h1>Hello</h1>' });

  // Live: the saves show up without a reload.
  await expect(page.getByTestId('v2-result-card')).toHaveCount(4);
  await expect(page.locator('[data-testid="v2-results-filter"][data-filter="all"] [data-testid="v2-results-count"]')).toHaveText('4');
  await expect(page.locator('[data-testid="v2-results-filter"][data-filter="diagrams"] [data-testid="v2-results-count"]')).toHaveText('1');
  await expect(card(page, 'Release notes')).toContainText('Markdown · v2 · pay-flow');

  await page.locator('[data-testid="v2-results-filter"][data-filter="tables"]').click();
  await expect(page.getByTestId('v2-result-card')).toHaveCount(1);
  await expect(page.getByTestId('v2-result-card')).toContainText('Test results');
  await page.locator('[data-testid="v2-results-filter"][data-filter="images"]').click();
  await expect(page.getByTestId('v2-results-empty')).toContainText('No images yet');
  await page.locator('[data-testid="v2-results-filter"][data-filter="all"]').click();
  await page.getByTestId('v2-results-search').fill('CHECKOUT');
  await expect(page.getByTestId('v2-result-card')).toHaveCount(1);
  await page.getByTestId('v2-results-search').fill('nothing like it');
  await expect(page.getByTestId('v2-results-empty')).toContainText('Nothing matches');
  await page.getByTestId('v2-results-search').fill('');

  await page.getByTestId('v2-results-layout').getByRole('button', { name: 'List' }).click();
  await expect(page.getByTestId('v2-results-grid')).toHaveAttribute('data-layout', 'list');
  await page.getByTestId('v2-results-layout').getByRole('button', { name: 'Grid' }).click();

  // The CSV previews as a table; the address carries the deep link.
  await card(page, 'Test results').click();
  const drawer = page.getByTestId('v2-result-drawer');
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/results\\?open=${ids['table']}&agent=`));
  await expect(drawer.getByTestId('v2-result-table').locator('tbody tr')).toHaveCount(2);
  await expect(drawer.getByTestId('v2-result-title')).toHaveText('Test results');

  // Mermaid and the web page in their sandboxed frames.
  await card(page, 'Checkout flow').click();
  await expect(drawer.getByTestId('v2-result-mermaid')).toHaveAttribute('sandbox', 'allow-scripts');
  await card(page, 'Landing mockup').click();
  await expect(drawer.getByTestId('v2-result-frame')).toHaveAttribute('sandbox', 'allow-scripts');

  // Markdown: rendered, two versions, Compare side by side, Source / Rendered.
  await card(page, 'Release notes').click();
  await expect(drawer.getByTestId('v2-result-markdown')).toContainText('Second fix');
  await expect(drawer.getByTestId('v2-result-version')).toHaveText(['v1', 'v2']);
  await drawer.getByTestId('v2-result-version').first().click();
  await expect(drawer.getByTestId('v2-result-view')).toHaveAttribute('data-version', '1');
  await expect(drawer.getByTestId('v2-result-markdown')).not.toContainText('Second fix');
  await drawer.getByTestId('v2-result-version').nth(1).click();
  await drawer.getByTestId('v2-result-compare').click();
  const sides = drawer.getByTestId('v2-result-cmp-side');
  await expect(sides).toHaveCount(2);
  await expect(sides.first()).toHaveAttribute('data-version', '1');
  await expect(sides.nth(1)).toContainText('Second fix');
  await expect(sides.first()).not.toContainText('Second fix');
  await expect(drawer).toHaveAttribute('data-full', '');
  await drawer.getByTestId('v2-result-compare').click();
  await drawer.getByTestId('v2-result-source').click();
  await expect(drawer.getByTestId('v2-result-source-text')).toContainText('- Second fix');
  await expect(drawer.getByTestId('v2-result-source')).toHaveText('Rendered');
  await expect(drawer.getByTestId('v2-result-download')).toHaveAttribute('href', new RegExp(`/artifacts/${ids['notes']}/versions/2/raw\\?download`));

  // Escape closes it and drops the query.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(`${world.baseUrl}/results`);
});

test('Open agent goes to the agent; the deep link opens the drawer; a gone result says so', async ({ page }) => {
  await page.goto(`${world.baseUrl}/results?open=${ids['notes']}&agent=${agentId}`);
  const drawer = page.getByTestId('v2-result-drawer');
  await expect(drawer.getByTestId('v2-result-title')).toHaveText('Release notes');
  await drawer.getByTestId('v2-result-open-agent').click();
  await expect(page).toHaveURL(`${world.baseUrl}/agents/${agentId}`);

  await page.goto(`${world.baseUrl}/results?open=gone`);
  await expect(page.getByTestId('v2-toast')).toContainText('That result is gone.');
  await expect(page).toHaveURL(`${world.baseUrl}/results`);
});

test('delete with Undo brings it back and sends nothing; delete for real removes it', async ({ page }) => {
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname);
  });
  await openWithHub(page, `${world.baseUrl}/results`);
  await expect(page.getByTestId('v2-result-card')).toHaveCount(4);
  await card(page, 'Landing mockup').getByTestId('v2-result-select').check();
  await card(page, 'Checkout flow').getByTestId('v2-result-select').check();
  await expect(page.getByTestId('v2-results-selcount')).toHaveText('2 selected');
  await page.getByTestId('v2-results-delete').click();
  await expect(page.getByTestId('v2-result-card')).toHaveCount(2);
  await expect(page.getByTestId('v2-toast')).toContainText('Deleted 2 results');
  await page.getByTestId('v2-toast-undo').click();
  await expect(page.getByTestId('v2-result-card')).toHaveCount(4);
  await page.waitForTimeout(6_500);
  expect(deletes).toEqual([]);
  await expect(page.getByTestId('v2-result-card')).toHaveCount(4);

  // For real: from the drawer, then the Undo window runs out.
  await card(page, 'Landing mockup').click();
  await page.getByTestId('v2-result-drawer').getByTestId('v2-result-delete').click();
  await expect(page.getByTestId('v2-result-drawer')).toHaveCount(0);
  await expect(page.getByTestId('v2-result-card')).toHaveCount(3);
  await expect.poll(() => deletes, { timeout: 10_000 }).toEqual([`/api/sessions/${agentId}/artifacts/${ids['page']}`]);
  await page.reload();
  await expect(page.getByTestId('v2-result-card')).toHaveCount(3);
  await expect(card(page, 'Landing mockup')).toHaveCount(0);
});

test('phone: one column, the drawer fills the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.baseUrl}/results`);
  await expect(page.getByTestId('v2-result-card')).toHaveCount(3);
  const boxes = await page.getByTestId('v2-result-card').evaluateAll((cards) => cards.map((element) => element.getBoundingClientRect().left));
  expect(new Set(boxes.map((left) => Math.round(left))).size).toBe(1);
  await card(page, 'Release notes').click();
  const drawer = page.getByTestId('v2-result-drawer');
  await expect(drawer).toHaveAttribute('data-full', '');
  const box = await drawer.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(390);
  await expect(drawer.getByTestId('v2-result-markdown')).toContainText('Second fix');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toHaveCount(0);
});
