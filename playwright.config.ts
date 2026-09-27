import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E + screenshots. Specs live in `tests/e2e/` and start their own
 * server on 127.0.0.1 in the 4871–4879 test range (never 4870, which the
 * developer may use for the real app) with a temp data dir.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: ['**/.worktrees/**', '**/.spike/**', '**/dist/**', '**/node_modules/**'],
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
