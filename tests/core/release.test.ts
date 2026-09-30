import { describe, expect, it } from 'vitest';
import { checksumLine, checksumName, isReleaseExcluded, packagePrefix, parseChecksum, releaseTag, tarballName } from '../../src/core/release.ts';

/** D55: the release package layout shared by the updater and `npm run release:package`. */

const HEX = '7c01433f7643b863684e64eff0b9b295c133209932059a6c3bbd914ff980a034';

describe('release names', () => {
  it('match the 1.0.0 assets', () => {
    expect(tarballName('1.0.0')).toBe('switchboard-1.0.0.tar.gz');
    expect(checksumName('1.0.0')).toBe('switchboard-1.0.0.tar.gz.sha256');
    expect(packagePrefix('1.0.0')).toBe('switchboard-1.0.0/');
    expect(releaseTag('1.0.0')).toBe('v1.0.0');
  });
});

describe('isReleaseExcluded', () => {
  it('leaves out the tests, the loop state, the visual references and the test configs', () => {
    for (const file of ['tests', 'tests/', 'tests/core/x.test.ts', '.loop/progress.md', 'docs/visual/inbox.md', 'playwright.config.ts', 'vitest.config.ts', 'tsconfig.e2e.json']) {
      expect(isReleaseExcluded(file), file).toBe(true);
    }
  });

  it('keeps everything else', () => {
    for (const file of ['src/server/main.ts', 'docs/updates.md', 'docs/visualize.md', 'tools/fake-gh/main.ts', 'tsconfig.json', 'package.json', 'testsuite.md', '.github/workflows/service.yml']) {
      expect(isReleaseExcluded(file), file).toBe(false);
    }
  });
});

describe('checksum files', () => {
  it('reads the sha256sum format (the 1.0.0 asset)', () => {
    const text = checksumLine(HEX, 'switchboard-1.0.0.tar.gz');
    expect(text).toBe(`${HEX}  switchboard-1.0.0.tar.gz\n`);
    expect(parseChecksum(text, 'switchboard-1.0.0.tar.gz')).toBe(HEX);
    expect(parseChecksum(`${HEX.toUpperCase()} *switchboard-1.0.0.tar.gz\r\n`, 'switchboard-1.0.0.tar.gz')).toBe(HEX);
  });

  it('refuses another file name, a short hash, several lines or nothing', () => {
    expect(parseChecksum(checksumLine(HEX, 'switchboard-1.0.1.tar.gz'), 'switchboard-1.0.0.tar.gz')).toBeNull();
    expect(parseChecksum(`${HEX.slice(1)}  switchboard-1.0.0.tar.gz\n`, 'switchboard-1.0.0.tar.gz')).toBeNull();
    expect(parseChecksum(`${checksumLine(HEX, 'a')}${checksumLine(HEX, 'switchboard-1.0.0.tar.gz')}`, 'switchboard-1.0.0.tar.gz')).toBeNull();
    expect(parseChecksum('', 'switchboard-1.0.0.tar.gz')).toBeNull();
    expect(parseChecksum(HEX, 'switchboard-1.0.0.tar.gz')).toBeNull();
  });
});
