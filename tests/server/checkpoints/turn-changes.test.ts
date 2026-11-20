import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointGit } from '../../../src/server/checkpoints/git.ts';
import { CheckpointService } from '../../../src/server/checkpoints/service.ts';
import { TurnChangesError, TurnChangesService } from '../../../src/server/checkpoints/turn-changes.ts';
import type { EventRecord } from '../../../src/server/db/repos/events.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { failureText, runCommand, succeeded } from '../../../src/server/exec.ts';
import { SessionTouchedFiles } from '../../../src/server/worktrees/touched.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D180 · side panel: what each turn changed, read from the save points Switchboard
 * takes before every turn (D80, `docs/undo.md`). A turn's changes are the difference
 * between its save point and the next one (the newest turn: the files as they are now),
 * limited to the files the agent's own edit tools named in it.
 */

let tmp: string;
let repo: string;
let store: Store;
let clock: number;
let env: NodeJS.ProcessEnv;
let checkpoints: CheckpointService;
let changes: TurnChangesService;
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

/** An edit by hand (or by another agent): no tool event of this session names it. */
async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content);
}

/** D180: the session's own edit tool names `absolute` (what makes a file count to its turn). */
async function toolNames(absolute: string, of: string = sessionId, tool = 'Write'): Promise<void> {
  await store.events.append({ sessionId: of, kind: 'impl', label: tool, payload: { type: 'tool', name: tool, input: { file_path: absolute } } });
}

/** The agent writes `file` (relative to the repo) with its Write tool. */
async function agentWrite(file: string, content: string): Promise<void> {
  await write(file, content);
  await toolNames(path.join(repo, file));
}

/** The agent's tools named `file` and it is gone afterwards (a Write, then a delete). */
async function agentRemove(file: string): Promise<void> {
  await rm(path.join(repo, file));
  await toolNames(path.join(repo, file));
}

/** What a read must leave byte-identical: the status (ignored files too), the index file and HEAD. */
async function fingerprint(): Promise<Record<string, string>> {
  const gitDir = await git(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
  return {
    status: (await runCommand(['git'], ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], { cwd: repo, env })).stdout,
    index: createHash('sha256').update(await readFile(path.join(gitDir, 'index'))).digest('hex'),
    head: await git(repo, 'rev-parse', 'HEAD'),
  };
}

/**
 * One turn, a minute after the one before: the save point, its user message, then `act` plays the
 * agent. `storedLateMs`: the save point's row is stored that long after the message went out (the
 * supervisor stores it in the background, so a quick turn can end first).
 */
