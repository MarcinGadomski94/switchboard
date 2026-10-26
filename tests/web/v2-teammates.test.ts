import { describe, expect, it } from 'vitest';
import type { TeamSummary } from '../../src/core/team.ts';
import { agentRow } from '../../src/web/v2/palette/palette-model.ts';
import { NO_TEAM_MEMBERS, agentDisplayName, displayNameById, sessionOwnName, teamMembersOf, teammateOf } from '../../src/web/v2/shared/teammate-name.ts';

/** Fix after 2.0 · a teammate is named by its teammate's name everywhere in v2 (`agentDisplayName`). */

const roster = (id: string, name: string, sessionRef: string) => ({ id, name, status: 'idle', sessionRef, machineName: 'mac', local: true, current: null, turnStartedAt: null, lastActivityAt: null });
const teams = [
  { id: 'core', name: 'Acme Core', order: 0, members: 2, needsYou: 0, roster: [roster('m1', 'Reviewer/QA', 's-review'), roster('m2', '  ', 's-blank')] },
  { id: 'mobile', name: 'Acme Mobile', order: 1, members: 0, needsYou: 0 },
] as unknown as TeamSummary[];
const members = teamMembersOf(teams);
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `${id}-name`, title: null, displayTitle: undefined, ...over }) as never;

describe('agentDisplayName', () => {
  it('a teammate shows its teammate name, with its crew', () => {
    expect(agentDisplayName(session('s-review', { title: 'fix-login' }), members)).toBe('Reviewer/QA');
    expect(teammateOf('s-review', members)).toEqual({ memberId: 'm1', name: 'Reviewer/QA', crewId: 'core', crewName: 'Acme Core' });
  });
  it('anything else (and a teammate after Return to agents) shows its own name', () => {
    expect(agentDisplayName(session('s-plain', { title: 'fix-login' }), members)).toBe('fix-login');
    expect(agentDisplayName(session('s-plain', { displayTitle: 'Fix the login', title: 'x' }), members)).toBe('Fix the login');
    expect(agentDisplayName(session('s-review', { title: 'fix-login' }), teamMembersOf([]))).toBe('fix-login');
    expect(agentDisplayName(session('s-review'), NO_TEAM_MEMBERS)).toBe('s-review-name');
    expect(teammateOf('s-plain', members)).toBeNull();
    expect(teammateOf(null, members)).toBeNull();
  });
  it('a blank member name falls back to the session’s own name', () => {
    expect(agentDisplayName(session('s-blank', { title: 'own' }), members)).toBe('own');
    expect(sessionOwnName({ displayTitle: undefined, title: null, name: 'n' } as never)).toBe('n');
  });
  it('by id (Needs you’s agent tags), with the item’s name as the fallback', () => {
    expect(displayNameById('s-review', 'fix-login', members)).toBe('Reviewer/QA');
    expect(displayNameById('s-plain', 'fix-login', members)).toBe('fix-login');
    expect(displayNameById(null, 'Usage', members)).toBe('Usage');
  });
  it('⌘K names the teammate and tags its crew', () => {
    const row = agentRow({ ...(session('s-review', { title: 'fix-login' }) as object), kind: 'session', machine: null, createdAt: '2026-10-26T08:00:00.000Z', lastActivityAt: null } as never, members);
    expect(row.label).toBe('Reviewer/QA');
    expect(row.hint).toBe('Teammate · Acme Core');
    expect(row.keywords).toContain('fix-login');
    expect(agentRow({ ...(session('s-plain', { title: 'fix-login' }) as object), kind: 'session', machine: null, createdAt: '2026-10-26T08:00:00.000Z', lastActivityAt: null } as never).label).toBe('fix-login');
  });
});
