import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_WORKTREES_SCANNED_SETTING } from '../../../src/core/auto-clean.ts';
import { AgentWorktrees } from '../../../src/server/worktrees/agent-made.ts';
import { GIT_SPY_COMMAND, type GitWorld, makeGitWorld } from '../../helpers/git.ts';

/**
 * D145 (D38 extended): which worktrees become Switchboard's because its agent made them. The
 * evidence is the session's stored tool calls; a worktree is adopted only when a call names it,
 * git lists it in a repository of that session and it was made after the session started.
 */

let world: GitWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

async function rig(): Promise<{ w: GitWorld; scanner: AgentWorktrees }> {
  world = await makeGitWorld();
  const w = world;
  const scanner = new AgentWorktrees({ store: w.store, gitCommand: GIT_SPY_COMMAND, env: w.env, onError: (error) => w.errors.push(error), window: 3 });
  return { w, scanner };
}

async function repoSession(w: GitWorld, name: string, extra: { hooked?: boolean } = {}): Promise<string> {
  const created = await w.store.sessions.create({ name, claudeSessionId: `c-${name}`, root: w.web, rootKind: 'repo', cwd: w.web, ...(extra.hooked ? { hooked: true } : {}) });
  return created.id;
}

async function tool(w: GitWorld, sessionId: string, name: string, input: Record<string, unknown>, result?: string): Promise<number> {
  const event = await w.store.events.append({ sessionId, kind: 'tool', label: name, payload: { type: 'tool', name, toolUseId: `t-${Math.random()}`, input, ...(result === undefined ? {} : { result }) } });
  return event.id;
}

async function addWorktree(w: GitWorld, dir: string, branch: string): Promise<string> {
  await w.git(w.web, 'worktree', 'add', '-q', '-b', branch, dir);
  return realpath(dir);
}

describe('AgentWorktrees (D145)', () => {
  it("adopts Claude Code's .claude/worktrees/<name> its EnterWorktree named, once; never a hand-made one", async () => {
    const { w, scanner } = await rig();
    const id = await repoSession(w, 'agent');
    const made = await addWorktree(w, path.join(w.web, '.claude', 'worktrees', 'x'), 'worktree-x');
    const handmade = await addWorktree(w, path.join(w.web, '..', 'web-front-mine'), 'mine');
    await tool(w, id, 'EnterWorktree', { name: 'x' }, 'ok');
    // Many unrelated events: read in windows.
    for (let i = 0; i < 7; i++) await tool(w, id, 'Bash', { command: 'git status' }, '');
    const adopted = await scanner.scan();
    expect(adopted.map((row) => [row.path, row.branch, row.sessionId, row.baseRef, row.repo])).toEqual([[made, 'worktree-x', id, 'main', 'web-front']]);
    expect(await w.store.worktrees.getLiveByPath(handmade)).toBeNull();
    expect(await w.store.settings.get(AGENT_WORKTREES_SCANNED_SETTING)).toBe(await w.store.events.maxId());
    // Nothing new: nothing adopted again.
    expect(await scanner.scan()).toEqual([]);
  });

  it('a Bash `git worktree add` names its folder or branch, in any session kind', async () => {
    const { w, scanner } = await rig();
    const id = await repoSession(w, 'basher');
    const dir = await addWorktree(w, path.join(w.web, '..', 'web-front-wt-basher'), 'PROJ-7-x');
    await tool(w, id, 'Bash', { command: 'git worktree add -b PROJ-7-x ../web-front-wt-basher' }, 'Preparing worktree');
    expect((await scanner.scan()).map((row) => row.path)).toEqual([dir]);
  });

  it("an Agent run with isolation \"worktree\" is read again until its result names the worktree", async () => {
    const { w, scanner } = await rig();
    const id = await repoSession(w, 'iso');
    const eventId = await tool(w, id, 'Agent', { prompt: 'p', isolation: 'worktree' });
    const dir = await addWorktree(w, path.join(w.web, '.claude', 'worktrees', 'agent-a1'), 'worktree-agent-a1');
    expect(await scanner.scan()).toEqual([]);
    await w.store.events.update(eventId, { payload: { type: 'tool', name: 'Agent', toolUseId: 't', input: { prompt: 'p', isolation: 'worktree' }, result: `Changes kept in worktree ${dir} (branch worktree-agent-a1)` } });
    expect((await scanner.scan()).map((row) => row.path)).toEqual([dir]);
  });

  it('never a terminal (hooked) session, a worktree made before the session started, or the main checkout', async () => {
    const { w, scanner } = await rig();
    const hooked = await repoSession(w, 'terminal', { hooked: true });
    await addWorktree(w, path.join(w.web, '.claude', 'worktrees', 'h'), 'worktree-h');
    await tool(w, hooked, 'EnterWorktree', { name: 'h' }, 'ok');
    // Made long before this session (its start is moved a day later).
    await addWorktree(w, path.join(w.web, '.claude', 'worktrees', 'old'), 'worktree-old');
    const later = await repoSession(w, 'later');
    w.store.db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(new Date(Date.now() + 86_400_000).toISOString(), later);
    await tool(w, later, 'EnterWorktree', { name: 'old' }, 'ok');
    await tool(w, later, 'Bash', { command: `git worktree add -b main ${w.web}` }, '');
    expect(await scanner.scan()).toEqual([]);
    expect(await w.store.worktrees.list()).toEqual([]);
  });
});
