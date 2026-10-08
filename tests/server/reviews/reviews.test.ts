/**
 * D79 · the review queue on the real path: temp git repos (`tests/helpers/git.ts`: an
 * isolated git config, a bare origin, the fake gh), a store, the bus. A session's turn
 * end (`sessionUpdated` run → idle) raises a card once per change set; the card's
 * actions run git: Merge (in the base's checkout, or by moving the ref), refused on
 * conflicts / uncommitted changes; Open PR (push + fake gh); Discard; Clean up; Commit;
 * Send back; Dismiss; and every resolution emits `reviewResolved` `{ sessionId, outcome }`.
 */
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import type { ReviewResolvedEvent } from '../../../src/core/reviews.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { listInbox } from '../../../src/server/inbox/wire.ts';
import { ReviewGit } from '../../../src/server/reviews/git.ts';
import { ReviewError, ReviewService } from '../../../src/server/reviews/service.ts';
import { runCommand } from '../../../src/server/exec.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

let world: GitWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
});

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

interface Setup {
  readonly w: GitWorld;
  readonly bus: HubBus;
  readonly service: ReviewService;
  readonly events: HubMessage[];
  readonly resolved: ReviewResolvedEvent[];
  readonly sent: Array<{ sessionId: string; text: string }>;
  enabled: boolean;
  /** One turn of the session: run → idle, then waits for the service. */
  turn(sessionId: string): Promise<void>;
}

async function setup(): Promise<Setup> {
  const w = await makeGitWorld();
  world = w;
  const bus = new HubBus();
  const events: HubMessage[] = [];
  const resolved: ReviewResolvedEvent[] = [];
  bus.subscribe((message) => {
    events.push(message);
    if (message.name === 'reviewResolved') resolved.push(message.payload);
  });
  const sent: Array<{ sessionId: string; text: string }> = [];
  const state: Setup = {
    w,
    bus,
    events,
    resolved,
    sent,
    enabled: true,
    service: null as unknown as ReviewService,
    async turn(sessionId) {
      bus.publish('sessionUpdated', { id: sessionId, status: 'run', closedAt: null } as unknown as Session);
      bus.publish('sessionUpdated', { id: sessionId, status: 'idle', closedAt: null } as unknown as Session);
      await state.service.idle();
    },
  };
  const manager = w.manager();
  const service = new ReviewService({
    store: w.store,
    bus,
    git: new ReviewGit({ gh: fakeGhCommand(), env: w.env }),
    resolveRepo: (solution, folder) => manager.resolveRepo(solution, folder),
    enabled: async () => state.enabled,
    send: async (sessionId, text) => {
      sent.push({ sessionId, text });
    },
    onError: (error) => w.errors.push(error),
  });
  (state as { service: ReviewService }).service = service;
  service.start();
  return state;
}

/** A worktree session on `web-front`: branch `session/<name>` from main, base `main`. */
async function branchSession(s: Setup, name = 'fix-login', baseRef: string | null = 'main') {
  const dir = path.join(path.dirname(s.w.web), `web-front-wt-${name}`);
  await s.w.git(s.w.web, 'worktree', 'add', '-q', '-b', `session/${name}`, dir, 'main');
  const session = await s.w.store.sessions.create({
    name,
    claudeSessionId: randomUUID(),
    solutions: ['web-front'],
    worktrees: true,
    root: s.w.workspace,
    rootKind: 'workspace',
    cwd: dir,
    title: 'Fix the login',
  });
  const worktree = await s.w.store.worktrees.create({ repo: 'web-front', repoPath: s.w.web, branch: `session/${name}`, path: dir, baseRef, sessionId: session.id });
  return { session, worktree, dir };
}

