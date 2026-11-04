import { describe, expect, it } from 'vitest';
import { gitErrorSummary, nonInteractiveGitEnv, remoteTransport, scrubCredentials, sshProgramOf, unreachableRemoteText } from '../../src/core/takeover.ts';
import { comparablePathText } from '../../src/server/takeover/git.ts';

/**
 * The take-over's remote check (`docs/peers.md` → *Reaching the remote*): git's
 * network calls never wait for a prompt in the background service, and a remote
 * the target's service cannot read blocks the take-over with git's reason and a hint.
 */

describe('nonInteractiveGitEnv: ssh in batch mode, no prompt of any kind', () => {
  it('plain ssh gets BatchMode; the prompts are off', () => {
    expect(nonInteractiveGitEnv({}, null)).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' });
  });

  it("keeps the developer's own ssh command (env first, then core.sshCommand) and adds BatchMode to it", () => {
    expect(nonInteractiveGitEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy -F /dev/null' }, 'ssh -i other').GIT_SSH_COMMAND).toBe('ssh -i ~/.ssh/deploy -F /dev/null -o BatchMode=yes');
    expect(nonInteractiveGitEnv({}, 'C:/Windows/System32/OpenSSH/ssh.exe').GIT_SSH_COMMAND).toBe('C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes');
    expect(nonInteractiveGitEnv({}, '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i key').GIT_SSH_COMMAND).toBe('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i key -o BatchMode=yes');
  });

  it('GIT_SSH (a program path, also a Windows one) becomes a quoted command with forward slashes; plink gets -batch', () => {
    expect(nonInteractiveGitEnv({ GIT_SSH: 'C:\\Program Files\\OpenSSH\\ssh.exe' }, null).GIT_SSH_COMMAND).toBe('"C:/Program Files/OpenSSH/ssh.exe" -o BatchMode=yes');
    expect(nonInteractiveGitEnv({ GIT_SSH: 'C:\\Program Files\\PuTTY\\plink.exe' }, null).GIT_SSH_COMMAND).toBe('"C:/Program Files/PuTTY/plink.exe" -batch');
    expect(nonInteractiveGitEnv({}, 'TortoisePlink.exe -i key.ppk').GIT_SSH_COMMAND).toBe('TortoisePlink.exe -i key.ppk -batch');
  });

  it('a command that already says BatchMode is kept; an unknown wrapper is not touched', () => {
    expect(nonInteractiveGitEnv({ GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }, null).GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
    const wrapper = nonInteractiveGitEnv({}, '/opt/bin/my-ssh-wrapper --flag');
    expect(wrapper).not.toHaveProperty('GIT_SSH_COMMAND');
    expect(wrapper.GIT_TERMINAL_PROMPT).toBe('0');
    expect(nonInteractiveGitEnv({ GIT_SSH: '/opt/bin/wrapper.sh' }, null)).not.toHaveProperty('GIT_SSH_COMMAND');
  });

  it('sshProgramOf reads the program of POSIX and Windows commands', () => {
    expect(sshProgramOf('/usr/bin/ssh -F x')).toBe('ssh');
    expect(sshProgramOf('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -i k')).toBe('ssh');
    expect(sshProgramOf("'D:/tools/SSH.EXE'")).toBe('ssh');
    expect(sshProgramOf('plink.exe -batch')).toBe('plink');
  });
});

describe("gitErrorSummary: git's reason, not its boilerplate", () => {
  it('keeps the ssh reason and drops the generic lines', () => {
    const out = 'git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\r\n\r\nPlease make sure you have the correct access rights\r\nand the repository exists.\r\n';
    expect(gitErrorSummary(out)).toBe('Permission denied (publickey)');
    expect(gitErrorSummary("fatal: '/nowhere/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n")).toBe("'/nowhere/x.git' does not appear to be a git repository");
    expect(gitErrorSummary('Host key verification failed.\nfatal: Could not read from remote repository.')).toBe('Host key verification failed');
  });

  it('never shows a credential in a URL, and stays short', () => {
    expect(gitErrorSummary("fatal: unable to access 'https://user:s3cr3t@example.com/acme/app.git/': The requested URL returned error: 403")).toBe("unable to access 'https://example.com/acme/app.git/': The requested URL returned error: 403");
    expect(scrubCredentials('ssh://git@example.com/x and https://tok@example.com/y')).toBe('ssh://git@example.com/x and https://example.com/y');
    expect(gitErrorSummary(`fatal: ${'x'.repeat(500)}`).length).toBe(300);
  });
});

describe('unreachableRemoteText: who, what, why and what to do', () => {
  it('an ssh remote the service has no key for (the example)', () => {
    expect(unreachableRemoteText({ machine: 'Desk', repo: 'app', url: 'git@example.com:acme/app.git', remoteName: 'origin', reason: 'Permission denied (publickey)', timedOut: false })).toBe(
      "Desk can't reach app's remote (git@example.com:acme/app.git) from Switchboard's service: Permission denied (publickey). Its SSH key isn't available to the background service — switch this repo's origin to HTTPS (Git Credential Manager) or make the key usable without a prompt, then check again.",
    );
  });

  it('a clone, a host key, https credentials, a timeout and anything else', () => {
    expect(unreachableRemoteText({ machine: 'Desk', repo: 'app', url: 'ssh://git@example.com/acme/app.git', remoteName: null, reason: 'Permission denied (publickey)', timedOut: false })).toContain('clone it here over HTTPS (Git Credential Manager) and choose that folder, or make the key usable without a prompt');
    expect(unreachableRemoteText({ machine: 'Desk', repo: 'app', url: 'git@example.com:acme/app.git', remoteName: 'origin', reason: 'Host key verification failed', timedOut: false })).toContain("The host's key isn't trusted for the account Switchboard's service runs as");
    const https = unreachableRemoteText({ machine: 'Desk', repo: 'app', url: 'https://user:tok@example.com/acme/app.git', remoteName: 'origin', reason: 'could not read Username for https://example.com: terminal prompts disabled', timedOut: false });
    expect(https).toContain('(https://example.com/acme/app.git)');
    expect(https).not.toContain('tok');
    expect(https).toContain('Its credentials aren\'t available to the background service');
    expect(unreachableRemoteText({ machine: 'Desk', repo: 'app', url: 'git@example.com:acme/app.git', remoteName: 'origin', reason: '', timedOut: true })).toContain('from Switchboard\'s service: no answer within 15 s. Its SSH key');
    expect(unreachableRemoteText({ machine: 'Desk', repo: 'app', url: '/srv/git/app.git', remoteName: 'origin', reason: "'/srv/git/app.git' does not appear to be a git repository", timedOut: false })).toContain('Check that the remote exists and that Desk can reach it, then check again.');
  });

  it('remoteTransport tells scp-like, ssh://, https and paths (Windows ones too) apart', () => {
    expect(remoteTransport('git@example.com:acme/app.git')).toBe('ssh');
    expect(remoteTransport('ssh://git@example.com:22/acme/app.git')).toBe('ssh');
    expect(remoteTransport('https://example.com/acme/app')).toBe('https');
    expect(remoteTransport('C:\\repos\\app.git')).toBe('other');
    expect(remoteTransport('D:/repos/app.git')).toBe('other');
    expect(remoteTransport('/srv/git/app.git')).toBe('other');
    expect(remoteTransport('file:///srv/git/app.git')).toBe('other');
  });
});

describe('comparablePathText: one folder, two spellings', () => {
  it('Windows: slashes and case do not matter; POSIX: they do', () => {
    expect(comparablePathText('D:\\Code\\App-wt-x\\', 'win32')).toBe(comparablePathText('d:/code/app-wt-x', 'win32'));
    expect(comparablePathText('/code/App/', 'darwin')).toBe('/code/App');
    expect(comparablePathText('/code/App', 'linux')).not.toBe(comparablePathText('/code/app', 'linux'));
  });
});
