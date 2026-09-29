import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/core/api.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { WorktreeRecord } from '../../../src/server/db/repos/worktrees.ts';
import type { FolderRef } from '../../../src/server/folders/ref.ts';
import type { SupervisorEvents } from '../../../src/server/supervisor/supervisor.ts';
import { WorktreeAdoption, finishedBashCommand, isTurnEnd } from '../../../src/server/worktrees/adopt.ts';
import type { AdoptionRepo, AdoptionSession } from '../../../src/server/worktrees/manager.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D38: when `WorktreeAdoption` adopts (`docs/worktrees.md` → *Adopted
 * worktrees*): a main agent's successful `git worktree add`, and the sweep at a
 * turn's end while a solution of a Worktrees-on session has no worktree; never a
 * subagent's command, a failed one, another command or a repo folder's session.
 * The manager is a stand-in here; the real one runs in
 * `tests/server/sessions/agent-solutions.test.ts`.
 */
let dir = '';
let store: Store;

beforeEach(async () => {
  dir = await makeTempDir('adopt');
  store = await openTempStore(dir);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(dir);
});

type Listener = (payload: SupervisorEvents['event']) => void;

function rig() {
  const listeners = new Set<Listener>();
  const added: Array<{ sessionId: string; solutions: readonly string[]; publish: string | undefined }> = [];
  const calls: Array<{ session: AdoptionSession; repos: readonly AdoptionRepo[] }> = [];
  let next: WorktreeRecord[] = [];
  const adoption = new WorktreeAdoption({
    store,
    sessions: {
      on: (_name, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      addSolutions: async (sessionId, solutions, options) => {
        added.push({ sessionId, solutions, publish: options?.publish });
      },
    },
    worktrees: {
      adopt: async (session, repos) => {
        calls.push({ session, repos });
        const out = next;
        next = [];
        return out;
      },
    },
    repos: async (folder: FolderRef) => [{ solution: 'web-front', repoPath: `${folder.root}/microfrontends/web-front` }],
  });
  const emit = (sessionId: string, event: Partial<SessionEvent> & Pick<SessionEvent, 'payload'>): void => {
    for (const listener of listeners) listener({ sessionId, event: { id: 1, sessionId, agentId: null, ts: '', endTs: null, kind: 'impl', label: '', ...event } });
  };
  return { adoption, emit, added, calls, willAdopt: (records: WorktreeRecord[]) => (next = records) };
}

async function session(overrides: Partial<Parameters<Store['sessions']['create']>[0]> = {}) {
  const record = await store.sessions.create({ name: 'demo', claudeSessionId: `c-${Math.random()}`, root: '/ws', rootKind: 'workspace', cwd: '/ws', ...overrides });
  const main = await store.agents.create({ sessionId: record.id, kind: 'main', name: 'main', status: 'idle' });
  return { record, main };
}

function bash(command: string, extra: Record<string, unknown> = { result: 'ok', isError: false }): SessionEvent['payload'] {
  return { type: 'tool', name: 'Bash', toolUseId: 'toolu_1', input: { command }, ...extra };
}

/** Lets the listener's async work run. */
async function settle(adoption: WorktreeAdoption): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await adoption.close();
}

describe('WorktreeAdoption · triggers (D38)', () => {
  it('reads a finished Bash command and a turn end', () => {
    expect(finishedBashCommand({ payload: bash('git worktree add x') })).toBe('git worktree add x');
    expect(finishedBashCommand({ payload: bash('git worktree add x', {}) })).toBeNull();
    expect(finishedBashCommand({ payload: bash('git worktree add x', { result: 'fatal', isError: true }) })).toBeNull();
    expect(finishedBashCommand({ payload: { type: 'tool', name: 'Write', input: { command: 'x' }, result: 'ok' } })).toBeNull();
    expect(isTurnEnd({ payload: { type: 'result', isError: false } })).toBe(true);
    expect(isTurnEnd({ payload: bash('x') })).toBe(false);
  });

  it("a main-agent `git worktree add` adopts once and adds the solution (published always); a subagent's, a failed or another command does not", async () => {
    const r = rig();
    const { record, main } = await session();
    const sub = await store.agents.create({ sessionId: record.id, kind: 'subagent', name: 'agent', status: 'run' });
    r.emit(record.id, { id: 10, agentId: sub.id, payload: bash('git worktree add -b PROJ-1-x ../web-front-wt-demo') });
    r.emit(record.id, { id: 11, agentId: main.id, payload: bash('git worktree add -b PROJ-1-x ../w', { result: 'fatal', isError: true }) });
    r.emit(record.id, { id: 12, agentId: main.id, payload: bash('git status') });
    r.emit(record.id, { id: 13, agentId: main.id, payload: bash('git worktree add -b PROJ-1-x ../w', {}) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.calls).toEqual([]);
    r.willAdopt([{ repo: 'web-front' } as WorktreeRecord]);
    r.emit(record.id, { id: 14, agentId: main.id, payload: bash('cd microfrontends/web-front && git worktree add -b PROJ-1-x ../web-front-wt-demo') });
    // The same event again (an update): handled once.
    r.emit(record.id, { id: 14, agentId: main.id, payload: bash('cd microfrontends/web-front && git worktree add -b PROJ-1-x ../web-front-wt-demo') });
    await settle(r.adoption);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.session).toMatchObject({ id: record.id, name: 'demo' });
    expect(r.calls[0]?.repos).toEqual([{ solution: 'web-front', repoPath: '/ws/microfrontends/web-front' }]);
    expect(r.added).toEqual([{ sessionId: record.id, solutions: ['web-front'], publish: 'always' }]);
  });

  it('the turn-end sweep runs only while a Worktrees-on workspace session has a solution without its own worktree', async () => {
    const r = rig();
    // Worktrees off: never swept.
    const off = await session({ name: 'off', solutions: ['web-front'], worktrees: false });
    // Nothing touched yet: nothing to look for.
    const empty = await session({ name: 'empty', worktrees: true, branch: 'PROJ-1-a' });
    // A repo folder's session: never.
    const repo = await session({ name: 'repo', solutions: ['app'], worktrees: true, rootKind: 'repo', root: '/r/app', cwd: '/r/app' });
    // Every solution has its worktree already (`microfrontends/web-front` names web-front too).
    const covered = await session({ name: 'covered', solutions: ['microfrontends/web-front'], worktrees: true, branch: 'PROJ-1-b' });
    await store.worktrees.create({ repo: 'web-front', repoPath: '/ws/microfrontends/web-front', branch: 'PROJ-1-b', path: '/ws/microfrontends/web-front-wt-covered', sessionId: covered.record.id });
    // A touched solution without a worktree: swept.
    const missing = await session({ name: 'missing', solutions: ['web-front', 'mobile'], worktrees: true, branch: 'PROJ-1-c' });
    await store.worktrees.create({ repo: 'web-front', repoPath: '/ws/microfrontends/web-front', branch: 'PROJ-1-c', path: '/ws/microfrontends/web-front-wt-missing', sessionId: missing.record.id });
    for (const s of [off, empty, repo, covered, missing]) r.emit(s.record.id, { payload: { type: 'result', isError: false } });
    await settle(r.adoption);
    expect(r.calls.map((c) => c.session.name)).toEqual(['missing']);
    // Nothing adopted: no solutions added, nothing published.
    expect(r.added).toEqual([]);
  });
});
