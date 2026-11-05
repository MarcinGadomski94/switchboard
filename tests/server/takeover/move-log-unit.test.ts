import { describe, expect, it } from 'vitest';
import { MoveLog, type MoveLogSink } from '../../../src/server/takeover/move-log.ts';

function sink(): { readonly sink: MoveLogSink; readonly lines: Array<{ level: 'info' | 'warn'; msg: string; fields: Record<string, unknown> }> } {
  const lines: Array<{ level: 'info' | 'warn'; msg: string; fields: Record<string, unknown> }> = [];
  return {
    lines,
    sink: {
      info: (fields, msg) => lines.push({ level: 'info', msg, fields }),
      warn: (fields, msg) => lines.push({ level: 'warn', msg, fields }),
    },
  };
}

describe('MoveLog (docs/peers.md → The move log)', () => {
  it('a step: started, then finished with its duration and result fields', async () => {
    const { sink: out, lines } = sink();
    const log = new MoveLog(out);
    expect(await log.step('run-1', 'capture', 'source', async () => 7, { repo: 'alpha' }, (value) => ({ value }))).toBe(7);
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ['info', 'move: capture started'],
      ['info', 'move: capture finished'],
    ]);
    expect(lines[1]?.fields).toMatchObject({ run: 'run-1', step: 'capture', state: 'finished', side: 'source', repo: 'alpha', value: 7, ms: expect.any(Number) });
  });

  it('a failure: warn with the scrubbed reason; the open sub-steps of the run fail with it; no run → nothing logged', async () => {
    const { sink: out, lines } = sink();
    const log = new MoveLog(out);
    const other = log.begin('run-2', 'apply', 'target');
    await expect(
      log.step('run-1', 'apply', 'target', async () => {
        log.begin('run-1', 'restore', 'target', { repo: 'alpha' });
        throw new Error('push to https://user:tok3n@example.com failed: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
      }),
    ).rejects.toThrow('failed');
    expect(lines.filter((line) => line.fields['run'] === 'run-1').map((line) => `${line.level} ${line.msg}`)).toEqual(['info move: apply started', 'info move: restore started', 'warn move: restore failed', 'warn move: apply failed']);
    const failed = lines.find((line) => line.msg === 'move: apply failed');
    expect(failed?.fields['reason']).toBe('push to https://example.com failed: [redacted]');
    // Another run's open step is untouched; a step ends once.
    other.done();
    other.fail('late');
    expect(lines.filter((line) => line.fields['run'] === 'run-2').map((line) => line.msg)).toEqual(['move: apply started', 'move: apply finished']);
    const before = lines.length;
    expect(await log.step(null, 'plan', 'target', async () => 'preview')).toBe('preview');
    expect(lines.length).toBe(before);
  });
});
