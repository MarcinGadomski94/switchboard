import { describe, expect, it } from 'vitest';
import { adminChangeProblem, mayManageAccess, profileAllowedOn, readComputerAccess, type AdminFacts } from '../../src/core/user-profiles.ts';

/** D173 (`docs/profiles.md` → *Admins and computer access*): the access rule, the bootstrap and the admin invariants. */

describe('D173 · computer access', () => {
  it('null / absent = every computer; a list allows only its computers; an unknown machine is allowed', () => {
    expect(profileAllowedOn(null, 'a')).toBe(true);
    expect(profileAllowedOn(undefined, 'a')).toBe(true);
    expect(profileAllowedOn(['a'], 'a')).toBe(true);
    expect(profileAllowedOn(['a'], 'b')).toBe(false);
    expect(profileAllowedOn([], 'a')).toBe(false);
    expect(profileAllowedOn(['a'], null)).toBe(true);
  });

  it('reads `all`, null and id lists; refuses anything else', () => {
    expect(readComputerAccess('all')).toBeNull();
    expect(readComputerAccess(null)).toBeNull();
    expect(readComputerAccess(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(readComputerAccess([])).toEqual([]);
    expect(readComputerAccess(['a', 3])).toBeUndefined();
    expect(readComputerAccess(['bad id'])).toBeUndefined();
    expect(readComputerAccess('some')).toBeUndefined();
    expect(readComputerAccess(undefined)).toBeUndefined();
  });
});

describe('D173 · who manages access', () => {
  const ann: AdminFacts = { id: 'ann', admin: false, hasPassword: true };
  const bo: AdminFacts = { id: 'bo', admin: false, hasPassword: false };

  it('bootstrap: with no admin, a profile with a password may make itself admin, nothing else', () => {
    expect(mayManageAccess([ann, bo], 'ann', { target: 'ann', makingAdmin: true })).toBe('bootstrap');
    expect(mayManageAccess([ann, bo], 'ann', { target: 'bo', makingAdmin: true })).toBeNull();
    expect(mayManageAccess([ann, bo], 'ann', { target: 'bo', makingAdmin: false })).toBeNull();
    expect(mayManageAccess([ann, bo], 'bo', { target: 'bo', makingAdmin: true })).toBeNull();
    expect(mayManageAccess([ann, bo], null, { target: 'ann', makingAdmin: true })).toBeNull();
  });

  it('once an admin exists, only admins manage; the bootstrap is closed', () => {
    const admin = { ...ann, admin: true };
    const cy: AdminFacts = { id: 'cy', admin: false, hasPassword: true };
    expect(mayManageAccess([admin, bo, cy], 'ann', { target: 'bo', makingAdmin: false })).toBe('admin');
    expect(mayManageAccess([admin, bo, cy], 'cy', { target: 'cy', makingAdmin: true })).toBeNull();
    expect(mayManageAccess([admin, bo, cy], 'unknown', { target: 'cy', makingAdmin: false })).toBeNull();
  });

  it('an admin needs a password; the last admin stays', () => {
    const admin = { ...ann, admin: true };
    expect(adminChangeProblem([admin, bo], 'bo', true)).toMatch(/password/);
    expect(adminChangeProblem([admin, bo], 'ann', false)).toMatch(/last admin/);
    expect(adminChangeProblem([admin, { ...bo, admin: true, hasPassword: true }], 'ann', false)).toBeNull();
    expect(adminChangeProblem([admin, bo], 'ann', true)).toBeNull();
  });
});
