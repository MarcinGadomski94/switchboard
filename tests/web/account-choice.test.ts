/**
 * D138 · the account picker's rows (`src/web/api/account-choice.ts`) and the agent's account line
 * (`src/web/v2/shared/AccountChoice.tsx`): only CLIs with more than one enabled account, the
 * overall choice (an old stored "fixed account" rule included), out-of-usage marks.
 */
import { describe, expect, it } from 'vitest';
import { type AccountProfile, DEFAULT_ACCOUNT_SETTINGS, readAccountSettings } from '../../src/core/accounts.ts';
import { accountChoiceRows } from '../../src/web/api/account-choice-rows.ts';
import { accountLine, choiceOptions } from '../../src/web/v2/shared/account-choice-model.ts';

const NOW = Date.parse('2026-10-27T12:00:00Z');

function profile(id: string, cli: AccountProfile['cli'], position: number, extra: Partial<AccountProfile> = {}): AccountProfile {
  return { id, cli, name: id.toUpperCase(), dir: null, builtin: false, enabled: true, position, shareSettings: true, signIn: 'signed-in', account: null, usage: null, exhausted: null, signInCommand: '', sessions: 0, ...extra };
}

describe('D138 · the account picker', () => {
  it('lists the CLIs with more than one enabled account, in order, with the choice', () => {
    const profiles = [profile('b', 'claude', 1, { exhausted: { until: new Date(NOW + 3_600_000).toISOString(), window: 'session', text: null } }), profile('a', 'claude', 0), profile('x', 'codex', 0), profile('off', 'codex', 1, { enabled: false })];
    const rows = accountChoiceRows({ profiles, settings: { ...DEFAULT_ACCOUNT_SETTINGS, choice: { claude: 'b' } } }, NOW);
    expect(rows).toEqual([{ cli: 'claude', label: 'Claude Code', options: [{ id: 'a', name: 'A', out: false }, { id: 'b', name: 'B', out: true }], chosen: 'b' }]);
    expect(choiceOptions(rows[0] as (typeof rows)[number]).map((o) => o.label)).toEqual(['Automatic', 'A', 'B (out of usage)']);
    // An old install's "fixed account" rule reads as the choice; a choice that is not enabled is Automatic.
    expect(accountChoiceRows({ profiles, settings: readAccountSettings({ newSessions: { rule: 'fixed', fixed: { claude: 'a' } } }) }, NOW)[0]?.chosen).toBe('a');
    expect(accountChoiceRows({ profiles, settings: { ...DEFAULT_ACCOUNT_SETTINGS, choice: { claude: 'gone' } } }, NOW)[0]?.chosen).toBeNull();
    expect(accountChoiceRows(null)).toEqual([]);
  });

  it('the agent\'s account line says where it comes from', () => {
    expect(accountLine({ profileName: 'B', accountChoice: { source: 'project', profileId: 'b', project: { id: 'p', title: 'Acme' } } })).toBe('Account: B (from project)');
    expect(accountLine({ profileName: 'B', accountChoice: { source: 'overall', profileId: 'b' } })).toBe('Account: B (overall choice)');
    expect(accountLine({ profileName: 'A', accountChoice: { source: 'pinned', profileId: 'a' } })).toBe('Account: A (pinned)');
    expect(accountLine({ profileName: 'A' })).toBe('Account: A (automatic)');
  });
});
