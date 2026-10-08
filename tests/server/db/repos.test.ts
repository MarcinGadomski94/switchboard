import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownAnswerOf } from '../../../src/server/db/repos/questions.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { StoreError } from '../../../src/server/db/table.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

let tmp: string;
let store: Store;
let clock: Date;

/** Moves the fake clock forward by `ms` and returns the new ISO time. */
function tick(ms = 1_000): string {
  clock = new Date(clock.getTime() + ms);
  return clock.toISOString();
}

const T0 = '2026-09-28T00:00:00.000Z';

beforeEach(async () => {
  tmp = await makeTempDir('repos');
  clock = new Date(T0);
  store = await openTempStore(tmp, { now: () => clock });
});
afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

async function session(name = 'free-talk', claudeSessionId = `claude-${name}`) {
  return store.sessions.create({ name, claudeSessionId });
}

describe('sessions', () => {
  it('create applies the table defaults and returns the stored record', async () => {
    const created = await session();
    expect(created).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'free-talk',
      // D22 (0006): no title until one is given.
      title: null,
      task: '',
      claudeSessionId: 'claude-free-talk',
      status: 'idle',
      workType: null,
      mode: null,
      phase: null,
      coordination: null,
      qaStack: null,
      qaConfluenceUrl: null,
      qaFigmaUrls: [],
      solutions: [],
      worktrees: false,
      ultracode: false,
      attached: true,
      cwd: null,
      folderId: null,
      root: null,
      rootKind: null,
      origin: 'switchboard',
      // D25 (0008): not a local copy of a remote session.
      remoteSource: null,
      pid: null,
      requestedPermissionMode: null,
      observedPermissionMode: null,
      cliVersion: null,
      lastTranscriptUuid: null,
      stopReason: null,
      scheduleId: null,
      createdAt: T0,
      updatedAt: T0,
      lastActivityAt: null,
      detachedAt: null,
      endedAt: null,
      // D24 (0007): no process run yet (null), Remote off, no bridge yet.
      remoteAvailable: null,
      remoteEnabled: false,
      remoteSessionUrl: null,
      remoteBridgeId: null,
      // D31 (0009): the CLI's default model and effort, no models reported yet.
      model: null,
      effort: null,
      modelOptions: null,
      // D33 (0010): open.
      closedAt: null,
      // D38 (0011): no worktree branch.
      branch: null,
      // D40 (0012): no branching.
      branching: null,
      context: null,
      // D48 P4 (0017): not a hooked terminal session.
      hooked: false,
      transcriptPath: null,
      provider: 'claude',
      profileId: null,
      profilePinned: false,
      // D65 (0025): not taken over.
      movedTo: null,
      movedFrom: null,
      // D76 (0032): not a todo's run session.
      todoLink: null,
    });
    expect(await store.sessions.get(created.id)).toEqual(created);
  });

  it('stores every NewSession field and the M0 fields', async () => {
    const created = await store.sessions.create({
      id: 's-1',
      name: 'qa-free-talk',
      task: 'Write E2E tests.',
      claudeSessionId: 'c9d4118a-0000-4000-8000-000000000000',
      status: 'run',
      workType: 'qa',
      mode: 'orchestrator',
      phase: 'ui-first',
      coordination: null,
      qaStack: 'both',
      qaConfluenceUrl: 'https://example.atlassian.net/wiki/x',
      qaFigmaUrls: ['https://figma.com/a', 'https://figma.com/b'],
      solutions: ['acme-app-front', 'mobile'],
      worktrees: true,
      ultracode: true,
      cwd: '/tmp/workspace',
      pid: 4242,
      requestedPermissionMode: 'acceptEdits',
      observedPermissionMode: 'acceptEdits',
      cliVersion: '2.1.283',
      lastTranscriptUuid: 'u-1',
    });
    expect(created).toMatchObject({ id: 's-1', workType: 'qa', qaStack: 'both', solutions: ['acme-app-front', 'mobile'], worktrees: true, ultracode: true, pid: 4242 });
    expect(await store.sessions.getByName('qa-free-talk')).toEqual(created);
    expect(await store.sessions.getByClaudeSessionId('c9d4118a-0000-4000-8000-000000000000')).toEqual(created);
    expect(await store.sessions.getByName('nope')).toBeNull();
  });

  it('update changes only the given fields and bumps updatedAt', async () => {
    const created = await session();
    const later = tick();
    const updated = await store.sessions.update(created.id, { status: 'paused', attached: false, pid: null, detachedAt: later });
    expect(updated).toEqual({ ...created, status: 'paused', attached: false, detachedAt: later, updatedAt: later });
    expect(await store.sessions.update('missing', { status: 'run' })).toBeNull();
  });

  it('list is newest first and filters by status', async () => {
    const a = await session('a');
    tick();
    const b = await store.sessions.create({ name: 'b', claudeSessionId: 'cb', status: 'need' });
    expect((await store.sessions.list()).map((s) => s.id)).toEqual([b.id, a.id]);
    expect((await store.sessions.list({ statuses: ['need', 'run'] })).map((s) => s.id)).toEqual([b.id]);
    expect(await store.sessions.list({ statuses: [] })).toEqual([]);
  });

  it('D33: list filters by closed state (open only, closed only), with the status filter too', async () => {
    const a = await session('a');
    tick();
    const b = await store.sessions.create({ name: 'b', claudeSessionId: 'cb', status: 'paused' });
    tick();
    const c = await store.sessions.create({ name: 'c', claudeSessionId: 'cc', status: 'need' });
    await store.sessions.update(b.id, { closedAt: T0 });
    expect((await store.sessions.list()).map((s) => s.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.sessions.list({ closed: false })).map((s) => s.id)).toEqual([c.id, a.id]);
    expect((await store.sessions.list({ closed: true })).map((s) => s.id)).toEqual([b.id]);
    expect((await store.sessions.list({ closed: false, statuses: ['need', 'paused'] })).map((s) => s.id)).toEqual([c.id]);
    expect((await store.sessions.update(b.id, { closedAt: null }))?.closedAt).toBeNull();
    expect((await store.sessions.list({ closed: true })).map((s) => s.id)).toEqual([]);
  });

  it('rejects duplicate names / claude ids and values outside the locked enums', async () => {
    await session('dup', 'c-dup');
    await expect(store.sessions.create({ name: 'dup', claudeSessionId: 'other' })).rejects.toThrow(/UNIQUE/);
    await expect(store.sessions.create({ name: 'other', claudeSessionId: 'c-dup' })).rejects.toThrow(/UNIQUE/);
    await expect(store.sessions.create({ name: 'x', claudeSessionId: 'x', status: 'running' as never })).rejects.toThrow(/CHECK/);
    await expect(store.sessions.create({ name: 'y', claudeSessionId: 'y', mode: 'solo' as never })).rejects.toThrow(/CHECK/);
    await expect(store.sessions.create({ name: 'z', claudeSessionId: 'z', solutions: 'mobile' as never })).rejects.toThrow(/CHECK/);
    await expect(store.sessions.create({ name: 'p', claudeSessionId: 'p', pid: '42' as never })).rejects.toThrow(StoreError);
    await expect(store.sessions.create({ name: 'q', claudeSessionId: 'q', ultracode: 1 as never })).rejects.toThrow(StoreError);
  });

  it('delete cascades to the session-owned rows and detaches the shared ones', async () => {
    const s = await session();
    const agent = await store.agents.create({ sessionId: s.id, name: 'orchestrator', kind: 'main' });
    await store.events.append({ sessionId: s.id, kind: 'text', agentId: agent.id });
    await store.questions.createBatch({ id: 'req-1', sessionId: s.id, input: { questions: [] } }, [
      { source: 'orchestrator', text: 'Q?', options: [{ label: 'A' }] },
    ]);
    await store.permissions.create({ sessionId: s.id, requestId: 'req-2', toolName: 'Bash', input: { command: 'ls' } });
    await store.loops.create({ sessionId: s.id, kind: '/loop' });
    await store.pendingMessages.enqueue({ sessionId: s.id, kind: 'restart-note', text: 'Switchboard restarted.' });
    const worktree = await store.worktrees.create({ repo: 'mobile', repoPath: '/w/mobile', branch: 'session/free-talk', path: '/w/mobile-wt-free-talk', sessionId: s.id });
    const artifact = await store.artifacts.create({ type: 'DOC', name: 'notes.md', sessionId: s.id });
    const item = await store.systemItems.create({ kind: 'worktree-removable', source: 'worktrees', title: 't', sessionId: s.id });
    const reading = await store.usage.add({ source: 'get_usage', sessionId: s.id, fiveHourPct: 8 });

    expect(await store.sessions.delete(s.id)).toBe(true);
    expect(await store.sessions.delete(s.id)).toBe(false);
    const count = (table: string) => Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
    for (const table of ['agents', 'events', 'question_batches', 'questions', 'permission_requests', 'loops', 'pending_messages']) {
      expect(count(table), table).toBe(0);
    }
    expect((await store.worktrees.get(worktree.id))?.sessionId).toBeNull();
    expect((await store.artifacts.get(artifact.id))?.sessionId).toBeNull();
    expect((await store.systemItems.get(item.id))?.sessionId).toBeNull();
    expect((await store.usage.latest())?.id).toBe(reading.id);
    expect((await store.usage.latest())?.sessionId).toBeNull();
  });

  it('refuses rows that point at a missing session', async () => {
    await expect(store.agents.create({ sessionId: 'missing', name: 'x' })).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('agents', () => {
  it('CRUD + lookups by tool_use id and task id', async () => {
    const s = await session();
    const main = await store.agents.create({ sessionId: s.id, name: 'main', kind: 'main', status: 'run' });
    tick();
    const sub = await store.agents.create({
      sessionId: s.id,
      name: 'web',
      description: 'FreeTalkPage @360',
      solutionPath: 'microfrontends/acme-app-front',
      branch: 'feature/free-talk-360',
      toolUseId: 'toolu_1',
      taskId: 'task_1',
      subagentType: 'general-purpose',
    });
    expect(sub).toMatchObject({ kind: 'subagent', status: 'run', statusText: null, endedAt: null });
    expect(await store.agents.listBySession(s.id)).toEqual([main, sub]);
    expect(await store.agents.findByToolUseId(s.id, 'toolu_1')).toEqual(sub);
    expect(await store.agents.findByTaskId(s.id, 'task_1')).toEqual(sub);
    expect(await store.agents.findByToolUseId(s.id, 'toolu_x')).toBeNull();
    await expect(store.agents.create({ sessionId: s.id, name: 'again', toolUseId: 'toolu_1' })).rejects.toThrow(/UNIQUE/);

    const ended = tick();
    expect(await store.agents.update(sub.id, { status: 'done', statusText: 'returned', endedAt: ended })).toMatchObject({
      status: 'done',
      statusText: 'returned',
      endedAt: ended,
      updatedAt: ended,
    });
    expect(await store.agents.delete(main.id)).toBe(true);
    expect(await store.agents.get(main.id)).toBeNull();
  });
});

describe('events', () => {
  it('append / list / latest / pairing lookups', async () => {
    const s = await session();
    const e1 = await store.events.append({ sessionId: s.id, kind: 'text', label: 'hello', payload: { role: 'user', text: 'hi' }, uuid: 'u1' });
    expect(e1).toEqual({
      id: expect.any(Number),
      sessionId: s.id,
      agentId: null,
      ts: T0,
      endTs: null,
      kind: 'text',
      label: 'hello',
      payload: { role: 'user', text: 'hi' },
      uuid: 'u1',
      messageId: null,
      toolUseId: null,
    });
    const t1 = tick();
    const e2 = await store.events.append({ sessionId: s.id, kind: 'tool', label: 'Read', toolUseId: 'toolu_1', messageId: 'msg_1' });
    const t2 = tick();
    const e3 = await store.events.append({ sessionId: s.id, kind: 'ok', ts: t2 });
    expect(e2.id).toBeGreaterThan(e1.id);
    expect(e3.id).toBeGreaterThan(e2.id);

    expect((await store.events.list(s.id)).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
    expect((await store.events.list(s.id, { sinceTs: T0 })).map((e) => e.id)).toEqual([e2.id, e3.id]);
    expect((await store.events.list(s.id, { afterId: e2.id })).map((e) => e.id)).toEqual([e3.id]);
    expect((await store.events.list(s.id, { limit: 2 })).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect((await store.events.latest(s.id, 2)).map((e) => e.id)).toEqual([e2.id, e3.id]);

    expect(await store.events.findByToolUseId(s.id, 'toolu_1')).toEqual(e2);
    expect(await store.events.hasUuid(s.id, 'u1')).toBe(true);
    expect(await store.events.hasUuid(s.id, 'u2')).toBe(false);

    const paired = await store.events.update(e2.id, { endTs: t2, payload: { result: 'ok' } });
    expect(paired).toEqual({ ...e2, endTs: t2, payload: { result: 'ok' } });
    expect(e2.ts).toBe(t1);
    expect(await store.events.get(e2.id)).toEqual(paired);
  });

  it('rejects a kind outside the locked list', async () => {
    const s = await session();
    await expect(store.events.append({ sessionId: s.id, kind: 'note' as never })).rejects.toThrow(/CHECK/);
  });
});

describe('questions', () => {
  const input = {
    questions: [
      { question: 'Wrap or scroll?', header: 'Chips', options: [{ label: 'Wrap', description: 'as Figma' }, { label: 'Scroll', description: 'horizontal' }], multiSelect: false },
      { question: 'Which size?', header: 'Size', options: [{ label: 'Default', description: '' }, { label: 'Compact', description: '' }], multiSelect: true },
    ],
  };

  async function batch(sessionId: string, id = 'req-ask') {
    return store.questions.createBatch(
      { id, sessionId, toolUseId: 'toolu_ask', input },
      input.questions.map((q) => ({ source: 'main', text: q.question, header: q.header, options: q.options, multiSelect: q.multiSelect })),
    );
  }

  it('createBatch stores the batch and its questions verbatim, in order', async () => {
    const s = await session();
    const { batch: stored, questions } = await batch(s.id);
    expect(stored).toEqual({
      id: 'req-ask',
      sessionId: s.id,
      toolUseId: 'toolu_ask',
      input,
      state: 'open',
      createdAt: T0,
      answeredAt: null,
      staleAt: null,
      deliveredVia: null,
      deliveredAt: null,
      // D24 (0007): answered on the phone first.
      answeredOn: null,
      // D33 (0010): closed with its session.
      closedReason: null,
    });
    expect(questions.map((q) => [q.position, q.text, q.header, q.options, q.multiSelect, q.answerIndex])).toEqual([
      [0, 'Wrap or scroll?', 'Chips', input.questions[0]?.options, false, null],
      [1, 'Which size?', 'Size', input.questions[1]?.options, true, null],
    ]);
    expect(await store.questions.getBatchWithQuestions('req-ask')).toEqual({ batch: stored, questions });
    expect(await store.questions.questionsOf('req-ask')).toEqual(questions);
    expect(await store.questions.getQuestion(questions[0]!.id)).toEqual(questions[0]);
    expect(await store.questions.listBatches({ sessionId: s.id, states: ['open'] })).toEqual([stored]);
    expect(await store.questions.listBatches({ states: ['stale'] })).toEqual([]);
  });

  it('D33: closeUnanswered closes a waiting batch without answers (open → stale + label, stale keeps its staleAt); answered or closed ones are left alone', async () => {
    const s = await session();
    await batch(s.id);
    const t1 = tick();
    expect(await store.questions.closeUnanswered('req-ask', 'session closed')).toMatchObject({ state: 'stale', staleAt: t1, answeredAt: null, closedReason: 'session closed' });
    tick();
    expect(await store.questions.closeUnanswered('req-ask', 'other')).toMatchObject({ staleAt: t1, closedReason: 'session closed' });
    const stale = await store.questions.createBatch({ id: 'req-stale', sessionId: s.id, input }, [{ source: 'main', text: 'a', options: [{ label: 'x' }] }]);
    const t2 = tick();
    await store.questions.markStale('req-stale');
    tick();
    expect(await store.questions.closeUnanswered('req-stale', 'session closed')).toMatchObject({ state: 'stale', staleAt: t2, closedReason: 'session closed' });
    const answered = await store.questions.createBatch({ id: 'req-done', sessionId: s.id, input }, [{ source: 'main', text: 'b', options: [{ label: 'y' }] }]);
    await store.questions.answer('req-done', [{ questionId: answered.questions[0]!.id, answerIndex: 0 }]);
    expect(await store.questions.closeUnanswered('req-done', 'session closed')).toMatchObject({ state: 'answered', closedReason: null });
    expect(stale.batch.closedReason).toBeNull();
    expect(await store.questions.closeUnanswered('missing', 'session closed')).toBeNull();
  });

  it('createBatch is atomic', async () => {
    const s = await session();
    await expect(
      store.questions.createBatch({ id: 'req-bad', sessionId: s.id, input }, [
        { id: 'q-same', source: 'main', text: 'a', options: [] },
        { id: 'q-same', source: 'main', text: 'b', options: [] },
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await store.questions.getBatch('req-bad')).toBeNull();
  });

  it('answer records index + label; the batch is answered once every question is', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    const [q0, q1] = questions;
    const t1 = tick();
    const partial = await store.questions.answer('req-ask', [{ questionId: q0!.id, answerIndex: 1 }]);
    expect(partial.batch).toMatchObject({ state: 'open', answeredAt: null });
    expect(partial.questions[0]).toMatchObject({ answerIndex: 1, answerLabel: 'Scroll', answeredAt: t1 });

    const t2 = tick();
    const done = await store.questions.answer('req-ask', [{ questionId: q1!.id, answerIndex: 0 }]);
    expect(done.batch).toMatchObject({ state: 'answered', answeredAt: t2 });
    expect(done.questions.map((q) => q.answerLabel)).toEqual(['Scroll', 'Default']);

    await expect(store.questions.answer('req-ask', [{ questionId: q0!.id, answerIndex: 0 }])).rejects.toMatchObject({ code: 'conflict' });
    const delivered = await store.questions.markDelivered('req-ask', 'control_response');
    expect(delivered).toMatchObject({ deliveredVia: 'control_response', deliveredAt: t2 });
  });

  it('D39: an own answer is stored as the label with no index, completes the batch like an option and survives a reopen', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    const [q0, q1] = questions;
    const text = 'Neither: wrap on phones,\nscroll from 768 up';
    const t1 = tick();
    const partial = await store.questions.answer('req-ask', [{ questionId: q0!.id, text }]);
    expect(partial.batch).toMatchObject({ state: 'open', answeredAt: null });
    expect(partial.questions[0]).toMatchObject({ answerIndex: null, answerLabel: text, answeredAt: t1 });
    expect(ownAnswerOf(partial.questions[0]!)).toBe(text);
    expect(ownAnswerOf(partial.questions[1]!)).toBeNull();

    const t2 = tick();
    const done = await store.questions.answer('req-ask', [{ questionId: q1!.id, answerIndex: 0 }]);
    expect(done.batch).toMatchObject({ state: 'answered', answeredAt: t2 });
    expect(done.questions.map((q) => [q.answerIndex, q.answerLabel, ownAnswerOf(q)])).toEqual([
      [null, text, text],
      [0, 'Default', null],
    ]);

    // Persisted: a fresh store on the same file reads the same answers.
    await store.close();
    store = await openTempStore(tmp, { now: () => clock });
    const reread = await store.questions.questionsOf('req-ask');
    expect(reread.map((q) => [q.answerIndex, q.answerLabel, q.answeredAt])).toEqual([
      [null, text, t1],
      [0, 'Default', t2],
    ]);
    expect(await store.questions.getBatch('req-ask')).toMatchObject({ state: 'answered', answeredAt: t2 });
  });

  it('D39: an empty own answer is refused and nothing is written', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    await expect(store.questions.answer('req-ask', [{ questionId: questions[0]!.id, text: '  ' }])).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.questions.questionsOf('req-ask')).every((q) => q.answeredAt === null && q.answerLabel === null)).toBe(true);
  });

  it('answer refuses unknown batches, foreign questions and out-of-range indexes', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    const other = await batch(s.id, 'req-other');
    await expect(store.questions.answer('missing', [])).rejects.toMatchObject({ code: 'not-found' });
    await expect(store.questions.answer('req-ask', [{ questionId: other.questions[0]!.id, answerIndex: 0 }])).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.questions.answer('req-ask', [{ questionId: questions[0]!.id, answerIndex: 2 }])).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.questions.answer('req-ask', [{ questionId: questions[0]!.id, answerIndex: -1 }])).rejects.toBeInstanceOf(StoreError);
    // Nothing was written by the refused calls.
    expect((await store.questions.questionsOf('req-ask')).every((q) => q.answerIndex === null)).toBe(true);
  });

  it('a stale batch stays stale when answered later, with answeredAt set and nothing delivered', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    const staleAt = tick();
    expect(await store.questions.markStale('req-ask')).toMatchObject({ state: 'stale', staleAt });
    expect(await store.questions.markStale('req-ask')).toMatchObject({ state: 'stale', staleAt });
    expect(await store.questions.markStale('missing')).toBeNull();
    const answeredAt = tick();
    const result = await store.questions.answer(
      'req-ask',
      questions.map((q) => ({ questionId: q.id, answerIndex: 0 })),
    );
    expect(result.batch).toMatchObject({ state: 'stale', answeredAt, deliveredAt: null });
    expect(await store.questions.listBatches({ states: ['stale'] })).toHaveLength(1);
  });

  it('an answered batch is not made stale', async () => {
    const s = await session();
    const { questions } = await batch(s.id);
    await store.questions.answer('req-ask', questions.map((q) => ({ questionId: q.id, answerIndex: 0 })));
    expect(await store.questions.markStale('req-ask')).toMatchObject({ state: 'answered', staleAt: null });
  });
});

