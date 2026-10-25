import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, keepaliveNow, withKeepalive } from '../../src/web/api/client.ts';
import { speedModel as homeSpeedModel } from '../../src/web/v2/home/home-model.ts';
import { speedModel as newSpeedModel } from '../../src/web/v2/new/new-model.ts';
import { speedOf } from '../../src/web/v2/agent/how-model.ts';
import { SPEED_ALIAS, speedModel, speedModels, speedOfModel } from '../../src/web/v2/shared/speed.ts';

describe('lane X · Smart / Fast (one mapping)', () => {
  const claude = [
    { value: 'default', label: 'Default' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ];

  it('Smart = Opus, Fast = Sonnet, with the aliases when no list is known', () => {
    expect(SPEED_ALIAS).toEqual({ smart: 'opus', fast: 'sonnet' });
    expect(speedModel('smart', null)).toBe('opus');
    expect(speedModel('fast', null)).toBe('sonnet');
    expect(speedModel('smart', claude)).toBe('opus');
    expect(speedModel('fast', claude)).toBe('sonnet');
  });

  it('falls back to a named model, then Haiku, then the engine default', () => {
    expect(speedModel('smart', [{ value: 'claude-opus-9', label: 'x' }])).toBe('claude-opus-9');
    expect(speedModel('fast', [{ value: 'default' }, { value: 'claude-haiku-5' }])).toBe('claude-haiku-5');
    expect(speedModel('smart', [{ value: 'default' }, { value: 'gpt-5' }], 'codex')).toBeNull();
    expect(speedModel('fast', [{ value: 'gpt-5' }, { value: 'gpt-5-mini' }], 'codex')).toBe('gpt-5-mini');
    expect(speedModel('fast', [{ value: 'gemini-2.5-pro' }], 'gemini')).toBeNull();
    expect(speedModel('fast', null, 'codex')).toBeNull();
  });

  it('Home, + New and the agent panel agree', () => {
    for (const speed of ['smart', 'fast'] as const) {
      const expected = speedModel(speed, claude);
      expect(homeSpeedModel(speed, claude)).toBe(expected);
      expect(newSpeedModel(speed, 'normal', 'claude', claude).model).toBe(expected);
      const panel = speedModels(claude);
      expect(panel[speed]).toBe(expected);
      expect(speedOf({ current: expected, available: claude } as never)).toBe(speed);
    }
    expect(speedOfModel('claude-haiku-5', null)).toBe('fast');
    expect(speedOfModel(null, claude)).toBe('smart');
  });
});

describe('lane X · keepalive for the Undo windows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a request started inside withKeepalive goes out with keepalive', async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_path: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    expect(keepaliveNow()).toBe(false);
    await withKeepalive(() => api.inbox());
    await api.inbox();
    expect(calls[0]?.keepalive).toBe(true);
    expect(calls[1]?.keepalive).toBeUndefined();
    expect(keepaliveNow()).toBe(false);
  });
});
