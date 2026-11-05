import { describe, expect, it } from 'vitest';
import { MOVE_LOG_REASON_MAX, moveLogReason, moveLogRunId, moveOutcomeMessage, moveStepMessage } from '../../src/core/move-log.ts';

describe('the move log (docs/peers.md → The move log): pure helpers', () => {
  it('scrubs a failure reason: URL credentials, token shapes, Bearer and token= values; one line, capped', () => {
    const reason = moveLogReason(
      new Error('git push https://someone:hunter2token@example.com/acme/app.git failed\nfatal: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 rejected; Authorization: Bearer abcdefghijklmnop; url?token=s3cr3tvalue&x=1 sk-ant-0123456789abcdefghijkl'),
    );
    expect(reason).toBe('git push https://example.com/acme/app.git failed fatal: [redacted] rejected; Authorization: Bearer [redacted]; url?token=[redacted]&x=1 [redacted]');
    expect(reason).not.toMatch(/hunter2|ghp_|abcdefghijklmnop|s3cr3t|sk-ant/);
    // Repo names and paths stay readable; ssh users are not secrets.
    expect(moveLogReason('alpha: /Users/dev/code/alpha via git@github.com:acme/alpha.git')).toBe('alpha: /Users/dev/code/alpha via git@github.com:acme/alpha.git');
    expect(moveLogReason('x'.repeat(1000))).toHaveLength(MOVE_LOG_REASON_MAX);
    expect(moveLogReason(42)).toBe('42');
  });

  it('messages: `move: <step> <state>` and the outcome', () => {
    expect(moveStepMessage('capture', 'finished')).toBe('move: capture finished');
    expect(moveOutcomeMessage({ failedAt: null, rolledBack: null })).toBe('move: done');
    expect(moveOutcomeMessage({ failedAt: 'apply', rolledBack: true })).toBe('move: failed at apply, rolled back');
    expect(moveOutcomeMessage({ failedAt: 'apply', rolledBack: false })).toBe('move: failed at apply, rollback left something behind');
    expect(moveOutcomeMessage({ failedAt: 'checks', rolledBack: null })).toBe('move: failed at checks');
  });

  it('a run id from a peer is logged only when it looks like one', () => {
    expect(moveLogRunId('90ddc49a-c102-4a8c-b001-f18bb72fa276')).toBe('90ddc49a-c102-4a8c-b001-f18bb72fa276');
    expect(moveLogRunId(undefined)).toBeNull();
    expect(moveLogRunId('a\nb')).toBeNull();
    expect(moveLogRunId('x'.repeat(65))).toBeNull();
  });
});