async function turn(text: string, act: () => Promise<void> = async () => undefined, storedLateMs = 0): Promise<EventRecord> {
  clock += 60_000;
  const capture = await checkpoints.capture(sessionId);
  const event = await store.events.append({ sessionId, kind: 'text', label: text, payload: { type: 'user', text, origin: 'user', delivered: true } });
  clock += storedLateMs;
  if (capture) await checkpoints.record(capture, event.id);
  await act();
  return event;
}

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('turn-changes'));
  await writeFile(path.join(tmp, 'gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
  env = gitEnv();
  repo = path.join(tmp, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await write('README.md', 'hello\n');
  await write('src/app.txt', 'v1\n');
  await write('.gitignore', '*.log\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  repo = await realpath(repo);
  clock = Date.parse('2026-11-18T10:00:00.000Z');
  store = await openTempStore(tmp, { now: () => new Date(clock) });
  checkpoints = new CheckpointService({
    store,
    env,
    now: () => clock,
    enabled: async () => (await store.settings.getAll())['sessions.checkpoints'] !== false,
    sessions: { turnRunning: () => false, recordServiceEvent: async (id, kind, label, payload) => store.events.append({ sessionId: id, kind, label, payload }) },
    onError: (error) => {
      throw error;
    },
  });
  changes = new TurnChangesService({ store, env });
  sessionId = (await store.sessions.create({ name: 'turns', claudeSessionId: randomUUID(), cwd: repo })).id;
});

afterEach(async () => {
  await checkpoints.stop();
  await store.close();
  await removeTempDir(tmp);
});

describe('what each turn changed (the save points before each turn)', () => {
  it('lists each turn that changed files with its file and line counts, and leaves out a turn that changed nothing', async () => {
    const first = await turn('Change three files', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\n');
      await agentWrite('notes/new.txt', 'a\nb\n');
      await agentRemove('README.md');
    });
    await turn('Only answer');
    const third = await turn('One more line', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\nv3\n');
    });

    expect(await changes.list(sessionId)).toEqual({
      turns: [
        { turn: 1, eventId: first.id, through: 1, files: 3, added: 3, removed: 1 },
        { turn: 3, eventId: third.id, through: 3, files: 1, added: 1, removed: 0 },
      ],
      latestTurn: 3,
    });
  });

  it("the diff of one turn holds only that turn's lines: an edited, a new and a deleted file", async () => {
    await turn('Change three files', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\n');
      await agentWrite('notes/new.txt', 'a\nb\n');
      await agentRemove('README.md');
    });
    await turn('One more line', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\nv3\n');
    });

    expect(await changes.diff(sessionId, 1, 1)).toEqual([
      { solution: 'repo', path: 'README.md', branch: 'main', added: 0, removed: 1, lines: ['@@ -1 +0,0 @@', '-hello'], uncommitted: false },
      { solution: 'repo', path: 'notes/new.txt', branch: 'main', added: 2, removed: 0, lines: ['@@ -0,0 +1,2 @@', '+a', '+b'], uncommitted: false },
      { solution: 'repo', path: 'src/app.txt', branch: 'main', added: 1, removed: 0, lines: ['@@ -1 +1,2 @@', ' v1', '+v2'], uncommitted: false },
    ]);
  });

  it("the newest turn is compared with the files as they are now: untracked files count, ignored files never, and nothing of the developer's is touched", async () => {
    await turn('Add a line and two files', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\n');
      await agentWrite('notes/later.txt', 'new\n');
      await agentWrite('debug.log', 'ignored\n');
    });
    const before = await fingerprint();

    const listed = await changes.list(sessionId);
    const files = await changes.diff(sessionId, 1, null);

    expect(listed.turns).toEqual([expect.objectContaining({ turn: 1, through: 1, files: 2, added: 2, removed: 0 })]);
    expect(files).toEqual([
      { solution: 'repo', path: 'notes/later.txt', branch: 'main', added: 1, removed: 0, lines: ['@@ -0,0 +1 @@', '+new'], uncommitted: true },
      { solution: 'repo', path: 'src/app.txt', branch: 'main', added: 1, removed: 0, lines: ['@@ -1 +1,2 @@', ' v1', '+v2'], uncommitted: true },
    ]);
    expect(await fingerprint()).toEqual(before);
  });

  it('D180: in a working copy shared with another agent, a turn counts only the files its own agent edited', async () => {
    const other = (await store.sessions.create({ name: 'neighbour', claudeSessionId: randomUUID(), cwd: repo })).id;
    const first = await turn('Change the app', async () => {
      await agentWrite('src/app.txt', 'v1\nv2\n');
      // Meanwhile the other agent in the same folder writes two files with its own tools.
      await write('notes/neighbour.txt', 'theirs\n');
      await toolNames(path.join(repo, 'notes/neighbour.txt'), other);
      await write('README.md', 'hello\nedited by the neighbour\n');
      await toolNames(path.join(repo, 'README.md'), other);
    });
    // A turn in which only the other agent changed something: no chip for this one.
    await turn('Only answer', async () => {
      await write('notes/later.txt', 'theirs\n');
      await toolNames(path.join(repo, 'notes/later.txt'), other);
    });

    expect((await changes.list(sessionId)).turns).toEqual([{ turn: 1, eventId: first.id, through: 1, files: 1, added: 1, removed: 0 }]);
    expect((await changes.diff(sessionId, 1, 1)).map((file) => file.path)).toEqual(['src/app.txt']);
    expect((await changes.diff(sessionId, 1, null)).map((file) => file.path)).toEqual(['src/app.txt']);
    expect(await changes.diff(sessionId, 2, 2)).toEqual([]);
  });

  it('D180: a turn that edited more files than one git command line holds counts them all, and still only its own', async () => {
    const first = await turn('Many files', async () => {
      for (let i = 0; i < 101; i++) await agentWrite(`gen/f${i}.txt`, `${i}\n`);
      await write('gen/mine.txt', 'by hand\n');
    });
    expect((await changes.list(sessionId)).turns).toEqual([{ turn: 1, eventId: first.id, through: 1, files: 101, added: 101, removed: 0 }]);
    const files = await changes.diff(sessionId, 1, null);
    expect(files).toHaveLength(101);
    expect(files.some((file) => file.path === 'gen/mine.txt')).toBe(false);
  });

  it('D180: a turn that only deleted a file (the Codex bridge records it as a Delete tool) gets its chip', async () => {
    const first = await turn('Delete the readme', async () => {
      await rm(path.join(repo, 'README.md'));
      await toolNames(path.join(repo, 'README.md'), sessionId, 'Delete');
    });
    expect((await changes.list(sessionId)).turns).toEqual([{ turn: 1, eventId: first.id, through: 1, files: 1, added: 0, removed: 1 }]);
    expect((await changes.diff(sessionId, 1, 1)).map((file) => file.path)).toEqual(['README.md']);
  });

  it('D180: a path with glob characters is read as itself (`[draft].txt` would also match `d.txt` as a glob)', async () => {
    await turn('Odd names', async () => {
      await agentWrite('notes/[draft].txt', 'odd\n');
    });
    await write('notes/d.txt', 'not the agent’s\n');
    expect((await changes.diff(sessionId, 1, null)).map((file) => file.path)).toEqual(['notes/[draft].txt']);
  });

  it('a turn without a save point of its own is covered by the turn before it', async () => {
    const first = await turn('With a save point', async () => {
      await agentWrite('notes/one.txt', 'one\n');
    });
    await store.settings.set('sessions.checkpoints', false);
    await turn('Without a save point', async () => {
      await agentWrite('notes/two.txt', 'two\n');
    });
    await store.settings.set('sessions.checkpoints', true);
    await turn('Only answer');

    expect((await changes.list(sessionId)).turns).toEqual([{ turn: 1, eventId: first.id, through: 2, files: 2, added: 2, removed: 0 }]);
    expect((await changes.diff(sessionId, 1, 1)).map((file) => file.path)).toEqual(['notes/one.txt', 'notes/two.txt']);
  });

  it('a turn ends where the agent stopped: what changes afterwards by hand is not counted to it', async () => {
    // The snapshots the Diff takes when a turn ends (D90), as the app wires them.
    const touched = new SessionTouchedFiles({ store, env, now: () => clock });
    const bounded = new TurnChangesService({ store, env, ends: touched });
    await turn('Write a note', async () => {
      await agentWrite('notes/agent.txt', 'by the agent\n');
    });
    touched.turnEnded(sessionId);
    await touched.idle();
    // After the turn: an edit by hand.
    await write('notes/mine.txt', 'by hand\n');

    expect((await bounded.list(sessionId)).turns).toEqual([expect.objectContaining({ turn: 1, files: 1, added: 1, removed: 0 })]);
    const ofTurn = await bounded.diff(sessionId, 1, 1);
    expect(ofTurn.map((file) => [file.path, file.uncommitted])).toEqual([['notes/agent.txt', false]]);
    // D180: an edit by hand is no turn's: not even "until now".
    expect((await bounded.diff(sessionId, 1, null)).map((file) => file.path)).toEqual(['notes/agent.txt']);

    // The next turn starts from what is there (the edit by hand is before it, not part of it).
    await turn('One more', async () => {
      await agentWrite('notes/agent.txt', 'by the agent\nagain\n');
    });
    touched.turnEnded(sessionId);
    await touched.idle();
    expect((await bounded.list(sessionId)).turns).toEqual([expect.objectContaining({ turn: 1, files: 1, added: 1 }), expect.objectContaining({ turn: 2, files: 1, added: 1 })]);
    await touched.stop();
  });

  it('a quick turn that ended before its save point was stored does not hand its end to the turn before', async () => {
    const touched = new SessionTouchedFiles({ store, env, now: () => clock });
    const bounded = new TurnChangesService({ store, env, ends: touched });
    await turn('First', async () => {
      await agentWrite('notes/one.txt', 'one\n');
    });
    touched.turnEnded(sessionId);
    await touched.idle();

    // The second turn: its message goes out, the agent writes and stops at once; only then is its save point's row stored,
    // so when it ends the newest stored save point is still the first turn's and the end snapshot lands there.
    clock += 60_000;
    const capture = await checkpoints.capture(sessionId);
    const event = await store.events.append({ sessionId, kind: 'text', label: 'Second', payload: { type: 'user', text: 'Second', origin: 'user', delivered: true } });
    await agentWrite('notes/two.txt', 'two\n');
    clock += 1_000;
    touched.turnEnded(sessionId);
    await touched.idle();
    clock += 1_000;
    if (capture) await checkpoints.record(capture, event.id);

    expect((await bounded.list(sessionId)).turns).toEqual([expect.objectContaining({ turn: 1, files: 1, added: 1 }), expect.objectContaining({ turn: 2, files: 1, added: 1 })]);
    expect((await bounded.diff(sessionId, 1, 1)).map((file) => file.path)).toEqual(['notes/one.txt']);
    expect((await bounded.diff(sessionId, 2, 2)).map((file) => file.path)).toEqual(['notes/two.txt']);
    await touched.stop();
  });

  it('reading right when a turn ends waits for its end snapshot instead of taking the files as they are a moment later', async () => {
    await turn('Write a note', async () => {
      await agentWrite('notes/agent.txt', 'by the agent\n');
    });
    // The end snapshot is being taken (held here) while an edit by hand already lands.
    const real = new CheckpointGit({ env });
    const atEnd = await real.snapshot(repo);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const touched = new SessionTouchedFiles({
      store,
      now: () => clock,
      git: {
        snapshot: async () => {
          await held;
          return atEnd;
        },
        diff: (top, from, to) => real.diff(top, from, to),
      },
    });
    const bounded = new TurnChangesService({ store, env, ends: touched });
    touched.turnEnded(sessionId);
    await write('notes/mine.txt', 'by hand\n');
    const listed = bounded.list(sessionId);
    // The end snapshot comes only after the read has long reached it: the read has to wait, not go on with the files as they are now.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    expect((await listed).turns).toEqual([expect.objectContaining({ turn: 1, files: 1 })]);
    await touched.stop();
  });

  describe('with a second working tree', () => {
    let other: string;

    /** The agent also works in `other` (a second repository), as the app's "repositories a session works in" would say. */
    async function useTwoTrees(folder: string): Promise<void> {
      other = path.join(tmp, folder);
      await mkdir(other, { recursive: true });
      await git(other, 'init', '-q', '-b', 'main');
      await writeFile(path.join(other, 'README.md'), 'other\n');
      await git(other, 'add', '-A');
      await git(other, 'commit', '-q', '-m', 'init');
      other = await realpath(other);
      await checkpoints.stop();
      checkpoints = new CheckpointService({
        store,
        env,
        now: () => clock,
        enabled: async () => true,
        foldersOf: async () => [other],
        sessions: { turnRunning: () => false, recordServiceEvent: async (id, kind, label, payload) => store.events.append({ sessionId: id, kind, label, payload }) },
        onError: (error) => {
          throw error;
        },
      });
    }

    it('counts both trees in a turn, and tells two trees with the same folder name apart', async () => {
      await useTwoTrees(path.join('elsewhere', 'repo'));
      const first = await turn('Change both', async () => {
        await agentWrite('notes/a.txt', 'a\n');
        await writeFile(path.join(other, 'b.txt'), 'b\nb\n');
        await toolNames(path.join(other, 'b.txt'));
      });
      await turn('Only answer');

      expect((await changes.list(sessionId)).turns).toEqual([{ turn: 1, eventId: first.id, through: 1, files: 2, added: 3, removed: 0 }]);
      expect((await changes.diff(sessionId, 1, 1)).map((file) => `${file.solution} · ${file.path}`)).toEqual([`${path.basename(tmp)}/repo · notes/a.txt`, 'elsewhere/repo · b.txt']);
    });

    it("leaves out a working tree that is gone (a removed copy) instead of failing the turn's diff", async () => {
      await useTwoTrees('copy');
      await turn('Change both', async () => {
        await agentWrite('notes/a.txt', 'a\n');
        await writeFile(path.join(other, 'b.txt'), 'b\n');
        await toolNames(path.join(other, 'b.txt'));
      });
      await turn('Only answer');
      await rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

      expect((await changes.list(sessionId)).turns).toEqual([expect.objectContaining({ turn: 1, files: 1, added: 1 })]);
      expect((await changes.diff(sessionId, 1, 1)).map((file) => `${file.solution} · ${file.path}`)).toEqual(['repo · notes/a.txt']);
      expect((await changes.diff(sessionId, 1, null)).map((file) => file.path)).toEqual(['notes/a.txt']);
    });
  });

  it('says so when the only working tree cannot be read, instead of answering "nothing changed"', async () => {
    await turn('Write a note', async () => {
      await agentWrite('notes/agent.txt', 'by the agent\n');
    });
    // The folder is still there, but git no longer reads it as a repository.
    await rename(path.join(repo, '.git', 'HEAD'), path.join(repo, '.git', 'HEAD.away'));

    // It is there, so the answer names git's trouble with it (not "no longer on this computer").
    await expect(changes.diff(sessionId, 1, null)).rejects.toMatchObject({ code: 'unreadable', message: expect.stringContaining('git could not read repo') });
    expect((await changes.list(sessionId)).turns).toEqual([]);
  });

  it('says that the working tree is gone when it was the only one, for one turn and for "until now"', async () => {
    await turn('Write a note', async () => {
      await agentWrite('notes/agent.txt', 'by the agent\n');
    });
    await turn('Only answer');
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    await expect(changes.diff(sessionId, 1, 1)).rejects.toMatchObject({ code: 'unreadable', message: expect.stringContaining('no longer') });
    await expect(changes.diff(sessionId, 1, null)).rejects.toMatchObject({ code: 'unreadable', message: expect.stringContaining('no longer') });
    expect((await changes.list(sessionId)).turns).toEqual([]);
  });

  it('refuses a turn that has no save point, and lists nothing for a session without save points', async () => {
    expect(await changes.list(sessionId)).toEqual({ turns: [], latestTurn: 0 });
    await turn('One turn');
    await expect(changes.diff(sessionId, 7, null)).rejects.toMatchObject({ code: 'no-checkpoint' });
    await expect(changes.diff(sessionId, 7, null)).rejects.toBeInstanceOf(TurnChangesError);
    await expect(changes.diff('no-such-session', 1, null)).rejects.toMatchObject({ code: 'not-found' });
  });
});
