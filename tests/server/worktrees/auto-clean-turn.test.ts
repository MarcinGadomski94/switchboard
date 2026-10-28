import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTO_CLEAN_SETTING } from '../../../src/core/auto-clean.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import type { SessionPlace } from '../../../src/server/supervisor/supervisor.ts';
import { wireAutoClean } from '../../../src/server/worktrees/auto-clean-wire.ts';
import { GIT_SPY_COMMAND, type GitWorld, makeGitWorld } from '../../helpers/git.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D145 end to end on the server: a real supervisor with fake-claude in a repo with a bare
 * "origin". The agent (Claude Code's `EnterWorktree`, played by `[fake:tool EnterWorktree …]`)
 * made `.claude/worktrees/x` on `worktree-x`, which was merged into dev; at its turn's end the
 * worktree becomes Switchboard's (adopted) and is cleaned up: the folder, the local branch and
 * `origin/worktree-x` are gone and the chat has the divider. A dirty one stays with its reason;
 * a worktree made by hand is never touched; the setting off changes nothing.
 */

let sw: SupervisorWorld | undefined;
let g: GitWorld | undefined;
let stopWiring: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopWiring?.();
  stopWiring = undefined;
  await sw?.cleanup();
  sw = undefined;
  g = undefined;
});

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

interface World {
  readonly s: SupervisorWorld;
  readonly g: GitWorld;
  readonly repo: string;
  readonly bare: string;
  readonly place: SessionPlace;
  readonly lines: string[];
}

async function setup(): Promise<World> {
  sw = await makeSupervisorWorld();
  g = await makeGitWorld({ root: sw.root, workspace: sw.workspace, store: sw.store, baseEnv: sw.env });
  const repo = g.web;
  await g.git(repo, 'switch', '-q', '-c', 'dev');
  await g.git(repo, 'push', '-q', '-u', 'origin', 'dev');
  const lines: string[] = [];
  const s = sw;
  const wired = wireAutoClean({
    store: s.store,
    sessions: s.supervisor,
    worktrees: { on: () => () => undefined },
    gitCommand: GIT_SPY_COMMAND,
    env: g.env,
    processCwds: async () => [],
    log: (line) => lines.push(line),
    onError: (error) => s.errors.push(error),
    service: { settleMs: 50 },
  });
  stopWiring = async () => {
    wired.off();
    await wired.autoClean.stop();
    await wired.agentMade.close();
  };
  return { s, g, repo, bare: path.join(g.root, 'remotes', 'web-front.git'), place: { folder: { id: null, path: repo, root: repo, kind: 'repo' }, cwd: repo }, lines };
}

/** What Claude Code's EnterWorktree does: `.claude/worktrees/<name>` on `worktree-<name>`; then a commit, pushed. */
async function claudeWorktree(w: World, name: string): Promise<string> {
  const dir = path.join(w.repo, '.claude', 'worktrees', name);
  await w.g.git(w.repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir);
  await w.g.commit(dir, `${name}.txt`, `${name}\n`);
  await w.g.git(dir, 'push', '-q', '-u', 'origin', `worktree-${name}`);
  return dir;
}

async function mergeIntoDev(w: World, branch: string): Promise<void> {
  await w.g.git(w.repo, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
  await w.g.git(w.repo, 'push', '-q', 'origin', 'dev');
}

async function startSession(w: World, name: string): Promise<SessionRecord> {
  const session = await w.s.supervisor.start(newSession({ name, task: 'Reply OK.', solutions: [] }), w.place);
  await waitForStatus(w.s.store, session.id, ['done', 'idle'], 20_000);
  return session;
}

async function enterWorktreeTurn(w: World, sessionId: string, name: string): Promise<void> {
  await w.s.supervisor.sendMessage(sessionId, `Work in a worktree. [fake:tool EnterWorktree {"name":"${name}"}]`, 'user');
  await until(async () => (await w.s.store.events.list(sessionId)).filter((event) => (event.payload as { type?: string } | null)?.type === 'result').length >= 2, 'the second turn', 20_000);
}

function divider(event: EventRecord): boolean {
  return (event.payload as { action?: string } | null)?.action === 'worktree-cleaned';
}

describe('the automatic clean-up after a turn (D145)', { timeout: 90_000 }, () => {
  it("an agent-made .claude/worktrees/x merged into dev: after the turn the folder, the local and the remote branch are gone; the chat says so", async () => {
    const w = await setup();
    const session = await startSession(w, 'agent-x');
    const dir = await claudeWorktree(w, 'x');
    await mergeIntoDev(w, 'worktree-x');
    // A worktree the developer made by hand, merged too: never Switchboard's.
    const handmade = path.join(w.repo, '..', 'web-front-handmade');
    await w.g.git(w.repo, 'worktree', 'add', '-q', '-b', 'handmade', handmade);
    await w.g.commit(handmade, 'h.txt', 'h\n');
    await mergeIntoDev(w, 'handmade');

    await enterWorktreeTurn(w, session.id, 'x');
    const event = await until(async () => (await w.s.store.events.list(session.id)).find(divider), 'the divider', 30_000);
    expect(event.label).toBe('Cleaned up worktree x: merged into dev; removed the folder, the local branch and origin/worktree-x');
    expect(event.kind).toBe('text');
    expect(await exists(dir)).toBe(false);
    expect(await w.g.git(w.repo, 'branch', '--list', 'worktree-x')).toBe('');
    expect(await w.g.git(w.bare, 'branch', '--list', 'worktree-x')).toBe('');
    // Adopted for the session, then marked removed.
    const rows = await w.s.store.worktrees.list({ sessionId: session.id, includeRemoved: true });
    expect(rows.map((row) => [path.basename(row.path), row.branch, row.removedAt !== null])).toEqual([['x', 'worktree-x', true]]);
    // The hand-made worktree: untouched, never registered.
    expect(await exists(handmade)).toBe(true);
    expect(await w.g.git(w.repo, 'branch', '--list', 'handmade')).not.toBe('');
    expect(await w.s.store.worktrees.getLiveByPath(await import('node:fs/promises').then((fs) => fs.realpath(handmade)))).toBeNull();
    expect(w.lines.some((line) => line.startsWith('[auto-clean] Cleaned up worktree x'))).toBe(true);
  });

  it('a dirty one stays with its reason (and no divider); the setting off: nothing is adopted or removed', async () => {
    const w = await setup();
    const session = await startSession(w, 'agent-dirty');
    const dir = await claudeWorktree(w, 'd');
    await mergeIntoDev(w, 'worktree-d');
    await import('node:fs/promises').then((fs) => fs.writeFile(path.join(dir, 'wip.txt'), 'not committed\n'));
    await enterWorktreeTurn(w, session.id, 'd');
    await until(async () => w.lines.some((line) => line.includes(`kept ${dir}: 1 uncommitted change`)), 'the kept line', 30_000);
    expect(await exists(dir)).toBe(true);
    expect((await w.s.store.events.list(session.id)).some(divider)).toBe(false);

    await w.s.store.settings.set(AUTO_CLEAN_SETTING, false);
    const off = await startSession(w, 'agent-off');
    const offDir = await claudeWorktree(w, 'o');
    await mergeIntoDev(w, 'worktree-o');
    await enterWorktreeTurn(w, off.id, 'o');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await exists(offDir)).toBe(true);
    expect(await w.s.store.worktrees.list({ sessionId: off.id, includeRemoved: true })).toEqual([]);
    expect((await w.s.store.events.list(off.id)).some(divider)).toBe(false);
  });
});
