import { describe, expect, it } from 'vitest';
import { DEFAULT_UI_THEME, SETTING_DEFAULTS, isUiTheme } from '../../src/core/settings.ts';
import { THEME_STORAGE_KEY, effectiveScheme, readDeviceTheme, readScheme, resolveTheme, serverDefaultOf, themeStore, writeDeviceTheme } from '../../src/web/theme.ts';
import { AGENT_TABS, isClassicOnlyPath, parseV2Route, phoneTabOf, railAreaOf, toClassicPath, toV2Path, v2Path } from '../../src/web/v2/routes.ts';

/** A `localStorage` double. */
function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('D131 · the theme: server default and this browser’s own choice', () => {
  it('v2 is the default of a fresh install; only v2 / classic are themes', () => {
    expect(DEFAULT_UI_THEME).toBe('v2');
    expect(SETTING_DEFAULTS['ui.theme']).toBe('v2');
    expect(isUiTheme('v2')).toBe(true);
    expect(isUiTheme('classic')).toBe(true);
    expect(isUiTheme('dark')).toBe(false);
    expect(isUiTheme(null)).toBe(false);
  });

  it('resolveTheme: the browser’s choice wins, then the server’s default, then v2', () => {
    expect(resolveTheme({ device: 'classic', serverDefault: 'v2' })).toBe('classic');
    expect(resolveTheme({ device: 'v2', serverDefault: 'classic' })).toBe('v2');
    expect(resolveTheme({ device: null, serverDefault: 'classic' })).toBe('classic');
    expect(resolveTheme({ device: null, serverDefault: 'something' })).toBe('v2');
    expect(resolveTheme({ device: null, serverDefault: undefined })).toBe('v2');
  });

  it('the browser’s choice lives in localStorage; junk or a broken storage reads as none', () => {
    const storage = memoryStorage();
    expect(readDeviceTheme(storage)).toBeNull();
    writeDeviceTheme(storage, 'classic');
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('classic');
    expect(readDeviceTheme(storage)).toBe('classic');
    writeDeviceTheme(storage, null);
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readDeviceTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'neon' }))).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    expect(readDeviceTheme(broken)).toBeNull();
    expect(() => writeDeviceTheme(broken, 'v2')).not.toThrow();
    expect(readDeviceTheme(null)).toBeNull();
  });

  it('serverDefaultOf reads ui.theme from a GET /api/settings body', () => {
    expect(serverDefaultOf({ 'ui.theme': 'classic' })).toBe('classic');
    expect(serverDefaultOf({ 'ui.theme': 7 })).toBeNull();
    expect(serverDefaultOf(null)).toBeNull();
  });

  it('themeStore: boot, choose, follow the default again, the default changing elsewhere', () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const off = themeStore.subscribe(() => seen.push(themeStore.get().theme));
    expect(themeStore.init('classic', storage)).toBe('classic');
    expect(themeStore.get()).toEqual({ theme: 'classic', serverDefault: 'classic', device: null });
    themeStore.choose('v2', storage);
    expect(themeStore.get()).toEqual({ theme: 'v2', serverDefault: 'classic', device: 'v2' });
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('v2');
    // The default changing does not override this browser's own choice.
    themeStore.serverDefaultChanged('classic');
    expect(themeStore.get().theme).toBe('v2');
    themeStore.followDefault(storage);
    expect(themeStore.get()).toEqual({ theme: 'classic', serverDefault: 'classic', device: null });
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
    themeStore.serverDefaultChanged('v2');
    expect(themeStore.get().theme).toBe('v2');
    // A stored choice is read at boot.
    expect(themeStore.init('v2', memoryStorage({ [THEME_STORAGE_KEY]: 'classic' }))).toBe('classic');
    off();
    // choose → v2, followDefault → classic, the default → v2 (an unchanged state notifies nobody).
    expect(seen).toEqual(['v2', 'classic', 'v2']);
  });

  it('the v2 light / dark scheme: system by default, or the stored pick', () => {
    expect(readScheme(memoryStorage())).toBe('system');
    expect(readScheme(memoryStorage({ 'switchboard.v2.scheme': 'dark' }))).toBe('dark');
    expect(readScheme(memoryStorage({ 'switchboard.v2.scheme': 'purple' }))).toBe('system');
    expect(effectiveScheme('system', true)).toBe('dark');
    expect(effectiveScheme('system', false)).toBe('light');
    expect(effectiveScheme('light', true)).toBe('light');
  });
});

