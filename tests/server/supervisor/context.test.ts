import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { parseStreamLine } from '../../../src/core/stream-json.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { toSessionContext } from '../../../src/server/sessions/wire.ts';
import { StreamRecorder } from '../../../src/server/supervisor/recorder.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D49: the recorder's context meter (`sessions.context`): main-agent usages only,
 * a result's windows, a compaction and the next turn, stored and announced
 * (`onContext` → the supervisor's `sessionUpdated`); read back by a new recorder
 * (a restart / resume) and resolved for the wire.
 */

const SID = 'c-context';
let tmp: string | undefined;
let store: Store | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
});

const NOW = new Date('2026-09-29T12:05:00.000Z');
const line = (value: Record<string, unknown>): string => JSON.stringify({ session_id: SID, ...value });
const init = (model = 'claude-opus-4-7'): string => line({ type: 'system', subtype: 'init', cwd: '/ws', model, permissionMode: 'auto', tools: [], claude_code_version: '2.1.284' });
const assistant = (id: string, tokens: number, parent: string | null = null, model = 'claude-opus-4-7'): string =>
  line({
    type: 'assistant',
    message: { id, model, type: 'message', role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }], usage: { input_tokens: 3, cache_read_input_tokens: tokens - 3, cache_creation_input_tokens: 0, output_tokens: 400 } },
    parent_tool_use_id: parent,
    uuid: `a-${id}`,
  });
const result = (window = 200_000, model = 'claude-opus-4-7'): string =>
  line({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, duration_ms: 1, total_cost_usd: 0, modelUsage: { [model]: { inputTokens: 1, contextWindow: window } } });
const boundary = (pre: number, post?: number, parent: string | null = null): string =>
  line({ type: 'system', subtype: 'compact_boundary', uuid: 'b-1', ...(parent ? { parent_tool_use_id: parent } : {}), compact_metadata: { trigger: 'auto', pre_tokens: pre, ...(post !== undefined ? { post_tokens: post } : {}) } });

async function world() {
  tmp = await makeTempDir('context-meter');
  store = await openTempStore(tmp);
  const session = await store.sessions.create({ name: 'ctx', claudeSessionId: SID, task: 't', mode: 'orchestrator', cwd: path.join(tmp, 'ws'), status: 'run', remoteAvailable: false });
  const main = await store.agents.create({ sessionId: session.id, kind: 'main', name: 'orchestrator', status: 'run' });
  let announced = 0;
  const recorder = new StreamRecorder({ store, session, mainAgentId: main.id, onEvent: () => undefined, onContext: () => announced++, now: () => NOW });
  const s = store;
  return {
    session,
    announced: () => announced,
    async feed(...lines: readonly string[]): Promise<void> {
      for (const l of lines) await recorder.handle(parseStreamLine(l));
    },
    async wire(choice: string | null = null) {
      const record = await s.sessions.get(session.id);
      if (!record) throw new Error('no session');
      return toSessionContext({ ...record, model: choice });
    },
  };
}

describe('StreamRecorder · context meter (D49)', () => {
  it('main usages set it, subagent usages never count; the result reports the window; stored and announced', async () => {
    const w = await world();
    expect(await w.wire()).toMatchObject({ tokens: null, percent: null, band: 'unknown', window: 200_000, windowSource: 'model' });
    await w.feed(init(), assistant('m1', 124_000));
    expect(await w.wire()).toMatchObject({ tokens: 124_000, percent: 62, band: 'warn', model: 'claude-opus-4-7' });
    const announced = w.announced();
    // A subagent's (sidechain) line: nothing changes, nothing announced.
    await w.feed(assistant('s1', 190_000, 'toolu_agent', 'claude-haiku-4-5'));
    expect(w.announced()).toBe(announced);
    // The same message's next block (same usage): no new write.
    await w.feed(assistant('m1', 124_000));
    expect(w.announced()).toBe(announced);
    await w.feed(result(200_000));
    expect(await w.wire()).toMatchObject({ tokens: 124_000, window: 200_000, windowSource: 'reported' });
  });

  it('a compaction resets to post_tokens with its time, the next usage replaces it, the next turn ends "compacted"; a subagent boundary is ignored', async () => {
    const w = await world();
    await w.feed(init(), assistant('m1', 170_000), result());
    await w.feed(boundary(170_000, 90_000, 'toolu_agent'));
    expect(await w.wire()).toMatchObject({ tokens: 170_000, compaction: null });
    await w.feed(init(), boundary(170_000, 18_000));
    expect(await w.wire()).toMatchObject({ tokens: 18_000, percent: 9, band: 'ok', compactedRecently: true, compaction: { at: NOW.toISOString(), trigger: 'auto', preTokens: 170_000, postTokens: 18_000 } });
    await w.feed(assistant('m2', 24_000), result());
    expect(await w.wire()).toMatchObject({ tokens: 24_000, compactedRecently: true });
    await w.feed(init());
    expect(await w.wire()).toMatchObject({ tokens: 24_000, compactedRecently: false, compaction: { trigger: 'auto' } });
  });

  it('survives a new process (a restart, a resume): the next recorder starts from the stored state; the window follows the model choice', async () => {
    const w = await world();
    await w.feed(init(), assistant('m1', 180_000), result(200_000));
    const record = await store?.sessions.get(w.session.id);
    if (!store || !record) throw new Error('no session');
    const again = new StreamRecorder({ store, session: record, mainAgentId: 'x', onEvent: () => undefined, now: () => NOW });
    await again.handle(parseStreamLine(init()));
    expect(await w.wire()).toMatchObject({ tokens: 180_000, percent: 90, band: 'high' });
    // Without a choice (the CLI's default) the process's own init model decides: a [1m] one → 1M.
    await again.handle(parseStreamLine(init('claude-opus-4-7[1m]')));
    expect(await w.wire()).toMatchObject({ window: 1_000_000, percent: 18 });
    // D31: the developer picks opus[1m]: the window follows at once.
    expect(await w.wire('opus[1m]')).toMatchObject({ tokens: 180_000, window: 1_000_000, percent: 18, band: 'ok' });
  });

  it('no context for a session Switchboard never ran and never read (the demo seed)', async () => {
    const w = await world();
    const record = await store?.sessions.get(w.session.id);
    if (!record) throw new Error('no session');
    expect(toSessionContext({ ...record, remoteAvailable: null, context: null })).toBeNull();
    expect(toSessionContext({ ...record, remoteAvailable: false, context: null })).toMatchObject({ tokens: null });
  });
});

