import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_MAX_AGE_MS,
  CHECKPOINT_NOTE_KIND,
  type RetentionGroup,
  checkpointRef,
  firstLineOf,
  isCheckpointRef,
  prunableGroups,
  redoDivider,
  revertDivider,
  revertNote,
  safetyRef,
} from '../../../src/core/checkpoints.ts';
import type { LifecyclePayload } from '../../../src/core/event-payload.ts';
import { CheckpointGit } from '../../../src/server/checkpoints/git.ts';
import { CheckpointError, CheckpointService, UNSUPPORTED } from '../../../src/server/checkpoints/service.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { failureText, runCommand, succeeded } from '../../../src/server/exec.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D80 oracle (`docs/undo.md`): a checkpoint before each turn never touches the
 * developer's index, HEAD, branch or files; a revert restores tracked and untracked
 * files (removing files made after the checkpoint), leaves ignored files alone,
 * moves the branch back over unpushed commits and refuses pushed ones (files only),
 * works several turns back, refuses while a turn runs, writes the divider and the
 * agent's note; Redo undoes it; the retention prunes refs and rows; and a ~5k-file
 * repo is checkpointed fast enough (timings printed).
 */

let tmp: string;
let repo: string;
let store: Store;
let clock: number;
let env: NodeJS.ProcessEnv;
let running: boolean;
let events: Array<{ sessionId: string; label: string; payload: LifecyclePayload }>;
let service: CheckpointService;
let sessionId: string;

function gitEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) out[key] = value;
  return {
    ...out,
    GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Dev',
    GIT_AUTHOR_EMAIL: 'dev@example.invalid',
    GIT_COMMITTER_NAME: 'Dev',
    GIT_COMMITTER_EMAIL: 'dev@example.invalid',
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

/** `git status --porcelain=v1 --untracked-files=all` lines, sorted (not trimmed: the first column matters). */
async function status(dir = repo): Promise<string[]> {
  const result = await runCommand(['git'], ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir, env });
  return result.stdout.split('\n').filter((line) => line !== '').sort();
}

async function write(file: string, content: string, dir = repo): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
}

async function read(file: string, dir = repo): Promise<string | null> {
  return readFile(path.join(dir, file), 'utf8').catch(() => null);
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Every file under `dir` (but `.git`) with its content hash. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await sha256(full);
    }
  };
  await walk(dir);
  return out;
}

/** What a checkpoint must leave byte-identical: status, the index file, HEAD, the branch, the files. */
async function fingerprint(dir: string): Promise<Record<string, unknown>> {
  const gitDir = await git(dir, 'rev-parse', '--path-format=absolute', '--git-dir');
  return {
    status: (await runCommand(['git'], ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], { cwd: dir, env })).stdout,
    index: await sha256(path.join(gitDir, 'index')),
    head: await readFile(path.join(gitDir, 'HEAD'), 'utf8'),
    headSha: await git(dir, 'rev-parse', 'HEAD'),
    branches: await git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'),
    files: await tree(dir),
  };
}

async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  await write('README.md', 'hello\n', dir);
  await write('src/app.txt', 'v1\n', dir);
  await write('.gitignore', '*.log\nbuild/\n', dir);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'init');
  return realpath(dir);
}

