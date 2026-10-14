import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTING_DEFAULTS, readKnownSettings } from '../../src/core/settings.ts';
import {
  BADGE_MAX,
  NAV_DRAWER_COLUMNS,
  NAV_GRID_COLUMNS,
  artifactsBadge,
  badgeCount,
  inboxBadge,
  navRows,
  navTitle,
  plansBadge,
  schedulesBadge,
  solutionsBadge,
  teamBadge,
  todosBadge,
  toolsCollapsedFromSettings,
  toolsCollapsedPatch,
  toolsHeadCount,
  toolsNeedAttention,
} from '../../src/web/shell/nav-grid.ts';
import { NAV_ICON_GLYPHS, NAV_ICON_NAMES } from '../../src/web/shell/nav-icon-glyphs.ts';

const saveSettings = vi.fn(async (body: unknown) => body);
vi.mock('../../src/web/api/client.ts', () => ({ api: { saveSettings: (body: unknown) => saveSettings(body) } }));

/** D101: the sidebar's navigation as an icon grid and the collapsible TOOLS section (pure parts). */
describe('nav grid (D101)', () => {
  it('5 columns on the desktop (two rows for the seven views, still two with Team and Plans), 4 in the drawer', () => {
    expect(NAV_GRID_COLUMNS).toBe(5);
    expect(NAV_DRAWER_COLUMNS).toBe(4);
    expect(navRows(7, NAV_GRID_COLUMNS)).toBe(2);
    expect(navRows(9, NAV_GRID_COLUMNS)).toBe(2);
    expect(navRows(11, NAV_GRID_COLUMNS)).toBe(3);
    expect(navRows(7, NAV_DRAWER_COLUMNS)).toBe(2);
    expect(navRows(0, NAV_GRID_COLUMNS)).toBe(0);
  });

  it('badges keep the counts and indicators of the text items: nothing at zero', () => {
    expect(inboxBadge(0)).toBeNull();
    expect(inboxBadge(5)).toEqual({ text: '5', kind: 'need', title: '5 items waiting' });
    expect(inboxBadge(1)?.title).toBe('1 item waiting');
    // Solutions: a small amber "!", the full text in the tooltip.
    expect(solutionsBadge(0)).toBeNull();
    expect(solutionsBadge(1)).toEqual({ text: '!', kind: 'warn', title: '1 conflict' });
    expect(solutionsBadge(3)?.title).toBe('3 conflicts');
    expect(schedulesBadge(2)).toEqual({ text: '2', kind: 'fail', title: '2 failed' });
    expect(schedulesBadge(0)).toBeNull();
    expect(artifactsBadge(13)).toEqual({ text: '13', kind: 'count', title: '13 artifacts' });
    expect(todosBadge(1)).toEqual({ text: '1', kind: 'count', title: '1 open todo' });
    expect(todosBadge(0)).toBeNull();
    expect(teamBadge(1)).toEqual({ text: '1', kind: 'need', title: '1 needs you' });
    expect(teamBadge(2)?.title).toBe('2 need you');
    expect(plansBadge(3)).toEqual({ text: '3', kind: 'run', title: '3 running' });
    expect(plansBadge(0)).toBeNull();
  });

  it('a large count reads "99+" on the icon; the tooltip has the number', () => {
    expect(badgeCount(BADGE_MAX)).toBe('99');
    expect(badgeCount(BADGE_MAX + 1)).toBe('99+');
    expect(inboxBadge(250)).toEqual({ text: '99+', kind: 'need', title: '250 items waiting' });
  });

  it('a cell tooltip is its full name, then the badge text', () => {
    expect(navTitle('MCP', null)).toBe('MCP');
    expect(navTitle('Solutions', solutionsBadge(1))).toBe('Solutions · 1 conflict');
    expect(navTitle('Schedules & loops', schedulesBadge(1))).toBe('Schedules & loops · 1 failed');
  });

  it('one icon per view (Search included), each drawn with strokes inside the 18 × 18 box', () => {
    // D107: Project memory's book; D108: Insights' bar chart.
    expect(NAV_ICON_NAMES).toEqual(['inbox', 'solutions', 'schedules', 'mcp', 'artifacts', 'history', 'todos', 'team', 'plans', 'memory', 'insights', 'search']);
    for (const name of NAV_ICON_NAMES) {
      const paths = NAV_ICON_GLYPHS[name];
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d, name).toMatch(/^M[\d.\s,a-zA-Z-]+$/);
        // Every coordinate stays in the view box (absolute commands only checked: their numbers are points).
        const numbers = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
        for (const n of numbers) expect(Math.abs(n), `${name}: ${d}`).toBeLessThanOrEqual(18);
      }
    }
    // The SVG itself (18 px, currentColor, stroke 1.6, aria-hidden) is checked in the browser: tests/e2e/sidebar-icons.spec.ts.
  });
});

