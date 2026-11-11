import { describe, expect, it } from 'vitest';
import { isPlanPinId, planOfPin, planPinId, planPinKey, planPinOfKey } from '../../src/core/plan-pins.ts';
import { sessionIdOf, sessionKey } from '../../src/core/sidebar-sync.ts';

/** D161 (`docs/sidebar.md` → *Pinned projects (D161)*): a project pin's id and its D71 wire key. */

const SELF = 'aaaaaaaaaaaa';
const PEER = 'bbbbbbbbbbbb';
const PLAN = '0b7c3e0a-1111-4222-8333-444455556666';

describe('D161 project pin ids', () => {
  it('a plan id (own or a paired machine’s) is pinned as plan~<id>; anything else is no project pin', () => {
    expect(planPinId(PLAN)).toBe(`plan~${PLAN}`);
    expect(planOfPin(`plan~${PLAN}`)).toBe(PLAN);
    expect(planOfPin(`plan~r~${PEER}~${PLAN}`)).toBe(`r~${PEER}~${PLAN}`);
    expect(isPlanPinId(`plan~${PLAN}`)).toBe(true);
    for (const other of [PLAN, `crew~team`, 'plan~', 'plan~bad id', `plan~r~nope~${PLAN}`, 42, null]) expect(isPlanPinId(other), String(other)).toBe(false);
  });

  it('travels as plan~<origin machine>:<id> and comes back as each machine’s own id or a remote one', () => {
    expect(planPinKey(`plan~${PLAN}`, SELF)).toBe(`plan~${SELF}:${PLAN}`);
    expect(planPinKey(`plan~r~${PEER}~${PLAN}`, SELF)).toBe(`plan~${PEER}:${PLAN}`);
    // The peer reads this machine's own plan as a remote one, and its own plan as its own.
    expect(planPinOfKey(`plan~${SELF}:${PLAN}`, PEER)).toBe(`plan~r~${SELF}~${PLAN}`);
    expect(planPinOfKey(`plan~${PEER}:${PLAN}`, PEER)).toBe(`plan~${PLAN}`);
    for (const bad of ['plan~', `plan~${SELF}:`, `plan~nope:${PLAN}`, `plan~${SELF}:r~${PEER}~${PLAN}`]) expect(planPinOfKey(bad, SELF), bad).toBeNull();
  });

  it('the D71 session keys carry project pins through (a crew pin and a session as before)', () => {
    expect(sessionKey(`plan~${PLAN}`, SELF)).toBe(`plan~${SELF}:${PLAN}`);
    expect(sessionIdOf(`plan~${SELF}:${PLAN}`, PEER)).toBe(`plan~r~${SELF}~${PLAN}`);
    expect(sessionKey('crew~team1', SELF)).toBe('crew~team1');
    expect(sessionKey('s1', SELF)).toBe(`${SELF}:s1`);
  });
});