/** A session working directly in the `mobile` repo folder (no worktree). */
async function folderSession(s: Setup, name = 'tidy-mobile') {
  // The repo's first commit predates the session (made in the same second here, it would count as the session's).
  const old = { ...s.w.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const amended = await runCommand(['git'], ['commit', '-q', '--amend', '--no-edit', '--reset-author'], { cwd: s.w.mobile, env: old });
  expect(amended.code).toBe(0);
  const session = await s.w.store.sessions.create({
    name,
    claudeSessionId: randomUUID(),
    solutions: [],
    worktrees: false,
    root: s.w.mobile,
    rootKind: 'repo',
    cwd: s.w.mobile,
  });
  return { session };
}

async function agentSays(s: Setup, sessionId: string, text: string): Promise<void> {
  await s.w.store.events.append({ sessionId, kind: 'text', payload: { type: 'assistant', text, messageId: null } });
}

async function bash(s: Setup, sessionId: string, command: string, result: string, isError = false): Promise<void> {
  await s.w.store.events.append({ sessionId, kind: 'tool', toolUseId: randomUUID(), payload: { type: 'tool', name: 'Bash', toolUseId: 'x', input: { command }, result, isError } });
}

async function open(s: Setup) {
  return (await s.service.list()).filter((review) => review.state !== 'resolved');
}

describe('raising review cards (D79)', () => {
  it('raises nothing without changes, then once per change set when a turn ends', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await s.turn(session.id);
    expect(await open(s)).toEqual([]);

    await writeFile(path.join(dir, 'login.txt'), 'a\nb\n');
    await agentSays(s, session.id, 'Added the login form.\n\nIt validates the email.');
    await bash(s, session.id, 'npm test', 'Exit code 1\n1 failed', true);
    await s.turn(session.id);
    const [card] = await open(s);
    expect(card).toMatchObject({
      sessionId: session.id,
      sessionTitle: 'Fix the login',
      mode: 'branch',
      state: 'pending',
      outcome: null,
      fileCount: 1,
      added: 2,
      removed: 0,
      uncommitted: 1,
      commitCount: 0,
      summary: 'Added the login form.\n\nIt validates the email.',
      tests: { status: 'failed', command: 'npm test', exitCode: 1 },
      actions: ['merge', 'open-pr', 'send-back', 'discard', 'dismiss'],
    });
    expect(card?.repos[0]).toMatchObject({ repo: 'web-front', branch: 'session/fix-login', base: 'main', baseSource: 'local', files: [{ path: 'login.txt', added: 2, removed: 0, uncommitted: true, binary: false }] });
    // In the Inbox as a "Review" item.
    const items = (await listInbox(s.w.store)).filter((item) => item.kind === 'review');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: card?.id, label: 'Review', status: 'need', title: '1 file changed (+2 −0)', detail: 'Tests failed (exit 1) · npm test', branches: [{ solution: 'web-front', branch: 'session/fix-login → main' }] });
    expect(s.events.some((event) => event.name === 'reviewsChanged')).toBe(true);

    // The same change set at the next turn end: no second card.
    await s.turn(session.id);
    expect(await s.w.store.reviews.countOpen()).toBe(1);

    // The agent commits: the open card is refreshed (still one), its commit listed.
    await s.w.git(dir, 'add', '-A');
    await s.w.git(dir, 'commit', '-q', '-m', 'Add the login form');
    await bash(s, session.id, 'npx vitest run', 'ok');
    await s.turn(session.id);
    const refreshed = await open(s);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ id: card?.id, uncommitted: 0, commitCount: 1, tests: { status: 'passed', command: 'npx vitest run', exitCode: 0 } });
    expect(refreshed[0]?.repos[0]?.commits[0]?.subject).toBe('Add the login form');
    expect(s.w.errors).toEqual([]);
  });

  it('raises nothing while Settings → Sessions has it off, and nothing for a closed session', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    s.enabled = false;
    await s.turn(session.id);
    expect(await open(s)).toEqual([]);
    s.enabled = true;
    await s.w.store.sessions.update(session.id, { closedAt: new Date().toISOString() });
    s.bus.publish('sessionUpdated', { id: session.id, status: 'run', closedAt: null } as unknown as Session);
    s.bus.publish('sessionUpdated', { id: session.id, status: 'idle', closedAt: '2026-10-08T10:00:00.000Z' } as unknown as Session);
    await s.service.idle();
    expect(await open(s)).toEqual([]);
  });

  it('Dismiss resolves it; the same changes raise nothing, a new change raises a new card', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    await s.turn(session.id);
    const [card] = await open(s);
    const dismissed = await s.service.act(card?.id as string, 'dismiss', undefined);
    expect(dismissed).toMatchObject({ state: 'resolved', outcome: 'dismissed', actions: [] });
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'dismissed' }]);
    expect(Object.keys(s.resolved[0] as object).sort()).toEqual(['outcome', 'sessionId']);
    await s.turn(session.id);
    expect(await open(s)).toEqual([]);
    await writeFile(path.join(dir, 'y.txt'), 'y\n');
    await s.turn(session.id);
    const again = await open(s);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(card?.id);
    // Recent reviews keep the dismissed one.
    expect((await s.service.list()).find((review) => review.id === card?.id)).toMatchObject({ state: 'resolved', outcome: 'dismissed' });
  });

  it('a pending card whose changes are gone is closed as dismissed when listed', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    await s.turn(session.id);
    await s.w.git(dir, 'clean', '-q', '-f');
    expect(await open(s)).toEqual([]);
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'dismissed' }]);
  });
});

