/**
 * D152 follow-up 2026-11-05 (`docs/peers.md` → *A complete move (D152)* → *Repos
 * outside the workspace*): the pure rules for repos outside a workspace session's
 * root (which are outside, their default, what a move leaves out, where a clone goes)
 * and for the folders that are never a repo or a solution (`.claude`, a hidden
 * folder, a path leaving the root).
 */
import { describe, expect, it } from 'vitest';
import { solutionOfPath } from '../../src/core/history.ts';
import { carriedByDefault, effectiveExclusions, isAgentFolderTop, isHiddenSolutionName, isOutsideRoot, outsideCarried, outsideCloneSuggestion } from '../../src/core/outside-repos.ts';
import { withSolutions, writtenSolution } from '../../src/core/session-solutions.ts';
import { commandWorkPaths, evidencePaths } from '../../src/core/works-in-evidence.ts';
import { placementOf, placementToRemember } from '../../src/core/takeover.ts';

const WS = '/Users/dev/acme ws';

describe('folders that are never a repo or a solution', () => {
  it('a CLI folder or Claude Code worktrees folder is never a repo; a worktree inside it is not one of these', () => {
    expect(isAgentFolderTop('/Users/dev/.claude')).toBe(true);
    expect(isAgentFolderTop(`${WS}/.claude`)).toBe(true);
    expect(isAgentFolderTop(`${WS}/.claude/worktrees`)).toBe(true);
    expect(isAgentFolderTop('C:\\Users\\dev\\.codex')).toBe(true);
    expect(isAgentFolderTop(`${WS}/.claude/worktrees/fix-login`)).toBe(false);
    expect(isAgentFolderTop('/Users/dev/code/tool-repo')).toBe(false);
    expect(isAgentFolderTop('/Users/dev/code/worktrees')).toBe(false);
  });

  it('a hidden folder or a path leaving the root is never a solution, also derived from a cwd or a written file', () => {
    expect(isHiddenSolutionName('.claude')).toBe(true);
    expect(isHiddenSolutionName('.claude/worktrees/x')).toBe(true);
    expect(isHiddenSolutionName('..')).toBe(true);
    expect(isHiddenSolutionName('')).toBe(true);
    expect(isHiddenSolutionName('web-front')).toBe(false);
    expect(isHiddenSolutionName('microfrontends/web-front')).toBe(false);
    // The 2.4.23 report: a cwd inside the workspace's `.claude` folder became the solution ".claude".
    expect(solutionOfPath('.claude/worktrees/fix-login')).toBeNull();
    expect(solutionOfPath('.claude/tmp/proj-123')).toBeNull();
    expect(solutionOfPath('../../Personal/tool-repo')).toBeNull();
    expect(solutionOfPath('microfrontends/.cache/x')).toBeNull();
    expect(solutionOfPath('microfrontends/web-front/src')).toBe('web-front');
    expect(solutionOfPath('mobile')).toBe('mobile');
    expect(writtenSolution({ root: WS, kind: 'workspace', cwd: WS }, `${WS}/.claude/agents/qa.md`, null)).toBeNull();
    expect(writtenSolution({ root: WS, kind: 'workspace', cwd: WS }, `${WS}/microfrontends/web-front/a.ts`, null)).toBe('web-front');
    expect(withSolutions(['web-front'], ['.claude', 'mobile'])).toEqual(['web-front', 'mobile']);
    expect(withSolutions(['web-front'], ['.claude'])).toBeNull();
  });
});

describe('repos outside the workspace root', () => {
  it('a main checkout outside the root (either separator, any case) is outside; the root and below are not', () => {
    expect(isOutsideRoot(WS, '/Users/dev/Personal/tool-repo')).toBe(true);
    expect(isOutsideRoot(WS, `${WS}-other/repo`)).toBe(true);
    expect(isOutsideRoot(WS, `${WS}/microfrontends/web-front`)).toBe(false);
    expect(isOutsideRoot(WS, WS)).toBe(false);
    expect(isOutsideRoot('D:\\code\\ws', 'd:/code/ws/mobile')).toBe(false);
    expect(isOutsideRoot('D:\\code\\ws', 'D:\\code\\tool-repo')).toBe(true);
  });

  it('is carried by default when it edited there or most of its commands ran there; else left out', () => {
    expect(carriedByDefault({ edited: 1, commands: 0 }, 9)).toBe(true);
    expect(carriedByDefault({ edited: 0, commands: 5 }, 5)).toBe(true);
    expect(carriedByDefault({ edited: 0, commands: 2 }, 5)).toBe(false);
    expect(carriedByDefault({ edited: 0, commands: 0 }, 0)).toBe(false);
  });

  it('a move leaves out the outside repos that are not carried: the developer’s choice by key, else the default; an older source carries all', () => {
    const repos = [
      { key: 'front', path: `${WS}/front` },
      { key: 'tool-repo', path: '/x/tool-repo', outside: true, carry: true },
      { key: 'notes', path: '/x/notes', outside: true, carry: false },
    ];
    expect(effectiveExclusions(repos, undefined, undefined)).toEqual(['/x/notes']);
    expect(effectiveExclusions(repos, ['/x/other'], { notes: true })).toEqual(['/x/other']);
    expect(effectiveExclusions(repos, [], { 'tool-repo': false })).toEqual(['/x/tool-repo', '/x/notes']);
    expect(effectiveExclusions([{ key: 'old', path: '/x/old' }], undefined, undefined)).toEqual([]);
    expect(outsideCarried({ key: 'notes', carry: false }, { notes: true })).toBe(true);
    expect(outsideCarried({ key: 'tool-repo' }, undefined)).toBe(true);
  });

  it('is cloned beside the target workspace by default, written the target’s way', () => {
    expect(outsideCloneSuggestion('D:\\code\\ws', '/Users/dev/Personal/tool-repo')).toBe('D:\\code\\tool-repo');
    expect(outsideCloneSuggestion('/Users/me/ws', 'D:\\code\\tool-repo')).toBe('/Users/me/tool-repo');
  });

  it('the carry choice travels in the placement and is remembered; a cloned outside repo is used from its folder next time', () => {
    expect(placementOf({ roots: ['/b/ws'], outsideCarry: { 'tool-repo': false } })).toEqual({ roots: ['/b/ws'], outsideCarry: { 'tool-repo': false } });
    expect(placementOf({ roots: [], outsideCarry: { x: 'yes' } })).toBeNull();
    const remembered = placementToRemember({ roots: ['/b/ws'], repoModes: { 'tool-repo': 'clone' }, outsideCarry: { 'tool-repo': true, notes: false } }, null, { 'tool-repo': '/b/tools/tool-repo' });
    expect(remembered).toEqual({ roots: ['/b/ws'], repoPaths: { 'tool-repo': '/b/tools/tool-repo' }, outsideCarry: { 'tool-repo': true, notes: false } });
  });

  it('a command that worked in a folder (cd, git -C, its own cwd) is marked, a path word is not', () => {
    expect(commandWorkPaths('cd /x/tool-repo && cat /x/notes/README.md && git -C ../other log', WS)).toEqual(['/x/tool-repo', '/x/other']);
    const paths = evidencePaths({ type: 'tool', name: 'Bash', input: { command: 'cd /x/tool-repo && cat /x/notes/README.md' } }, WS);
    expect(paths).toEqual([
      { path: '/x/tool-repo', kind: 'commands', workedIn: true },
      { path: '/x/notes/README.md', kind: 'commands' },
    ]);
  });
});
