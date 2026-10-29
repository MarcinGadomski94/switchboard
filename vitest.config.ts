import { configDefaults, defineConfig } from 'vitest/config';

/** Folders no tool may scan or watch (parallel lane worktrees live under `.worktrees/`). */
const IGNORED = ['**/.worktrees/**', '**/.spike/**', '**/dist/**', '**/node_modules/**'];

/**
 * Vitest runs unit + integration tests from `tests/`. Playwright E2E specs live
 * in `tests/e2e/` and run with `npm run e2e`, never under Vitest.
 */
export default defineConfig({
  server: {
    watch: { ignored: IGNORED },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...IGNORED, 'tests/e2e/**'],
    environment: 'node',
    // No test server outlives a run (tests/helpers/server-registry.ts, CONTRIBUTING.md).
    globalSetup: ['tests/helpers/vitest-global.ts'],
    setupFiles: ['tests/helpers/vitest-setup.ts'],
    // The server tests start real processes (servers, fake CLIs, git): 2–6 s alone, several times that while every
    // worker runs them at once (a full run puts a 12-core machine at a load of ~25). A hung test still fails, later.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
