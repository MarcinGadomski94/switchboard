import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgv } from '../../tools/fake-claude/args.ts';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import { BASELINE, type FakeEnv, kind, makeFakeEnv, readTranscript, runFake, spawnFake, transcriptPath, userLine } from '../helpers/fake-claude.ts';

/**
 * D25 oracle (tools/fake-claude): `--teleport <id>` as docs/fake-claude.md →
 * *Teleport* says, on temp git repos (no network): the clean-tree and repo
 * checks, the refusals behind FAKE_CLAUDE_TELEPORT / FAKE_CLAUDE_SIGNED_OUT with
 * their texts and distinct exit codes, the simulated branch checkout, `system/init`
 * at once with a fresh id, the remote history as the transcript's start, a normal
 * turn afterwards, and `--resume <local id>` later.
 */

const ID = 'session_011CUteleportXYZ';

let fx: FakeEnv | undefined;

afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

/** Git for the temp repo, isolated from the developer's config. */
function gitEnv(root: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

async function git(root: string, cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv(root) } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')}: ${failureText(result)}`);
  return result.stdout.trim();
}

/** The fake's cwd as a git repo with one commit on `main`. */
async function repoEnv(): Promise<{ fx: FakeEnv; env: Record<string, string> }> {
  const made = await makeFakeEnv('fake-teleport');
  fx = made;
  await writeFile(path.join(made.root, 'gitconfig'), '');
  await git(made.root, made.cwd, 'init', '-q', '-b', 'main');
  await writeFile(path.join(made.cwd, 'README.md'), 'hello\n');
  await git(made.root, made.cwd, 'add', '-A');
  await git(made.root, made.cwd, 'commit', '-q', '-m', 'init');
  return { fx: made, env: { ...gitEnv(made.root), CLAUDE_CONFIG_DIR: made.configDir } };
}

const TELEPORT_ARGS = [...BASELINE, '--teleport', ID, '--name', 'Remote 011CUtel', '--replay-user-messages'];