describe('branch sessions: Merge, Open PR, Discard, Clean up (D79)', () => {
  it('Merge merges into the checked-out base (locally), then Clean up removes the worktree and the branch', async () => {
    const s = await setup();
    const { session, dir, worktree } = await branchSession(s);
    await s.w.commit(dir, 'feature.txt', 'feature\n', 'Add the feature');
    await s.turn(session.id);
    const [card] = await open(s);
    const merged = await s.service.act(card?.id as string, 'merge', undefined);
    expect(merged).toMatchObject({ state: 'cleanup', outcome: 'merged', actions: ['cleanup', 'dismiss'] });
    expect(merged.note).toContain('merged session/fix-login into main');
    expect(await readFile(path.join(s.w.web, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'merged' }]);
    // Never pushed: origin/main is where it was.
    expect(await s.w.git(s.w.web, 'rev-parse', 'origin/main')).not.toBe(await s.w.git(s.w.web, 'rev-parse', 'main'));
    // Shown in the Inbox as a Clean up item.
    expect((await listInbox(s.w.store)).find((item) => item.id === card?.id)).toMatchObject({ label: 'Clean up', status: 'done', title: 'Merged — clean up the worktree?' });
    // Nothing left to review at the next turn end.
    await s.turn(session.id);
    expect((await open(s)).map((review) => review.id)).toEqual([card?.id]);

    await expect(s.service.act(card?.id as string, 'cleanup', {})).rejects.toMatchObject({ status: 422 });
    const cleaned = await s.service.act(card?.id as string, 'cleanup', { confirm: true });
    expect(cleaned).toMatchObject({ state: 'resolved', outcome: 'merged' });
    expect(await exists(dir)).toBe(false);
    expect(await s.w.git(s.w.web, 'branch', '--list', 'session/fix-login')).toBe('');
    expect((await s.w.store.worktrees.get(worktree.id))?.removedAt).not.toBeNull();
    expect(s.resolved).toHaveLength(1);
  });

  it('Merge moves the base ref when the base is not checked out (merge commit), never touching the main checkout', async () => {
    const s = await setup();
    await s.w.git(s.w.web, 'switch', '-q', '-c', 'elsewhere');
    const { session, dir } = await branchSession(s, 'two-sided', 'origin/main');
    await s.w.commit(dir, 'feature.txt', 'feature\n');
    // main moves on meanwhile (another file): a real merge.
    const other = path.join(path.dirname(s.w.web), 'web-front-main');
    await s.w.git(s.w.web, 'worktree', 'add', '-q', other, 'main');
    await s.w.commit(other, 'other.txt', 'other\n');
    await s.w.git(s.w.web, 'worktree', 'remove', other);
    await s.turn(session.id);
    const [card] = await open(s);
    expect(card?.repos[0]).toMatchObject({ base: 'main', baseSource: 'origin' });
    const merged = await s.service.act(card?.id as string, 'merge', undefined);
    expect(merged.outcome).toBe('merged');
    const parents = (await s.w.git(s.w.web, 'log', '-1', '--format=%P', 'main')).split(' ');
    expect(parents).toHaveLength(2);
    expect(await s.w.git(s.w.web, 'log', '-1', '--format=%s', 'main')).toBe("Merge branch 'session/two-sided' into main");
    expect(await s.w.git(s.w.web, 'show', 'main:feature.txt')).toBe('feature');
    expect(await s.w.git(s.w.web, 'branch', '--show-current')).toBe('elsewhere');
    expect(await exists(path.join(s.w.web, 'feature.txt'))).toBe(false);
  });

  it('Merge is refused with the conflicting files, and with uncommitted changes in the worktree', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await s.w.commit(dir, 'src/app.txt', 'one\nTWO (branch)\nthree\n');
    await s.w.commit(s.w.web, 'src/app.txt', 'one\nTWO (main)\nthree\n');
    await s.turn(session.id);
    const [card] = await open(s);
    const mainBefore = await s.w.git(s.w.web, 'rev-parse', 'main');
    const refused = await s.service.act(card?.id as string, 'merge', undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ReviewError);
    expect(refused).toMatchObject({ status: 409, code: 'conflicts', conflicts: ['src/app.txt'] });
    expect(await s.w.git(s.w.web, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await s.w.git(s.w.web, 'status', '--porcelain')).toBe('');
    const after = (await open(s))[0];
    expect(after).toMatchObject({ state: 'pending', conflicts: ['src/app.txt'] });
    expect(after?.note).toContain('conflicts with main');
    expect(s.resolved).toEqual([]);

    await writeFile(path.join(dir, 'loose.txt'), 'loose\n');
    await expect(s.service.act(card?.id as string, 'merge', undefined)).rejects.toMatchObject({ status: 409, code: 'uncommitted' });
  });

  it('Open PR pushes the branch to origin and opens a PR with gh (a separate click); the card stays pending', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await s.w.setPullRequests({});
    await s.w.commit(dir, 'feature.txt', 'feature\n');
    await agentSays(s, session.id, 'Feature done.');
    await s.turn(session.id);
    const [card] = await open(s);
    const withPr = await s.service.act(card?.id as string, 'open-pr', undefined);
    expect(withPr).toMatchObject({ state: 'pending', actions: ['merge', 'send-back', 'discard', 'dismiss'] });
    expect(withPr.repos[0]?.prUrl).toBe('https://github.com/fake/web-front/pull/1');
    const bare = path.join(s.w.root, 'remotes', 'web-front.git');
    expect(await s.w.git(bare, 'rev-parse', 'refs/heads/session/fix-login')).toBe(await s.w.git(dir, 'rev-parse', 'HEAD'));
    const create = (await s.w.ghCalls()).find((call) => call.argv[0] === 'pr' && call.argv[1] === 'create');
    expect(create?.argv).toEqual(['pr', 'create', '--base', 'main', '--head', 'session/fix-login', '--title', 'Fix the login', '--body', 'Feature done.\n\n---\nOpened from a Switchboard review card.']);
    expect(s.resolved).toEqual([]);
  });

  it('Discard (confirmed) resets the worktree to its base, then offers Clean up', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await s.w.commit(dir, 'feature.txt', 'feature\n');
    await writeFile(path.join(dir, 'scratch.txt'), 'scratch\n');
    await s.turn(session.id);
    const [card] = await open(s);
    await expect(s.service.act(card?.id as string, 'discard', undefined)).rejects.toMatchObject({ status: 422, code: 'invalid' });
    const discarded = await s.service.act(card?.id as string, 'discard', { confirm: true });
    expect(discarded).toMatchObject({ state: 'cleanup', outcome: 'discarded' });
    expect(await exists(path.join(dir, 'feature.txt'))).toBe(false);
    expect(await exists(path.join(dir, 'scratch.txt'))).toBe(false);
    expect(await s.w.git(dir, 'rev-parse', 'HEAD')).toBe(await s.w.git(s.w.web, 'rev-parse', 'main'));
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'discarded' }]);
    await s.service.act(card?.id as string, 'cleanup', { confirm: true });
    expect(await exists(dir)).toBe(false);
  });

  it('Send back sends the comment to the session and resolves the card as sent back', async () => {
    const s = await setup();
    const { session, dir } = await branchSession(s);
    await writeFile(path.join(dir, 'x.txt'), 'x\n');
    await s.turn(session.id);
    const [card] = await open(s);
    await expect(s.service.act(card?.id as string, 'send-back', { comment: '  ' })).rejects.toMatchObject({ status: 422 });
    const back = await s.service.act(card?.id as string, 'send-back', { comment: 'Add a test for the empty email.' });
    expect(back).toMatchObject({ state: 'resolved', outcome: 'sent-back' });
    expect(s.sent).toEqual([{ sessionId: session.id, text: 'Review: your changes were sent back with this comment:\n\nAdd a test for the empty email.' }]);
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'sent-back' }]);
    await expect(s.service.act(card?.id as string, 'merge', undefined)).rejects.toMatchObject({ status: 409, code: 'not-offered' });
    await expect(s.service.act(card?.id as string, 'explode', undefined)).rejects.toMatchObject({ status: 400 });
    await expect(s.service.act('nope', 'merge', undefined)).rejects.toMatchObject({ status: 404 });
  });
});

