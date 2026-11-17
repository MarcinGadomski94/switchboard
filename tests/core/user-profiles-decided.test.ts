import { describe, expect, it } from 'vitest';
import { blockedComputers, mergedAccess, profileAllowedOn } from '../../src/core/user-profiles.ts';

/** D176 (`docs/profiles.md` → *Admins and computer access*): a checklist decides only for the computers it was set for. */
describe('D176 · profileAllowedOn with decidedFor', () => {
  it('every computer: allowed everywhere, whatever was decided', () => {
    expect(profileAllowedOn(null, 'c', ['a'])).toBe(true);
    expect(profileAllowedOn(undefined, 'c')).toBe(true);
  });

  it('a computer the list was not decided for stays allowed; a decided one follows the list', () => {
    expect(profileAllowedOn(['a'], 'a', ['a', 'b'])).toBe(true);
    expect(profileAllowedOn(['a'], 'b', ['a', 'b'])).toBe(false);
    // The colleague's laptop the admin never saw.
    expect(profileAllowedOn(['a'], 'c', ['a', 'b'])).toBe(true);
  });

  it('D173 lists (no decidedFor) still decide for every computer', () => {
    expect(profileAllowedOn(['a'], 'c', null)).toBe(false);
    expect(profileAllowedOn(['a'], 'c')).toBe(false);
  });

  it('an unknown machine id is allowed', () => {
    expect(profileAllowedOn(['a'], null, ['a', 'b'])).toBe(true);
  });
});

describe('D176 · mergedAccess (D172 merge)', () => {
  const allowed = (access: { computers: readonly string[] | null; decidedFor: readonly string[] | null }, id: string): boolean => profileAllowedOn(access.computers, id, access.decidedFor);

  it('either on every computer: every computer', () => {
    expect(mergedAccess({ computers: null, decidedFor: null }, { computers: ['a'], decidedFor: ['a', 'b'] })).toEqual({ computers: null, decidedFor: null });
  });

  it('allowed where either allowed (checked on every computer)', () => {
    const a = { computers: ['a'], decidedFor: ['a', 'b', 'c'] };
    const b = { computers: ['b'], decidedFor: ['a', 'b'] };
    const merged = mergedAccess(a, b);
    for (const id of ['a', 'b', 'c', 'd']) expect(allowed(merged, id), id).toBe(allowed(a, id) || allowed(b, id));
  });

  it('a D173 list on one side: the other side’s decidedFor', () => {
    const a = { computers: ['a'], decidedFor: null };
    const b = { computers: ['b'], decidedFor: ['a', 'b'] };
    const merged = mergedAccess(a, b);
    expect(merged.decidedFor).toEqual(['a', 'b']);
    for (const id of ['a', 'b', 'c']) expect(allowed(merged, id), id).toBe(allowed(a, id) || allowed(b, id));
    expect(mergedAccess(a, { computers: ['b'], decidedFor: null })).toEqual({ computers: ['a', 'b'], decidedFor: null });
  });
});

describe('D176 · blockedComputers', () => {
  it('the decided computers not in the list; null for D173 lists and every computer', () => {
    expect(blockedComputers(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(blockedComputers(['a'], null)).toBeNull();
    expect(blockedComputers(null, ['a'])).toBeNull();
  });
});
