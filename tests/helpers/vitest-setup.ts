import { afterAll } from 'vitest';
import { stopAllServers } from './server-registry.ts';

/**
 * Runs in every Vitest file (`setupFiles` in vitest.config.ts). Its `afterAll` runs after the
 * file's own hooks: any test server still alive then (a test or hook timed out before its
 * cleanup saw the server, or a start finished after the test gave up) is stopped, with its
 * process group. CONTRIBUTING.md → *Test servers never outlive a run*.
 */
afterAll(async () => {
  const left = await stopAllServers();
  if (left.length > 0) console.warn(`[test servers] stopped ${left.length} test server(s) still running at the end of the file: pid ${left.join(', ')}`);
}, 30_000);
