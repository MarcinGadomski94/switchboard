import { describe, expect, it } from 'vitest';
import { boundEnv, commitAuthor, ghCredentialHelper, noreplyEmail, parseDeviceLogin, readGitHubIdentity, readGitHubLogin, shellWord } from '../../src/core/github-binding.ts';
import { readGitHubSignIns } from '../../src/server/github/bindings.ts';

/** D190 (`docs/profiles.md` → *A profile's GitHub account*): the pure parts of a profile's GitHub binding. */
describe('D190 · GitHub binding helpers', () => {
  const octo = { login: 'octo-cat', name: 'Octo Cat', id: 42, email: null };

  it('reads logins and identities strictly', () => {
    expect(readGitHubLogin('octo-cat')).toBe('octo-cat');
    for (const bad of ['-octo', 'octo cat', '', 'a'.repeat(40), 7]) expect(readGitHubLogin(bad)).toBeNull();
    expect(readGitHubIdentity({ login: 'octo-cat', name: 'Octo Cat', id: 42, email: 'me@example.com' })).toEqual({ ...octo, email: 'me@example.com' });
    expect(readGitHubIdentity({ login: 'octo-cat', id: -1 })).toBeNull();
    expect(readGitHubIdentity({ login: 'octo-cat', id: 42, email: 'not an email' })?.email ?? null).toBeNull();
  });

  it('commits as the GitHub name (else the login) and the chosen email (else the noreply)', () => {
    expect(noreplyEmail(octo)).toBe('42+octo-cat@users.noreply.github.com');
    expect(commitAuthor(octo)).toEqual({ name: 'Octo Cat', email: '42+octo-cat@users.noreply.github.com' });
    expect(commitAuthor({ ...octo, name: null, email: 'me@example.com' })).toEqual({ name: 'octo-cat', email: 'me@example.com' });
  });

  it('gives agents the gh folder, the author and a credential helper set only through the environment (reset first)', () => {
    const env = boundEnv(octo, '/data/github/p1', ['/usr/bin/gh']);
    expect(env).toEqual({
      GH_CONFIG_DIR: '/data/github/p1',
      GIT_AUTHOR_NAME: 'Octo Cat',
      GIT_AUTHOR_EMAIL: '42+octo-cat@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Octo Cat',
      GIT_COMMITTER_EMAIL: '42+octo-cat@users.noreply.github.com',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!/usr/bin/gh auth git-credential',
    });
    // A path with spaces or backslashes is quoted for git's shell.
    expect(shellWord('C:\\Program Files\\GitHub CLI\\gh.exe')).toBe('"C:/Program Files/GitHub CLI/gh.exe"');
    expect(ghCredentialHelper(['node', '/x y/main.ts'])).toBe('!node "/x y/main.ts" auth git-credential');
  });

  it('reads gh’s device code and page', () => {
    expect(parseDeviceLogin('! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n')).toEqual({ code: 'AB12-CD34', url: 'https://github.com/login/device' });
    expect(parseDeviceLogin('nothing yet')).toEqual({ code: null, url: null });
  });

  it('reads a peer’s sign-ins strictly (bad tokens, ids and shapes left out)', () => {
    expect(readGitHubSignIns({ v: 2, signIns: [] })).toBeNull();
    expect(readGitHubSignIns([])).toBeNull();
    expect(
      readGitHubSignIns({
        v: 1,
        signIns: [
          { profile: 'p1', clock: 'c1', token: 'gho_abcdefghij0123' },
          { profile: 'p2', clock: 'c2', token: null },
          { profile: 'p3', clock: 'c3', token: 'has spaces in it' },
          { profile: '../x', clock: 'c4', token: null },
          { profile: 'p5', clock: '', token: null },
        ],
      }),
    ).toEqual([
      { profile: 'p1', clock: 'c1', token: 'gho_abcdefghij0123' },
      { profile: 'p2', clock: 'c2', token: null },
    ]);
  });
});
