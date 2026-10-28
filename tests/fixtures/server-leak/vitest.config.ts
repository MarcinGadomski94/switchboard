import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The nested run of `tests/server/test-servers-no-leak.test.ts`: the leaky fixtures with the
 * same test-server nets as `vitest.config.ts` (its global setup and per-file setup). `forks`,
 * so `crash.fixture.ts` killing its worker kills a child process, not the runner.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    include: ['tests/fixtures/server-leak/*.fixture.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    globalSetup: ['tests/helpers/vitest-global.ts'],
    setupFiles: ['tests/helpers/vitest-setup.ts'],
  },
});
