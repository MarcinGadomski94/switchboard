import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiffCount, DiffTargets, SessionDetail } from '../../../src/core/api.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { generateToken } from '../../../src/server/token.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type LargeRoot, makeLargeRoot } from '../../helpers/large-root.ts';

const PORT = 4876; // inject() opens no socket; the port feeds the Host check only
const HOST = `127.0.0.1:${PORT}`;

/**
 * D144: a session in a large **non-git** multi-repo root (20 000 files beside the
 * solution, agent-made worktrees with their own `node_modules` under the solution's
 * `.claude/worktrees`, thousands of events): the detail and the Diff count answer
 * from the per-session cache without waiting for git, count only the session's
 * repository, and concurrent asks run git once.
 */
describe('a large non-git root (D144)', () => {
  let w: GitWorld;
  let big: LargeRoot;
  let app: FastifyInstance;
  let token = '';
  let id = '';

  const get = async (url: string): Promise<{ status: number; body: unknown; ms: number }> => {
    const started = performance.now();
    const response = await app.inject({ method: 'GET', url, headers: { host: HOST, cookie: `sb_token=${token}` } });
    return { status: response.statusCode, body: response.json(), ms: performance.now() - started };
  };
  /** `git diff --name-only` runs (the count's git) logged so far. */
  const countRuns = async (): Promise<number> => (await w.gitCalls()).filter((call) => call.argv.includes('diff') && call.argv.includes('--name-only') && !call.argv.includes('HEAD')).length;

  beforeAll(async () => {
    w = await makeGitWorld();
    big = await makeLargeRoot(w.root, { env: w.env });
    const manager = w.manager();
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
    await seedFolder(w.store, big.root);
    app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, worktrees: manager, bus: new HubBus(), providers: { diff: manager } });
    await app.ready();
    id = (await w.store.sessions.create({ name: 'big-root', claudeSessionId: randomUUID(), solutions: [big.solution], worktrees: false, root: big.root, rootKind: 'workspace', cwd: big.root })).id;
    // A long conversation: edits of two of the changed files, and many other tool calls.
    const filler = 'x'.repeat(1_000);
    for (let i = 0; i < 2_000; i++) {
      const payload =
        i === 10
          ? { type: 'tool', name: 'Edit', toolUseId: randomUUID(), input: { file_path: path.join(big.repo, 'src', 'd0', 'e0', 'f0.txt'), old_string: 'a', new_string: 'b' } }
          : i === 20
            ? { type: 'tool', name: 'Write', toolUseId: randomUUID(), input: { file_path: path.join(big.repo, 'new-1.md'), content: 'new' } }
            : { type: 'tool', name: 'Bash', toolUseId: randomUUID(), input: { command: filler } };
      await w.store.events.append({ sessionId: id, kind: 'impl', label: String(payload.name), payload });
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await w?.cleanup();
  });

  it('reads only the declared solution: no sibling folder, no unedited worktree under .claude/worktrees', async () => {
    const targets = await get(`/api/sessions/${id}/diff/targets`);
    expect(targets.status).toBe(200);
    expect(targets.body as DiffTargets).toEqual({ worktrees: [], inPlace: [{ solution: big.solution, branch: 'main' }] });
  });

  it('the count is computed once in the background, then answered from memory fast; it counts only the solution repo', async () => {
    const first = await get(`/api/sessions/${id}/diff/count?scope=repo`);
    expect(first.status).toBe(200);
    expect(first.ms).toBeLessThan(5_000);
    const fresh = await vi.waitFor(
      async () => {
        const answer = (await get(`/api/sessions/${id}/diff/count?scope=repo`)).body as DiffCount;
        expect(answer.stale).toBeUndefined();
        return answer;
      },
      { timeout: 20_000, interval: 100 },
    );
    // The 5 uncommitted changes of the solution; the worktrees' own changes and the sibling tree are not counted.
    expect(fresh).toEqual({ scope: 'repo', files: 5 });
    // Since the last commit, in place: only the files the session edited.
    const head = await vi.waitFor(
      async () => {
        const answer = (await get(`/api/sessions/${id}/diff/count`)).body as DiffCount;
        expect(answer.stale).toBeUndefined();
        return answer;
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(head).toEqual({ scope: 'head', files: 2 });
    for (let i = 0; i < 5; i++) {
      const again = await get(`/api/sessions/${id}/diff/count?scope=repo`);
      expect(again.body).toEqual({ scope: 'repo', files: 5 });
      expect(again.ms).toBeLessThan(300);
    }
  });

  it('the detail never waits for git: fast on repeat, its files read in the background', async () => {
    await get(`/api/sessions/${id}`);
    const detail = await vi.waitFor(
      async () => {
        const answer = (await get(`/api/sessions/${id}`)).body as SessionDetail;
        expect(answer.filesStale).toBeUndefined();
        return answer;
      },
      { timeout: 20_000, interval: 100 },
    );
    expect(detail.files.map((file) => file.path).sort()).toEqual(['new-1.md', 'new-3.md', 'src/d0/e0/f0.txt', 'src/d0/e0/f2.txt', 'src/d0/e0/f4.txt']);
    for (let i = 0; i < 5; i++) {
      const again = await get(`/api/sessions/${id}`);
      expect(again.status).toBe(200);
      expect(again.ms).toBeLessThan(300);
    }
  });

  it('concurrent asks after a change run git once', async () => {
    // A new event: the fingerprint changes, the next asks count again.
    await w.store.events.append({ sessionId: id, kind: 'impl', label: 'Bash', payload: { type: 'tool', name: 'Bash', toolUseId: randomUUID(), input: { command: 'ls' } } });
    const before = await countRuns();
    const answers = await Promise.all(Array.from({ length: 12 }, () => get(`/api/sessions/${id}/diff/count?scope=repo`)));
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    await vi.waitFor(
      async () => {
        expect(((await get(`/api/sessions/${id}/diff/count?scope=repo`)).body as DiffCount).stale).toBeUndefined();
      },
      { timeout: 20_000, interval: 100 },
    );
    // One target, one count: exactly one `git diff --name-only` for twelve concurrent asks.
    expect((await countRuns()) - before).toBe(1);
  });
});
