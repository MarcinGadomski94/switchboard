import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Folder, Session } from '../../../src/core/api.ts';
import type { TakeoverPreview, TakeoverRun } from '../../../src/core/takeover.ts';
import type { SessionWorksIn } from '../../../src/core/workspace-move.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, removeWorld, settle, startWorkspaceSession, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D152 (`docs/peers.md` → *A complete move (D152)*), two real Switchboards (the pc
 * "a" and the mac "b"), fake CLIs, temp repos, local bare repos as the remotes. The
 * pc's workspace session moves to a mac that has no workspace: the developer creates
 * the workspace root there, points one repo at an existing checkout and has the other
 * cloned; the workspace's own files travel over the paired link (a secret only after
 * confirming, a different file on the mac never overwritten); the receiver refuses
 * names that leave the root, files over the caps and an unconfirmed secret; and which
 * repos a session works in comes from its history.
 */

let tmp: string;
let world: TakeoverWorld;
/** The mac's code folder (the parent of its saved `gamma`: an allowed place). */
let code: string;
/** The pc's workspace root. */
let ws: string;

const SECRET_SETTINGS = '{\n  "env": { "ACME_API_TOKEN": "synthetic-test-token-1234567890" }\n}\n';

beforeAll(async () => {
  tmp = await makeTempDir('takeover-complete-move');
  world = await takeoverWorld(tmp, { aRepos: { alpha: true, workspace: true }, bRepos: { gamma: true } });
  code = await realpath(path.dirname(world.paths.b.gamma));
  ws = world.paths.a.workspace;
  // The workspace's own files on the pc: a plain doc, two secret-looking files, one over the cap, a link out of the root.
  await mkdir(path.join(ws, 'docs'), { recursive: true });
  await writeFile(path.join(ws, 'docs', 'plan.md'), '# Plan\n\nShip the move.\n');
  await mkdir(path.join(ws, '.claude'), { recursive: true });
  await writeFile(path.join(ws, '.claude', 'settings.local.json'), SECRET_SETTINGS);
  await writeFile(path.join(ws, '.env'), 'ACME_PASSWORD=synthetic-password-0987654321\n');
  await mkdir(path.join(ws, 'notes'), { recursive: true });
  await writeFile(path.join(ws, 'notes', 'big.txt'), 'x'.repeat(1024 * 1024 + 10));
  await writeFile(path.join(tmp, 'outside.txt'), 'outside the workspace\n');
  await symlink(path.join(tmp, 'outside.txt'), path.join(ws, 'linked.md'));
}, 120_000);

afterAll(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  await removeWorld(tmp);
});

