import { describe, expect, it } from 'vitest';
import { parseLoopProgress } from '../../src/core/loop-progress.ts';

const LOOP_MD_EXAMPLE = [
  '## Current',
  'item: M3.2',
  'attempt: 2/5',
  'last oracle: e2e inbox-answer.spec FAIL (send button enabled before all answered)',
  '## Done',
  '- M0.1 ✓ 2026-09-28 (commit abc123)',
  '## Blocked',
  '- (none)',
  '## Breaker',
  'consecutive_blocked: 1',
  '## Assumptions (see .loop/questions.md)',
  '- (none)',
].join('\n');

describe('loop-progress · parseLoopProgress (LOOP.md state file)', () => {
  it('reads the cap from `attempt: a/n` and the breaker count from the Breaker section', () => {
    expect(parseLoopProgress(LOOP_MD_EXAMPLE)).toEqual({ cap: 5, breakerCount: 1 });
  });

  it('accepts the original LOOP.md key, CRLF, a BOM, bullets and bold keys', () => {
    const text = '﻿## Current\r\n- **attempt:** 3 / 7\r\n## Breaker\r\n- consecutive_failures: 2\r\n';
    expect(parseLoopProgress(text)).toEqual({ cap: 7, breakerCount: 2 });
  });

  it('a consecutive_… line outside the Breaker section is not the breaker; missing parts stay null', () => {
    expect(parseLoopProgress('## Current\nitem: M1\nconsecutive_blocked: 4\n')).toEqual({ cap: null, breakerCount: null });
    expect(parseLoopProgress('## Breaker\nconsecutive_blocked: 0\n')).toEqual({ cap: null, breakerCount: 0 });
    expect(parseLoopProgress('attempt: 0/5 (idle)\n')).toEqual({ cap: 5, breakerCount: null });
    expect(parseLoopProgress('')).toEqual({ cap: null, breakerCount: null });
    expect(parseLoopProgress('# Notes\nattempt: two of five\n## Breaker\ntripped\n')).toEqual({ cap: null, breakerCount: null });
  });

  it("reads this repo's own lane progress format (Current / Done / Blocked / Breaker / Assumptions)", () => {
    const lane = '## Current\nitem: (none) · M4.6 done, lane w2-tabs idle\nattempt: 0/5\n## Done\n- M4.6 ✓\n## Blocked\n- (none)\n## Breaker\nconsecutive_blocked: 0\n## Assumptions\n- x\n';
    expect(parseLoopProgress(lane)).toEqual({ cap: 5, breakerCount: 0 });
  });
});
