/**
 * D152 follow-up 2026-11-05 (`docs/worktrees.md` → *Which repositories* → *Works in*):
 * a workspace session rooted at a folder that is no git repo, which only READ files
 * and ran shell commands in one repo, works in that repo. Real temp git repos
 * (`tests/helpers/git.ts`): the nearest `.git` holds a path (a nested repo wins, never
 * above the session's folder), read-only layout folders and paths outside the folder
 * are left out, edits rank above commands above reads, the answer is cached until a
 * new event arrives, and nothing of it reaches the Diff / checkpoints' repo set.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../../src/server/db/repos/sessions.ts';
import { WORKS_IN_EVENT_WINDOW } from '../../../src/server/worktrees/works-in.ts';
import { type GitWorld, makeGitWorld } from '../../helpers/git.ts';

let world: GitWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
});

async function workspaceSession(w: GitWorld, solutions: string[] = []): Promise<SessionRecord> {
  return w.store.sessions.create({ name: 'acme-reader', claudeSessionId: randomUUID(), solutions, worktrees: false, root: w.workspace, rootKind: 'workspace', cwd: w.workspace });
}

async function tool(w: GitWorld, sessionId: string, name: string, input: Record<string, unknown>, result?: string): Promise<void> {
  await w.store.events.append({ sessionId, kind: 'impl', label: name, payload: { type: 'tool', name, toolUseId: randomUUID(), input, ...(result !== undefined ? { result } : {}) } });
}

describe('Works in: repos a session only read in or ran commands in', () => {
  it('a non-git workspace root with two repos: the one it read and ran commands in is listed, the other is not', async () => {
    const w = (world = await makeGitWorld());
    const m = w.manager();
    const session = await workspaceSession(w);
    // Before anything: no repo.
    expect((await m.worksIn(session.id)).repos).toEqual([]);

    await tool(w, session.id, 'Read', { file_path: path.join(w.web, 'README.md') });
    await tool(w, session.id, 'Grep', { pattern: 'app', path: path.join(w.web, 'src') });
    await tool(w, session.id, 'Bash', { command: `cd "${w.web}" && git status && dotnet build` });
    await tool(w, session.id, 'Bash', { command: 'git -C microfrontends/web-front log --oneline -3' });

    const answer = await m.worksIn(session.id);
    expect(answer.repos).toEqual([{ name: 'web-front', path: w.web, kind: 'main', source: 'commands', branch: 'main', remoteUrl: expect.any(String), evidence: ['commands', 'read'], mainPath: w.web }]);
    // The Diff and checkpoints' set is unchanged: reads never put a repo in the diff.
    expect((await m.repos.of(session)).inPlace).toEqual([]);
  });

  it('ranks an edited repo above one it only ran commands in, above one it only read; nested repos and the root bound hold', async () => {
    const w = (world = await makeGitWorld());
    const m = w.manager();
    const session = await workspaceSession(w);
    // A repo nested in web-front (its own .git): a path inside it is its, not web-front's.
    const nested = await w.makeRepo(path.join(w.web, 'packages', 'acme-ui'));
    // A repo under a read-only layout folder, and one outside the workspace.
    const archived = await w.makeRepo(path.join(w.workspace, 'deprecated', 'old-front'));
    const outside = await w.makeRepo(path.join(w.root, 'elsewhere', 'acme-tools'));

    for (let i = 0; i < 5; i++) await tool(w, session.id, 'Read', { file_path: path.join(nested, 'README.md') });
    await tool(w, session.id, 'Bash', { command: `cd "${w.mobile}" && npm test` });
    await tool(w, session.id, 'Read', { file_path: path.join(w.web, 'README.md') });
    await mkdir(path.join(w.web, 'src'), { recursive: true });
    await writeFile(path.join(w.web, 'src', 'new.txt'), 'x\n');
    await tool(w, session.id, 'Edit', { file_path: path.join(w.web, 'src', 'new.txt') });
    await tool(w, session.id, 'Read', { file_path: path.join(archived, 'README.md') });
    await tool(w, session.id, 'Read', { file_path: path.join(outside, 'README.md') });
    await tool(w, session.id, 'Glob', { pattern: '**/*.txt', path: w.workspace }, `${path.join(w.mobile, 'src', 'app.txt')}\n`);
    // A Windows path on a Mac is no path here (and the reverse).
    await tool(w, session.id, 'Read', { file_path: 'D:\\code\\ws\\mobile\\App.xaml' });

    const found = await m.worksInFound(session);
    expect(found.map((repo) => [repo.name, repo.source, repo.evidence])).toEqual([
      ['web-front', 'edited', ['edited', 'read']],
      ['acme-ui', 'read', ['read']],
      ['mobile', 'commands', ['commands', 'read']],
    ]);
    expect(found.map((repo) => repo.top)).toEqual([w.web, nested, w.mobile]);
  });

  it('is cached until a new event arrives, and reads only the newest events', async () => {
    const w = (world = await makeGitWorld());
    const m = w.manager();
    const session = await workspaceSession(w);
    await tool(w, session.id, 'Read', { file_path: path.join(w.web, 'README.md') });
    const first = await m.worksInEvidence.of(session, { root: w.workspace, worktrees: [] });
    expect(first.map((entry) => entry.top)).toEqual([w.web]);
    // Same history: the same answer object (no new read).
    expect(await m.worksInEvidence.of(session, { root: w.workspace, worktrees: [] })).toBe(first);
    // A new event: read again.
    await tool(w, session.id, 'Bash', { command: 'cd mobile && ls' });
    const second = await m.worksInEvidence.of(session, { root: w.workspace, worktrees: [] });
    expect(second.map((entry) => entry.top)).toEqual([w.web, w.mobile]);
    // The window: the read of mobile pushed out by newer events is no longer seen.
    expect(WORKS_IN_EVENT_WINDOW).toBeGreaterThan(1000);
    const rows = await w.store.events.toolCallsInNewest(session.id, ['Read', 'Bash'], 1, 100);
    expect(rows.map((row) => row.name)).toEqual(['Bash']);
  });
});