async function preview(body: Record<string, unknown>): Promise<TakeoverPreview> {
  const answer = await world.a.call('POST', '/api/takeover/preview', body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as TakeoverPreview;
}

async function runOn(body: Record<string, unknown>): Promise<TakeoverRun> {
  const started = await world.a.call('POST', '/api/takeover', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as TakeoverRun).id;
  return waitFor('the take-over to end', async () => {
    const current = (await world.a.call('GET', `/api/takeover/runs/${id}`)).body as TakeoverRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

describe('D152: a workspace session whose workspace does not exist on the target', () => {
  let newWs: string;
  let frontOnMac: string;

  it('creates the workspace root at the picked folder, uses an existing checkout for one repo, clones the other into its place, copies the ticked files', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-move', ['front', 'back']);
    newWs = path.join(code, 'new-ws');
    frontOnMac = path.join(code, 'elsewhere', 'front-copy');
    await mkdir(path.dirname(frontOnMac), { recursive: true });
    await world.git(path.dirname(frontOnMac), 'clone', '-q', world.remotes.front, frontOnMac);
    frontOnMac = await realpath(frontOnMac);

    const base = { sessionId: session.id, targetMachine: world.bId };
    // Without a folder, the mac has no workspace for it: the old blocker.
    const before = await preview(base);
    expect(before.ok).toBe(false);
    expect(before.blockers.join('\n')).toContain('no saved workspace folder on this machine holds any of this session');

    // The listing of the workspace's own files: regular files outside the repos, links never followed.
    const listed = before.source.workspaceFiles;
    expect(listed).toBeTruthy();
    const byName = Object.fromEntries((listed?.files ?? []).map((file) => [file.name, file]));
    expect(Object.keys(byName).sort()).toEqual(['.claude/settings.local.json', '.env', 'AGENTS.md', 'docs/plan.md', 'notes/big.txt']);
    expect(byName['docs/plan.md']).toMatchObject({ secret: null, refused: null, binary: false });
    expect(byName['.claude/settings.local.json']?.secret).toBeTruthy();
    expect(byName['.env']?.secret).toBeTruthy();
    expect(byName['notes/big.txt']?.refused).toContain('over 1.0 MB');
    // Never a value in the listing.
    expect(JSON.stringify(listed)).not.toContain('synthetic-test-token');

    const placement = { roots: [], newWorkspace: { path: newWs }, repoPaths: { front: frontOnMac } };
    const ready = await preview({ ...base, placement, workspaceFiles: { copy: ['docs/plan.md'] } });
    expect(ready.blockers).toEqual([]);
    expect(ready.ok).toBe(true);
    expect(ready.target.workspaceRoot).toMatchObject({ path: newWs, exists: false, ok: true, needsConfirm: false });
    const repos = Object.fromEntries(ready.target.repos.map((repo) => [repo.name, repo]));
    expect(repos['front']).toMatchObject({ action: 'use', matchedPath: frontOnMac });
    expect(repos['back']).toMatchObject({ action: 'clone', cloneTo: path.join(newWs, 'back') });
    expect(ready.target.workspaceFiles?.every((entry) => entry.state === 'new')).toBe(true);
    expect(ready.target.folder).toMatchObject({ path: newWs, kind: 'workspace' });

    const run = await runOn({ ...base, placement, workspaceFiles: { copy: ['docs/plan.md'] } });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.state).toBe('done');
    // The root AGENTS.md comes along (it makes the new folder a workspace); the ticked doc too; nothing else.
    expect(run.workspaceFiles).toMatchObject({ copied: expect.arrayContaining(['AGENTS.md', 'docs/plan.md']), conflicts: [], secret: 0 });
    expect(run.workspaceFiles?.copied).toHaveLength(2);
    expect(run.log.join('\n')).toContain('copied 2 workspace files (0 marked secret) to mac-laptop');
    expect(await readFile(path.join(newWs, 'docs', 'plan.md'), 'utf8')).toBe('# Plan\n\nShip the move.\n');
    expect(await readFile(path.join(newWs, 'AGENTS.md'), 'utf8')).toBe('# AGENTS.md (Workspace Router)\n');
    await expect(lstat(path.join(newWs, '.env'))).rejects.toThrow();
    await expect(lstat(path.join(newWs, '.claude', 'settings.local.json'))).rejects.toThrow();
    await expect(lstat(path.join(newWs, 'linked.md'))).rejects.toThrow();
    // back was cloned at its place in the layout; front is used where it is.
    expect(await world.git(path.join(newWs, 'back'), 'remote', 'get-url', 'origin')).toBe(world.remotes.back);
    const created = ((await world.b.call('GET', '/api/sessions')).body as Session[]).find((entry) => entry.movedFrom?.sessionId === session.id) as Session;
    expect(created.cwd).toBe(newWs);
    const folders = (await world.b.call('GET', '/api/folders')).body as Folder[];
    expect(folders.find((folder) => folder.path === newWs)?.kind).toBe('workspace');

    // Remembered for the next move: the created root is now one of the folders.
    const next = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-move-2', ['front', 'back']);
    const again = await preview({ sessionId: next.id, targetMachine: world.bId });
    expect(again.remembered).toBe(true);
    expect(again.placement).toEqual({ roots: [newWs], repoPaths: { front: frontOnMac } });
  });

  it('copies a secret-marked file only after confirming, never overwrites a different file, and reports both', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-secret', ['front', 'back']);
    await writeFile(path.join(newWs, 'docs', 'plan.md'), 'changed on the mac\n');
    const base = { sessionId: session.id, targetMachine: world.bId, placement: { roots: [newWs], repoPaths: { front: frontOnMac } } };
    const copy = ['.claude/settings.local.json', 'docs/plan.md'];

    // Ticked but not confirmed: blocked before anything moves.
    const unconfirmed = await preview({ ...base, workspaceFiles: { copy } });
    expect(unconfirmed.ok).toBe(false);
    expect(unconfirmed.blockers.join('\n')).toContain('.claude/settings.local.json looks like it holds secrets: confirm copying it first');
    const states = Object.fromEntries((unconfirmed.target.workspaceFiles ?? []).map((entry) => [entry.name, entry.state]));
    expect(states).toMatchObject({ 'AGENTS.md': 'same', 'docs/plan.md': 'conflict', '.claude/settings.local.json': 'new' });
    const refused = await runOn({ ...base, workspaceFiles: { copy } });
    expect(refused.state).toBe('failed');
    expect(refused.error?.step).toBe('checks');
    expect(refused.error?.message).toContain('looks like it holds secrets');
    await expect(lstat(path.join(newWs, '.claude', 'settings.local.json'))).rejects.toThrow();

    // Confirmed: copied (owner-only), the different plan.md skipped and reported.
    const run = await runOn({ ...base, workspaceFiles: { copy, confirmSecrets: true } });
    expect(run.error, JSON.stringify(run)).toBeNull();
    expect(run.workspaceFiles).toMatchObject({ copied: ['.claude/settings.local.json'], conflicts: ['docs/plan.md'], secret: 1 });
    expect(await readFile(path.join(newWs, '.claude', 'settings.local.json'), 'utf8')).toBe(SECRET_SETTINGS);
    if (process.platform !== 'win32') expect((await stat(path.join(newWs, '.claude', 'settings.local.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(newWs, 'docs', 'plan.md'), 'utf8')).toBe('changed on the mac\n');
    const log = run.log.join('\n');
    expect(log).toContain('copied 1 workspace file (1 marked secret) to mac-laptop');
    expect(log).not.toContain('synthetic-test-token');
  });

  it('the receiver refuses names that leave the root, a file over the cap and an unconfirmed secret', async () => {
    const opId = 'f00dfeed-0000-4000-8000-000000000152';
    const chunk = (name: unknown, text: string, extra: Record<string, unknown> = {}) => {
      const data = Buffer.from(text);
      return world.a.call('POST', `/api/machines/${world.bId}/api/takeover/target/workspace-chunk`, { opId, name, size: data.length, sha256: 'x', offset: 0, data: data.toString('base64'), ...extra });
    };
    for (const name of ['../evil.txt', 'docs/../../evil.txt', '/etc/evil', 'C:/evil.txt', 'a\\b.txt', 'docs/.git/config', 'file.txt:stream']) {
      const answer = await chunk(name, 'nope');
      expect(answer.status, name).toBe(422);
    }
    const big = await world.a.call('POST', `/api/machines/${world.bId}/api/takeover/target/workspace-chunk`, { opId, name: 'big.txt', size: 2 * 1024 * 1024, sha256: 'x', offset: 0, data: '' });
    expect(big.status).toBe(413);
    // A secret the source did not mark (the receiver checks the content itself), not confirmed: nothing kept.
    const text = '{"env":{"ACME_TOKEN":"synthetic-0123456789abcdef"}}';
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(text).digest('hex');
    const secret = await chunk('hidden.json', text, { sha256: sha, secret: false, confirmed: false });
    expect(secret.status, JSON.stringify(secret.body)).toBe(422);
    expect((secret.body as { error: string }).error).toBe('secret-not-confirmed');
    const fine = await chunk('fine.md', 'hello\n', { sha256: createHash('sha256').update('hello\n').digest('hex') });
    expect(fine.status, JSON.stringify(fine.body)).toBe(200);
    // The staged op is dropped again.
    expect((await world.a.call('POST', `/api/machines/${world.bId}/api/takeover/target/abort`, { opId })).status).toBe(200);
  });
});

describe('D152: which repos an agent works in, from its history', () => {
  it('lists the repos of the files it edited beside its solutions, in the API and in what a move carries', async () => {
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-history', ['front']);
    const sent = await world.a.call('POST', `/api/sessions/${session.id}/messages`, { text: 'Note it. [fake:write back/history.txt]' });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    await waitFor('the edit to be recorded', async () => {
      await settle(world.a, session.id);
      const answer = (await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn;
      return answer.repos.some((repo) => repo.name === 'back') ? answer : null;
    }, 30_000);
    const answer = (await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn;
    const byName = Object.fromEntries(answer.repos.map((repo) => [repo.name, repo]));
    expect(byName['front']).toMatchObject({ source: 'solution', kind: 'main', path: world.paths.a.front, branch: 'main', remoteUrl: world.remotes.front });
    expect(byName['back']).toMatchObject({ source: 'edited', kind: 'main', path: world.paths.a.back, branch: 'main' });
    // Through the paired machine too (the side panel of a peer's agent).
    const remote = await world.b.call('GET', `/api/sessions/r~${world.aId}~${session.id}/works-in`);
    expect(remote.status, JSON.stringify(remote.body)).toBe(200);
    expect((remote.body as SessionWorksIn).repos.map((repo) => repo.name).sort()).toEqual(['back', 'front']);
    // The move carries both repos (the one named at start and the one it edited in).
    const inspected = await world.a.call('POST', '/api/takeover/source/inspect', { sessionId: session.id });
    const names = ((inspected.body as { result: { repos: Array<{ name: string }> } }).result.repos ?? []).map((repo) => repo.name).sort();
    expect(names).toEqual(['back', 'front']);
    expect(await world.git(world.paths.a.back, 'status', '--porcelain')).toContain('history.txt');
    await world.git(world.paths.a.back, 'clean', '-fdq');
  });

  it('D152 follow-up 2026-11-05: a session that only read files and ran commands in one repo works in it; the move carries it unless it is left out', async () => {
    // No solution picked, nothing edited: the developer's real case.
    const session = await startWorkspaceSession(world.a, world.folders.a.workspace as string, 'ws-reader', []);
    await settle(world.a, session.id);
    const front = await realpath(world.paths.a.front);
    const read = JSON.stringify({ file_path: path.join(front, 'README.md') });
    const command = JSON.stringify({ command: `cd "${front}" && git status --short` });
    for (const text of [`Look. [fake:tool Read ${read}]`, `Check. [fake:tool Bash ${command}]`]) {
      const sent = await world.a.call('POST', `/api/sessions/${session.id}/messages`, { text });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      await settle(world.a, session.id);
    }
    const answer = await waitFor('the reads and the command to count', async () => {
      const now = (await world.a.call('GET', `/api/sessions/${session.id}/works-in`)).body as SessionWorksIn;
      return now.repos.some((repo) => repo.evidence?.includes('commands')) ? now : null;
    }, 30_000);
    expect(answer.repos).toEqual([expect.objectContaining({ name: 'front', path: front, kind: 'main', source: 'commands', branch: 'main', remoteUrl: world.remotes.front, evidence: ['commands', 'read'] })]);
    // The source's inspect (what the move dialog lists) carries it, marked.
    const inspected = await world.a.call('POST', '/api/takeover/source/inspect', { sessionId: session.id });
    const repos = (inspected.body as { result: { repos: Array<{ name: string; path: string; found?: string; evidence?: string[] }>; blockers: string[] } }).result.repos;
    expect(repos.map((repo) => [repo.name, repo.found, repo.evidence])).toEqual([['front', 'commands', ['commands', 'read']]]);
    // The move's plan includes it (carried by default) …
    const planned = await preview({ sessionId: session.id, targetMachine: world.bId, placement: null });
    expect(planned.target.repos.map((repo) => repo.name)).toEqual(['front']);
    expect(planned.excluded).toEqual([]);
    // … and leaving it out takes it out of the plan (and, as it is the only one, blocks the move).
    const left = await preview({ sessionId: session.id, targetMachine: world.bId, placement: null, excludeRepos: [repos[0]?.path] });
    expect(left.target.repos).toEqual([]);
    expect(left.excluded).toEqual([repos[0]?.path]);
    expect(left.blockers).toContain('every repo is left out: tick at least one to carry');
    const bad = await world.a.call('POST', '/api/takeover/preview', { sessionId: session.id, targetMachine: world.bId, excludeRepos: 'front' });
    expect(bad.status).toBe(422);
  });
});
