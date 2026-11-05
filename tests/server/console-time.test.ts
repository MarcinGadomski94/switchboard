import { describe, expect, it } from 'vitest';
import { timestampConsole } from '../../src/server/console-time.ts';

describe('timestampConsole (docs/service.md → The service log)', () => {
  it('prefixes every console line with an ISO time, keeps the arguments, installs once and undoes', () => {
    const printed: Array<{ method: string; args: unknown[] }> = [];
    const target = {
      log: (...args: unknown[]) => printed.push({ method: 'log', args }),
      info: (...args: unknown[]) => printed.push({ method: 'info', args }),
      warn: (...args: unknown[]) => printed.push({ method: 'warn', args }),
      error: (...args: unknown[]) => printed.push({ method: 'error', args }),
      debug: (...args: unknown[]) => printed.push({ method: 'debug', args }),
    };
    const at = new Date('2026-11-05T09:12:03.456Z');
    const undo = timestampConsole(target, () => at);
    expect(timestampConsole(target, () => at)).toBeTypeOf('function');
    const error = new Error('boom');
    target.warn('switchboard peers: pc-office (abc123): attempt 1 failed (connection refused); next try in 1 s');
    target.error('switchboard ci:', error);
    target.log('[auto-clean] removed a worktree');
    expect(printed).toEqual([
      { method: 'warn', args: ['2026-11-05T09:12:03.456Z', 'switchboard peers: pc-office (abc123): attempt 1 failed (connection refused); next try in 1 s'] },
      { method: 'error', args: ['2026-11-05T09:12:03.456Z', 'switchboard ci:', error] },
      { method: 'log', args: ['2026-11-05T09:12:03.456Z', '[auto-clean] removed a worktree'] },
    ]);
    undo();
    target.info('plain');
    expect(printed.at(-1)).toEqual({ method: 'info', args: ['plain'] });
  });
});
