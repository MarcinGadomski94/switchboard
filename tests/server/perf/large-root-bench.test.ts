import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { buildApp } from '../../../src/server/app.ts';
import { CheckpointService } from '../../../src/server/checkpoints/service.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { makeGitWorld } from '../../helpers/git.ts';
import { makeLargeRoot } from '../../helpers/large-root.ts';

const HOST = '127.0.0.1:4875';

/**
 * D144 bench (not in the default suite): a large non-git root whose session edited in
 * `SB_WT` agent-made worktrees. `SB_BENCH=1 SB_WT=40 npx vitest run tests/server/perf/large-root-bench.test.ts --silent=false`.
 */
describe.skipIf(process.env['SB_BENCH'] !== '1')('bench', () => {
  it('large root timings', async () => {
    const w = await makeGitWorld();
    const n = Number(process.env['SB_WT'] ?? 20);
    const big = await makeLargeRoot(w.root, { env: w.env, worktrees: n });
    const manager = new WorktreeManager({ store: w.store, ghCommand: fakeGhCommand(), gitCommand: ['git'], env: w.env, onError: (e) => console.log('ERR', e) });
    const token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
    await seedFolder(w.store, big.root);
    const app = await buildApp({ config: { ...base, port: 4875 }, token, store: w.store, webRoot: w.root, worktrees: manager, bus: new HubBus(), providers: { diff: manager } });
    await app.ready();
    const id = (await w.store.sessions.create({ name: 'big', claudeSessionId: randomUUID(), solutions: [big.solution], worktrees: false, root: big.root, rootKind: 'workspace', cwd: big.root })).id;
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 10_000; i++) {
      if (i % 5 === 0) {
        const wt = (i / 5) % (n + 1);
        const top = wt === n ? big.repo : (big.worktrees[wt] as string);
        const file = path.join(top, 'src', `d${i % 4}`, `e${i % 10}`, `f${i % 400}.txt`);
        await w.store.events.append({ sessionId: id, kind: 'impl', label: 'Edit', payload: { type: 'tool', name: 'Edit', toolUseId: randomUUID(), input: { file_path: file, old_string: filler, new_string: filler } } });
      } else {
        await w.store.events.append({ sessionId: id, kind: 'impl', label: 'Bash', payload: { type: 'tool', name: 'Bash', toolUseId: randomUUID(), input: { command: filler } } });
      }
    }
    const get = async (url: string): Promise<number> => {
      const t = performance.now();
      await app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
      return performance.now() - t;
    };
    const line = (label: string, ms: number[]): void => {
      const sorted = [...ms].sort((a, b) => a - b);
      console.log(`BENCH ${label}: first ${Math.round(ms[0] ?? 0)} ms, median ${Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)} ms, max ${Math.round(sorted[sorted.length - 1] ?? 0)} ms`);
    };
    for (const [label, url] of [
      ['detail', `/api/sessions/${id}`],
      ['diff/count head', `/api/sessions/${id}/diff/count?scope=head`],
      ['diff/count repo', `/api/sessions/${id}/diff/count?scope=repo`],
      ['diff head', `/api/sessions/${id}/diff?scope=head`],
    ] as const) {
      const ms: number[] = [];
      for (let r = 0; r < 6; r++) ms.push(await get(url));
      line(label, ms);
    }
    // A storm: 20 concurrent details + 20 concurrent counts after a new event (several clients reloading at once).
    await w.store.events.append({ sessionId: id, kind: 'impl', label: 'Bash', payload: { type: 'tool', name: 'Bash', toolUseId: randomUUID(), input: { command: 'ls' } } });
    const t = performance.now();
    await Promise.all([...Array.from({ length: 20 }, () => get(`/api/sessions/${id}`)), ...Array.from({ length: 20 }, () => get(`/api/sessions/${id}/diff/count?scope=head`))]);
    console.log(`BENCH storm 20 detail + 20 count: ${Math.round(performance.now() - t)} ms`);
    // The send path: a checkpoint of every working tree before the turn.
    const checkpoints = new CheckpointService({
      store: w.store,
      sessions: {} as never,
      env: w.env,
      enabled: async () => true,
      includeCwd: false,
      foldersOf: async (session) => {
        const { worktrees: own, inPlace } = await manager.repos.of(session);
        return [...own.map((x) => x.path), ...inPlace.map((x) => x.top)];
      },
    });
    for (let r = 0; r < 2; r++) {
      const c = performance.now();
      const captured = await checkpoints.capture(id);
      console.log(`BENCH checkpoint capture (${captured?.items.length ?? 0} trees): ${Math.round(performance.now() - c)} ms`);
    }
    await app.close();
    await w.cleanup();
  }, 900_000);
});