/** One turn: the capture before it, its user message's event, the record; then `act` plays the agent. */
async function turn(text: string, act: () => Promise<void> = async () => undefined, id = sessionId): Promise<EventRecord> {
  const capture = await service.capture(id);
  const event = await store.events.append({ sessionId: id, kind: 'text', label: text, payload: { type: 'user', text, origin: 'user', delivered: true } });
  if (capture) await service.record(capture, event.id);
  await act();
  return event;
}

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('checkpoints'));
  // No background `gc --auto` racing the temp folder's removal.
  await writeFile(path.join(tmp, 'gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  env = gitEnv();
  repo = await makeRepo(path.join(tmp, 'repo'));
  clock = Date.parse('2026-10-08T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
  running = false;
  events = [];
  service = new CheckpointService({
    store,
    env,
    now: () => clock,
    enabled: async () => (await store.settings.getAll())['sessions.checkpoints'] !== false,
    sessions: {
      turnRunning: () => running,
      recordServiceEvent: async (id, kind, label, payload) => {
        events.push({ sessionId: id, label, payload });
        return store.events.append({ sessionId: id, kind, label, payload });
      },
    },
    onError: (error) => {
      throw error;
    },
  });
  sessionId = (await store.sessions.create({ name: 'undo', claudeSessionId: randomUUID(), cwd: repo })).id;
});

afterEach(async () => {
  await service.stop();
  await store.close();
  await removeTempDir(tmp);
});

describe('D80 pure part', () => {
  it('names refs, quotes the first line, writes the note and dividers', () => {
    expect(checkpointRef('s1', 3)).toBe('refs/switchboard/checkpoints/s1/3');
    expect(checkpointRef('s1', 3, 2)).toBe('refs/switchboard/checkpoints/s1/3-2');
    expect(safetyRef('s1', 'g')).toBe('refs/switchboard/checkpoints/s1/safety/g');
    expect(isCheckpointRef('refs/heads/main')).toBe(false);
    expect(isCheckpointRef('refs/switchboard/checkpoints/../heads/main')).toBe(false);
    expect(firstLineOf('\n  Fix the header  \nmore')).toBe('Fix the header');
    expect(firstLineOf('x'.repeat(100))).toHaveLength(80);
    expect(revertNote(2, 'Fix the header', 4)).toBe("Switchboard reverted the files to before turn 2 (Fix the header); changes made in turns 2..4 are gone. Don't rely on them.");
    expect(revertNote(4, 'x', 4)).toContain('changes made in turn 4 are gone');
    expect(revertDivider(2)).toBe('Reverted to before turn 2');
    expect(redoDivider(2)).toBe('Undid the revert to before turn 2');
  });

  it('retention keeps whichever is fewer of 7 days / the last 100 turns; safety captures 7 days / newest 20; a closed session nothing', () => {
    const now = Date.parse('2026-10-08T10:00:00.000Z');
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
    const turns: RetentionGroup[] = Array.from({ length: 120 }, (_, i) => ({ groupId: `t${i + 1}`, kind: 'turn', turnSeq: i + 1, createdAt: at(1000 * (120 - i)) }));
    // 120 recent turns: the oldest 20 go (beyond the newest 100).
    expect(prunableGroups(turns, now).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `t${i + 1}`).sort());
    // 3 turns, one older than 7 days: only it goes.
    const few: RetentionGroup[] = [
      { groupId: 'a', kind: 'turn', turnSeq: 1, createdAt: at(CHECKPOINT_MAX_AGE_MS + 1) },
      { groupId: 'b', kind: 'turn', turnSeq: 2, createdAt: at(1) },
      { groupId: 'c', kind: 'before-revert', turnSeq: 1, createdAt: at(1) },
    ];
    expect(prunableGroups(few, now)).toEqual(['a']);
    const safety: RetentionGroup[] = Array.from({ length: 25 }, (_, i) => ({ groupId: `s${i}`, kind: 'before-revert', turnSeq: 1, createdAt: at(1000 * (25 - i)) }));
    expect(prunableGroups(safety, now).sort()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(prunableGroups(few, now, { closed: true }).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('D80 checkpoint before a turn', () => {
  it("never touches the developer's index, HEAD, branch or files (byte-compared), and keeps tracked + untracked, never ignored", async () => {
    // A messy working tree: staged, unstaged, untracked, ignored.
    await write('README.md', 'hello staged\n');
    await git(repo, 'add', 'README.md');
    await write('README.md', 'hello staged then edited\n');
    await write('notes/todo.txt', 'untracked\n');
    await write('debug.log', 'ignored\n');
    await write('build/out.bin', 'ignored too\n');
    const before = await fingerprint(repo);
    const event = await turn('Fix the header');
    expect(await fingerprint(repo)).toEqual(before);

    const [row] = await store.checkpoints.listOf(sessionId);
    expect(row).toMatchObject({ kind: 'turn', turnSeq: 1, eventId: event.id, repoPath: repo, ref: checkpointRef(sessionId, 1), branch: 'main', head: before['headSha'] });
    expect(await git(repo, 'rev-parse', row!.ref)).toBe(row!.commitSha);
    expect(await git(repo, 'rev-parse', `${row!.commitSha}^`)).toBe(before['headSha']);
    const files = (await git(repo, 'ls-tree', '-r', '--name-only', row!.commitSha)).split('\n').sort();
    expect(files).toEqual(['.gitignore', 'README.md', 'notes/todo.txt', 'src/app.txt']);
    expect(await git(repo, 'show', `${row!.commitSha}:README.md`)).toBe('hello staged then edited');
    // The staged state is kept too (index_tree).
    expect(await git(repo, 'show', `${row!.indexTree}:README.md`)).toBe('hello staged');
    // Hidden: not a branch, no log entry of the developer's branch.
    expect(await git(repo, 'branch', '--list')).toBe('* main');
  });

  it('dedupes an unchanged tree (same commit), skips non-git folders and the setting off, and says why', async () => {
    await turn('one');
    await turn('two');
    const rows = await store.checkpoints.listOf(sessionId);
    expect(rows.map((row) => row.turnSeq)).toEqual([1, 2]);
    expect(rows[0]!.commitSha).toBe(rows[1]!.commitSha);
    expect(rows[1]!.ref).toBe(checkpointRef(sessionId, 2));

    const plain = path.join(tmp, 'plain');
    await mkdir(plain);
    const other = (await store.sessions.create({ name: 'plain', claudeSessionId: randomUUID(), cwd: plain })).id;
    await turn('hi', undefined, other);
    expect(await store.checkpoints.listOf(other)).toEqual([]);
    expect((await service.list(other)).unsupported).toBe(UNSUPPORTED.notGit);

    await store.settings.set('sessions.checkpoints', false);
    await turn('three');
    expect((await store.checkpoints.listOf(sessionId)).length).toBe(2);
    expect((await service.list(sessionId)).unsupported).toBe(UNSUPPORTED.off);

    const hooked = (await store.sessions.create({ name: 'hooked', claudeSessionId: randomUUID(), cwd: repo, hooked: true })).id;
    await store.settings.set('sessions.checkpoints', true);
    await turn('terminal', undefined, hooked);
    expect(await store.checkpoints.listOf(hooked)).toEqual([]);
    expect((await service.list(hooked)).unsupported).toBe(UNSUPPORTED.hooked);
  });

  it('covers every working tree the session uses (two worktrees of one repo get distinct refs)', async () => {
    const wt = path.join(tmp, 'repo-wt');
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const real = await realpath(wt);
    await store.worktrees.create({ repo: 'repo', repoPath: repo, branch: 'feature', path: real, sessionId });
    service = new CheckpointService({
      store,
      env,
      now: () => clock,
      enabled: async () => true,
      sessions: { turnRunning: () => false, recordServiceEvent: async () => undefined },
    });
    await turn('both');
    const rows = await store.checkpoints.listOf(sessionId);
    expect(rows.map((row) => [row.repoPath, row.ref, row.branch])).toEqual([
      [repo, checkpointRef(sessionId, 1), 'main'],
      [real, checkpointRef(sessionId, 1, 2), 'feature'],
    ]);
  });
});

describe('D80 revert to before a turn', () => {
  it('restores tracked and untracked files several turns back, removes files made later, leaves ignored files alone; Redo brings it all back', async () => {
    await write('notes/keep.txt', 'untracked before\n');
    await write('debug.log', 'ignored before\n');
    await turn('Turn one: edit the app', async () => {
      await write('src/app.txt', 'v2\n');
      await write('notes/keep.txt', 'untracked changed\n');
      await write('debug.log', 'ignored changed by the agent\n');
    });
    await turn('Turn two: add things', async () => {
      await write('src/new/deep.txt', 'new file\n');
      await rm(path.join(repo, 'README.md'));
      await rm(path.join(repo, 'notes/keep.txt'));
      await write('build/cache.bin', 'ignored new\n');
    });
    await turn('Turn three', async () => {
      await write('src/app.txt', 'v3\n');
    });
    const beforeRevert = await fingerprint(repo);

    const preview = await service.preview(sessionId, 1);
    expect(preview).toMatchObject({ turn: 1, firstLine: 'Turn one: edit the app', latestTurn: 3, filesOnlyReason: null });
    expect(preview.repos[0]!.files).toEqual(
      expect.arrayContaining([
        { path: 'README.md', change: 'added' },
        { path: 'notes/keep.txt', change: 'added' },
        { path: 'src/app.txt', change: 'modified' },
        { path: 'src/new/deep.txt', change: 'deleted' },
      ]),
    );
    expect(preview.repos[0]!.fileCount).toBe(4);
    expect(preview.repos[0]!.head.action).toBe('none');

    const result = await service.revert(sessionId, 1);
    expect(result.filesOnly).toBe(false);
    expect(await read('src/app.txt')).toBe('v1\n');
    expect(await read('README.md')).toBe('hello\n');
    expect(await read('notes/keep.txt')).toBe('untracked before\n');
    expect(await read('src/new/deep.txt')).toBeNull();
    await expect(stat(path.join(repo, 'src/new'))).rejects.toThrow();
    // Ignored files: untouched (the agent's edit and new file stay).
    expect(await read('debug.log')).toBe('ignored changed by the agent\n');
    expect(await read('build/cache.bin')).toBe('ignored new\n');
    // `git status` as before turn 1: only the untracked note (and nothing staged).
    expect(await status()).toEqual(['?? notes/keep.txt']);

    // The divider and the agent's note.
    expect(events.map((e) => [e.label, e.payload.action, e.payload.turn])).toEqual([[revertDivider(1), 'reverted', 1]]);
    const pending = await store.pendingMessages.pending(sessionId);
    expect(pending.map((m) => [m.kind, m.text])).toEqual([[CHECKPOINT_NOTE_KIND, revertNote(1, 'Turn one: edit the app', 3)]]);
    expect((await service.list(sessionId)).redo).toMatchObject({ turn: 1 });

    // Redo: back to exactly the state before the revert; the undelivered note goes.
    await service.redo(sessionId);
    expect(await fingerprint(repo)).toEqual({ ...beforeRevert, index: (await fingerprint(repo))['index'] });
    expect(await status()).toEqual(
      (beforeRevert['status'] as string).split('\0').filter((line) => line !== '' && !line.startsWith('!!')).sort(),
    );
    expect(events.at(-1)).toMatchObject({ label: redoDivider(1), payload: { action: 'revert-undone', turn: 1 } });
    expect(await store.pendingMessages.pending(sessionId)).toEqual([]);
    expect((await service.list(sessionId)).redo).toBeNull();
    await expect(service.redo(sessionId)).rejects.toMatchObject({ code: 'nothing-to-redo' });
  });

  it('moves the branch back over the commits the agent made (index restored), and Redo moves it forward again', async () => {
    await write('src/app.txt', 'staged before\n');
    await git(repo, 'add', 'src/app.txt');
    const start = await git(repo, 'rev-parse', 'HEAD');
    await turn('Commit twice', async () => {
      await write('a.txt', 'a\n');
      await git(repo, 'add', '-A');
      await git(repo, 'commit', '-q', '-m', 'agent 1');
      await write('b.txt', 'b\n');
      await git(repo, 'add', '-A');
      await git(repo, 'commit', '-q', '-m', 'agent 2');
    });
    const agentHead = await git(repo, 'rev-parse', 'HEAD');
    const preview = await service.preview(sessionId, 1);
    expect(preview.repos[0]!.head).toMatchObject({ action: 'reset', branch: 'main', commits: 2, to: start });
    await service.revert(sessionId, 1);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(start);
    expect(await git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await read('a.txt')).toBeNull();
    // The staged change before the turn is staged again.
    expect(await status()).toEqual(['M  src/app.txt']);
    expect(await git(repo, 'reflog', '-1', '--format=%gs', 'main')).toBe('switchboard: revert to before turn 1');

    await service.redo(sessionId);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(agentHead);
    expect(await read('b.txt')).toBe('b\n');
    expect(await status()).toEqual([]);
  });

  it('refuses to move a branch whose new commits are pushed (files only offered), and a revert files-only leaves the branch', async () => {
    const origin = path.join(tmp, 'origin.git');
    await git(tmp, 'init', '-q', '--bare', origin);
    await git(repo, 'remote', 'add', 'origin', origin);
    await git(repo, 'push', '-q', '-u', 'origin', 'main');
    await turn('Commit and push', async () => {
      await write('pushed.txt', 'p\n');
      await git(repo, 'add', '-A');
      await git(repo, 'commit', '-q', '-m', 'pushed');
      await git(repo, 'push', '-q');
      await write('later.txt', 'uncommitted\n');
    });
    const head = await git(repo, 'rev-parse', 'HEAD');
    const refused = await service.revert(sessionId, 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CheckpointError);
    expect((refused as CheckpointError).code).toBe('files-only-needed');
    expect((refused as CheckpointError).status).toBe(409);
    expect((refused as CheckpointError).message).toContain('already pushed');
    expect((refused as CheckpointError).plan?.repos[0]!.head.action).toBe('refused');
    // Nothing changed by the refusal.
    expect(await read('later.txt')).toBe('uncommitted\n');
    expect(await store.checkpoints.listOf(sessionId, 'before-revert')).toEqual([]);

    const files = await service.revert(sessionId, 1, { filesOnly: true });
    expect(files.filesOnly).toBe(true);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await read('later.txt')).toBeNull();
    expect(await read('pushed.txt')).toBeNull();
    // The reverted file shows as a change against today's HEAD.
    expect(await status()).toEqual([' D pushed.txt']);
    expect(events.at(-1)?.payload).toMatchObject({ action: 'reverted', filesOnly: true });
  });

  it('refuses a branch switched since the turn (files only), and refuses everything while a turn runs', async () => {
    await turn('Switch branch', async () => {
      await git(repo, 'checkout', '-q', '-b', 'other');
      await write('x.txt', 'x\n');
      await git(repo, 'add', '-A');
      await git(repo, 'commit', '-q', '-m', 'x');
    });
    const plan = await service.preview(sessionId, 1);
    expect(plan.filesOnlyReason).toContain('is on other now, not main');
    running = true;
    await expect(service.revert(sessionId, 1, { filesOnly: true })).rejects.toMatchObject({ code: 'turn-running', status: 409 });
    running = false;
    await store.sessions.update(sessionId, { status: 'run' });
    await expect(service.revert(sessionId, 1, { filesOnly: true })).rejects.toMatchObject({ code: 'turn-running' });
    await store.sessions.update(sessionId, { status: 'idle' });
    await expect(service.revert(sessionId, 9)).rejects.toMatchObject({ code: 'no-checkpoint', status: 404 });
    await service.revert(sessionId, 1, { filesOnly: true });
    expect(await git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('other');
    expect(await read('x.txt')).toBeNull();
  });

  it('Redo is gone once a message is sent after the revert', async () => {
    await turn('one', async () => write('a.txt', 'a\n'));
    await service.revert(sessionId, 1);
    expect((await service.list(sessionId)).redo).not.toBeNull();
    await turn('two');
    expect((await service.list(sessionId)).redo).toBeNull();
    await expect(service.redo(sessionId)).rejects.toMatchObject({ code: 'nothing-to-redo' });
  });
});

describe('D80 retention', () => {
  it('prunes checkpoints older than 7 days and a closed session’s, deleting their refs (no gc)', async () => {
    await turn('old', async () => write('a.txt', 'a\n'));
    clock += CHECKPOINT_MAX_AGE_MS + 60_000;
    await turn('new', async () => write('b.txt', 'b\n'));
    expect(await service.prune()).toBe(1);
    const rows = await store.checkpoints.listOf(sessionId);
    expect(rows.map((row) => row.turnSeq)).toEqual([2]);
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/switchboard')).toBe(checkpointRef(sessionId, 2));

    await store.sessions.update(sessionId, { closedAt: new Date(clock).toISOString() });
    expect(await service.prune()).toBe(1);
    expect(await store.checkpoints.listOf(sessionId)).toEqual([]);
    expect(await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/switchboard')).toBe('');
  });

  it('a session dropped on close loses its checkpoints at once', async () => {
    await turn('one');
    await service.dropSession(sessionId);
    expect(await store.checkpoints.listOf(sessionId)).toEqual([]);
    expect(await git(repo, 'for-each-ref', 'refs/switchboard')).toBe('');
  });
});

describe('D80 performance', () => {
  it('checkpoints a repo of ~5,000 files quickly (timings printed)', { timeout: 120_000 }, async () => {
    const big = path.join(tmp, 'big');
    await mkdir(big);
    await git(big, 'init', '-q', '-b', 'main');
    for (let d = 0; d < 50; d += 1) {
      await mkdir(path.join(big, `dir${d}`), { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, f) => writeFile(path.join(big, `dir${d}`, `file${f}.txt`), `content ${d}/${f}\n`.repeat(20))));
    }
    await git(big, 'add', '-A');
    await git(big, 'commit', '-q', '-m', 'big');
    const top = await realpath(big);
    const bigSession = (await store.sessions.create({ name: 'big', claudeSessionId: randomUUID(), cwd: top })).id;
    const g = new CheckpointGit({ env });
    const time = async (label: string, work: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await work();
      const ms = Math.round(performance.now() - started);
      console.log(`D80 timing (5,000 files): ${label}: ${ms} ms`);
      return ms;
    };
    await time('snapshot only', () => g.snapshot(top));
    const first = await time('first turn checkpoint (capture + refs)', () => turn('first', async () => writeFile(path.join(top, 'dir1', 'file1.txt'), 'changed\n'), bigSession));
    const changed = await time('next turn, one file changed', () => turn('second', async () => undefined, bigSession));
    const unchanged = await time('next turn, nothing changed (deduped)', () => turn('third', async () => undefined, bigSession));
    await writeFile(path.join(top, 'dir2', 'new.txt'), 'new\n');
    const revert = await time('revert to turn 1 (safety capture + restore)', () => service.revert(bigSession, 1));
    expect(await readFile(path.join(top, 'dir1', 'file1.txt'), 'utf8')).toBe('content 1/1\n'.repeat(20));
    expect(first).toBeLessThan(10_000);
    expect(changed).toBeLessThan(10_000);
    expect(unchanged).toBeLessThan(10_000);
    expect(revert).toBeLessThan(20_000);
  });
});