describe('D152 follow-up (2.4.23 report): repos outside the workspace root, and folders that are never repos', () => {
  it('never lists a CLI folder (`.claude` kept in git, `.claude/worktrees` itself) or a non-repo folder as a repo', async () => {
    const w = (world = await makeGitWorld());
    const m = w.manager();
    const session = await workspaceSession(w);
    // A `~/.claude` kept in git (dotfiles) that the agent wrote a memory note into, and the workspace's own `.claude` folder.
    const dotClaude = await w.makeRepo(path.join(w.root, 'home', '.claude'));
    await tool(w, session.id, 'Write', { file_path: path.join(dotClaude, 'notes.md') });
    await mkdir(path.join(w.workspace, '.claude', 'worktrees', 'old', 'src'), { recursive: true });
    await mkdir(path.join(w.workspace, '.claude', 'worktrees', '.git'), { recursive: true });
    await tool(w, session.id, 'Read', { file_path: path.join(w.workspace, '.claude', 'settings.local.json') });
    await tool(w, session.id, 'Read', { file_path: path.join(w.workspace, '.claude', 'worktrees', 'old', 'src', 'a.ts') });
    await tool(w, session.id, 'Bash', { command: `cd "${path.join(w.workspace, '.claude', 'tmp')}" && ls` });
    await tool(w, session.id, 'Read', { file_path: path.join(w.web, 'README.md') });

    const found = await m.worksInFound(session);
    expect(found.map((repo) => repo.name)).toEqual(['web-front']);
    expect((await m.repos.of(session)).inPlace.map((repo) => repo.name)).toEqual([]);
    expect(JSON.stringify(await m.worksIn(session.id))).not.toContain('.claude');
  });

  it('counts a repo outside the root when a command worked in it (cd, git -C), never for a read or a path word there; a moved-in extra folder counts', async () => {
    const w = (world = await makeGitWorld());
    const m = w.manager();
    const tools = await w.makeRepo(path.join(w.root, 'personal', 'tool-repo'));
    const notes = await w.makeRepo(path.join(w.root, 'personal', 'notes-repo'));
    const carried = await w.makeRepo(path.join(w.root, 'personal', 'carried-repo'));
    const session = await w.store.sessions.create({ name: 'acme-outside', claudeSessionId: randomUUID(), solutions: [], worktrees: false, root: w.workspace, rootKind: 'workspace', cwd: w.workspace, extraDirs: [carried] });
    await tool(w, session.id, 'Bash', { command: `cd "${tools}" && npm test` });
    await tool(w, session.id, 'Bash', { command: `git -C "${tools}" status --short` });
    await tool(w, session.id, 'Read', { file_path: path.join(notes, 'README.md') });
    await tool(w, session.id, 'Bash', { command: `cat ${path.join(notes, 'README.md')}` });
    await tool(w, session.id, 'Read', { file_path: path.join(carried, 'README.md') });

    const found = await m.worksInFound(session);
    expect(found.map((repo) => [repo.name, repo.source, repo.evidence, repo.counts.commands])).toEqual([
      ['carried-repo', 'extra', ['read'], 0],
      ['tool-repo', 'commands', ['commands'], 2],
    ]);
  });
});
