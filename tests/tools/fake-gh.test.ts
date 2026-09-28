import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/server/exec.ts';
import { fakeGhCommand } from '../../tools/fake-gh/command.ts';
import { type GitWorld, makeGitWorld } from '../helpers/git.ts';

let world: GitWorld | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

function gh(w: GitWorld, args: string[], extra: Record<string, string> = {}, cwd = w.web) {
  return runCommand(fakeGhCommand(), args, { cwd, env: { ...w.env, ...extra } });
}

describe('tools/fake-gh', () => {
  it('--version and auth status (signed in / FAKE_GH_SIGNED_OUT=1)', async () => {
    world = await makeGitWorld();
    expect(await gh(world, ['--version'])).toMatchObject({ code: 0, stdout: expect.stringContaining('gh version') });
    expect((await gh(world, ['auth', 'status'])).code).toBe(0);
    const out = await gh(world, ['auth', 'status'], { FAKE_GH_SIGNED_OUT: '1' });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('You are not logged into any GitHub hosts');
  });

  it('pr view by branch, by number and for the checked-out branch; only the requested fields; no PR / FAKE_GH_FAIL exit 1', async () => {
    world = await makeGitWorld();
    await writeFile(world.prsFile, JSON.stringify({ main: { number: 4, state: 'OPEN', url: 'https://github.com/o/r/pull/4', title: 'x' } }));
    const byBranch = await gh(world, ['pr', 'view', 'main', '--json', 'number,state']);
    expect(byBranch).toMatchObject({ code: 0 });
    expect(JSON.parse(byBranch.stdout)).toEqual({ number: 4, state: 'OPEN' });
    expect(JSON.parse((await gh(world, ['pr', 'view', '4', '--json', 'url'])).stdout)).toEqual({ url: 'https://github.com/o/r/pull/4' });
    expect(JSON.parse((await gh(world, ['pr', 'view', '--json', 'state'])).stdout)).toEqual({ state: 'OPEN' });
    const none = await gh(world, ['pr', 'view', 'session/x', '--json', 'state']);
    expect(none.code).toBe(1);
    expect(none.stderr).toBe('no pull requests found for branch "session/x"\n');
    const failing = await gh(world, ['pr', 'view', 'main', '--json', 'state'], { FAKE_GH_FAIL: 'error connecting to api.github.com' });
    expect(failing).toMatchObject({ code: 1, stderr: 'error connecting to api.github.com\n' });
    expect((await gh(world, ['repo', 'clone'])).code).toBe(1);
    const log = await world.ghCalls();
    expect(log[0]).toEqual({ argv: ['pr', 'view', 'main', '--json', 'number,state'], cwd: world.web });
    expect(log).toHaveLength(6);
    expect(path.isAbsolute(log[0]?.cwd ?? '')).toBe(true);
  });
});
