import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TEST_RUN_DIR_ENV, killLeftoversOfRun } from './server-registry.ts';

/**
 * The run-wide net of `tests/helpers/server-registry.ts`, shared by the Vitest global setup
 * (`tests/helpers/vitest-global.ts`) and Playwright's (`tests/e2e/global-setup.ts`): a fresh
 * pid-file folder for this run, handed to the workers through {@link TEST_RUN_DIR_ENV}; the
 * teardown kills the test servers still listed there (only this run's) and removes it.
 * @returns the teardown.
 */
export async function beginTestRun(runner: string): Promise<() => Promise<void>> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), `switchboard-test-run-${process.pid}-`));
  const previous = process.env[TEST_RUN_DIR_ENV];
  process.env[TEST_RUN_DIR_ENV] = runDir;
  return async () => {
    const killed = await killLeftoversOfRun(runDir);
    if (killed.length > 0) console.warn(`[test servers] ${runner} teardown killed ${killed.length} leftover test server(s) of this run: pid ${killed.join(', ')}`);
    if (previous === undefined) delete process.env[TEST_RUN_DIR_ENV];
    else process.env[TEST_RUN_DIR_ENV] = previous;
  };
}
