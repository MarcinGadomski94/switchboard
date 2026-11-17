import { describe, expect, it } from 'vitest';
import { parseV2Route, phoneTabOf, v2Path } from '../../src/web/v2/routes.ts';
import { ctrlOf, keySequence } from '../../src/web/v2/terminals/terminal-keys.ts';

describe('D170 terminal routes', () => {
  it('parses the list and one terminal, on this computer or a paired one', () => {
    expect(parseV2Route('/terminals')).toEqual({ area: 'terminals' });
    expect(parseV2Route('/terminals/local/t1')).toEqual({ area: 'terminal', machine: null, id: 't1' });
    expect(parseV2Route('/terminals/m%201/t2')).toEqual({ area: 'terminal', machine: 'm 1', id: 't2' });
  });

  it('round-trips through v2Path', () => {
    for (const route of [{ area: 'terminal', machine: null, id: 't1' }, { area: 'terminal', machine: 'm 1', id: 't2' }, { area: 'terminals' }] as const) {
      expect(parseV2Route(v2Path(route))).toEqual(route);
    }
  });

  it('lives under More on a phone', () => {
    expect(phoneTabOf({ area: 'terminal', machine: null, id: 't1' })).toBe('more');
  });
});

describe('D170 phone key bar', () => {
  it('sends the escape sequences of its keys', () => {
    expect(keySequence('esc')).toBe('\x1b');
    expect(keySequence('tab')).toBe('\t');
    expect(keySequence('up')).toBe('\x1b[A');
    expect(keySequence('left')).toBe('\x1b[D');
    expect(keySequence('ctrlC')).toBe('\x03');
    expect(keySequence('ctrl')).toBe('');
  });

  it('turns the letter after the sticky Ctrl into its control character', () => {
    expect(ctrlOf('c')).toBe('\x03');
    expect(ctrlOf('D')).toBe('\x04');
    expect(ctrlOf('[')).toBe('\x1b');
    expect(ctrlOf('1')).toBe('1');
  });
});
