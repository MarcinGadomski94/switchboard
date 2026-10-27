import { describe, expect, it } from 'vitest';
import { V2_SETTINGS_SECTIONS } from '../../src/web/v2/routes.ts';
import { actionRows, pageRows, rankRows, settingRows } from '../../src/web/v2/palette/palette-model.ts';
import { type SettingEntry, SETTINGS_INDEX, helpExcerpt, markParts, searchSettings, settingById, settingCrumbs, settingPath, settingRank } from '../../src/web/v2/settings/settings-index.ts';
import { ADVANCED_GROUPS, ADVANCED_PAGES, advancedGroups, isV2Section, resolveAdvanced } from '../../src/web/v2/settings/settings-map.ts';

/** Fix after 2.0 · the Settings search index, its ranking, the ⌘K rows from it, and the grouped Advanced list. */

const ids = (query: string): string[] => searchSettings(query).map((hit) => hit.entry.id);

describe('the settings index', () => {
  it('has unique ids, a label, an anchor and keywords in lower case', () => {
    const seen = new Set<string>();
    for (const entry of SETTINGS_INDEX) {
      expect(seen.has(entry.id), entry.id).toBe(false);
      seen.add(entry.id);
      expect(entry.label.trim(), entry.id).not.toBe('');
      expect(entry.anchor.trim(), entry.id).not.toBe('');
      for (const word of entry.keywords) expect(word, entry.id).toBe(word.toLowerCase());
    }
  });

  it('every entry’s page exists (a v2 section, or an Advanced page in Advanced)', () => {
    for (const entry of SETTINGS_INDEX) {
      expect(isV2Section(entry.section), entry.id).toBe(true);
      if (entry.section === 'advanced') expect(resolveAdvanced(entry.sub)?.key, entry.id).toBe(entry.sub);
      else expect(entry.sub, entry.id).toBeNull();
    }
  });

  it('covers every Settings section but Advanced’s list, and every Advanced page', () => {
    for (const section of V2_SETTINGS_SECTIONS.filter((s) => s !== 'advanced')) {
      expect(SETTINGS_INDEX.some((entry) => entry.section === section), section).toBe(true);
    }
    for (const page of ADVANCED_PAGES) expect(SETTINGS_INDEX.some((entry) => entry.sub === page.key), page.key).toBe(true);
  });

  it('builds the breadcrumb and the address of a setting', () => {
    const archive = settingById('sessions.archive') as SettingEntry;
    expect(settingCrumbs(archive)).toBe('Advanced › Agents & separate copies › Delete archived agents after');
    expect(settingPath(archive)).toBe('/settings/advanced/sessions?setting=sessions.archive');
    const warn = settingById('usage.warn-at') as SettingEntry;
    expect(settingCrumbs(warn)).toBe('Usage & accounts › Warn at Max usage');
    expect(settingPath(warn)).toBe('/settings/usage?setting=usage.warn-at');
    expect(settingById('nope')).toBeNull();
    expect(settingById(null)).toBeNull();
  });
});

