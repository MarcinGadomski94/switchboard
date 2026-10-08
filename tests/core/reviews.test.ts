import { describe, expect, it } from 'vitest';
import { mapPeerAnswer, peerAnswerKind, peerHubEvent, peerInboxItem } from '../../src/core/peer-wire.ts';
import {
  type Review,
  type ReviewResolvedEvent,
  HANDLED_BY_AGENT,
  bashExitCode,
  resolutionLabel,
  draftCommitMessage,
  isTestCommand,
  reviewActions,
  reviewTitle,
  sendBackMessage,
  testsFromCalls,
  testsLine,
} from '../../src/core/reviews.ts';
import { DEVICE_ALLOWED, DEVICE_REFUSED, matchesRule } from '../../src/server/devices/local-only.ts';
import { peerApiAllowed } from '../../src/server/peers/service.ts';
import { parseLog, parseNumstat } from '../../src/server/reviews/git.ts';

/** D79: the review queue's pure parts. */

describe('the shared reviewResolved contract', () => {
  it('is exactly { sessionId, outcome }', () => {
    const event: ReviewResolvedEvent = { sessionId: 's1', outcome: 'merged' };
    expect(Object.keys(event)).toEqual(['sessionId', 'outcome']);
  });
});

describe('isTestCommand / bashExitCode / testsFromCalls', () => {
  it('recognizes test runners and test scripts, not other commands', () => {
    for (const command of ['npm test', 'npm run test:unit', 'npx vitest run tests/x', 'pnpm test', 'yarn jest --ci', 'pytest -q', 'go test ./...', 'cargo test', 'dotnet test', 'make test', 'cd web && npm test', 'npx playwright test e2e', 'python -m pytest']) {
      expect(isTestCommand(command), command).toBe(true);
    }
    for (const command of ['npm run build', 'npm ci', 'git status', 'ls tests', 'cat test.txt', 'echo testing', 'npm run typecheck']) {
      expect(isTestCommand(command), command).toBe(false);
    }
  });

  it('reads the exit code of a Bash result', () => {
    expect(bashExitCode('Exit code 2\nfailed', true)).toBe(2);
    expect(bashExitCode('all good', false)).toBe(0);
    expect(bashExitCode('boom', true)).toBe(1);
    expect(bashExitCode(undefined, undefined)).toBeNull();
  });

  it('takes the last test-like call with a result; "not reported" without one', () => {
    expect(testsFromCalls([])).toEqual({ status: 'not-reported', command: null, exitCode: null });
    expect(testsFromCalls([{ command: 'npm test', result: 'Exit code 1\nx', isError: true }, { command: 'npm test', result: 'ok', isError: false }, { command: 'git push', result: 'ok', isError: false }])).toEqual({
      status: 'passed',
      command: 'npm test',
      exitCode: 0,
    });
    expect(testsFromCalls([{ command: 'npm test', result: undefined, isError: undefined }])).toEqual({ status: 'not-reported', command: null, exitCode: null });
    expect(testsLine({ status: 'failed', command: 'pytest', exitCode: 1 })).toBe('Tests failed (exit 1) · pytest');
    expect(testsLine({ status: 'not-reported', command: null, exitCode: null })).toBe('Tests not reported');
  });
});

describe('draftCommitMessage', () => {
  it('uses the summary’s first line (Markdown marks removed, ≤ 72) as the subject and the rest as the body', () => {
    expect(draftCommitMessage('## **Fixed** the `login`\n\nDetails here.', 'x')).toBe('Fixed the login\n\nDetails here.');
    expect(draftCommitMessage(`- ${'a'.repeat(100)}`, 'x')).toBe(`${'a'.repeat(71)}…`);
    expect(draftCommitMessage(null, 'Fix login')).toBe('Changes from Fix login');
    expect(draftCommitMessage('  \n ', 'Fix login')).toBe('Changes from Fix login');
  });
});

