import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * A stand-in for `ssh` (`docs/peers.md` → *Reaching the remote*, tests): never a real
 * key, host or network. It writes its arguments to `FAKE_SSH_LOG`; called in batch
 * mode (`-o BatchMode=yes`) it fails at once like ssh without a usable key
 * ("Permission denied (publickey)"); called without it, it waits like ssh at a
 * passphrase prompt nobody can answer (`FAKE_SSH_PROMPT_SECONDS`, default 30), so a
 * non-batch call shows up as a hang. POSIX only (a `#!/bin/sh` script named `ssh`).
 */
export async function writeFakeSsh(dir: string): Promise<{ readonly program: string; readonly log: string; readonly env: Record<string, string>; calls(): Promise<string[]> }> {
  await mkdir(dir, { recursive: true });
  const program = path.join(dir, 'ssh');
  const log = path.join(dir, 'fake-ssh.log');
  await writeFile(
    program,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_SSH_LOG"',
      'case "$*" in',
      '  *BatchMode=yes*) echo "git@example.invalid: Permission denied (publickey)." >&2; exit 255 ;;',
      'esac',
      'sleep "${FAKE_SSH_PROMPT_SECONDS:-30}"',
      'exit 255',
      '',
    ].join('\n'),
  );
  await chmod(program, 0o755);
  return {
    program,
    log,
    env: { GIT_SSH: program, FAKE_SSH_LOG: log },
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== ''),
  };
}
