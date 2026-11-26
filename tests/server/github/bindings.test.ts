import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubIdentity } from '../../../src/core/github-binding.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { GITHUB_SIGN_INS_SETTING, GitHubBindings } from '../../../src/server/github/bindings.ts';
import type { UserProfileService } from '../../../src/server/user-profiles/service.ts';
import { fakeGhCommand } from '../../../tools/fake-gh/command.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';

/**
 * D190 (`docs/profiles.md` → *A profile's GitHub account*), the service on its own with tools/fake-gh:
 * a Disconnect while a paired computer's sign-in is being imported wins (one change of a profile at a
 * time); gh's token variables never decide a profile's call nor travel as its token; a shared
 * sign-in is taken only into a profile bound to that account (its numeric id).
 */

const OCTO: GitHubIdentity = { login: 'octo-fake', name: 'Octo Fake', id: 4242, email: null };
const TOKEN = 'gho_sharedTokenFromPeer0123456789';

let tmp: string;
let bindings: GitHubBindings | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('github-bindings');
});
afterEach(async () => {
  bindings?.close();
  bindings = null;
  await removeTempDir(tmp);
});

interface World {
  readonly bindings: GitHubBindings;
  readonly settings: Map<string, unknown>;
  readonly profile: { github: GitHubIdentity | null };
  readonly stdinLog: string;
}

