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
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
