import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { it } from 'vitest';
import { startServer } from '../../helpers/server-process.ts';
import { leakLog, leakRoot, logSpawns } from './log.ts';

/**
 * Deliberately crashing (run only by tests/server/test-servers-no-leak.test.ts): the worker dies
 * by SIGKILL with a server running, so no hook and no `exit` handler runs; only the global
 * teardown's pid files are left to find it.
 */
logSpawns();

it('the worker is killed with a server running', async () => {
  const root = await mkdtemp(path.join(leakRoot(), 'crash-'));
  await startServer({ SWITCHBOARD_DATA_DIR: path.join(root, 'data') });
  leakLog('crashing');
  process.kill(process.pid, 'SIGKILL');
});
