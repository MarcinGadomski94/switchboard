import { describe, expect, it } from 'vitest';
import { costText, filtersFromSearch, forecastText, insightsPath, percentText, ratioText, suggestionPath, trendGeometry } from '../../src/web/views/insights/insights-view.ts';
import { matchModelOption, suggestedRule } from '../../src/web/views/settings/model-rules.ts';
import { machinesNotice } from '../../src/web/views/insights/useInsights.ts';

/** D108 · the Insights page's pure parts and the suggested rule's way into Model by task. */
describe('D108 · Insights page helpers', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');

  it('the filters live in the address; unusable values read as the defaults', () => {
    expect(filtersFromSearch('', now)).toEqual({ period: '30d', from: '2026-09-15', to: '2026-10-14', folder: null, cli: null, model: null, account: null, machine: null });
    const f = filtersFromSearch('?period=custom&from=2026-10-01&to=2026-10-05&folder=none&model=claude-haiku-4-5&machine=m1', now);
    expect(f).toMatchObject({ period: 'custom', from: '2026-10-01', to: '2026-10-05', folder: '', model: 'claude-haiku-4-5', machine: 'm1' });
    expect(insightsPath(f)).toBe('/insights?period=custom&from=2026-10-01&to=2026-10-05&folder=none&model=claude-haiku-4-5&machine=m1');
    expect(filtersFromSearch('?period=1y', now).period).toBe('30d');
  });

  it('formats', () => {
    expect(costText(0.0096, 'USD')).toBe('$0.0096');
    expect(costText(1.1008, 'USD')).toBe('$1.10');
    expect(costText(null, 'USD')).toBe('—');
    expect(percentText(1 / 3)).toBe('33%');
    expect(percentText(0.055)).toBe('5.5%');
    expect(ratioText(0.8)).toBe('0.8×');
    expect(forecastText({ window: 'five_hour', pct: 40, resetsAt: null, pctPerHour: null, readings: 1, verdict: 'unknown', fullAt: null, atReset: null })).toBe('40% now; too few readings for a pace.');
  });

  it('the trend: empty days break the line; the y axis rounds up', () => {
    const g = trendGeometry(
      [
        { day: '2026-10-12', turns: 4, tokens: 40_000, tokensPerTurn: 10_000 },
        { day: '2026-10-13', turns: 0, tokens: 0, tokensPerTurn: null },
        { day: '2026-10-14', turns: 8, tokens: 32_000, tokensPerTurn: 4_000 },
      ],
      200,
      100,
    );
    expect(g.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [200, 60],
    ]);
    expect(g.segments).toEqual([]);
    expect(g.ticks.map((t) => t.label)).toEqual(['0', '5k', '10k']);
  });

  it('a suggestion opens Model by task with its rule; the reported model maps to the CLI\'s alias', () => {
    const rule = { priority: 'low', estimate: { kind: 'at-most', minutes: 30 }, provider: 'claude', model: 'claude-haiku-4-5' } as const;
    const path = suggestionPath({ rule });
    expect(path.startsWith('/settings/sessions?suggestRule=')).toBe(true);
    expect(suggestedRule(path.slice(path.indexOf('?')), 'r1')).toEqual({ id: 'r1', ...rule });
    expect(suggestedRule('?suggestRule=%7Bnope', 'r1')).toBeNull();
    const options = [
      { value: 'default', label: 'Default' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
    ];
    expect(matchModelOption('claude-haiku-4-5', options)).toBe('haiku');
    expect(matchModelOption('opus', options)).toBe('opus');
    expect(matchModelOption('gpt-x', options)).toBeNull();
  });

  it('the merged view\'s notice', () => {
    const here = { id: null, name: 'This machine' };
    expect(machinesNotice({ scope: 'all', included: [here], pending: [], missing: [{ id: 'm2', name: 'Studio', reason: 'offline' }] })).toBe('This machine only — Studio not reachable');
    expect(machinesNotice({ scope: 'all', included: [here], pending: [{ id: 'm2', name: 'Studio' }], missing: [] })).toBe('Adding Studio…');
    expect(machinesNotice({ scope: 'all', included: [here, { id: 'm2', name: 'Studio' }], pending: [], missing: [] })).toBe('All machines: This machine, Studio');
    expect(machinesNotice({ scope: 'all', included: [here], pending: [], missing: [] })).toBeNull();
    expect(machinesNotice({ scope: 'local', included: [here], pending: [], missing: [] })).toBeNull();
  });
});
