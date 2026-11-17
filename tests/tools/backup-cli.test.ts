import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../tools/backup/cli.ts';

/** D168 (`docs/backup.md` → *From the terminal*): `switchboard backup` / `restore`'s arguments. */

describe('switchboard backup / restore arguments', () => {
  it('backup: an output, the passphrase from a named variable', () => {
    expect(parseArgs(['backup', '--out', '/tmp/x.sbbackup', '--passphrase-env', 'SB_PASS'])).toMatchObject({ command: 'backup', out: '/tmp/x.sbbackup', passphraseEnv: 'SB_PASS' });
  });

  it('restore: the file, several maps (Windows paths too), the identity, force and allow-missing', () => {
    expect(parseArgs(['restore', 'b.sbbackup', '--map', 'D:\\code=/Users/me/code', '--map', '/a=/b', '--identity', 'new', '--force', '--allow-missing'])).toMatchObject({
      command: 'restore',
      file: 'b.sbbackup',
      maps: [
        { from: 'D:\\code', to: '/Users/me/code' },
        { from: '/a', to: '/b' },
      ],
      identity: 'new',
      force: true,
      allowMissing: true,
    });
  });

  it('never a passphrase as an argument; bad values and unknown options are refused', () => {
    expect(parseArgs(['backup', '--passphrase', 'secret'])).toMatch(/never an argument/);
    expect(parseArgs(['backup', '--passphrase=secret'])).toMatch(/never an argument/);
    expect(parseArgs(['restore'])).toMatch(/needs the backup file/);
    expect(parseArgs(['restore', 'b', '--identity', 'maybe'])).toMatch(/keep or new/);
    expect(parseArgs(['restore', 'b', '--map', 'nothing'])).toMatch(/<old path>=<new path>/);
    expect(parseArgs(['backup', '--force'])).toMatch(/unknown option/);
    expect(parseArgs(['other'])).toMatch(/unknown command/);
    expect(parseArgs([])).toMatchObject({ command: 'help' });
  });
});