describe('D49 rulings on the real supervisor (fake-claude)', () => {
  let sworld: SupervisorWorld | undefined;
  afterEach(async () => {
    await sworld?.cleanup();
    sworld = undefined;
  });

  /** A session that ran one turn and was paused (no live process). */
  async function pausedSession(parentEnv: Record<string, string> = {}) {
    sworld = await makeSupervisorWorld({ parentEnv });
    const w = sworld;
    const session = await w.supervisor.start(newSession({ task: 'Reply with just OK. [fake:usage 124000]' }), w.place);
    await waitForStatus(w.store, session.id, ['done']);
    await w.supervisor.pause(session.id);
    return { w, session };
  }

  it('D49-backfill: a session without a stored meter reads it from its transcript once, stores it and publishes sessionUpdated', async () => {
    const { w, session } = await pausedSession();
    await w.store.sessions.update(session.id, { context: null });
    const updates: Array<Session['context']> = [];
    w.supervisor.on('sessionUpdated', (s) => {
      if (s.id === session.id) updates.push(s.context);
    });
    await Promise.all([w.supervisor.backfillContext(session.id), w.supervisor.backfillContext(session.id)]);
    const stored = await w.store.sessions.get(session.id);
    expect(stored?.context).toMatchObject({ tokens: 124_000, model: 'claude-haiku-4-5-20251001' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ tokens: 124_000, percent: 62 });
    // Read once: a stored meter is never read again.
    await w.supervisor.backfillContext(session.id);
    expect(updates).toHaveLength(1);
    expect(w.errors).toEqual([]);
  });

  it('D49-backfill: a missing transcript stores the empty meter (Context —); the demo-like session without a process is skipped', async () => {
    const { w, session } = await pausedSession();
    await w.store.sessions.update(session.id, { context: null, claudeSessionId: '00000000-0000-4000-8000-000000000000' });
    await w.supervisor.backfillContext(session.id);
    expect((await w.store.sessions.get(session.id))?.context).toMatchObject({ tokens: null, compaction: null });
    await w.store.sessions.update(session.id, { context: null, remoteAvailable: null });
    await w.supervisor.backfillContext(session.id);
    expect((await w.store.sessions.get(session.id))?.context).toBeNull();
  });

  it('D49-backfill at resume: a pre-D49 session starts from its transcript meter', async () => {
    const { w, session } = await pausedSession();
    await w.store.sessions.update(session.id, { context: null });
    await w.supervisor.sendMessage(session.id, 'Hold on. [fake:hold 3]');
    const record = await until(async () => {
      const r = await w.store.sessions.get(session.id);
      return r?.context ? r : undefined;
    }, 'the meter at resume');
    expect(record.context?.tokens).toBe(124_000);
  });

  it('D49-autocompact-mark: the process env / settings decide the tick (DISABLE_AUTO_COMPACT → none; a pct override lowers it)', async () => {
    const off = await pausedSession({ DISABLE_AUTO_COMPACT: '1' });
    expect(toSessionContext((await off.w.store.sessions.get(off.session.id)) as NonNullable<Awaited<ReturnType<Store['sessions']['get']>>>)).toMatchObject({ autoCompactTokens: null, autoCompactPercent: null });
    await off.w.cleanup();
    sworld = undefined;
    const pct = await pausedSession();
    await writeFile(path.join(pct.w.configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' } }));
    await pct.w.supervisor.sendMessage(pct.session.id, 'Again.');
    await waitForStatus(pct.w.store, pct.session.id, ['done']);
    const record = await pct.w.store.sessions.get(pct.session.id);
    if (!record) throw new Error('no session');
    expect(toSessionContext(record)).toMatchObject({ window: 200_000, autoCompactTokens: 90_000, autoCompactPercent: 45 });
  });
});
