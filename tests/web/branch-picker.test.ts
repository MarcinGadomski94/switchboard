import { describe, expect, it } from 'vitest';
import type { RepoBranch, RepoBranches } from '../../src/core/api.ts';
import { existingBranchName, moveToWorktreeMessage, parseBranchRefs } from '../../src/core/worktrees.ts';
import {
  BRANCH_MODE_LABELS,
  branchRow,
  existingConfirmText,
  filterBranches,
  isolateBody,
  pickedBranch,
  pickerNote,
  pickerStatus,
} from '../../src/web/views/branch-picker.ts';

/** D60: the conflict card's Existing branch picker (pure logic) and the core helpers it stands on. */

const NOW = Date.parse('2026-09-30T12:00:00Z');

function branch(overrides: Partial<RepoBranch> & Pick<RepoBranch, 'name'>): RepoBranch {
  return {
    kind: 'local',
    remote: null,
    localName: overrides.name,
    upstream: null,
    localExists: true,
    subject: null,
    committedAt: null,
    checkedOutAt: null,
    ...overrides,
  };
}

const LOCAL = branch({ name: 'PROJ-7-login', upstream: 'origin/PROJ-7-login', subject: 'Fix the login', committedAt: '2026-09-27T12:00:00Z' });
const MASTER = branch({ name: 'master', checkedOutAt: '/work/alpha-front', upstream: 'origin/master' });
const REMOTE = branch({ name: 'origin/PROJ-5-search', kind: 'remote', remote: 'origin', localName: 'PROJ-5-search', upstream: 'origin/PROJ-5-search', localExists: false, subject: 'Add search', committedAt: '2026-09-30T09:00:00Z' });
const SHARED = branch({ name: 'upstream/PROJ-7-login', kind: 'remote', remote: 'upstream', localName: 'PROJ-7-login', upstream: 'upstream/PROJ-7-login', localExists: true });
const ALL = [LOCAL, MASTER, REMOTE, SHARED];

describe('D60 · branchRow', () => {
  it('local: kind, subject + age, its upstream as the note', () => {
    expect(branchRow(LOCAL, NOW)).toEqual({ name: 'PROJ-7-login', kind: 'local', detail: 'Fix the login · 3d ago', disabled: false, reason: '', note: 'tracks origin/PROJ-7-login' });
  });

  it('checked out elsewhere: listed, disabled, with the reason', () => {
    expect(branchRow(MASTER, NOW)).toMatchObject({ disabled: true, reason: 'checked out in /work/alpha-front', detail: '' });
  });

  it('remote: its remote in the kind; a new tracking branch, or the local branch it uses', () => {
    expect(branchRow(REMOTE, NOW)).toMatchObject({ kind: 'remote · origin', detail: 'Add search · 3h ago', note: 'makes the local branch PROJ-5-search tracking it' });
    expect(branchRow(SHARED, NOW)).toMatchObject({ kind: 'remote · upstream', note: 'uses the local branch PROJ-7-login' });
    expect(branchRow({ ...REMOTE, committedAt: '2026-09-30T11:59:40Z' }, NOW).detail).toBe('Add search · just now');
  });
});

describe('D60 · search and pick', () => {
  it('every word must occur in the name, case-insensitive; empty keeps the order', () => {
    expect(filterBranches(ALL, '')).toEqual(ALL);
    expect(filterBranches(ALL, '  proj ')).toEqual([LOCAL, REMOTE, SHARED]);
    expect(filterBranches(ALL, 'LOGIN upstream').map((b) => b.name)).toEqual(['upstream/PROJ-7-login']);
    expect(filterBranches(ALL, 'nothing')).toEqual([]);
  });

  it('a pick counts only while it is listed and not checked out elsewhere', () => {
    expect(pickedBranch(ALL, 'origin/PROJ-5-search')).toBe(REMOTE);
    expect(pickedBranch(ALL, 'master')).toBeNull();
    expect(pickedBranch(ALL, 'gone')).toBeNull();
    expect(pickedBranch(null, 'origin/PROJ-5-search')).toBeNull();
    expect(pickedBranch(ALL, null)).toBeNull();
  });

  it('the choice becomes the isolate body: existingBranch as listed, or D32 branch', () => {
    expect(isolateBody('s1', { mode: 'existing', branch: REMOTE })).toEqual({ sessionId: 's1', existingBranch: 'origin/PROJ-5-search' });
    expect(isolateBody('s1', { mode: 'existing', branch: LOCAL })).toEqual({ sessionId: 's1', existingBranch: 'PROJ-7-login' });
    expect(isolateBody('s1', { mode: 'new', branch: 'PROJ-1-new' })).toEqual({ sessionId: 's1', branch: 'PROJ-1-new' });
  });

  it('copy: the choices, the confirm line, the note', () => {
    expect(BRANCH_MODE_LABELS).toEqual({ new: 'New branch', existing: 'Existing branch' });
    expect(existingConfirmText({ sessionTitle: 'Login fix', repo: 'alpha-front' })).toBe('Login fix gets a new worktree of alpha-front on an existing branch (local or remote):');
    expect(pickerNote(null)).toEqual({ text: 'Pick the branch the worktree will be on', ok: false });
    expect(pickerNote(REMOTE)).toEqual({ text: '⎇ a new local PROJ-5-search tracking origin/PROJ-5-search', ok: true });
    expect(pickerNote(SHARED)).toEqual({ text: '⎇ the worktree will be on PROJ-7-login', ok: true });
  });

  it('status line: loading, fetching over the cached list, the fetch failure, a refusal', () => {
    const list: RepoBranches = { repo: 'alpha-front', repoPath: '/work/alpha-front', branches: ALL, fetched: true, fetchError: null };
    expect(pickerStatus({ list: null, fetching: false, error: null })).toEqual({ text: 'Loading branches…', warn: false });
    expect(pickerStatus({ list, fetching: true, error: null })).toEqual({ text: 'Fetching from the remotes… (showing the branches known locally)', warn: false });
    expect(pickerStatus({ list, fetching: false, error: null })).toEqual({ text: '', warn: false });
    expect(pickerStatus({ list: { ...list, fetched: false, fetchError: 'git fetch failed: offline' }, fetching: false, error: null })).toEqual({
      text: 'Could not fetch: git fetch failed: offline. Showing the branches known locally.',
      warn: true,
    });
    expect(pickerStatus({ list: null, fetching: false, error: 'no session x' })).toEqual({ text: 'no session x', warn: true });
  });
});