describe('folder sessions: Commit, Discard (D79)', () => {
  it('Commit commits every current change with the edited message; nothing is raised again for it', async () => {
    const s = await setup();
    const { session } = await folderSession(s);
    await writeFile(path.join(s.w.mobile, 'README.md'), 'hello\nworld\n');
    await writeFile(path.join(s.w.mobile, 'new.txt'), 'new\n');
    await agentSays(s, session.id, '## Tidied the readme\n\n- added a line');
    await s.turn(session.id);
    const [card] = await open(s);
    expect(card).toMatchObject({ mode: 'folder', fileCount: 2, uncommitted: 2, actions: ['commit', 'send-back', 'discard', 'dismiss'], commitMessage: 'Tidied the readme\n\n- added a line' });
    expect(card?.repos[0]).toMatchObject({ repo: 'mobile', worktreeId: null, branch: 'main' });
    await expect(s.service.act(card?.id as string, 'commit', {})).rejects.toMatchObject({ status: 422 });
    const committed = await s.service.act(card?.id as string, 'commit', { message: 'Tidy the readme' });
    expect(committed).toMatchObject({ state: 'resolved', outcome: 'committed' });
    expect(await s.w.git(s.w.mobile, 'log', '-1', '--format=%s')).toBe('Tidy the readme');
    expect(await s.w.git(s.w.mobile, 'status', '--porcelain')).toBe('');
    expect(s.resolved).toEqual([{ sessionId: session.id, outcome: 'committed' }]);
    await s.turn(session.id);
    expect(await open(s)).toEqual([]);
  });

  it('a folder session that committed everything itself gets a card with its commits (Send back / Dismiss)', async () => {
    const s = await setup();
    const { session } = await folderSession(s);
    await s.w.commit(s.w.mobile, 'done.txt', 'done\n', 'Agent commit');
    await s.turn(session.id);
    const [card] = await open(s);
    expect(card).toMatchObject({ mode: 'folder', uncommitted: 0, commitCount: 1, fileCount: 1, actions: ['send-back', 'dismiss'] });
    expect(card?.repos[0]?.commits[0]?.subject).toBe('Agent commit');
  });

  it('Discard (confirmed) reverts the card’s uncommitted changes and deletes its new files', async () => {
    const s = await setup();
    const { session } = await folderSession(s);
    await writeFile(path.join(s.w.mobile, 'README.md'), 'changed\n');
    await writeFile(path.join(s.w.mobile, 'new.txt'), 'new\n');
    await s.turn(session.id);
    const [card] = await open(s);
    const discarded = await s.service.act(card?.id as string, 'discard', { confirm: true });
    expect(discarded).toMatchObject({ state: 'resolved', outcome: 'discarded' });
    expect(await readFile(path.join(s.w.mobile, 'README.md'), 'utf8')).toBe('hello\n');
    expect(await exists(path.join(s.w.mobile, 'new.txt'))).toBe(false);
    expect(await s.w.git(s.w.mobile, 'status', '--porcelain')).toBe('');
  });
});
