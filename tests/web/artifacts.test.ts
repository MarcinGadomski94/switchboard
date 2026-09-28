import { describe, expect, it } from 'vitest';
import type { Artifact, FileDiff } from '../../src/core/api.ts';
import { NO_ARTIFACTS, artifactRows, diffFilesOf, fileCount, locationTitle, storedCount } from '../../src/web/views/session/artifacts.ts';

function artifact(patch: Partial<Artifact> & Pick<Artifact, 'id' | 'type' | 'name'>): Artifact {
  return { solution: null, branch: null, sessionId: 's1', meta: null, createdAt: '2026-09-28T10:00:00.000Z', ...patch };
}

function file(patch: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
  return { solution: 'web-front', branch: 'session/s1', added: 1, removed: 0, lines: ['+x'], uncommitted: true, ...patch };
}

describe('Artifacts tab model (M4.6)', () => {
  it('shows the INFO row without artifacts (the Solutions detail form)', () => {
    expect(artifactRows([], [])).toEqual([NO_ARTIFACTS]);
    expect(NO_ARTIFACTS).toMatchObject({ tag: 'INFO', name: 'No artifacts', meta: '' });
  });

  it('renders the prototype’s free-talk-feature rows from the demo artifacts (stored meta kept)', () => {
    const rows = artifactRows(
      [
        artifact({ id: 'a', type: 'CONTRACT', name: 'contracts/free-talk.md', solution: 'root', meta: 'locked' }),
        artifact({ id: 'b', type: 'DIFF', name: 'Pages/FreeTalk · 6 files', solution: 'acme-app-front', branch: 'feature/free-talk-360', meta: '+284 −12' }),
        artifact({ id: 'c', type: 'DIFF', name: 'Views/FreeTalkView · 5 files', solution: 'mobile', branch: 'feature/free-talk-360', meta: '+231 −4' }),
        artifact({ id: 'd', type: 'FOLLOWUP', name: 'mobile-followups/from-acme-app-front.md', solution: 'mobile', meta: '1 new' }),
      ],
      // The demo diff provider has fewer files than the mock counts: a stored meta wins over git.
      [file({ solution: 'acme-app-front', branch: 'feature/free-talk-360', path: 'Pages/FreeTalk/FreeTalk.razor', added: 118 })],
    );
    expect(rows.map((r) => [r.tag, r.name, r.meta])).toEqual([
      ['CONTRACT', 'contracts/free-talk.md', 'locked'],
      ['DIFF', 'acme-app-front · 6 files', '+284 −12'],
      ['DIFF', 'mobile · 5 files', '+231 −4'],
      ['FOLLOWUP', 'mobile-followups/from-acme-app-front.md', '1 new'],
    ]);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows[1]?.title).toBe('acme-app-front ⎇ feature/free-talk-360');
  });

  it('counts a DIFF without stored meta from the session’s git diff (solution + branch)', () => {
    const arts = [
      artifact({ id: 'diff:web', type: 'DIFF', name: 'src · 2 files', solution: 'web-front', branch: 'session/s1' }),
      artifact({ id: 'diff:mobile', type: 'DIFF', name: 'docs/in-place.md', solution: 'mobile' }),
    ];
    const files = [
      file({ path: 'README.md', added: 1, removed: 1 }),
      file({ path: 'src/a.txt', added: 3 }),
      file({ path: 'src/b.txt', added: 0, removed: 2 }),
      file({ path: 'src/other-branch.txt', branch: 'feature/x', added: 9 }),
      file({ solution: 'mobile', branch: 'main', path: 'docs/in-place.md', added: 1 }),
    ];
    const rows = artifactRows(arts, files);
    // Git has 3 files on session/s1 (a Bash-made README change included), not the 2 the recorder saw written.
    expect(rows.map((r) => [r.name, r.meta])).toEqual([
      ['web-front · 3 files', '+4 −3'],
      ['mobile · 1 file', '+1'],
    ]);
    expect(rows[1]?.title).toBe('mobile');
  });

  it('keeps the stored count and an empty meta when git has nothing for the DIFF', () => {
    const rows = artifactRows([artifact({ id: 'd', type: 'DIFF', name: 'Pages/FreeTalk · 6 files', solution: 'web-front', branch: 'session/s1' })], []);
    expect(rows.map((r) => [r.name, r.meta])).toEqual([['web-front · 6 files', '']]);
    const single = artifactRows([artifact({ id: 'e', type: 'DIFF', name: 'Services/ReminderScheduler.cs', solution: 'calendar-func', meta: '+14 −6' })], []);
    expect(single.map((r) => [r.name, r.meta])).toEqual([['calendar-func · Services/ReminderScheduler.cs', '+14 −6']]);
  });

  it('shows binary-only git changes as —', () => {
    const rows = artifactRows([artifact({ id: 'd', type: 'DIFF', name: '1 file', solution: 'web-front', branch: 'session/s1' })], [file({ path: 'logo.png', added: 0, removed: 0, lines: [] })]);
    expect(rows[0]).toMatchObject({ name: 'web-front · 1 file', meta: '—' });
  });

  it('a DIFF without a branch takes the solution’s files on branches no other DIFF of it names', () => {
    const worktree = artifact({ id: 'w', type: 'DIFF', name: '1 file', solution: 'web-front', branch: 'session/s1' });
    const inPlace = artifact({ id: 'p', type: 'DIFF', name: '1 file', solution: 'web-front' });
    const files = [file({ path: 'a.txt' }), file({ path: 'b.txt', branch: 'main', added: 5 }), file({ path: 'c.txt', branch: null, added: 2 })];
    expect(diffFilesOf(worktree, [worktree, inPlace], files).map((f) => f.path)).toEqual(['a.txt']);
    expect(diffFilesOf(inPlace, [worktree, inPlace], files).map((f) => f.path)).toEqual(['b.txt', 'c.txt']);
    expect(diffFilesOf(artifact({ id: 'x', type: 'DIFF', name: '1 file' }), [], files)).toEqual([]);
  });

  it('shows every other type’s stored name and meta verbatim, empty meta when none is known', () => {
    const rows = artifactRows(
      [
        artifact({ id: 'pr', type: 'PR', name: 'web-front #231', solution: 'web-front', meta: 'merged' }),
        artifact({ id: 'br', type: 'BRANCH', name: 'feature/x', solution: 'web-front', branch: 'feature/x' }),
        artifact({ id: 'qa', type: 'QA', name: 'coverage-matrix.md' }),
        artifact({ id: 'doc', type: 'DOC', name: 'docs/notes.md', solution: 'web-front', branch: 'session/s1', meta: '' }),
        artifact({ id: 'tk', type: 'TICKET', name: 'Reply draft', meta: 'draft' }),
      ],
      [],
    );
    expect(rows.map((r) => [r.tag, r.name, r.meta, r.title])).toEqual([
      ['PR', 'web-front #231', 'merged', 'web-front'],
      ['BRANCH', 'feature/x', '', 'web-front ⎇ feature/x'],
      ['QA', 'coverage-matrix.md', '', 'workspace root'],
      ['DOC', 'docs/notes.md', '', 'web-front ⎇ session/s1'],
      ['TICKET', 'Reply draft', 'draft', 'workspace root'],
    ]);
  });

  it('helpers', () => {
    expect(fileCount(1)).toBe('1 file');
    expect(fileCount(6)).toBe('6 files');
    expect(storedCount('Pages/FreeTalk · 6 files')).toBe('6 files');
    expect(storedCount('1 file')).toBe('1 file');
    expect(storedCount('Services/ReminderScheduler.cs')).toBeNull();
    expect(storedCount('notes · 12 filesystem')).toBeNull();
    expect(locationTitle({ solution: null, branch: null })).toBe('workspace root');
  });
});