describe('D60 · core: parseBranchRefs, existingBranchName, the move message', () => {
  it('parses for-each-ref: local first, remotes by the longest remote name, HEAD left out, checked-out map', () => {
    const out = [
      'refs/remotes/team/sub/PROJ-2-x\0\x002026-09-30T10:00:00+02:00\0Two',
      'refs/heads/PROJ-1-a\0origin/PROJ-1-a\x002026-09-29T10:00:00+02:00\0One',
      'refs/remotes/origin/HEAD\0\0\0',
      'refs/remotes/origin/PROJ-1-a\0\x002026-09-29T10:00:00+02:00\0One',
      '',
    ].join('\n');
    const rows = parseBranchRefs(out, ['origin', 'team', 'team/sub'], new Map([['PROJ-1-a', '/wt/a']]));
    expect(rows).toEqual([
      branch({ name: 'PROJ-1-a', upstream: 'origin/PROJ-1-a', subject: 'One', committedAt: '2026-09-29T10:00:00+02:00', checkedOutAt: '/wt/a' }),
      branch({ name: 'team/sub/PROJ-2-x', kind: 'remote', remote: 'team/sub', localName: 'PROJ-2-x', upstream: 'team/sub/PROJ-2-x', localExists: false, subject: 'Two', committedAt: '2026-09-30T10:00:00+02:00' }),
      branch({ name: 'origin/PROJ-1-a', kind: 'remote', remote: 'origin', localName: 'PROJ-1-a', upstream: 'origin/PROJ-1-a', localExists: true, subject: 'One', committedAt: '2026-09-29T10:00:00+02:00', checkedOutAt: '/wt/a' }),
    ]);
  });

  it('existingBranchName: trimmed; never an option, spaces, control characters or ..', () => {
    expect(existingBranchName(' origin/PROJ-1-a ')).toBe('origin/PROJ-1-a');
    expect(existingBranchName('feature/x')).toBe('feature/x');
    for (const bad of ['', '  ', '-x', '--orphan', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a\u0001', 7, null, undefined]) expect(existingBranchName(bad), String(bad)).toBeNull();
  });

  it('the move message: a new branch as before; an existing one names it (and its upstream)', () => {
    const base = { repo: 'alpha-front', repoPath: '/w/alpha-front', worktreePath: '/w/alpha-front-wt-x', branch: 'PROJ-7-login', base: 'master' };
    expect(moveToWorktreeMessage(base)).toContain('(branch PROJ-7-login, created from the current commit of master)');
    expect(moveToWorktreeMessage({ ...base, existing: null })).toBe(moveToWorktreeMessage(base));
    const tracking = moveToWorktreeMessage({ ...base, existing: { upstream: 'origin/PROJ-7-login', createdFromRemote: false, pickedRemote: null } });
    expect(tracking).toContain('(the existing branch PROJ-7-login, tracking origin/PROJ-7-login)');
    expect(tracking).toContain("This branch already has work on it: you are continuing that branch's work, not starting fresh.");
    expect(tracking).not.toContain('created from the current commit');
    expect(tracking).toContain('Do not stash, reset or check out anything in /w/alpha-front');
  });
});
