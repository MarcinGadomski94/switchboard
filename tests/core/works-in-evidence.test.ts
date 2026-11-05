/**
 * D152 follow-up 2026-11-05 (`docs/worktrees.md` → *Which repositories* → *Works in*):
 * the paths a session's Read / Grep / Glob / LS calls and shell commands name, read
 * conservatively, and the ranking (an edit weighs more than a command or a read).
 */
import { describe, expect, it } from 'vitest';
import {
  commandPaths,
  commandStatements,
  evidenceKinds,
  evidencePaths,
  joinEvidencePath,
  rankByEvidence,
  readToolPaths,
  resultPaths,
} from '../../src/core/works-in-evidence.ts';

const WS = '/Users/dev/acme ws';

describe('readToolPaths', () => {
  it('takes the path a Read / NotebookRead / Grep / LS names, resolved against the cwd', () => {
    expect(readToolPaths('Read', { file_path: `${WS}/microfrontends/web-front/src/App.razor` }, WS)).toEqual([`${WS}/microfrontends/web-front/src/App.razor`]);
    expect(readToolPaths('Read', { file_path: 'microfrontends/web-front/README.md' }, WS)).toEqual([`${WS}/microfrontends/web-front/README.md`]);
    expect(readToolPaths('NotebookRead', { notebook_path: '/n/a.ipynb' }, null)).toEqual(['/n/a.ipynb']);
    expect(readToolPaths('Grep', { pattern: 'Login', path: './microfrontends/web-front/../web-front/src' }, WS)).toEqual([`${WS}/microfrontends/web-front/src`]);
    expect(readToolPaths('LS', { path: `${WS}/mobile` }, null)).toEqual([`${WS}/mobile`]);
    // A Grep without a path searched the cwd: nothing new.
    expect(readToolPaths('Grep', { pattern: 'x' }, WS)).toEqual([]);
  });

  it('takes a Glob path and the static folder of an absolute pattern', () => {
    expect(readToolPaths('Glob', { pattern: `${WS}/microfrontends/web-front/**/*.cs` }, null)).toEqual([`${WS}/microfrontends/web-front`]);
    expect(readToolPaths('Glob', { pattern: '**/*.cs', path: 'mobile' }, WS)).toEqual([`${WS}/mobile`]);
    expect(readToolPaths('Glob', { pattern: '**/*.cs' }, WS)).toEqual([]);
  });

  it('never guesses: a relative path without a cwd, ~ and variables are left out', () => {
    expect(readToolPaths('Read', { file_path: 'a.txt' }, null)).toEqual([]);
    expect(readToolPaths('Read', { file_path: '~/a.txt' }, WS)).toEqual([]);
    expect(readToolPaths('Read', { file_path: '$HOME/a.txt' }, WS)).toEqual([]);
    expect(readToolPaths('Write', { file_path: '/x/a.txt' }, WS)).toEqual([]);
    expect(readToolPaths('Read', 'nope', WS)).toEqual([]);
  });

  it('keeps Windows paths in their own style', () => {
    expect(readToolPaths('Read', { file_path: 'D:\\code\\acme ws\\mobile\\App.xaml' }, null)).toEqual(['D:\\code\\acme ws\\mobile\\App.xaml']);
    expect(readToolPaths('Read', { file_path: 'mobile/../mobile/App.xaml' }, 'D:\\code\\ws')).toEqual(['D:\\code\\ws\\mobile\\App.xaml']);
    expect(joinEvidencePath('C:/code/ws', '..\\other')).toBe('C:\\code\\other');
    expect(joinEvidencePath(null, '\\\\server\\share\\repo')).toBe('\\\\server\\share\\repo');
  });
});

describe('resultPaths', () => {
  it('reads the absolute paths a Glob / Grep result lists (capped), not other tools', () => {
    const listing = [`${WS}/microfrontends/web-front/a.cs`, `${WS}/microfrontends/web-front/b.cs:12:  var x = 1;`, 'relative/c.cs', 'Found 3 files', 'D:\\ws\\mobile\\App.cs:3:x'].join('\n');
    expect(resultPaths('Grep', listing)).toEqual([`${WS}/microfrontends/web-front/a.cs`, `${WS}/microfrontends/web-front/b.cs`, 'D:\\ws\\mobile\\App.cs']);
    expect(resultPaths('Glob', Array.from({ length: 50 }, (_, i) => `/r/f${i}.ts`).join('\n'))).toHaveLength(20);
    expect(resultPaths('Read', '/r/a.ts')).toEqual([]);
    expect(resultPaths('Grep', undefined)).toEqual([]);
  });
});