describe('reviewActions', () => {
  const repo = { uncommitted: 0, prUrl: null, worktreeId: 'w' };
  it('offers each mode’s actions, the first primary', () => {
    expect(reviewActions('pending', 'branch', [repo])).toEqual(['merge', 'open-pr', 'send-back', 'discard', 'dismiss']);
    expect(reviewActions('pending', 'branch', [{ ...repo, prUrl: 'https://x/pull/1' }])).toEqual(['merge', 'send-back', 'discard', 'dismiss']);
    expect(reviewActions('pending', 'folder', [{ ...repo, uncommitted: 2 }])).toEqual(['commit', 'send-back', 'discard', 'dismiss']);
    expect(reviewActions('pending', 'folder', [repo])).toEqual(['send-back', 'dismiss']);
    expect(reviewActions('cleanup', 'branch', [repo])).toEqual(['cleanup', 'dismiss']);
    expect(reviewActions('resolved', 'branch', [repo])).toEqual([]);
  });

  it('a card that closed itself reads "Handled by the agent"; a clicked one its outcome (ruling)', () => {
    expect(resolutionLabel({ outcome: 'dismissed', handledByAgent: true })).toBe(HANDLED_BY_AGENT);
    expect(HANDLED_BY_AGENT).toBe('Handled by the agent');
    expect(resolutionLabel({ outcome: 'dismissed', handledByAgent: false })).toBe('Dismissed');
    expect(resolutionLabel({ outcome: 'merged', handledByAgent: false })).toBe('Merged');
    expect(resolutionLabel({ outcome: null, handledByAgent: false })).toBeNull();
  });

  it('titles and the Send back message', () => {
    expect(reviewTitle({ state: 'pending', outcome: null, fileCount: 1, added: 3, removed: 1, commitCount: 0 })).toBe('1 file changed (+3 −1)');
    expect(reviewTitle({ state: 'pending', outcome: null, fileCount: 0, added: 0, removed: 0, commitCount: 2 })).toBe('2 commits to review');
    expect(reviewTitle({ state: 'cleanup', outcome: 'discarded', fileCount: 1, added: 0, removed: 0, commitCount: 0 })).toBe('Discarded — clean up the worktree?');
    expect(sendBackMessage('  Add a test. ')).toBe('Review: your changes were sent back with this comment:\n\nAdd a test.');
  });
});

describe('git output parsers', () => {
  it('parses numstat -z and log lines', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\u00000\t0\tempty.txt\u0000-\t-\timg.png\u0000')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1, binary: false },
      { path: 'empty.txt', added: 0, removed: 0, binary: false },
      { path: 'img.png', added: 0, removed: 0, binary: true },
    ]);
    expect(parseLog('abc\u001fFirst\ndef\u001fSecond: with \u001f inside\n')).toEqual([
      { sha: 'abc', subject: 'First' },
      { sha: 'def', subject: 'Second: with \u001f inside' },
    ]);
  });
});

describe('devices and peers (D79)', () => {
  it('a device may list reviews and Merge / Open PR / Commit / Send back / Dismiss; Discard and Clean up stay on the desktop', () => {
    expect(matchesRule(DEVICE_ALLOWED, 'GET', '/api/reviews')).toBe(true);
    for (const action of ['merge', 'open-pr', 'commit', 'send-back', 'dismiss']) expect(matchesRule(DEVICE_ALLOWED, 'POST', `/api/reviews/abc/${action}`), action).toBe(true);
    for (const action of ['discard', 'cleanup']) {
      expect(matchesRule(DEVICE_ALLOWED, 'POST', `/api/reviews/abc/${action}`), action).toBe(false);
      expect(matchesRule(DEVICE_REFUSED, 'POST', `/api/reviews/abc/${action}`), action).toBe(true);
    }
  });

  it('the peer API serves the list and every action; answers and items are namespaced', () => {
    expect(peerApiAllowed('GET', '/api/reviews')).toBe(true);
    expect(peerApiAllowed('POST', '/api/reviews/abc/merge')).toBe(true);
    expect(peerApiAllowed('POST', '/api/reviews/abc/cleanup')).toBe(true);
    expect(peerApiAllowed('POST', '/api/reviews/abc/nope')).toBe(false);
    const machine = { id: 'abcdefghijkl', name: 'studio', state: 'online' as const };
    const review = { id: 'r1', sessionId: 's1', repos: [] } as unknown as Review;
    expect(peerAnswerKind('GET', '/api/reviews')).toBe('reviews');
    expect(peerAnswerKind('POST', '/api/reviews/r1/merge')).toBe('review');
    expect(mapPeerAnswer(machine, 'review', review)).toMatchObject({ id: 'r~abcdefghijkl~r1', sessionId: 'r~abcdefghijkl~s1', handledByAgent: false, machine: { name: 'studio' } });
    expect(mapPeerAnswer(machine, 'reviews', [review])).toMatchObject([{ id: 'r~abcdefghijkl~r1' }]);
    const item = peerInboxItem(machine, { id: 'r1', kind: 'review', sessionId: 's1', source: 's', status: 'need', title: 't', label: 'Review', detail: '', createdAt: '', branches: [], review });
    expect(item.review).toMatchObject({ id: 'r~abcdefghijkl~r1', sessionId: 'r~abcdefghijkl~s1' });
    expect(peerHubEvent(machine, 'reviewsChanged', { sessionId: 's1' })).toEqual({ sessionId: 'r~abcdefghijkl~s1' });
    // The todo lane's event stays on its machine.
    expect(peerHubEvent(machine, 'reviewResolved', { sessionId: 's1', outcome: 'merged' })).toBeNull();
  });
});