describe('permission requests', () => {
  it('create / lookups / decide / stale', async () => {
    const s = await session();
    const request = await store.permissions.create({
      sessionId: s.id,
      requestId: 'req-perm',
      toolUseId: 'toolu_bash',
      toolName: 'Bash',
      input: { command: 'rm -rf build', description: 'clean' },
      description: 'Remove the build folder',
      decisionReason: 'not in allow rules',
      agentId: 'task_1',
    });
    expect(request).toMatchObject({ state: 'open', decision: null, decidedAt: null, staleAt: null, createdAt: T0 });
    expect(request.input).toEqual({ command: 'rm -rf build', description: 'clean' });
    expect(await store.permissions.getByRequestId(s.id, 'req-perm')).toEqual(request);
    expect(await store.permissions.list({ states: ['open'] })).toEqual([request]);
    await expect(store.permissions.create({ sessionId: s.id, requestId: 'req-perm', toolName: 'Bash', input: {} })).rejects.toThrow(/UNIQUE/);

    const decidedAt = tick();
    expect(await store.permissions.decide(request.id, 'allow-once')).toMatchObject({ state: 'decided', decision: 'allow-once', decidedAt });
    await expect(store.permissions.decide(request.id, 'deny')).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.permissions.decide('missing', 'deny')).rejects.toMatchObject({ code: 'not-found' });
    expect(await store.permissions.markStale(request.id)).toMatchObject({ state: 'decided' });

    const second = await store.permissions.create({ sessionId: s.id, requestId: 'req-2', toolName: 'Write', input: { file_path: 'a' } });
    const staleAt = tick();
    expect(await store.permissions.markStale(second.id)).toMatchObject({ state: 'stale', staleAt, decision: null });
    await expect(store.permissions.decide(second.id, 'allow-once')).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.permissions.list({ sessionId: s.id })).map((p) => p.id)).toEqual([request.id, second.id]);
    expect(await store.permissions.list({ states: ['open'] })).toEqual([]);
  });
});