describe('commandStatements', () => {
  it('splits like bash: quotes, escapes, separators, redirections dropped', () => {
    expect(commandStatements('cd "path with spaces" && ls -la | head > /tmp/out.txt; echo \'a && b\'')).toEqual([['cd', 'path with spaces'], ['ls', '-la'], ['head'], ['echo', 'a && b']]);
    expect(commandStatements('cd path\\ with\\ spaces && make')).toEqual([['cd', 'path with spaces'], ['make']]);
    // A double-quoted backslash stays unless it escapes $ ` " \ (bash's rule).
    expect(commandStatements('cd "D:\\code\\acme ws\\mobile"')).toEqual([['cd', 'D:\\code\\acme ws\\mobile']]);
    // An unquoted Windows path keeps its backslashes (PowerShell style).
    expect(commandStatements('cd D:\\code\\mobile; dotnet build')).toEqual([['cd', 'D:\\code\\mobile'], ['dotnet', 'build']]);
  });
});

describe('commandPaths', () => {
  it('follows cd / pushd within one command and resolves relative paths against it', () => {
    expect(commandPaths('cd microfrontends/web-front && dotnet build', WS)).toEqual([`${WS}/microfrontends/web-front`]);
    expect(commandPaths(`cd "${WS}/microfrontends/web-front" && git status && cd ../other && ls`, '/elsewhere')).toEqual([`${WS}/microfrontends/web-front`, `${WS}/microfrontends/other`]);
    expect(commandPaths('pushd mobile && npm test', WS)).toEqual([`${WS}/mobile`]);
    expect(commandPaths('Set-Location -Path D:\\code\\ws\\mobile; dotnet test', null)).toEqual(['D:\\code\\ws\\mobile']);
  });

  it('reads git -C and absolute path words (also --flag=/path)', () => {
    expect(commandPaths(`git -C "${WS}/mobile" log --oneline -5`, WS)).toEqual([`${WS}/mobile`]);
    expect(commandPaths('git -C mobile status', WS)).toEqual([`${WS}/mobile`]);
    expect(commandPaths(`dotnet test "--project=${WS}/mobile/Tests.csproj"`, WS)).toEqual([`${WS}/mobile/Tests.csproj`]);
    expect(commandPaths('rg Login /Users/dev/acme/web-front/src 2>/dev/null', WS)).toEqual(['/Users/dev/acme/web-front/src']);
  });

  it('never guesses: ~, variables, a bare cd and what follows them', () => {
    expect(commandPaths('cd ~/code/web && ls src', WS)).toEqual([]);
    expect(commandPaths('cd $REPO && git status', WS)).toEqual([]);
    expect(commandPaths('cd && git -C web status', WS)).toEqual([]);
    expect(commandPaths('npm test', WS)).toEqual([]);
    expect(commandPaths('cd web', null)).toEqual([]);
  });
});

describe('evidencePaths', () => {
  it('marks read tools `read` and shell commands `commands`; a Codex command its own cwd', () => {
    expect(evidencePaths({ type: 'tool', name: 'Read', input: { file_path: `${WS}/mobile/a.cs` } }, WS)).toEqual([{ path: `${WS}/mobile/a.cs`, kind: 'read' }]);
    expect(evidencePaths({ type: 'tool', name: 'Bash', input: { command: 'cd mobile && dotnet build' } }, WS)).toEqual([{ path: `${WS}/mobile`, kind: 'commands' }]);
    expect(evidencePaths({ type: 'tool', name: 'Bash', input: { command: 'dotnet build', cwd: `${WS}/mobile` } }, WS)).toEqual([{ path: `${WS}/mobile`, kind: 'commands' }]);
    // A failed Grep's result is not read; its input still is.
    expect(evidencePaths({ type: 'tool', name: 'Grep', input: { path: `${WS}/mobile` }, result: '/other/x.cs', isError: true }, WS)).toEqual([{ path: `${WS}/mobile`, kind: 'read' }]);
    expect(evidencePaths({ type: 'tool', name: 'Write', input: { file_path: '/x' } }, WS)).toEqual([]);
    expect(evidencePaths({ type: 'assistant', text: 'cd /x' }, WS)).toEqual([]);
  });
});

describe('ranking', () => {
  it('puts worktrees first, then edits over commands over reads, ties in found order', () => {
    const repo = (name: string, edited: number, read: number, commands: number, extra: { isWorktree?: boolean; declared?: boolean } = {}) => ({ name, isWorktree: extra.isWorktree ?? false, declared: extra.declared ?? false, counts: { edited, read, commands } });
    const ranked = rankByEvidence([repo('read-a-lot', 0, 9, 0), repo('ran', 0, 0, 5), repo('edited', 1, 0, 0), repo('copy', 0, 0, 0, { isWorktree: true }), repo('read-too', 0, 9, 0), repo('picked', 0, 0, 0, { declared: true })]);
    expect(ranked.map((entry) => entry.name)).toEqual(['copy', 'ran', 'edited', 'picked', 'read-a-lot', 'read-too']);
    expect(evidenceKinds({ edited: 1, read: 2, commands: 3 })).toEqual(['edited', 'commands', 'read']);
    expect(evidenceKinds({ edited: 0, read: 2, commands: 0 })).toEqual(['read']);
  });
});
