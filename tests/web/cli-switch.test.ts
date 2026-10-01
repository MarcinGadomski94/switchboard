import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/core/api.ts';
import { bulkRowState, cliBadgeOf, footerLabel, switchableSessions } from '../../src/web/shell/cli-switch.ts';

function session(patch: Partial<Session>): Session {
  return { id: 'a', live: true, attached: true, hooked: false, closedAt: null, provider: 'claude', providerSwitch: null, ...patch } as unknown as Session;
}

describe('D62 P6 · the sidebar\'s CLI switcher (web)', () => {
  it('the footer label is the default CLI in lower case', () => {
    expect(footerLabel('claude')).toBe('claude code');
    expect(footerLabel('codex')).toBe('codex cli');
    expect(footerLabel('opencode')).toBe('opencode');
  });

  it('rows get a badge only once the list mixes CLIs', () => {
    expect(cliBadgeOf([session({}), session({ id: 'b' })])(session({}))).toBeNull();
    const badge = cliBadgeOf([session({}), session({ id: 'b', provider: 'codex' })]);
    expect(badge(session({}))).toBe('claude');
    expect(badge(session({ provider: 'codex' }))).toBe('codex');
    expect(badge(session({ provider: 'opencode' }))).toBe('opencode');
  });

  it('the bulk switch offers live, attached, open, not hooked sessions; each row\'s state', () => {
    const list = [session({ id: 'a' }), session({ id: 'b', live: false }), session({ id: 'c', hooked: true }), session({ id: 'd', attached: false }), session({ id: 'e', closedAt: 'x' })];
    expect(switchableSessions(list).map((entry) => entry.id)).toEqual(['a']);
    expect(bulkRowState(session({}), 'codex', null)).toEqual({ kind: 'ready' });
    expect(bulkRowState(session({ provider: 'codex' }), 'codex', null)).toEqual({ kind: 'already', text: 'already on Codex CLI' });
    expect(bulkRowState(session({ providerSwitch: { id: 's', from: 'claude', to: 'codex', step: 'handover', handoverBy: null } }), 'codex', { started: true, refused: null })).toEqual({ kind: 'switching', text: 'switching to Codex CLI…' });
    expect(bulkRowState(session({ provider: 'codex' }), 'codex', { started: true, refused: null })).toEqual({ kind: 'done', text: '✓ on Codex CLI' });
    expect(bulkRowState(session({}), 'codex', { started: true, refused: null })).toEqual({ kind: 'failed', text: 'the switch failed (its chat says why)' });
    expect(bulkRowState(session({}), 'codex', { started: false, refused: 'Codex CLI is signed out' })).toEqual({ kind: 'failed', text: 'Codex CLI is signed out' });
  });
});
