/**
 * D79 / D80 / D90 follow-up (2026-10-13): "change tracking missed agent-made worktrees
 * and repos outside the workspace". Real temp git repos (`tests/helpers/git.ts`). The
 * shared answer (`WorktreeManager.repos`) is what review cards, turn checkpoints and
 * the Diff tab read: a workspace session whose solution is a linked worktree (no
 * `worktrees` row) gets a card, a checkpoint and a diff; a repo outside the workspace
 * that the session edited is watched; a declared-but-untouched solution and an edited
 * repo are both watched, deduplicated; read-only layout folders never are; creating
 * worktrees still refuses a linked worktree; and a pending card whose changes are gone
 * closes as handled by the agent when the session goes idle / done / closed and at startup.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { CheckpointService } from '../../../src/server/checkpoints/service.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { listInbox } from '../../../src/server/inbox/wire.ts';
import { ReviewGit } from '../../../src/server/reviews/git.ts';
import { ReviewService } from '../../../src/server/reviews/service.ts';
import { checkoutOf, watchedCheckoutOf } from '../../../src/server/solutions/checkout.ts';
import type { WorktreeManager } from '../../../src/server/worktrees/manager.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

let world: GitWorld | null = null;
const services: ReviewService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  await world?.cleanup();
  world = null;
});

interface Setup {
  readonly w: GitWorld;
  readonly m: WorktreeManager;
  readonly bus: HubBus;
  reviews(): ReviewService;
  checkpoints(): CheckpointService;
}

async function setup(): Promise<Setup> {
  const w = await makeGitWorld();
  world = w;
  const m = w.manager();
  const bus = new HubBus();
  return {
    w,
    m,
    bus,
    reviews() {
      const service = new ReviewService({
        store: w.store,
        bus,
        git: new ReviewGit({ gh: fakeGhCommand(), env: w.env }),
        repos: (session) => m.repos.of(session),
        enabled: async () => true,
        send: async () => undefined,
        onError: (error) => w.errors.push(error),
      });
      services.push(service);
      service.start();
      return service;
    },
    checkpoints() {
      // As the app wires it: the shared set decides, the cwd included.
      return new CheckpointService({
        store: w.store,
        env: w.env,
        enabled: async () => true,
        includeCwd: false,
        foldersOf: async (session) => {
          const { worktrees, inPlace } = await m.repos.of(session);
          return [...worktrees.map((worktree) => worktree.path), ...inPlace.map((repo) => repo.top)];
        },
        sessions: { turnRunning: () => false, recordServiceEvent: async () => undefined },
        onError: (error) => {
          throw error;
        },
      });
    },
  };
}

/** A workspace session (cwd = the workspace root, which is not a git repo). */
async function workspaceSession(w: GitWorld, solutions: string[], name = 'acme-task'): Promise<SessionRecord> {
  return w.store.sessions.create({ name, claudeSessionId: randomUUID(), solutions, worktrees: false, root: w.workspace, rootKind: 'workspace', cwd: w.workspace });
}

/** A Write / Edit tool call of the session, as the recorder stores it. */
async function edited(w: GitWorld, sessionId: string, file: string, name = 'Write'): Promise<void> {
  await w.store.events.append({ sessionId, kind: 'impl', label: name, payload: { type: 'tool', name, toolUseId: randomUUID(), input: { file_path: file } } });
}

/** Writes `content` to `file` (making its folder) and records the session's Write of it. */
async function write(w: GitWorld, sessionId: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await edited(w, sessionId, file);
}

