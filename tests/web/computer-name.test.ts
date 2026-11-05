import { describe, expect, it } from 'vitest';
import { computerShortName } from '../../src/web/v2/components/computer-name.ts';

describe('the computer badge name', () => {
  it('keeps hyphens and spaces, so two computers of one owner stay apart', () => {
    expect(computerShortName('Marcins-PC')).toBe('Marcins-PC');
    expect(computerShortName('Marcins-MacBook-Pro')).toBe('Marcins-MacBook-Pro');
    expect(computerShortName('Studio Mac')).toBe('Studio Mac');
  });
  it('drops a network domain', () => {
    expect(computerShortName('Marcins-PC.local')).toBe('Marcins-PC');
    expect(computerShortName('mac.lan')).toBe('mac');
  });
  it('never returns an empty name', () => {
    expect(computerShortName('  ')).toBe('');
    expect(computerShortName('.hidden')).toBe('.hidden');
  });
});