describe('TOOLS collapse (D101)', () => {
  it('stored as the editable setting ui.toolsCollapsed, expanded by default; missing or mistyped reads as expanded', () => {
    expect(SETTING_DEFAULTS['ui.toolsCollapsed']).toBe(false);
    expect(readKnownSettings({})['ui.toolsCollapsed']).toBe(false);
    expect(toolsCollapsedFromSettings(null)).toBe(false);
    expect(toolsCollapsedFromSettings({ 'ui.toolsCollapsed': 'yes' })).toBe(false);
    expect(toolsCollapsedFromSettings({ 'ui.toolsCollapsed': true })).toBe(true);
    expect(toolsCollapsedPatch(true)).toEqual({ 'ui.toolsCollapsed': true });
  });

  it('the header shows the count only while collapsed, and a dot only for a stopped tool', () => {
    expect(toolsHeadCount(false, 2)).toBe('');
    expect(toolsHeadCount(true, 2)).toBe('(2)');
    expect(toolsHeadCount(true, 0)).toBe('');
    expect(toolsNeedAttention(['up', 'idle', 'unset', 'checking'])).toBe(false);
    expect(toolsNeedAttention(['up', 'down'])).toBe(true);
    expect(toolsNeedAttention([])).toBe(false);
  });

  describe('the page store', () => {
    beforeEach(() => {
      vi.resetModules();
      saveSettings.mockClear();
    });

    it('takes the first read, saves every change at once; a change here wins over a late read', async () => {
      const store = await import('../../src/web/shell/useToolsCollapsed.ts');
      store.seedToolsCollapsed({ 'ui.toolsCollapsed': true });
      store.setToolsCollapsed(false);
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ 'ui.toolsCollapsed': false }));
      // A late first read does not undo the change made on the page.
      store.seedToolsCollapsed({ 'ui.toolsCollapsed': true });
      store.setToolsCollapsed(true);
      await vi.waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ 'ui.toolsCollapsed': true }));
      expect(saveSettings).toHaveBeenCalledTimes(2);
      // Setting the same state again saves nothing.
      store.setToolsCollapsed(true);
      await Promise.resolve();
      expect(saveSettings).toHaveBeenCalledTimes(2);
    });

    it('D106: SESSIONS and CHATS fold the same way, each under its own setting (expanded by default)', async () => {
      const store = await import('../../src/web/shell/useToolsCollapsed.ts');
      expect(SETTING_DEFAULTS['ui.sessionsCollapsed']).toBe(false);
      expect(SETTING_DEFAULTS['ui.chatsCollapsed']).toBe(false);
      expect(readKnownSettings({ 'ui.chatsCollapsed': 'yes' })['ui.chatsCollapsed']).toBe(false);
      store.seedToolsCollapsed({ 'ui.sessionsCollapsed': true, 'ui.chatsCollapsed': false });
      store.setSectionCollapsed('ui.chatsCollapsed', true);
      await vi.waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ 'ui.chatsCollapsed': true }));
      store.setSectionCollapsed('ui.sessionsCollapsed', false);
      await vi.waitFor(() => expect(saveSettings).toHaveBeenLastCalledWith({ 'ui.sessionsCollapsed': false }));
      // A late read does not undo either change made on the page.
      store.seedToolsCollapsed({ 'ui.sessionsCollapsed': true, 'ui.chatsCollapsed': false, 'ui.toolsCollapsed': true });
      store.setSectionCollapsed('ui.sessionsCollapsed', false);
      store.setSectionCollapsed('ui.chatsCollapsed', true);
      await Promise.resolve();
      expect(saveSettings).toHaveBeenCalledTimes(2);
    });
  });
});