describe('system items', () => {
  it('create / list / update / close', async () => {
    const schedule = await store.schedules.create({ name: 'nightly', cron: '0 2 * * *', template: { task: 'build' } });
    const run = await store.schedules.addRun({ scheduleId: schedule.id, result: 'fail' });
    const item = await store.systemItems.create({
      kind: 'schedule-run-failed',
      source: 'nightly',
      status: 'fail',
      title: 'Android build failed',
      detail: 'details',
      branches: [{ solution: 'mobile', branch: 'main' }],
      actions: [
        { id: 'open-fix-session', label: 'Open fix session' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
      scheduleId: schedule.id,
      scheduleRunId: run.id,
    });
    expect(item).toMatchObject({ state: 'open', closedAction: null, closedAt: null, payload: null, worktreeId: null });
    expect(item.actions[0]).toEqual({ id: 'open-fix-session', label: 'Open fix session' });
    tick();
    const newer = await store.systemItems.create({ kind: 'worktree-removable', source: 'worktrees', title: 'PR merged' });
    expect(newer.status).toBe('need');
    expect((await store.systemItems.list(['open'])).map((i) => i.id)).toEqual([newer.id, item.id]);
    expect(await store.systemItems.update(newer.id, { detail: 'no changes' })).toMatchObject({ detail: 'no changes' });

    const closedAt = tick();
    expect(await store.systemItems.close(item.id, 'dismiss')).toMatchObject({ state: 'closed', closedAction: 'dismiss', closedAt });
    await expect(store.systemItems.close(item.id, 'dismiss')).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.systemItems.close('missing', 'dismiss')).rejects.toMatchObject({ code: 'not-found' });
    expect((await store.systemItems.list(['open'])).map((i) => i.id)).toEqual([newer.id]);
    expect(await store.systemItems.list()).toHaveLength(2);
  });
});

describe('worktrees', () => {
  it('create / live lookups / update / remove, and a path can be reused after removal', async () => {
    const s = await session();
    const wt = await store.worktrees.create({
      repo: 'acme-app-front',
      repoPath: '/w/microfrontends/acme-app-front',
      branch: 'session/free-talk',
      baseRef: 'main',
      path: '/w/microfrontends/acme-app-front-wt-free-talk',
      sessionId: s.id,
    });
    expect(wt).toMatchObject({ removable: false, prNumber: null, prState: null, removedAt: null });
    expect(await store.worktrees.getLiveByPath(wt.path)).toEqual(wt);
    await expect(store.worktrees.create({ repo: 'x', repoPath: '/x', branch: 'b', path: wt.path })).rejects.toThrow(/UNIQUE/);
    expect(await store.worktrees.list({ sessionId: s.id })).toEqual([wt]);
    expect(await store.worktrees.list({ repo: 'mobile' })).toEqual([]);

    const checked = tick();
    const merged = await store.worktrees.update(wt.id, { prNumber: 231, prUrl: 'https://github.com/o/r/pull/231', prState: 'MERGED', prCheckedAt: checked, removable: true });
    expect(merged).toMatchObject({ prNumber: 231, prState: 'MERGED', removable: true, updatedAt: checked });

    const removedAt = tick();
    expect(await store.worktrees.markRemoved(wt.id)).toMatchObject({ removedAt, removable: false });
    expect(await store.worktrees.list()).toEqual([]);
    expect(await store.worktrees.list({ includeRemoved: true })).toHaveLength(1);
    expect(await store.worktrees.getLiveByPath(wt.path)).toBeNull();
    const again = await store.worktrees.create({ repo: 'acme-app-front', repoPath: wt.repoPath, branch: 'session/free-talk-2', path: wt.path });
    expect(await store.worktrees.getLiveByPath(wt.path)).toEqual(again);
  });
});

describe('artifacts', () => {
  it('create / upsert / list with filters and search / delete', async () => {
    const s = await session();
    const contract = await store.artifacts.create({ type: 'CONTRACT', name: 'contracts/free-talk.md', meta: 'locked', sessionId: s.id, path: 'contracts/free-talk.md' });
    tick();
    const pr = await store.artifacts.upsert({ id: 'pr-88', type: 'PR', name: 'notifications-microservice #88', solution: 'notifications-microservice', branch: 'feature/push-prefs', meta: 'open', url: 'https://github.com/o/r/pull/88' });
    const later = tick();
    const prMerged = await store.artifacts.upsert({ id: 'pr-88', type: 'PR', name: 'notifications-microservice #88', meta: 'merged', data: { number: 88 } });
    expect(prMerged).toEqual({ ...pr, meta: 'merged', data: { number: 88 }, updatedAt: later });
    tick();
    const diff = await store.artifacts.create({ type: 'DIFF', name: '100%_done · 6 files', solution: 'acme-app-front', branch: 'feature/free-talk-360', meta: '+284 −12', sessionId: s.id });

    expect((await store.artifacts.list()).map((a) => a.id)).toEqual([diff.id, 'pr-88', contract.id]);
    expect((await store.artifacts.list({ types: ['PR', 'BRANCH'] })).map((a) => a.id)).toEqual(['pr-88']);
    expect(await store.artifacts.list({ types: [] })).toEqual([]);
    expect((await store.artifacts.list({ sessionId: s.id })).map((a) => a.id)).toEqual([diff.id, contract.id]);
    expect((await store.artifacts.list({ q: 'FREE-TALK' })).map((a) => a.id)).toEqual([diff.id, contract.id]);
    expect((await store.artifacts.list({ q: 'push-prefs' })).map((a) => a.id)).toEqual(['pr-88']);
    expect((await store.artifacts.list({ q: '100%' })).map((a) => a.id)).toEqual([diff.id]);
    expect(await store.artifacts.list({ q: '_x%' })).toEqual([]);
    expect((await store.artifacts.update(contract.id, { meta: 'changed' }))?.meta).toBe('changed');
    expect(await store.artifacts.delete(contract.id)).toBe(true);
    expect(await store.artifacts.get(contract.id)).toBeNull();
    await expect(store.artifacts.create({ type: 'NOTE' as never, name: 'x' })).rejects.toThrow(/CHECK/);
  });
});

describe('schedules', () => {
  it('create / update / runs strip / delete cascades runs', async () => {
    const template = { name: 'nightly-build-verify', task: 'Build web + mobile on main', workType: 'feature', mode: 'orchestrator', solutions: ['mobile'] };
    const schedule = await store.schedules.create({ name: 'nightly-build-verify', description: 'Build web + mobile', cron: '0 2 * * *', template });
    expect(schedule).toMatchObject({ paused: false, template, createdAt: T0 });
    expect(await store.schedules.getByName('nightly-build-verify')).toEqual(schedule);
    await expect(store.schedules.create({ name: 'nightly-build-verify', cron: '* * * * *', template: {} })).rejects.toThrow(/UNIQUE/);
    const pausedAt = tick();
    expect(await store.schedules.update(schedule.id, { paused: true })).toMatchObject({ paused: true, updatedAt: pausedAt });
    expect(await store.schedules.list()).toHaveLength(1);

    const s = await session();
    const runs = [];
    for (let i = 0; i < 16; i += 1) {
      tick(60_000);
      runs.push(await store.schedules.addRun({ scheduleId: schedule.id, result: i === 15 ? 'running' : 'ok', triggeredBy: i === 15 ? 'manual' : 'cron' }));
    }
    const last = runs.at(-1)!;
    expect(last).toMatchObject({ result: 'running', triggeredBy: 'manual', finishedAt: null, summary: null });
    const finished = tick();
    expect(await store.schedules.updateRun(last.id, { result: 'fail', finishedAt: finished, summary: 'Failed · Android XamlC', sessionId: s.id })).toMatchObject({
      result: 'fail',
      finishedAt: finished,
      sessionId: s.id,
    });
    const strip = await store.schedules.recentRuns(schedule.id);
    expect(strip).toHaveLength(14);
    expect(strip.map((r) => r.id)).toEqual(runs.slice(2).map((r) => r.id));
    expect(strip.at(-1)?.result).toBe('fail');
    expect(await store.schedules.getRun(runs[0]!.id)).toEqual(runs[0]);

    expect(await store.schedules.delete(schedule.id)).toBe(true);
    expect(await store.schedules.getRun(runs[0]!.id)).toBeNull();
  });
});

describe('loops', () => {
  it('create keeps unknown values null (D9) / update / list / delete', async () => {
    const s = await session();
    const loop = await store.loops.create({ sessionId: s.id, kind: '/loop', label: '/loop 1h · Plan-Act-Verify', iteration: 17, nextFireAt: '2026-09-28T15:00:00.000Z', expiresAt: '2026-10-04T00:00:00.000Z' });
    expect(loop).toMatchObject({ cap: null, breakerCount: null, breakerState: null, progressPath: null, iterations: [] });
    const updated = await store.loops.update(loop.id, { iteration: 18, cap: 12, breakerCount: 2, breakerState: 'tripped', iterations: ['ok', 'ok', 'fail'], progressPath: '/w/.loop/progress.md' });
    expect(updated).toMatchObject({ iteration: 18, cap: 12, breakerCount: 2, iterations: ['ok', 'ok', 'fail'] });
    expect(await store.loops.list(s.id)).toEqual([updated]);
    expect(await store.loops.list()).toEqual([updated]);
    expect(await store.loops.delete(loop.id)).toBe(true);
    expect(await store.loops.get(loop.id)).toBeNull();
  });
});

describe('tools', () => {
  it('a fresh database has the default tools (0002_default_tools.sql, M8.1)', async () => {
    expect((await store.tools.list()).map((t) => [t.id, t.name, t.url, t.description, t.showInSidebar, t.position])).toEqual([
      ['cm', 'Codebase Memory', 'http://localhost:13000', 'code graph for your indexed solutions', true, 0],
      ['sw', 'Acme Tool', null, 'AI chat connected to other tools', true, 1],
    ]);
  });

  it('CRUD and replaceAll (PUT /api/tools)', async () => {
    await store.tools.replaceAll([]); // start without the default tools
    const cm = await store.tools.create({ id: 'cm', name: 'Codebase Memory', url: 'http://localhost:13000', description: 'code graph', position: 0 });
    const sw = await store.tools.create({ id: 'sw', name: 'Acme Tool', position: 1 });
    expect(sw).toMatchObject({ url: null, showInSidebar: true, description: null });
    expect(await store.tools.list()).toEqual([cm, sw]);
    const t1 = tick();
    expect(await store.tools.update('sw', { url: 'http://127.0.0.1:9000' })).toMatchObject({ url: 'http://127.0.0.1:9000', updatedAt: t1 });

    const t2 = tick();
    const replaced = await store.tools.replaceAll([
      { id: 'new', name: 'Grafana', url: 'http://localhost:3000' },
      { id: 'cm', name: 'Codebase Memory', url: 'http://localhost:13001', showInSidebar: false },
    ]);
    expect(replaced.map((t) => [t.id, t.position, t.url, t.showInSidebar])).toEqual([
      ['new', 0, 'http://localhost:3000', true],
      ['cm', 1, 'http://localhost:13001', false],
    ]);
    expect(replaced[1]).toMatchObject({ createdAt: T0, updatedAt: t2 });
    expect(await store.tools.get('sw')).toBeNull();
    expect(await store.tools.replaceAll([])).toEqual([]);
    expect(await store.tools.delete('cm')).toBe(false);
  });
});

describe('settings', () => {
  it('get / set / setMany / getAll / delete with JSON values', async () => {
    expect(await store.settings.get('usage.warnAtPct')).toBeUndefined();
    await store.settings.set('usage.warnAtPct', 90);
    await store.settings.set('notifications.sound', true);
    await store.settings.set('workspace.root', null);
    expect(await store.settings.get('usage.warnAtPct')).toBe(90);
    expect(await store.settings.get('workspace.root')).toBeNull();
    await store.settings.setMany({ 'usage.warnAtPct': 80, 'setup.completed': { at: T0, steps: [1, 2, 3, 4, 5] } });
    expect(await store.settings.getAll()).toEqual({
      'notifications.sound': true,
      'setup.completed': { at: T0, steps: [1, 2, 3, 4, 5] },
      'usage.warnAtPct': 80,
      'workspace.root': null,
    });
    expect(await store.settings.delete('notifications.sound')).toBe(true);
    expect(await store.settings.get('notifications.sound')).toBeUndefined();
    await expect(store.settings.set('bad', undefined)).rejects.toThrow(TypeError);
  });
});

describe('usage readings', () => {
  it('add / latest / list / prune', async () => {
    expect(await store.usage.latest()).toBeNull();
    const first = await store.usage.add({ source: 'get_usage', fiveHourPct: 8, fiveHourResetsAt: '2026-09-28T05:00:00.000Z', sevenDayPct: 17, sevenDayResetsAt: '2026-10-01T00:00:00.000Z', raw: { rate_limits: {} } });
    const t1 = tick();
    const second = await store.usage.add({ source: 'rate_limit_event', fiveHourPct: 12.5, sevenDayPct: null });
    expect(second).toMatchObject({ receivedAt: t1, fiveHourPct: 12.5, sevenDayPct: null, raw: null });
    expect(await store.usage.latest()).toEqual(second);
    expect(await store.usage.list()).toEqual([first, second]);
    expect(await store.usage.list(T0)).toEqual([second]);
    expect(await store.usage.prune(t1)).toBe(1);
    expect(await store.usage.list()).toEqual([second]);
  });
});

describe('history cache', () => {
  it('upsert / getFresh by (size, mtime) / list / delete', async () => {
    const path = '/home/dev/.claude/projects/-w/abc.jsonl';
    const entry = await store.historyCache.upsert({ transcriptPath: path, claudeSessionId: 'abc', size: 1200, mtimeMs: 1790000000123.5, item: { name: 'x', summary: 'y' } });
    expect(entry).toEqual({ transcriptPath: path, claudeSessionId: 'abc', size: 1200, mtimeMs: 1790000000123.5, item: { name: 'x', summary: 'y' }, parsedAt: T0 });
    expect(await store.historyCache.getFresh(path, 1200, 1790000000123.5)).toEqual(entry);
    expect(await store.historyCache.getFresh(path, 1300, 1790000000123.5)).toBeNull();
    const t1 = tick();
    const hidden = await store.historyCache.upsert({ transcriptPath: path, claudeSessionId: 'abc', size: 1300, mtimeMs: 1790000000999, item: null });
    expect(hidden).toEqual({ transcriptPath: path, claudeSessionId: 'abc', size: 1300, mtimeMs: 1790000000999, item: null, parsedAt: t1 });
    expect(await store.historyCache.list()).toEqual([hidden]);
    expect(await store.historyCache.get(path)).toEqual(hidden);
    expect(await store.historyCache.delete(path)).toBe(true);
    expect(await store.historyCache.get(path)).toBeNull();
  });
});

describe('pending messages', () => {
  it('enqueue / pending / markDelivered', async () => {
    const s = await session();
    const { batch } = await store.questions.createBatch({ id: 'req-q', sessionId: s.id, input: {} }, []);
    const note = await store.pendingMessages.enqueue({ sessionId: s.id, kind: 'restart-note', text: 'Switchboard restarted. Continue.' });
    tick();
    const answers = await store.pendingMessages.enqueue({ sessionId: s.id, kind: 'stale-answers', text: '"Q?" = "A"', batchId: batch.id });
    expect(await store.pendingMessages.pending(s.id)).toEqual([note, answers]);
    const t = tick();
    expect(await store.pendingMessages.markDelivered(note.id)).toMatchObject({ deliveredAt: t });
    expect(await store.pendingMessages.pending(s.id)).toEqual([answers]);
  });
});
