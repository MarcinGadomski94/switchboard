import { describe, expect, it } from 'vitest';
import { compareSemVer, isNewerRelease, parseSemVer } from '../../src/core/semver.ts';

/** D55: the updater's version compare (`docs/updates.md` → *Checking*). */

function cmp(a: string, b: string): number {
  const x = parseSemVer(a);
  const y = parseSemVer(b);
  if (!x || !y) throw new Error(`bad version ${a} / ${b}`);
  return compareSemVer(x, y);
}

describe('parseSemVer', () => {
  it('reads versions and tags', () => {
    expect(parseSemVer('1.0.0')).toMatchObject({ major: 1, minor: 0, patch: 0, prerelease: [], text: '1.0.0' });
    expect(parseSemVer('v1.10.3')?.text).toBe('1.10.3');
    expect(parseSemVer(' v2.0.0-rc.1+build.5 ')).toMatchObject({ prerelease: ['rc', '1'], text: '2.0.0-rc.1' });
  });

  it('refuses anything else', () => {
    for (const bad of ['', '1', '1.0', '1.0.0.0', '01.0.0', '1.02.0', 'v', 'version 1.0.0', '1.0.0-', '1.0.0-01', 'x1.0.0', '1.0.0 beta', '99999999999999999999.0.0']) {
      expect(parseSemVer(bad), bad).toBeNull();
    }
  });
});

describe('compareSemVer', () => {
  it('orders by major, minor, patch', () => {
    expect(cmp('1.0.0', '1.0.1')).toBe(-1);
    expect(cmp('1.10.0', '1.9.9')).toBe(1);
    expect(cmp('2.0.0', '10.0.0')).toBe(-1);
    expect(cmp('1.2.3', 'v1.2.3')).toBe(0);
    expect(cmp('1.2.3+a', '1.2.3+b')).toBe(0);
  });

  it('puts pre-releases before their release, in semver order', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < order.length - 1; i++) expect(cmp(order[i] as string, order[i + 1] as string), `${order[i]} < ${order[i + 1]}`).toBe(-1);
  });
});

describe('isNewerRelease', () => {
  it('is true only for a newer release', () => {
    expect(isNewerRelease('1.1.0', '1.0.0')).toBe(true);
    expect(isNewerRelease('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerRelease('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerRelease('0.9.9', '1.0.0')).toBe(false);
  });

  it('never offers a pre-release or an unparseable version', () => {
    expect(isNewerRelease('2.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewerRelease('latest', '1.0.0')).toBe(false);
    expect(isNewerRelease('1.1.0', 'dev')).toBe(false);
  });
});