describe('the settings search', () => {
  it('finds nothing for an empty query or a word that is nowhere', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('zzqx')).toEqual([]);
  });

  it('ranks the exact label, then a label prefix, then label words, then keywords, then help text', () => {
    const entry = (over: Partial<SettingEntry>): SettingEntry => ({ id: 'x', label: 'x', help: '', keywords: [], section: 'usage', sub: null, anchor: '[data-row="x"]', ...over });
    const index = [
      entry({ id: 'help', label: 'Other thing', help: 'Mentions sound in passing' }),
      entry({ id: 'keyword', label: 'Toast', keywords: ['sound'] }),
      entry({ id: 'words', label: 'Play a sound' }),
      entry({ id: 'prefix', label: 'Sound when done' }),
      entry({ id: 'exact', label: 'Sound' }),
    ];
    expect(searchSettings('sound', index).map((hit) => hit.entry.id)).toEqual(['exact', 'prefix', 'words', 'keyword', 'help']);
    expect(searchSettings('sound', index).map((hit) => hit.rank)).toEqual([0, 1, 2, 3, 4]);
    // Every word must match somewhere.
    expect(settingRank(index[2] as SettingEntry, 'play sound')).toBe(2);
    expect(settingRank(index[2] as SettingEntry, 'play loud')).toBeNull();
  });

  it('finds single settings by their synonyms', () => {
    expect(ids('archive')[0]).toBe('sessions.archive');
    expect(ids('loud')).toContain('notify.toast');
    expect(ids('sound')[0]).toBe('notify.toast');
    expect(ids('port')).toContain('machines.peer-listener');
    expect(ids('token')).toContain('notify.prices');
    expect(ids('cost')).toEqual(expect.arrayContaining(['notify.prices', 'usage.insights']));
    expect(ids('dark mode')[0]).toBe('appearance.scheme');
    expect(ids('separate copy')).toContain('sessions.worktrees');
    expect(ids('mcp')).toContain('connections.list');
    // A word matches at the start of a word: "port" is not in "import".
    expect(ids('port')).not.toContain('jira.connection');
  });

  it('matches the label before the help text, case-insensitively', () => {
    expect(ids('Warn at')[0]).toBe('usage.warn-at');
    expect(ids('WARN AT MAX USAGE')[0]).toBe('usage.warn-at');
    expect(searchSettings('warn at max usage')[0]?.rank).toBe(0);
  });

  it('finds a page’s settings by the page’s name', () => {
    expect(ids('github')).toEqual(expect.arrayContaining(['github.login', 'github.pr-detection', 'github.repositories']));
  });

  it('marks the query’s words and cuts long help around the first match', () => {
    expect(markParts('Delete archived agents after', 'archive')).toEqual([
      { text: 'Delete ', match: false },
      { text: 'archive', match: true },
      { text: 'd agents after', match: false },
    ]);
    expect(markParts('Port and PORT', 'port').filter((part) => part.match).map((part) => part.text)).toEqual(['Port', 'PORT']);
    expect(markParts('No match', '')).toEqual([{ text: 'No match', match: false }]);
    // Only at the start of a word, as the search matches.
    expect(markParts('Jira import', 'port').some((part) => part.match)).toBe(false);
    const long = `${'a '.repeat(150)}needle ${'b '.repeat(50)}`;
    const cut = helpExcerpt(long, 'needle', 100);
    expect(cut).toContain('needle');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(104);
    expect(helpExcerpt('Short help.', 'x')).toBe('Short help.');
  });
});

describe('⌘K · settings', () => {
  it('lists every indexed setting as a Settings row that opens it highlighted', () => {
    const rows = settingRows();
    expect(rows).toHaveLength(SETTINGS_INDEX.length);
    const archive = rows.find((row) => row.id === 'setting:sessions.archive');
    expect(archive).toMatchObject({ group: 'settings', label: 'Delete archived agents after', hint: 'Advanced › Agents & separate copies', action: { go: '/settings/advanced/sessions?setting=sessions.archive' } });
  });

  it('finds a setting among the pages', () => {
    const ranked = rankRows([...pageRows(), ...settingRows()], 'delete archived');
    expect(ranked[0]?.id).toBe('setting:sessions.archive');
    expect(rankRows([...pageRows(), ...settingRows()], 'peer listener')[0]?.id).toBe('setting:machines.peer-listener');
    // A page still comes first for its own name.
    expect(rankRows([...pageRows(), ...settingRows()], 'insights')[0]?.id).toBe('page:insights');
    // An action keeps its place for its own words (the palette lists settings after the actions).
    expect(rankRows([...pageRows(), ...actionRows(), ...settingRows()], 'classic')[0]?.id).toBe('action:theme-classic');
  });
});

describe('the grouped Advanced list', () => {
  it('puts every Advanced page in exactly one group', () => {
    const grouped = ADVANCED_GROUPS.flatMap((group) => group.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(ADVANCED_PAGES.map((page) => page.key).sort());
  });

  it('shows the groups and pages in the agreed order (and ADVANCED_PAGES in that order)', () => {
    expect(advancedGroups().map(({ group, pages }) => [group.label, pages.map((page) => page.key)])).toEqual([
      ['Agents', ['clis', 'sessions', 'schedules', 'memory', 'processes', 'tools', 'connections']],
      ['Projects & code', ['workspace', 'code-projects', 'github', 'ci', 'jira']],
      ['Accounts & devices', ['accounts', 'machines', 'devices', 'claude']],
      ['Notifications', ['notify']],
      ['App', ['updates', 'login', 'cleanup', 'tutorial', 'setup']],
    ]);
    expect(ADVANCED_PAGES.map((page) => page.key)).toEqual(ADVANCED_GROUPS.flatMap((group) => group.keys));
  });

  it('orders the Settings sections everyday ones first', () => {
    expect(V2_SETTINGS_SECTIONS).toEqual(['usage', 'rules', 'appearance', 'computers', 'phones', 'advanced']);
  });
});
