import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_REFUSED, isLocalOnly, matchesRule } from '../../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { TakeoverGit } from '../../../src/server/takeover/git.ts';
import { LocateRefusal, allowedPlaces, checkoutFacts, findCheckouts, listFolders, resolveAllowed } from '../../../src/server/takeover/locate.ts';
import { gitIn } from '../../helpers/takeover.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D110 (`docs/peers.md` → *Target folders and verification*): the target side's
 * read-only helpers with temp git repos: the bounded checkout search, the folder
 * listing (folders only), the allowed places (no path outside them, links resolved
 * first), a checkout's facts; and the routes' peer / device classification.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('takeover-locate'));
  await writeFile(path.join(tmp, 'gitconfig'), '');
});
afterEach(async () => {
  await removeTempDir(tmp);
});

async function repo(dir: string, remote: string | null = null): Promise<string> {
  await mkdir(dir, { recursive: true });
  await gitIn(tmp, dir, 'init', '-q', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), '# r\n');
  await gitIn(tmp, dir, 'add', '-A');
  await gitIn(tmp, dir, 'commit', '-q', '-m', 'init');
  if (remote) await gitIn(tmp, dir, 'remote', 'add', 'origin', remote);
  return dir;
}

describe('D110 findCheckouts: bounded, main checkouts only', () => {
  it('finds the root itself and checkouts up to three levels down (a group folder, a nested clone, <org>/<group>/<repo>); never hidden, linked, worktree, archived or deeper folders', async () => {
    const ws = path.join(tmp, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'AGENTS.md'), '# AGENTS.md (Workspace Router)\n');
    const app = await repo(path.join(ws, 'app'));
    const front = await repo(path.join(ws, 'microfrontends', 'web-front'));
    const mobile = await repo(path.join(ws, 'mobile', 'acme-app-mobile'));
    await repo(path.join(ws, '.hidden', 'secret'));
    await repo(path.join(ws, 'deprecated', 'old-app'));
    await repo(path.join(ws, 'node_modules', 'dep'));
    // Three levels down is searched (developer ruling 2026-10-14), four is not.
    const threeDown = await repo(path.join(ws, 'acme', 'platform', 'three-down'));
    await repo(path.join(ws, 'acme', 'platform', 'legacy', 'four-down'));
    await gitIn(tmp, app, 'worktree', 'add', '-q', '-b', 'wt', path.join(ws, 'app-wt-x'));
    await symlink(app, path.join(ws, 'linked'));
    expect((await findCheckouts(ws)).sort()).toEqual([app, mobile, front, threeDown].sort());
    // A root that is a checkout is the one match; nothing under it is searched.
    expect(await findCheckouts(app)).toEqual([app]);
    expect(await findCheckouts(path.join(tmp, 'nothing-here'))).toEqual([]);
  });

  it("reads a checkout's facts: every remote (credentials removed, keys normalised), the branch and the uncommitted count", async () => {
    const dir = await repo(path.join(tmp, 'app'), 'https://user:secret@Git.Acme.Example/Acme/App.git');
    await gitIn(tmp, dir, 'remote', 'add', 'mirror', 'git@git.acme.example:acme/app-mirror.git');
    await gitIn(tmp, dir, 'checkout', '-q', '-b', 'feature/x');
    await writeFile(path.join(dir, 'new.txt'), 'x');
    const git = new TakeoverGit({ log: () => undefined, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig') } });
    const facts = await checkoutFacts(dir, git);
    expect(facts).toMatchObject({ path: dir, branch: 'feature/x', dirty: 1 });
    expect(facts.remotes).toEqual([
      { name: 'mirror', url: 'git@git.acme.example:acme/app-mirror.git', key: 'git.acme.example/acme/app-mirror' },
      { name: 'origin', url: 'https://Git.Acme.Example/Acme/App.git', key: 'git.acme.example/acme/app' },
    ]);
  });
});

describe('D110 the folder listing and the allowed places', () => {
  it('lists folders only (never a file), marks repos and workspaces, leaves hidden folders and links out', async () => {
    const home = path.join(tmp, 'home');
    await mkdir(path.join(home, 'code', 'plain'), { recursive: true });
    await mkdir(path.join(home, 'code', '.cache'), { recursive: true });
    await repo(path.join(home, 'code', 'app'));
    await mkdir(path.join(home, 'code', 'ws'), { recursive: true });
    await writeFile(path.join(home, 'code', 'ws', 'AGENTS.md'), '# router\n');
    await writeFile(path.join(home, 'code', 'secret.txt'), 'do not list me');
    await symlink(path.join(home, 'code', 'plain'), path.join(home, 'code', 'link'));
    const entries = await listFolders(path.join(home, 'code'));
    expect(entries.map((entry) => entry.name)).toEqual(['app', 'plain', 'ws']);
    expect(entries.find((entry) => entry.name === 'app')).toMatchObject({ repo: true, workspace: false });
    expect(entries.find((entry) => entry.name === 'ws')).toMatchObject({ repo: false, workspace: true });
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('allows the home folder, the saved folders and their parents; refuses anything else, relative paths, files and links out', async () => {
    const home = path.join(tmp, 'home');
    const saved = path.join(tmp, 'drive', 'code', 'ws');
    const elsewhere = path.join(tmp, 'elsewhere');
    await mkdir(path.join(home, 'projects'), { recursive: true });
    await mkdir(path.join(saved, 'inner'), { recursive: true });
    await mkdir(path.join(tmp, 'drive', 'code', 'sibling'), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(home, 'file.txt'), 'x');
    await symlink(elsewhere, path.join(home, 'escape'));
    const places = await allowedPlaces(home, [saved, path.join(tmp, 'gone')]);
    expect(places).toEqual([home, saved, path.join(tmp, 'drive', 'code')]);
    // The root of the file system is never an allowed place, even for a folder saved right under it.
    expect(await allowedPlaces(home, [path.parse(tmp).root])).toEqual([home, path.parse(tmp).root]);
    expect(await allowedPlaces(home, ['/tmp-not-there'])).toEqual([home]);
    expect(await resolveAllowed(path.join(home, 'projects'), places)).toBe(path.join(home, 'projects'));
    expect(await resolveAllowed(path.join(saved, 'inner'), places)).toBe(path.join(saved, 'inner'));
    expect(await resolveAllowed(path.join(tmp, 'drive', 'code', 'sibling'), places)).toBe(path.join(tmp, 'drive', 'code', 'sibling'));
    const refusal = async (input: string): Promise<number> => resolveAllowed(input, places).then(() => 0, (error: unknown) => (error instanceof LocateRefusal ? error.status : -1));
    expect(await refusal(elsewhere)).toBe(403);
    expect(await refusal(path.join(tmp, 'drive'))).toBe(403);
    expect(await refusal(path.join(home, 'escape'))).toBe(403);
    expect(await refusal(path.join(home, '..', 'elsewhere'))).toBe(403);
    expect(await refusal('relative/path')).toBe(422);
    expect(await refusal(path.join(home, 'missing'))).toBe(422);
    expect(await refusal(path.join(home, 'file.txt'))).toBe(422);
  });
});

describe('D110 route classification', () => {
  it('the target-side listing and verification are peer-callable; the UI routes are not; devices get none of them', () => {
    expect(peerApiAllowed('POST', '/api/takeover/target/folders')).toBe(true);
    expect(peerApiAllowed('POST', '/api/takeover/target/verify')).toBe(true);
    expect(peerApiAllowed('GET', '/api/takeover/target/folders')).toBe(false);
    expect(peerApiAllowed('POST', '/api/takeover/folders')).toBe(false);
    expect(peerApiAllowed('POST', '/api/takeover/preview')).toBe(false);
    for (const url of ['/api/takeover/folders', '/api/takeover/target/folders', '/api/takeover/target/verify', '/api/team/members/m1/move/check', '/api/team/members/m1/move']) {
      expect(isLocalOnly('POST', url), url).toBe(true);
      expect(matchesRule(DEVICE_REFUSED, 'POST', url), url).toBe(true);
    }
  });
});
