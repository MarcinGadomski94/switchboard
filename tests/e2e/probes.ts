import type { Page } from '@playwright/test';

/**
 * Answers the page's embedded-tool probes (`POST /api/tools/{id}/probe`, M8.1) in
 * the browser with `state`, so a spec that is not about tools never makes the
 * service fetch the default Codebase Memory URL (`http://localhost:13000`) on the
 * developer's machine: the sidebar probes every configured tool once per page
 * load. `tests/e2e/tools.spec.ts` drives the real probes against a stub server.
 */
export async function stubToolProbes(page: Page, state: 'up' | 'down' = 'down'): Promise<void> {
  await page.route(/\/api\/tools\/[^/]+\/probe$/, (route) => route.fulfill({ status: 200, json: { state } }));
}