/** A repo whose first commit predates the sessions (a commit in the session's first second would count as its own). */
async function oldRepo(w: GitWorld, dir: string): Promise<string> {
  const repo = await w.makeRepo(dir);
  const old = { ...w.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  expect((await runCommand(['git'], ['commit', '-q', '--amend', '--no-edit', '--reset-author'], { cwd: repo, env: old })).code).toBe(0);
  return repo;
}

/** An agent-made linked worktree next to `web-front` (`.git` is a file; no `worktrees` row). */
async function agentWorktree(w: GitWorld, name = 'web-front-wt-proj-123'): Promise<string> {
  const dir = path.join(path.dirname(w.web), name);
  await w.git(w.web, 'worktree', 'add', '-q', '-b', `feature/${name}`, dir, 'main');
  return dir;
}

function turn(bus: HubBus, sessionId: string): void {
  bus.publish('sessionUpdated', { id: sessionId, status: 'run', closedAt: null } as unknown as Session);
  bus.publish('sessionUpdated', { id: sessionId, status: 'idle', closedAt: null } as unknown as Session);
}

describe('the repositories a session works in (shared by reviews, checkpoints and the Diff)', () => {
  it('a workspace solution that is a linked worktree: a card is raised, a checkpoint is taken, the diff shows it', async () => {
    const s = await setup();
    const dir = await agentWorktree(s.w);
    const session = await workspaceSession(s.w, ['microfrontends/web-front-wt-proj-123']);
    // Before: a linked worktree was no solution at all for watching.
    expect(await checkoutOf(dir)).toBeNull();
    expect(await watchedCheckoutOf(dir)).toBe(dir);

    const set = await s.m.repos.of(session);
    expect(set.worktrees).toEqual([]);
    expect(set.inPlace).toEqual([{ name: 'microfrontends/web-front-wt-proj-123', top: dir, source: 'solution' }]);

    // Checkpoint before the turn: the worktree is snapshotted.
    const checkpoints = s.checkpoints();
    const capture = await checkpoints.capture(session.id);
    expect(capture?.items.map((item) => item.snapshot.top)).toEqual([dir]);
    await checkpoints.stop();

    // The agent edits a file in it; the turn ends: a folder-mode card.
    await write(s.w, session.id, path.join(dir, 'src', 'feature.txt'), 'new\n');
    const reviews = s.reviews();
    turn(s.bus, session.id);
    await reviews.idle();
    const [card] = (await reviews.list()).filter((review) => review.state === 'pending');
    expect(card).toMatchObject({ mode: 'folder', repos: [{ repo: 'microfrontends/web-front-wt-proj-123', dir, branch: 'feature/web-front-wt-proj-123', uncommitted: 1 }] });
    expect(card?.actions).toEqual(['commit', 'send-back', 'discard', 'dismiss']);
    // The Inbox names the repository.
    const item = (await listInbox(s.w.store)).find((entry) => entry.id === card?.id);
    expect(item?.title).toBe('1 file changed (+1 −0) · microfrontends/web-front-wt-proj-123');
    expect(item?.branches).toEqual([{ solution: 'microfrontends/web-front-wt-proj-123', branch: 'feature/web-front-wt-proj-123' }]);

    // The Diff tab: since the last commit, only the session's files.
    expect((await s.m.diff(session.id, undefined, 'head')).map((file) => `${file.solution}:${file.path}`)).toEqual(['microfrontends/web-front-wt-proj-123:src/feature.txt']);
    expect((await s.m.targets(session.id)).inPlace).toEqual([{ solution: 'microfrontends/web-front-wt-proj-123', branch: 'feature/web-front-wt-proj-123' }]);
    expect(await s.m.count(session.id, 'head')).toEqual({ scope: 'head', files: 1 });
  });

  it('a repo outside the workspace edited via Write / Edit is watched (card, checkpoint, diff)', async () => {
    const s = await setup();
    const outside = await oldRepo(s.w, path.join(s.w.root, 'elsewhere', 'acme-tools'));
    const session = await workspaceSession(s.w, []);
    expect((await s.m.repos.of(session)).inPlace).toEqual([]);

    await writeFile(path.join(outside, 'README.md'), 'hello\nmore\n');
    await edited(s.w, session.id, path.join(outside, 'README.md'), 'Edit');
    expect((await s.m.repos.of(session)).inPlace).toEqual([{ name: 'acme-tools', top: outside, source: 'edited' }]);

    const checkpoints = s.checkpoints();
    expect(await checkpoints.treesOf(session)).toEqual([outside]);
    await checkpoints.stop();

    const reviews = s.reviews();
    turn(s.bus, session.id);
    await reviews.idle();
    const [card] = (await reviews.list()).filter((review) => review.state === 'pending');
    expect(card?.repos.map((repo) => [repo.repo, repo.dir, repo.uncommitted])).toEqual([['acme-tools', outside, 1]]);
    expect((await s.m.diff(session.id, undefined, 'head')).map((file) => `${file.solution}:${file.path}`)).toEqual(['acme-tools:README.md']);
  });

  it('a declared but untouched solution plus an edited repo: both watched, deduplicated by real path', async () => {
    const s = await setup();
    const outside = await oldRepo(s.w, path.join(s.w.root, 'elsewhere', 'acme-api'));
    const session = await workspaceSession(s.w, ['mobile']);
    // Two files in the outside repo, one through a relative path from a sub-folder, and one in the declared solution.
    await write(s.w, session.id, path.join(outside, 'a.txt'), 'a\n');
    await write(s.w, session.id, path.join(outside, 'src', 'b.txt'), 'b\n');
    await write(s.w, session.id, path.join(s.w.mobile, 'src', 'c.txt'), 'c\n');
    await edited(s.w, session.id, path.join(outside, 'src', '..', 'a.txt'));

    const { inPlace } = await s.m.repos.of(session);
    expect(inPlace).toEqual([
      { name: 'mobile', top: s.w.mobile, source: 'solution' },
      { name: 'acme-api', top: outside, source: 'edited' },
    ]);
    const checkpoints = s.checkpoints();
    expect(await checkpoints.treesOf(session)).toEqual([s.w.mobile, outside]);
    await checkpoints.stop();
    expect((await s.m.targets(session.id)).inPlace.map((target) => target.solution)).toEqual(['mobile', 'acme-api']);

    // A repo edited later (incremental read) joins the set.
    const later = await oldRepo(s.w, path.join(s.w.root, 'elsewhere', 'acme-later'));
    await write(s.w, session.id, path.join(later, 'x.txt'), 'x\n');
    expect((await s.m.repos.of(session)).inPlace.map((repo) => repo.name)).toEqual(['mobile', 'acme-api', 'acme-later']);
  });

  it('read-only layout folders are never watched, declared or edited', async () => {
    const s = await setup();
    const legacy = await oldRepo(s.w, path.join(s.w.workspace, 'deprecated', 'microfrontends', 'old-front'));
    const infra = await oldRepo(s.w, path.join(s.w.workspace, 'infrastructure'));
    const session = await workspaceSession(s.w, ['deprecated/microfrontends/old-front', 'infrastructure']);
    await write(s.w, session.id, path.join(legacy, 'x.txt'), 'x\n');
    await write(s.w, session.id, path.join(infra, 'main.tf'), 'x\n');
    expect((await s.m.repos.of(session)).inPlace).toEqual([]);
    const checkpoints = s.checkpoints();
    expect(await checkpoints.treesOf(session)).toEqual([]);
    await checkpoints.stop();
    expect(await s.m.diff(session.id, undefined, 'repo')).toEqual([]);
  });

  it('creating worktrees still refuses a linked worktree (main checkouts only)', async () => {
    const s = await setup();
    await agentWorktree(s.w);
    await expect(s.m.resolveRepo('microfrontends/web-front-wt-proj-123', s.w.folder)).rejects.toMatchObject({ code: 'solution-not-found' });
    const session = await workspaceSession(s.w, ['microfrontends/web-front-wt-proj-123'], 'acme-create');
    await expect(s.m.createForSession('acme-create', ['microfrontends/web-front-wt-proj-123'], s.w.folder, session.id)).rejects.toMatchObject({ code: 'solution-not-found' });
    // The main checkout still resolves.
    expect((await s.m.resolveRepo('web-front', s.w.folder)).repoPath).toBe(s.w.web);
  });

  it('the cwd is the fallback of a workspace session, and always counts for a repo folder session', async () => {
    const s = await setup();
    const repoSession = await s.w.store.sessions.create({ name: 'acme-repo', claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: s.w.mobile, rootKind: 'repo', cwd: s.w.mobile });
    expect((await s.m.repos.of(repoSession)).inPlace).toEqual([{ name: 'mobile', top: s.w.mobile, source: 'solution' }]);
    // A workspace session working inside a solution folder with nothing declared or edited: its cwd's repo.
    const inside = await s.w.store.sessions.create({ name: 'acme-inside', claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: s.w.workspace, rootKind: 'workspace', cwd: s.w.web });
    expect((await s.m.repos.of(inside)).inPlace).toEqual([{ name: 'web-front', top: s.w.web, source: 'cwd' }]);
  });
});

describe('stale pending cards close as handled by the agent without being opened', () => {
  async function pendingCard(s: Setup): Promise<{ session: SessionRecord; file: string; reviews: ReviewService }> {
    // The mobile repo's first commit predates the session (else it would stay the session's unpushed commit).
    const old = { ...s.w.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
    expect((await runCommand(['git'], ['commit', '-q', '--amend', '--no-edit', '--reset-author'], { cwd: s.w.mobile, env: old })).code).toBe(0);
    const session = await workspaceSession(s.w, ['mobile']);
    const file = path.join(s.w.mobile, 'notes.md');
    await write(s.w, session.id, file, 'draft\n');
    const reviews = s.reviews();
    turn(s.bus, session.id);
    await reviews.idle();
    expect((await s.w.store.reviews.openOf(session.id))?.state).toBe('pending');
    return { session, file, reviews };
  }

  async function expectHandled(s: Setup, sessionId: string): Promise<void> {
    expect(await s.w.store.reviews.openOf(sessionId)).toBeNull();
    const latest = await s.w.store.reviews.latestOf(sessionId);
    expect(latest).toMatchObject({ state: 'resolved', outcome: 'dismissed' });
    expect((latest?.data as { handledByAgent?: boolean }).handledByAgent).toBe(true);
  }

  it('at a turn end with no changes left', async () => {
    const s = await setup();
    const { session, file, reviews } = await pendingCard(s);
    await rm(file);
    turn(s.bus, session.id);
    await reviews.idle();
    await expectHandled(s, session.id);
  });

  it('when the session goes done (no turn), and when it is closed', async () => {
    const s = await setup();
    const { session, file, reviews } = await pendingCard(s);
    await rm(file);
    s.bus.publish('sessionUpdated', { id: session.id, status: 'done', closedAt: null } as unknown as Session);
    await reviews.idle();
    await expectHandled(s, session.id);

    // A closed session's open card is re-checked too (evaluate() skips closed sessions).
    const other = await workspaceSession(s.w, ['mobile'], 'acme-closed');
    await write(s.w, other.id, file, 'again\n');
    turn(s.bus, other.id);
    await reviews.idle();
    expect((await s.w.store.reviews.openOf(other.id))?.state).toBe('pending');
    await rm(file);
    await s.w.store.sessions.update(other.id, { closedAt: new Date().toISOString(), status: 'done' });
    s.bus.publish('sessionUpdated', { id: other.id, status: 'done', closedAt: new Date().toISOString() } as unknown as Session);
    await reviews.idle();
    await expectHandled(s, other.id);
  });

  it('once at startup', async () => {
    const s = await setup();
    const { session, file, reviews } = await pendingCard(s);
    await reviews.stop();
    await rm(file);
    // A restart: a new service re-checks the open cards once, nobody opens the Inbox.
    const restarted = s.reviews();
    await restarted.idle();
    await expectHandled(s, session.id);
  });
});
