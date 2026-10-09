import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isNoPullRequest,
  looksBinary,
  moveToWorktreeMessage,
  parsePatch,
  parsePullRequest,
  readGitPathToken,
  solutionCandidates,
  splitNulList,
  untrackedFileDiff,
  newFileHunkHeader,
  isHunkHeader,
  worktreeBranch,
  worktreePath,
} from '../../src/core/worktrees.ts';

describe('gap #1 naming', () => {
  it('branch session/{name}, folder ../{repo}-wt-{name} next to the repo', () => {
    expect(worktreeBranch('free-talk-640')).toBe('session/free-talk-640');
    const repo = path.join(path.sep, 'ws', 'microfrontends', 'acme-app-front');
    expect(worktreePath(repo, 'free-talk-640')).toBe(path.join(path.sep, 'ws', 'microfrontends', 'acme-app-front-wt-free-talk-640'));
    expect(worktreePath(path.join(path.sep, 'ws', 'mobile'), 'x')).toBe(path.join(path.sep, 'ws', 'mobile-wt-x'));
  });
});

describe('solutionCandidates (router layout)', () => {
  const root = path.join(path.sep, 'ws');
  it('a bare name is <root>/<name> or <root>/<group>/<name>', () => {
    expect(solutionCandidates(root, 'mobile')).toEqual([
      path.join(root, 'mobile'),
      path.join(root, 'microfrontends', 'mobile'),
      path.join(root, 'nugets', 'mobile'),
      path.join(root, 'microservices', 'mobile'),
      path.join(root, 'functions', 'mobile'),
      path.join(root, 'other', 'mobile'),
    ]);
  });
  it('a relative path is taken as is; escapes and absolute paths are refused; read-only folders never match', () => {
    expect(solutionCandidates(root, 'other/switchboard')).toEqual([path.join(root, 'other', 'switchboard')]);
    expect(solutionCandidates(root, '../x')).toBeNull();
    expect(solutionCandidates(root, '/etc')).toBeNull();
    expect(solutionCandidates(root, 'C:\\x')).toBeNull();
    expect(solutionCandidates(root, '')).toBeNull();
    expect(solutionCandidates(root, 'deprecated/microfrontends/old-front')).toEqual([]);
    expect(solutionCandidates(root, 'infrastructure')).toEqual([]);
  });
});

