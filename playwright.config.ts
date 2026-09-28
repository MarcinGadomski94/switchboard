import { defineConfig, devices } from '@playwright/test';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Playwright E2E + screenshots. Specs live in `tests/e2e/` and start their own
 * server on 127.0.0.1 in the 4871–4879 test range, or the range in
 * `SWITCHBOARD_TEST_PORTS` (tests/helpers/net.ts; never 4870, which the developer
 * may use for the real app) with a temp data dir.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Anchored at this repo: a lane worktree's own path contains `.worktrees/` (docs/lanes.md).
  testIgnore: new RegExp(`^${escapeRegExp(import.meta.dirname)}[\\\\/](?:\\.worktrees|\\.spike|dist|node_modules)[\\\\/]`),
  // Builds dist/web from the current src/web before any spec runs.
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
});