describe('fake-claude --teleport (D25)', () => {
  it('argv: --teleport takes a value; it cannot be mixed with --resume / --session-id / --fork-session', () => {
    expect(parseArgv(['-p', '--teleport', ID])).toMatchObject({ kind: 'run', args: { teleport: ID } });
    expect(parseArgv(['-p', `--teleport=${ID}`])).toMatchObject({ kind: 'run', args: { teleport: ID } });
    expect(() => parseArgv(['-p', '--teleport', ID, '--resume', 'x'])).toThrow(/--teleport cannot be combined/);
    expect(() => parseArgv(['-p', '--teleport', ID, '--session-id', 'x'])).toThrow(/--teleport cannot be combined/);
    expect(() => parseArgv(['-p', '--teleport'])).toThrow(/argument missing/);
  });

  it('a clean checkout: the branch named after the id is checked out, init at once (fresh id), the history in the transcript, then a normal turn', async () => {
    const { fx: f, env } = await repoEnv();
    const run = spawnFake(TELEPORT_ARGS, { cwd: f.cwd, env });
    const init = await run.waitFor((line) => kind(line) === 'system/init');
    const localId = String(init['session_id']);
    expect(localId).toMatch(/^[0-9a-f-]{36}$/);
    expect(init['cwd']).toBe(f.cwd);
    // Nothing but the SessionStart pair and init before a message: no turn, no history on stdout.
    expect(run.lines.map(kind)).toEqual(['system/hook_started', 'system/hook_response', 'system/init']);
    expect(await git(f.root, f.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`claude/${ID}`);

    const file = transcriptPath(f.configDir, f.cwd, localId);
    const seeded = await readTranscript(file);
    expect(seeded.map((entry) => [entry['type'], (entry['message'] as { content?: unknown }).content])).toEqual([
      ['user', 'Remote history 1: add a /health endpoint to the API.'],
      ['assistant', [{ type: 'text', text: 'Remote reply 1: added GET /health, which answers { ok: true }, and a test for it.' }]],
      ['user', 'Remote history 2: push the branch.'],
      ['assistant', [{ type: 'text', text: `Remote reply 2: pushed claude/${ID}.` }]],
    ]);
    expect(seeded.every((entry) => entry['sessionId'] === localId && entry['gitBranch'] === `claude/${ID}` && entry['cwd'] === f.cwd)).toBe(true);
    expect(seeded.map((entry) => entry['parentUuid'])).toEqual([null, seeded[0]?.['uuid'], seeded[1]?.['uuid'], seeded[2]?.['uuid']]);
    expect(seeded.every((entry) => Date.parse(String(entry['timestamp'])) < Date.now())).toBe(true);

    // A message is a normal turn of the local copy; its prompt continues the chain after the history.
    run.send(userLine('Reply with just OK.'));
    const result = await run.waitFor((line) => line['type'] === 'result');
    expect(result['session_id']).toBe(localId);
    run.end();
    expect((await run.exited).code).toBe(0);
    const after = await readTranscript(file);
    const prompt = after.find((entry) => entry['type'] === 'user' && (entry['message'] as { content?: unknown }).content === 'Reply with just OK.');
    expect(prompt?.['parentUuid']).toBe(seeded[3]?.['uuid']);

    // Later: --resume of the local id, in the worktree, like any session.
    const resumed = await runFake([...BASELINE, '--resume', localId], { cwd: f.cwd, env, stdin: `${JSON.stringify(userLine('Again.'))}\n` });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('"type":"result"');
  });

  it('the refusals: stderr text, distinct exit codes, nothing on stdout, the branch not checked out', async () => {
    const { fx: f, env } = await repoEnv();
    const cases: Array<[Record<string, string>, string, number]> = [
      [{ FAKE_CLAUDE_TELEPORT: 'dirty' }, 'Git working directory is not clean. Please commit or stash your changes before using --teleport.', 1],
      [{ FAKE_CLAUDE_TELEPORT: 'wrong-repo' }, `You must run claude --teleport ${ID} from a checkout of acme/app`, 2],
      [{ FAKE_CLAUDE_TELEPORT: 'wrong-repo', FAKE_CLAUDE_TELEPORT_REPO: 'acme/web-front' }, `You must run claude --teleport ${ID} from a checkout of acme/web-front`, 2],
      [{ FAKE_CLAUDE_TELEPORT: 'archived' }, `cloud session ${ID} is archived and cannot accept new messages`, 3],
      [{ FAKE_CLAUDE_TELEPORT: 'not-pushed' }, `Failed to fetch branch claude/${ID} from origin: fatal: couldn't find remote ref claude/${ID}`, 4],
      [{ FAKE_CLAUDE_SIGNED_OUT: '1' }, 'Not logged in · Please run /login', 5],
    ];
    for (const [extra, text, code] of cases) {
      const run = await runFake(TELEPORT_ARGS, { cwd: f.cwd, env: { ...env, ...extra } });
      expect(run, JSON.stringify(extra)).toMatchObject({ code, stdout: '', stderr: `${text}\n` });
    }
    expect(await git(f.root, f.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('checks the tree for real: tracked changes refuse (untracked files do not); outside a git checkout it is the wrong repo', async () => {
    const { fx: f, env } = await repoEnv();
    await writeFile(path.join(f.cwd, 'untracked.txt'), 'new\n');
    const untracked = await runFake(TELEPORT_ARGS, { cwd: f.cwd, env });
    expect(untracked.stderr).toBe('');
    await git(f.root, f.cwd, 'checkout', '-q', 'main');
    await writeFile(path.join(f.cwd, 'README.md'), 'changed\n');
    expect(await runFake(TELEPORT_ARGS, { cwd: f.cwd, env })).toMatchObject({
      code: 1,
      stderr: 'Git working directory is not clean. Please commit or stash your changes before using --teleport.\n',
    });
    const outside = path.join(f.root, 'not a repo');
    await mkdir(outside, { recursive: true });
    expect(await runFake(TELEPORT_ARGS, { cwd: outside, env })).toMatchObject({ code: 2, stderr: `You must run claude --teleport ${ID} from a checkout of acme/app\n` });
  });

  it('FAKE_CLAUDE_TELEPORT=no-init: the checkout and the history happen at start, init only comes with the first turn', async () => {
    const { fx: f, env } = await repoEnv();
    const run = spawnFake(TELEPORT_ARGS, { cwd: f.cwd, env: { ...env, FAKE_CLAUDE_TELEPORT: 'no-init' } });
    await run.waitFor((line) => kind(line) === 'system/hook_response');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(run.lines.map(kind)).toEqual(['system/hook_started', 'system/hook_response']);
    expect(await git(f.root, f.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`claude/${ID}`);
    run.send(userLine('Reply with just OK.'));
    const init = await run.waitFor((line) => kind(line) === 'system/init');
    await run.waitFor((line) => line['type'] === 'result');
    run.end();
    expect((await run.exited).code).toBe(0);
    const entries = await readTranscript(transcriptPath(f.configDir, f.cwd, String(init['session_id'])));
    expect(entries.filter((entry) => entry['type'] === 'user').map((entry) => (entry['message'] as { content?: unknown }).content)).toEqual([
      'Remote history 1: add a /health endpoint to the API.',
      'Remote history 2: push the branch.',
      'Reply with just OK.',
    ]);
  });

  it('a second teleport of the same id in the same checkout checks the existing branch out again', async () => {
    const { fx: f, env } = await repoEnv();
    expect((await runFake(TELEPORT_ARGS, { cwd: f.cwd, env })).code).toBe(0);
    await git(f.root, f.cwd, 'checkout', '-q', 'main');
    expect((await runFake(TELEPORT_ARGS, { cwd: f.cwd, env })).code).toBe(0);
    expect(await git(f.root, f.cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`claude/${ID}`);
  });
});