describe('parsePatch (git diff --no-renames)', () => {
  const patch = [
    'diff --git a/src/app.txt b/src/app.txt',
    'index 1111111..2222222 100644',
    '--- a/src/app.txt',
    '+++ b/src/app.txt',
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO\r',
    ' three',
    '@@ -10,2 +10,3 @@ section',
    ' ten',
    '+eleven',
    '\\ No newline at end of file',
    'diff --git a/dir with space/new file.md b/dir with space/new file.md',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/dir with space/new file.md\t',
    '@@ -0,0 +1,2 @@',
    '+# Title',
    '+--- not a header',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 4444444..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'index 5555555..6666666 100644',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
    'diff --git "a/q\\"uote\\tx" "b/q\\"uote\\tx"',
    'index 7777777..8888888 100644',
    '--- "a/q\\"uote\\tx"',
    '+++ "b/q\\"uote\\tx"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'old mode 100644',
    'new mode 100755',
    '',
  ].join('\n');

  it('one entry per file with +/- counts, each hunk header (D90) and its body lines', () => {
    const files = parsePatch(patch);
    expect(files.map((f) => f.path)).toEqual(['src/app.txt', 'dir with space/new file.md', 'gone.txt', 'img.png', 'run.sh', 'q"uote\tx', 'café.txt']);
    expect(files[0]).toEqual({ path: 'src/app.txt', added: 2, removed: 1, lines: ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', '@@ -10,2 +10,3 @@ section', ' ten', '+eleven'], binary: false });
    expect(files[1]).toMatchObject({ added: 2, removed: 0, lines: ['@@ -0,0 +1,2 @@', '+# Title', '+--- not a header'] });
    expect(files[2]).toMatchObject({ added: 0, removed: 1, lines: ['@@ -1 +0,0 @@', '-bye'] });
    expect(files[3]).toMatchObject({ added: 0, removed: 0, lines: [], binary: true });
    expect(files[4]).toMatchObject({ added: 0, removed: 0, lines: [], binary: false });
    expect(files[5]).toMatchObject({ added: 1, removed: 1 });
  });

  it('empty output = no files', () => {
    expect(parsePatch('')).toEqual([]);
  });

  it('reads C-quoted path tokens (octal UTF-8 bytes, escapes)', () => {
    expect(readGitPathToken('"a/caf\\303\\251"')?.value).toBe('a/café');
    expect(readGitPathToken('"a/x\\\\y\\n"')?.value).toBe('a/x\\y\n');
    expect(readGitPathToken('plain name')).toEqual({ value: 'plain name', rest: '' });
    expect(readGitPathToken('"unterminated')).toBeNull();
  });
});

describe('untracked files', () => {
  it('text → every line added; binary → no lines; empty → nothing', () => {
    const text = untrackedFileDiff('n.txt', new TextEncoder().encode('a\r\nb\n'));
    expect(text).toEqual({ path: 'n.txt', added: 2, removed: 0, lines: ['@@ -0,0 +1,2 @@', '+a', '+b'], binary: false });
    expect(untrackedFileDiff('b.bin', new Uint8Array([1, 0, 2]))).toMatchObject({ binary: true, lines: [], added: 0 });
    expect(untrackedFileDiff('e.txt', new Uint8Array())).toMatchObject({ binary: false, lines: [], added: 0 });
    expect(looksBinary(new TextEncoder().encode('plain'))).toBe(false);
    // D90: a one-line file gets git's short header.
    expect(untrackedFileDiff('o.txt', new TextEncoder().encode('only'))).toMatchObject({ added: 1, lines: ['@@ -0,0 +1 @@', '+only'] });
    expect(newFileHunkHeader(3)).toBe('@@ -0,0 +1,3 @@');
    expect(isHunkHeader('@@ -1 +1 @@')).toBe(true);
    expect(isHunkHeader('+@@ not a header')).toBe(false);
  });
  it('ls-files -z entries, nested repos (dir/) dropped', () => {
    expect(splitNulList('a.txt\0dir/b.txt\0nested/\0')).toEqual(['a.txt', 'dir/b.txt']);
  });
});

describe('gh pr view --json', () => {
  it('reads number, state (verbatim), url, headRefOid', () => {
    expect(parsePullRequest('{"number":231,"state":"MERGED","url":"https://github.com/o/r/pull/231","headRefOid":"abc1234def"}\n')).toEqual({
      number: 231,
      state: 'MERGED',
      url: 'https://github.com/o/r/pull/231',
      headRefOid: 'abc1234def',
    });
    expect(parsePullRequest('{"number":1,"state":"OPEN"}')).toEqual({ number: 1, state: 'OPEN', url: null, headRefOid: null });
  });
  it('anything else is unreadable', () => {
    for (const text of ['', 'nope', '[]', '{"state":"OPEN"}', '{"number":"1","state":"OPEN"}', '{"number":1,"state":""}']) {
      expect(parsePullRequest(text), text).toBeNull();
    }
  });
  it('"no pull requests found" = no PR', () => {
    expect(isNoPullRequest('no pull requests found for branch "session/x"\n')).toBe(true);
    expect(isNoPullRequest('error connecting to api.github.com')).toBe(false);
  });
});

describe('gap #2 move message', () => {
  it('names the worktree, the branch and the base, and forbids stash/reset/checkout of the developer tree', () => {
    const text = moveToWorktreeMessage({ repo: 'web-front', repoPath: '/ws/web-front', worktreePath: '/ws/web-front-wt-s', branch: 'session/s', base: 'main' });
    expect(text).toContain('/ws/web-front-wt-s');
    expect(text).toContain('session/s');
    expect(text).toContain('main');
    expect(text).toContain('Do not stash, reset or check out anything in /ws/web-front');
  });
});