/** One profile `p1` (bound to `github`, allowed everywhere) and an in-memory settings store. */
function world(env: Record<string, string> = {}, github: GitHubIdentity | null = OCTO): World {
  const settings = new Map<string, unknown>();
  const profile = { id: 'p1', name: 'Ann', github };
  const stdinLog = path.join(tmp, 'stdin.log');
  const store = { settings: { get: async (key: string) => settings.get(key) ?? null, set: async (key: string, value: unknown) => void settings.set(key, value) }, sessions: { get: async () => ({ id: 's1', userProfileId: 'p1' }) } } as unknown as Store;
  const profiles = {
    get: async (id: string) => (id === 'p1' ? profile : null),
    setGitHub: async (_id: string, value: GitHubIdentity | null) => {
      profile.github = value;
      return profile;
    },
    authorizeGitHub: async () => profile,
    selfMachineId: () => 'self',
    profileOfSession: () => 'p1',
    allowedOn: () => true,
    allowedHere: () => true,
    linkIdOf: (id: string) => id,
    fromRemote: (_machine: string, id: string) => id,
  } as unknown as UserProfileService;
  const made = new GitHubBindings({ store, profiles, dataDir: path.join(tmp, 'data'), gh: fakeGhCommand(), env: { ...process.env, FAKE_GH_STDIN_LOG: stdinLog, ...env } });
  bindings = made;
  return { bindings: made, settings, profile, stdinLog };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

describe('D190 · GitHubBindings', () => {
  it('a Disconnect while a paired computer’s sign-in is imported wins: folder gone, tombstone kept, nothing offered again', async () => {
    const w = world({ FAKE_GH_WITH_TOKEN_DELAY_MS: '800' });
    const importing = w.bindings.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }]);
    // gh is taking the token (the import has started): Disconnect now.
    for (let i = 0; i < 50 && !(await exists(w.bindings.dirOf('p1'))); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const disconnected = w.bindings.disconnect('p1', 'p1', undefined);
    expect(await importing).toBe(1);
    const view = await disconnected;
    expect(view).toMatchObject({ identity: null, signedInHere: false });
    expect(await exists(w.bindings.dirOf('p1'))).toBe(false);
    const record = (w.settings.get(GITHUB_SIGN_INS_SETTING) as Record<string, { clock: string; signedIn: boolean }>)['p1'];
    expect(record?.signedIn).toBe(false);
    expect(record && record.clock > '000000000000001.000001.peer').toBe(true);
    // The same record again (a relay): older than the tombstone, ignored; this computer offers only the tombstone.
    expect(await w.bindings.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }])).toBe(0);
    expect((await w.bindings.wire('peer')).signIns).toEqual([{ profile: 'p1', clock: record?.clock, token: null }]);
  }, 30_000);

  it('gh’s token variables in Switchboard’s environment never decide a profile’s call nor travel as its token', async () => {
    const w = world({ GH_TOKEN: 'ghp_switchboardOwnToken0123456789', GITHUB_TOKEN: 'ghp_switchboardOwnToken0123456789' });
    expect(await w.bindings.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }])).toBe(1);
    const sent = await w.bindings.wire('peer');
    expect(sent.signIns).toEqual([{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }]);
    expect(JSON.stringify(sent)).not.toContain('switchboardOwnToken');
    // An agent of the profile gets the folder, not the variables (the supervisor removes them from what it inherits).
    expect(Object.keys(await w.bindings.envForProfile('p1'))).not.toContain('GH_TOKEN');
    expect(await w.bindings.ghEnvForSession('any')).toEqual({ GH_CONFIG_DIR: w.bindings.dirOf('p1') });
  }, 30_000);

  it('a deleted profile’s sign-in is removed and tombstoned; a relative gh path is absolute in the credential helper', async () => {
    let listener: ((message: { name: string }) => void) | null = null;
    const settings = new Map<string, unknown>();
    let alive = true;
    const profile = { id: 'p1', name: 'Ann', github: OCTO };
    const store = { settings: { get: async (key: string) => settings.get(key) ?? null, set: async (key: string, value: unknown) => void settings.set(key, value) }, sessions: { get: async () => null } } as unknown as Store;
    const profiles = {
      get: async () => (alive ? profile : null),
      selfMachineId: () => 'self',
      profileOfSession: () => 'p1',
      allowedOn: () => true,
      allowedHere: () => true,
      linkIdOf: (id: string) => id,
      fromRemote: (_machine: string, id: string) => id,
    } as unknown as UserProfileService;
    const bus = { subscribe: (fn: (message: { name: string }) => void) => ((listener = fn), () => undefined) };
    const made = new GitHubBindings({ store, profiles, bus: bus as never, dataDir: path.join(tmp, 'data'), gh: [process.execPath, path.relative(process.cwd(), fakeGhCommand()[1] as string)] });
    bindings = made;
    expect(await made.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }])).toBe(1);
    const helper = (await made.envForProfile('p1'))['GIT_CONFIG_VALUE_1'] ?? '';
    expect(helper).toContain(path.resolve(fakeGhCommand()[1] as string).replace(/\\/g, '/'));
    // The profile is deleted (here or on a paired computer): its folder goes, a tombstone stays.
    alive = false;
    (listener as unknown as (message: { name: string }) => void)({ name: 'userProfilesChanged' });
    for (let i = 0; i < 100 && (await exists(made.dirOf('p1'))); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await exists(made.dirOf('p1'))).toBe(false);
    expect((settings.get(GITHUB_SIGN_INS_SETTING) as Record<string, { signedIn: boolean }>)['p1']?.signedIn).toBe(false);
  }, 30_000);

  it('takes a shared sign-in only into a profile bound to that account (its numeric id), never an unbound one', async () => {
    const unbound = world({}, null);
    expect(await unbound.bindings.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }])).toBe(0);
    expect(await exists(unbound.bindings.dirOf('p1'))).toBe(false);
    expect(await readFile(unbound.stdinLog, 'utf8').catch(() => '')).toBe('');
    unbound.bindings.close();
    // Bound to another account with the same login: refused (the id differs), its folder removed.
    const other = world({}, { ...OCTO, id: 9999 });
    expect(await other.bindings.merge('peer', [{ profile: 'p1', clock: '000000000000001.000001.peer', token: TOKEN }])).toBe(0);
    expect(await exists(other.bindings.dirOf('p1'))).toBe(false);
  }, 30_000);
});
