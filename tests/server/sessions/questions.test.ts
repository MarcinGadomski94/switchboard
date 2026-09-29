import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/db/store.ts';
import { sessionQuestions, toSessionDetail } from '../../../src/server/sessions/wire.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * M4.2: `SessionDetail.questions` (additive) carries every question batch of the
 * session, oldest first, in the contract's `Question` shape, so the chat can show
 * waiting batches inline and answered ones as the answers bubble (docs/chat.md).
 */

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await makeTempDir('session-questions');
  store = await openTempStore(tmp);
});

afterEach(async () => {
  await store.close();
  await removeTempDir(tmp);
});

async function batch(id: string, sessionId: string, createdAt: string, texts: string[]) {
  return store.questions.createBatch(
    { id, sessionId, input: { questions: texts.map((question) => ({ question, options: [{ label: 'Yes' }, { label: 'No' }] })) }, createdAt },
    texts.map((text) => ({ source: 'main', text, options: [{ label: 'Yes' }, { label: 'No' }] })),
  );
}

describe('sessionQuestions / SessionDetail.questions', () => {
  it('every batch of the session, oldest first, questions in order, with state and answers', async () => {
    const session = await store.sessions.create({ id: 's1', name: 'chat-questions', claudeSessionId: 'c1' });
    const other = await store.sessions.create({ id: 's2', name: 'other', claudeSessionId: 'c2' });
    await batch('b2', session.id, '2026-09-28T10:02:00.000Z', ['Third?']);
    const first = await batch('b1', session.id, '2026-09-28T10:01:00.000Z', ['First?', 'Second?']);
    await batch('bx', other.id, '2026-09-28T10:00:00.000Z', ['Elsewhere?']);
    await store.questions.answer('b1', first.questions.map((q, i) => ({ questionId: q.id, answerIndex: i })));

    const questions = await sessionQuestions(store, session.id);
    expect(questions.map((q) => [q.batchId, q.text, q.state, q.answerIndex, q.answeredAt === null])).toEqual([
      ['b1', 'First?', 'answered', 0, false],
      ['b1', 'Second?', 'answered', 1, false],
      ['b2', 'Third?', 'open', null, true],
    ]);
    expect(Object.keys(questions[0] ?? {}).sort()).toEqual(['answerIndex', 'answerText', 'answeredAt', 'answeredOn', 'batchId', 'closedReason', 'header', 'id', 'multiSelect', 'options', 'queued', 'sessionId', 'source', 'state', 'text']);

    const detail = await toSessionDetail(store, {}, session);
    expect(detail.questions).toEqual(questions);
    expect((await toSessionDetail(store, {}, (await store.sessions.get('s2'))!)).questions.map((q) => q.text)).toEqual(['Elsewhere?']);
  });

  it('a session without batches has none', async () => {
    const session = await store.sessions.create({ name: 'quiet', claudeSessionId: 'c3' });
    expect((await toSessionDetail(store, {}, session)).questions).toEqual([]);
  });
});
