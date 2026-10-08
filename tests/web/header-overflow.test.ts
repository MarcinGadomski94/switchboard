import { describe, expect, it } from 'vitest';
import { NO_OVERFLOW, headerOverflow } from '../../src/web/views/session/header-overflow.ts';

/** D74 follow-up: the header's actions adapt to the width the header has (pure part). */
describe('headerOverflow', () => {
  const widths = { cli: 100, model: 120, close: 50, remote: 80, takeover: 200, pause: 55, handoff: 150 };
  const present = ['cli', 'model', 'close', 'remote', 'takeover', 'pause', 'handoff'] as const;
  const total = Object.values(widths).reduce((a, b) => a + b, 0) + 6 * 6;
  const input = (available: number) => ({ available, gap: 6, moreWidth: 30, present, widths, shortWidths: { takeover: 70 } });

  it('changes nothing when everything fits', () => {
    expect(headerOverflow(input(total))).toBe(NO_OVERFLOW);
  });

  it('shortens Move first, then moves Move, Continue in terminal, Remote, Close … into ⋯, the model picker last', () => {
    expect(headerOverflow(input(total - 100))).toEqual({ short: true, hidden: [] });
    expect(headerOverflow(input(total - 140))).toEqual({ short: true, hidden: ['takeover'] });
    expect(headerOverflow(input(total - 300))).toEqual({ short: true, hidden: ['takeover', 'handoff'] });
    expect(headerOverflow(input(total - 400))).toEqual({ short: true, hidden: ['takeover', 'handoff', 'remote'] });
    expect(headerOverflow(input(0)).hidden).toEqual(['takeover', 'handoff', 'remote', 'close', 'cli', 'pause', 'model']);
  });

  it('without a take-over action nothing shortens', () => {
    const { takeover: _t, ...rest } = widths;
    const fewer = { ...input(200), present: present.filter((key) => key !== 'takeover'), widths: rest };
    expect(headerOverflow(fewer).short).toBe(false);
    expect(headerOverflow(fewer).hidden[0]).toBe('handoff');
  });
});
