import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureText, runCommand, succeeded } from '../../src/server/exec.ts';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { worktreeAddCommand, worktreeAddToken } from '../../tools/fake-claude/worktree.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * D38: `[fake:worktree-add <repo> <branch> <path>]` plays a Bash call that adds a
 * git worktree and really runs it (argv only), so Switchboard's adoption can be
 * tested on the real path.
 */
let env: FakeEnv;
let runs: FakeRun[] = [];
let gitEnv: Record<string, string>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...gitEnv } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')} failed: ${failureText(result)}`);
  return result.stdout.trim();
}

beforeEach(async () => {
  env = await makeFakeEnv('fake-worktree');
  const gitConfig = path.join(env.root, 'gitconfig');
  await writeFile(gitConfig, '');
  gitEnv = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Switchboard Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Switchboard Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const repo = path.join(env.cwd, 'microfrontends', 'web-front');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
});

afterEach(async () => {
  for (const run of runs) run.kill('SIGKILL');
  runs = [];
  await env.cleanup();
});

function start(): FakeRun {
  const run = spawnFake(BASELINE, { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir, ...gitEnv } });
  runs.push(run);
  return run;
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';

describe('fake-claude · [fake:worktree-add] (D38)', () => {
  it('parses the token: paths inside the cwd, absolute', () => {
    expect(worktreeAddToken('go [fake:worktree-add microfrontends/web-front PROJ-1-x microfrontends/web-front-wt-demo] now', '/w')).toEqual({
      repo: path.resolve('/w', 'microfrontends/web-front'),
      branch: 'PROJ-1-x',
      path: path.resolve('/w', 'microfrontends/web-front-wt-demo'),
    });
    expect(worktreeAddToken('no token', '/w')).toBeNull();
    expect(worktreeAddToken('[fake:worktree-add a b]', '/w')).toMatchObject({ error: expect.any(String) });
    expect(worktreeAddToken('[fake:worktree-add a b ../outside]', '/w')).toMatchObject({ error: expect.stringContaining('leaves the cwd') });
    expect(worktreeAddCommand({ repo: '/w/a', branch: 'b', path: '/w/a wt' })).toBe("git -C /w/a worktree add -b b '/w/a wt'");
  });

  it('runs git worktree add from the repo HEAD and plays the Bash call with git’s output', async () => {
    const run = start();
    run.send(userLine('Make it [fake:worktree-add microfrontends/web-front PROJ-38-demo microfrontends/web-front-wt-demo]'));
    await run.waitFor(isResult);
    const cwd = await realpath(env.cwd);
    const repo = path.join(cwd, 'microfrontends', 'web-front');
    const worktree = path.join(cwd, 'microfrontends', 'web-front-wt-demo');
    expect(await git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('PROJ-38-demo');
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'HEAD'));
    const call = run.lines
      .filter((l) => l['type'] === 'assistant')
      .flatMap((l) => ((l['message'] as JsonObject)['content'] as JsonObject[]).filter((b) => b['type'] === 'tool_use'))[0];
    // The cwd has a space ("work dir"): the displayed command quotes the paths.
    expect(call).toMatchObject({ name: 'Bash', input: { command: `git -C '${repo}' worktree add -b PROJ-38-demo '${worktree}'` } });
    const result = run.lines.find((l) => l['type'] === 'user' && JSON.stringify(l).includes('tool_result')) as JsonObject;
    const block = ((result['message'] as JsonObject)['content'] as JsonObject[])[0] as JsonObject;
    expect(block['tool_use_id']).toBe(call?.['id']);
    expect(String(block['content'])).toContain("Preparing worktree (new branch 'PROJ-38-demo')");
    expect(block['is_error']).toBeUndefined();

    // A second add of the same branch fails: the result is an error, the turn still ends.
    run.send(userLine('Again [fake:worktree-add microfrontends/web-front PROJ-38-demo microfrontends/web-front-wt-again]'));
    await run.waitFor(isResult, 2);
    const failed = run.lines.filter((l) => l['type'] === 'user' && JSON.stringify(l).includes('tool_result')).at(-1) as JsonObject;
    const failedBlock = ((failed['message'] as JsonObject)['content'] as JsonObject[])[0] as JsonObject;
    expect(failedBlock['is_error']).toBe(true);
    expect(String(failedBlock['content'])).toContain('PROJ-38-demo');
    run.end();
    expect((await run.exited).code).toBe(0);
  });
});
