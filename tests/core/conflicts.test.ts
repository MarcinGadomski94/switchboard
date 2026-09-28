import { describe, expect, it } from 'vitest';
import { CONFLICT_FLAG, NO_CONFLICT, type RepoWriter, conflictText, joinNames, moveLabel, repoConflict } from '../../src/core/conflicts.ts';

function writer(name: string, isolated: boolean, overrides: Partial<RepoWriter> = {}): RepoWriter {
  return { sessionId: `id-${name}`, name, createdAt: '2026-09-28T10:00:00.000Z', isolated, repo: 'mobile', attached: true, ...overrides };
}

describe('repoConflict (M6.3)', () => {
  it('no writers, one writer, or only isolated writers → no conflict', () => {
    expect(repoConflict([])).toEqual(NO_CONFLICT);
    expect(repoConflict([writer('a', false)])).toEqual(NO_CONFLICT);
    expect(repoConflict([writer('a', true)])).toEqual(NO_CONFLICT);
    expect(repoConflict([writer('a', true), writer('b', true), writer('c', true)])).toEqual(NO_CONFLICT);
    expect(NO_CONFLICT).toEqual({ conflict: false, flag: '', sessions: [] });
  });

  it('two sessions in the main checkout → conflict, both named, both movable', () => {
    const result = repoConflict([writer('b', false, { createdAt: '2026-09-28T10:05:00.000Z' }), writer('a', false)]);
    expect(result.conflict).toBe(true);
    expect(result.flag).toBe(CONFLICT_FLAG);
    expect(CONFLICT_FLAG).toBe('⚠ shared working tree');
    expect(result.sessions).toEqual([
      { sessionId: 'id-a', name: 'a', isolated: false, repo: 'mobile', attached: true },
      { sessionId: 'id-b', name: 'b', isolated: false, repo: 'mobile', attached: true },
    ]);
  });

  it('a worktree session and one in place → conflict (each must have its own worktree), the prototype case', () => {
    const result = repoConflict([
      writer('free-talk-feature', true, { createdAt: '2026-09-28T09:00:00.000Z' }),
      writer('button-rollout', false, { createdAt: '2026-09-28T09:30:00.000Z', attached: false }),
    ]);
    expect(result.conflict).toBe(true);
    expect(result.sessions.map((s) => [s.name, s.isolated, s.attached])).toEqual([
      ['free-talk-feature', true, true],
      ['button-rollout', false, false],
    ]);
  });

  it('orders oldest first, then by name; a session listed twice counts once (isolated if any entry is)', () => {
    const same = '2026-09-28T10:00:00.000Z';
    const result = repoConflict([writer('zeta', false, { createdAt: same }), writer('alpha', false, { createdAt: same }), writer('alpha', true, { createdAt: same })]);
    expect(result.sessions.map((s) => [s.name, s.isolated])).toEqual([
      ['alpha', true],
      ['zeta', false],
    ]);
    // One session twice is not two writers.
    expect(repoConflict([writer('a', false), writer('a', false)])).toEqual(NO_CONFLICT);
  });
});

describe('conflict copy (prototype sd.warn)', () => {
  it('two sessions: "… both write to <folder>/ in one working tree …", verbatim', () => {
    expect(conflictText([{ name: 'free-talk-feature' }, { name: 'button-rollout' }], 'mobile')).toBe(
      "free-talk-feature and button-rollout both write to mobile/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
    );
  });

  it('three or more: "… all write to …"; nested folders keep their path; a trailing slash is not doubled', () => {
    expect(conflictText([{ name: 'a' }, { name: 'b' }, { name: 'c' }], 'microfrontends/web-front/')).toBe(
      "a, b and c all write to microfrontends/web-front/ in one working tree. Your AGENTS.md requires isolation: 'worktree' for parallel writers in the same repo.",
    );
  });

  it('names and the action label', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['a'])).toBe('a');
    expect(joinNames(['a', 'b'])).toBe('a and b');
    expect(joinNames(['a', 'b', 'c', 'd'])).toBe('a, b, c and d');
    expect(moveLabel('button-rollout')).toBe('Move button-rollout to worktree');
  });
});