describe('D131 · v2 routes and the classic ⇄ v2 address map', () => {
  it('parses and builds every v2 route', () => {
    const cases: Array<[string, unknown]> = [
      ['/', { area: 'home' }],
      ['/needs-you', { area: 'needs-you' }],
      ['/agents', { area: 'agents' }],
      ['/agents/s1', { area: 'agent', id: 's1', tab: 'chat' }],
      ['/agents/s1/changes', { area: 'agent', id: 's1', tab: 'changes' }],
      ['/agents/s1/helpers', { area: 'agent', id: 's1', tab: 'helpers' }],
      ['/agents/s1/helpers/h2', { area: 'agent', id: 's1', tab: 'chat', helperId: 'h2' }],
      ['/agents/s1/helpers/h2/events/9', { area: 'agent', id: 's1', tab: 'chat', helperId: 'h2', eventId: 9 }],
      ['/agents/s1/events/12', { area: 'agent', id: 's1', tab: 'chat', eventId: 12 }],
      ['/agents/s1/results/r1', { area: 'agent', id: 's1', tab: 'results', resultId: 'r1' }],
      ['/projects', { area: 'projects' }],
      ['/projects/p1', { area: 'project', id: 'p1' }],
      ['/crews', { area: 'crews' }],
      ['/crews/c1', { area: 'crew', id: 'c1' }],
      ['/results', { area: 'results' }],
      ['/search', { area: 'search' }],
      ['/insights', { area: 'insights' }],
      ['/settings', { area: 'settings', section: null, sub: null }],
      ['/settings/usage', { area: 'settings', section: 'usage', sub: null }],
      ['/settings/advanced/cleanup', { area: 'settings', section: 'advanced', sub: 'cleanup' }],
      ['/notes', { area: 'notes' }],
      ['/routines', { area: 'routines' }],
      ['/tasks', { area: 'tasks' }],
      ['/tools/cm', { area: 'tool', id: 'cm' }],
      ['/share', { area: 'share' }],
      ['/more', { area: 'more' }],
    ];
    for (const [path, route] of cases) {
      expect(parseV2Route(path), path).toEqual(route);
      expect(v2Path(parseV2Route(path)), path).toBe(path);
    }
    expect(parseV2Route('/nowhere/at/all')).toEqual({ area: 'home' });
    expect(parseV2Route('/agents/a%20b')).toEqual({ area: 'agent', id: 'a b', tab: 'chat' });
    expect(v2Path({ area: 'agent', id: 'a b', tab: 'chat' })).toBe('/agents/a%20b');
    expect(AGENT_TABS).toEqual(['chat', 'changes', 'results', 'timeline', 'helpers']);
  });

  it('the rail and the phone tabs light the right item', () => {
    expect(railAreaOf({ area: 'needs-you' })).toBe('home');
    expect(railAreaOf({ area: 'agent', id: 'x', tab: 'chat' })).toBe('agents');
    expect(railAreaOf({ area: 'notes' })).toBe('agents');
    expect(railAreaOf({ area: 'tasks' })).toBe('tasks');
    expect(railAreaOf({ area: 'project', id: 'p' })).toBe('projects');
    expect(railAreaOf({ area: 'search' })).toBeNull();
    expect(railAreaOf({ area: 'insights' })).toBe('settings');
    expect(phoneTabOf({ area: 'needs-you' })).toBe('needs');
    expect(phoneTabOf({ area: 'crews' })).toBe('more');
    expect(phoneTabOf({ area: 'agent', id: 'x', tab: 'changes' })).toBe('agents');
  });

  it('every classic address maps to its v2 page and back (deep links, push notifications, paired computers)', () => {
    const pairs: Array<[string, string]> = [
      ['/', '/'],
      ['/inbox', '/needs-you'],
      ['/sessions/s1', '/agents/s1'],
      ['/sessions/s1/diff', '/agents/s1/changes'],
      ['/sessions/s1/timeline', '/agents/s1/timeline'],
      ['/sessions/s1/artifacts', '/agents/s1/results'],
      ['/sessions/s1/artifacts/a1', '/agents/s1/results/a1'],
      ['/sessions/s1/agents/g1', '/agents/s1/helpers/g1'],
      ['/sessions/s1/agents/g1/events/5', '/agents/s1/helpers/g1/events/5'],
      ['/sessions/s1/events/7', '/agents/s1/events/7'],
      ['/plans', '/projects'],
      ['/plans/p1', '/projects/p1'],
      ['/team', '/crews'],
      ['/team/t1', '/crews/t1'],
      ['/artifacts', '/results'],
      ['/memory?scope=%2Fw', '/notes?scope=%2Fw'],
      ['/todos', '/tasks'],
      ['/schedules', '/routines'],
      ['/history', '/agents?show=closed'],
      ['/search?q=tests', '/search?q=tests'],
      ['/insights?period=7d', '/insights?period=7d'],
      ['/settings/accounts', '/settings/usage'],
      ['/settings/machines', '/settings/computers'],
      ['/settings/devices', '/settings/phones'],
      ['/settings/appearance', '/settings/appearance'],
      ['/settings/cleanup', '/settings/advanced/cleanup'],
      ['/solutions', '/settings/advanced/code-projects'],
      ['/mcp', '/settings/advanced/connections'],
      ['/tools/cm', '/tools/cm'],
    ];
    for (const [classic, v2] of pairs) {
      expect(toV2Path(classic), classic).toBe(v2);
      // A v2 address is left as it is.
      expect(toV2Path(v2), v2).toBe(v2);
    }
    // Back to classic (where both have the page).
    expect(toClassicPath('/agents/s1/changes')).toBe('/sessions/s1/diff');
    expect(toClassicPath('/agents/s1/helpers/g1/events/5')).toBe('/sessions/s1/agents/g1/events/5');
    expect(toClassicPath('/agents/s1/results/a1')).toBe('/sessions/s1/artifacts/a1');
    expect(toClassicPath('/agents/s1/helpers')).toBe('/sessions/s1');
    expect(toClassicPath('/needs-you')).toBe('/inbox');
    expect(toClassicPath('/agents')).toBe('/');
    expect(toClassicPath('/agents?show=closed')).toBe('/history');
    expect(toClassicPath('/projects/p1')).toBe('/plans/p1');
    expect(toClassicPath('/crews/t1')).toBe('/team/t1');
    expect(toClassicPath('/results')).toBe('/artifacts');
    expect(toClassicPath('/notes?scope=%2Fw')).toBe('/memory?scope=%2Fw');
    expect(toClassicPath('/settings/usage')).toBe('/settings/accounts');
    expect(toClassicPath('/settings/rules')).toBe('/settings/sessions');
    expect(toClassicPath('/settings/advanced/cleanup')).toBe('/settings/cleanup');
    expect(toClassicPath('/settings/advanced/code-projects')).toBe('/solutions');
    expect(toClassicPath('/settings/advanced')).toBe('/settings');
    // A classic address is left as it is.
    for (const classic of ['/', '/inbox', '/sessions/s1/diff', '/plans/p1', '/settings/accounts', '/settings/cleanup', '/schedules']) expect(toClassicPath(classic), classic).toBe(classic);
    expect(isClassicOnlyPath('/sessions/s1')).toBe(true);
    expect(isClassicOnlyPath('/agents/s1')).toBe(false);
    expect(isClassicOnlyPath('/search?q=x')).toBe(false);
  });
});
