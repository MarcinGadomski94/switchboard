import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { QuietRequestLogs } from '../../src/server/request-log.ts';

/** A Fastify app at `info` (as the service runs) whose log lines are collected. */
async function appWith(controller: QuietRequestLogs | undefined): Promise<{ app: ReturnType<typeof Fastify>; lines: Array<{ level: number; msg: string }> }> {
  const lines: Array<{ level: number; msg: string }> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) lines.push(JSON.parse(line) as { level: number; msg: string });
      done();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream }, ...(controller ? { logController: controller } : {}) });
  app.get('/ok', async () => ({ ok: true }));
  app.get('/boom', async () => {
    throw new Error('kaboom');
  });
  // A peer API call that runs a take-over step: its move-log line goes to the app's logger.
  app.post('/api/takeover/source/stop', async () => {
    app.log.info({ run: 'run-1', step: 'stop', state: 'finished', side: 'source', ms: 6 }, 'move: stop finished');
    return { ok: true };
  });
  await app.ready();
  return { app, lines };
}

describe('QuietRequestLogs (docs/service.md → The service log)', () => {
  it('drops the routine per-request lines and keeps the errors', async () => {
    const { app, lines } = await appWith(new QuietRequestLogs());
    try {
      expect((await app.inject({ method: 'GET', url: '/ok' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/boom' })).statusCode).toBe(500);
    } finally {
      await app.close();
    }
    const messages = lines.map((line) => line.msg);
    expect(messages).not.toContain('incoming request');
    expect(messages).not.toContain('request completed');
    // The 500 is still logged at error level (50).
    expect(lines.some((line) => line.msg === 'kaboom' && line.level === 50)).toBe(true);
  });

  it('Fastify\'s default (SWITCHBOARD_REQUEST_LOGS=on) logs every request', async () => {
    const { app, lines } = await appWith(undefined);
    try {
      await app.inject({ method: 'GET', url: '/ok' });
    } finally {
      await app.close();
    }
    const messages = lines.map((line) => line.msg);
    expect(messages).toContain('incoming request');
    expect(messages).toContain('request completed');
  });

  it('keeps the move log: `move:` lines are not request lines and stay in production (2.4.18 filter on)', async () => {
    const { app, lines } = await appWith(new QuietRequestLogs());
    try {
      expect((await app.inject({ method: 'POST', url: '/api/takeover/source/stop' })).statusCode).toBe(200);
      app.log.warn({ run: 'run-1', step: 'outcome', state: 'failed', failedAt: 'apply' }, 'move: failed at apply, rolled back');
    } finally {
      await app.close();
    }
    const messages = lines.map((line) => line.msg);
    expect(messages).toEqual(['move: stop finished', 'move: failed at apply, rolled back']);
    expect(lines.every((line) => typeof (line as { time?: unknown }).time === 'number')).toBe(true);
  });
});
