import { describe, expect, it, vi } from 'vitest';
import type { InboxItem, Question, SystemInfo } from '../../src/core/api.ts';
import type { TeamNeedsYouItem } from '../../src/core/team.ts';
import { type QuestionPicks, answerBody } from '../../src/web/components/question-card.ts';
import { type BatchDraft, answeredDetailFromServer, batchAnswers, cardButtons, detailOf, questionAnswer } from '../../src/web/v2/shared/answer-model.ts';
import { createNeedsYouStore } from '../../src/web/v2/shared/needs-you-store.ts';
import { type NeedsItem, fromInbox, inboxKindOf, mergeNeedsYou } from '../../src/web/v2/shared/needs-you-model.ts';

/**
 * Fix after 2.0 · v2 answer options: every "needs you" kind offers what classic
 * offers. Inputs are shaped as `GET /api/inbox` sends them (`src/server/inbox/wire.ts`):
 * a question batch with headers, option descriptions and a multi-select question;
 * a permission request with the server's actions; a D124 "Waiting for you" item,
 * declared and detected.
 */

const AT = '2026-10-26T09:00:00.000Z';

function q(id: string, text: string, header: string, options: ReadonlyArray<readonly [string, string]>, multiSelect = false): Question {
  return { id, batchId: 'batch-1', sessionId: 'sess-1', source: 'acme-web-front', text, header, options: options.map(([label, description]) => ({ label, description })), multiSelect, state: 'open', answerIndex: null, answeredAt: null, answerIndexes: null, answerText: null };
}

const REGION = q('batch-1:0', 'Which Acme region should I deploy to?', 'Region', [
  ['EU', 'Acme EU (Frankfurt)'],
  ['US', 'Acme US (Virginia)'],
  ['Both', 'Both regions, EU first'],
]);
const PARTS = q('batch-1:1', 'Which parts should I update?', 'Parts', [
  ['Code', 'The source files'],
  ['Tests', 'Unit and E2E tests'],
  ['Docs', 'README and docs/'],
  ['Changelog', 'CHANGELOG.md'],
], true);

const BATCH: InboxItem = {
  id: 'batch-1',
  kind: 'questions',
  sessionId: 'sess-1',
  source: 'acme-agent',
  sourceTitle: 'Acme agent',
  status: 'need',
  title: '2 questions from acme-web-front',
  label: '2 questions',
  detail: 'I can ship the Acme checkout now.',
  createdAt: AT,
  branches: [],
  questions: [REGION, PARTS],
};
const SINGLE: InboxItem = { ...BATCH, id: 'batch-2', title: REGION.text, label: '1 question', questions: [{ ...REGION, id: 'batch-2:0', batchId: 'batch-2' }] };
const PERMISSION: InboxItem = {
  id: 'perm-1',
  kind: 'permission',
  sessionId: 'sess-1',
  source: 'acme-agent',
  sourceTitle: 'Acme agent',
  status: 'need',
  title: 'Bash',
  label: 'Permission',
  detail: 'Run the Acme deploy',
  createdAt: AT,
  branches: [],
  actions: [{ id: 'allow-once', label: 'Allow once' }, { id: 'always-allow', label: 'Always allow' }, { id: 'deny', label: 'Deny' }],
  permission: { requestId: 'r1', toolName: 'Bash', input: { command: 'npm run deploy:acme' }, description: 'Run the Acme deploy', decisionReason: null, agentId: null, agent: null },
};
const WAITING_ACTIONS = [{ id: 'open-session', label: 'Open session' }, { id: 'dismiss', label: 'Dismiss' }];
const DECLARED: InboxItem = { id: 'w-1', kind: 'system', systemKind: 'turn-waiting', sessionId: 'sess-1', source: 'Acme agent', status: 'need', title: 'Waiting for you: Acme agent', label: 'Waiting for you', detail: 'Pick the Acme region: EU or US', createdAt: AT, branches: [], actions: WAITING_ACTIONS };
const DETECTED: InboxItem = { ...DECLARED, id: 'w-2', label: 'Waiting for you · detected', detail: 'Which region should I use, Acme EU or Acme US?' };

const ids = (item: NeedsItem): string[] => cardButtons(item).map((button) => button.id);

describe('Fix after 2.0 · v2 answer options match classic', () => {
  it('a question batch keeps every question, option label and description (and is never an ask)', () => {
    expect(inboxKindOf(BATCH)).toBe('multi');
    expect(inboxKindOf(SINGLE)).toBe('question');
    const item = fromInbox(BATCH);
    expect(item.kind).toBe('multi');
    expect(item.questions).toEqual([REGION, PARTS]);
    expect(item.questions?.[1]?.options.map((o) => o.description)).toEqual(['The source files', 'Unit and E2E tests', 'README and docs/', 'CHANGELOG.md']);
    expect(fromInbox(SINGLE).title).toBe(REGION.text);
  });

  it('regression: options from a question batch are never replaced by Go ahead (or any generic button)', () => {
    for (const raw of [BATCH, SINGLE]) {
      const item = fromInbox(raw);
      expect(ids(item)).toEqual([]);
      expect(cardButtons(item).map((b) => b.label)).not.toContain('Go ahead');
    }
    // A crew's copy (the Inbox not read yet) and a paired computer's item keep the questions too.
    const crew: TeamNeedsYouItem = { id: 'batch-1', source: 'inbox', kind: 'questions', memberId: 'm-1', memberName: 'Acme reviewer', label: 'Acme reviewer · questions', title: BATCH.title, detail: '', createdAt: AT, sessionRef: 'sess-1', teamId: 't-1', teamName: 'Acme crew', inbox: BATCH };
    const viaCrew = mergeNeedsYou({ inbox: [], team: [crew], notes: {}, usage: [] });
    expect(viaCrew.map((i) => [i.key, i.kind, i.questions?.length])).toEqual([['inbox:batch-1', 'multi', 2]]);
    const peer = fromInbox({ ...BATCH, id: 'r~studio~batch-1', machine: { id: 'studio', name: 'Acme-PC', state: 'online' } });
    expect(peer.questions).toHaveLength(2);
    expect(ids(peer)).toEqual([]);
  });

  it('a permission request: Allow once / Always allow / Deny, as the server offers them', () => {
    expect(ids(fromInbox(PERMISSION))).toEqual(['allow-once', 'always-allow', 'deny']);
    expect(ids(fromInbox({ ...PERMISSION, actions: [{ id: 'allow-once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }))).toEqual(['allow-once', 'deny']);
  });

  it("an agent's ask (D124): its words, a reply box and Not waiting, as classic; no made-up Go ahead", () => {
    const declared = fromInbox(DECLARED);
    expect(declared).toMatchObject({ kind: 'ask', quote: 'Pick the Acme region: EU or US' });
    expect(declared.detected).toBeUndefined();
    expect(ids(declared)).toEqual(['not-waiting']);
    const detected = fromInbox(DETECTED);
    expect(detected).toMatchObject({ kind: 'ask', quote: DETECTED.detail, detected: true });
    expect(ids(detected)).toEqual(['not-waiting']);
  });

  it("answers go back in classic's shapes (the same body as classic's card for the same picks)", () => {
    const cases: ReadonlyArray<readonly [BatchDraft, QuestionPicks]> = [
      // One option each.
      [{ [REGION.id]: { index: 1 }, [PARTS.id]: { picks: [2] } }, { [REGION.id]: 1, [PARTS.id]: { indexes: [2], own: null } }],
      // Several options.
      [{ [REGION.id]: { index: 0 }, [PARTS.id]: { picks: [0, 3] } }, { [REGION.id]: 0, [PARTS.id]: { indexes: [0, 3], own: null } }],
      // Options + own words; own words alone.
      [{ [REGION.id]: { other: true, text: ' Acme APAC ' }, [PARTS.id]: { picks: [1], other: true, text: 'the Acme README' } }, { [REGION.id]: { text: ' Acme APAC ', editing: false }, [PARTS.id]: { indexes: [1], own: { text: 'the Acme README', editing: false } } }],
      [{ [REGION.id]: { index: 2 }, [PARTS.id]: { picks: [], other: true, text: 'only the changelog' } }, { [REGION.id]: 2, [PARTS.id]: { indexes: [], own: { text: 'only the changelog', editing: false } } }],
    ];
    for (const [draft, picks] of cases) expect(batchAnswers([REGION, PARTS], draft)).toEqual(answerBody([REGION, PARTS], picks)?.answers);
    expect(questionAnswer(PARTS, { picks: [3, 1] })).toEqual({ questionId: PARTS.id, answerIndexes: [1, 3] });
  });
});

/**
 * Fix after 2.4.12 · an answer's description stays a hover tooltip in v2: on every
 * option of the open card (the props `AnswerCard` reads), and on the answered line
 * once the card folds (classic's answered card keeps each option's `title`; v2's
 * line showed only the labels).
 */
describe('option descriptions as tooltips', () => {
  it('the card model keeps every option description verbatim (what the option `title` shows)', () => {
    const item = fromInbox(BATCH);
    expect(item.questions?.map((question) => question.options.map((option) => option.description))).toEqual([
      ['Acme EU (Frankfurt)', 'Acme US (Virginia)', 'Both regions, EU first'],
      ['The source files', 'Unit and E2E tests', 'README and docs/', 'CHANGELOG.md'],
    ]);
  });

  it("the answered line's tooltip: each chosen option's description, plain text, one per line", () => {
    const item = fromInbox(BATCH);
    const answers = [
      { questionId: REGION.id, answerIndex: 1 },
      { questionId: PARTS.id, answerIndexes: [0, 2], text: 'and the logs' },
    ];
    expect(detailOf(item, { type: 'questions', answers })).toBe('US: Acme US (Virginia)\nCode: The source files\nDocs: README and docs/');
    // Markdown in a description is stripped, as on the option's own tooltip.
    const md = { ...item, questions: [{ ...REGION, options: [{ label: 'EU', description: 'Uses **Frankfurt** via `eu-1`' }] }] };
    expect(detailOf(md, { type: 'questions', answers: [{ questionId: REGION.id, answerIndex: 0 }] })).toBe('EU: Uses Frankfurt via eu-1');
    // Nothing to show: own words only, options without descriptions, other kinds of answer.
    expect(detailOf(item, { type: 'questions', answers: [{ questionId: REGION.id, text: 'Asia' }] })).toBeUndefined();
    expect(detailOf({ questions: [{ ...REGION, options: [{ label: 'EU' }] }] }, { type: 'questions', answers: [{ questionId: REGION.id, answerIndex: 0 }] })).toBeUndefined();
    expect(detailOf(item, { type: 'permission', decision: 'allow-once' })).toBeUndefined();
  });

  it("the chat's answered row (the server's record) gets the same tooltip; none while a question is open", () => {
    const region = { ...REGION, state: 'answered' as const, answerIndex: 2, answeredAt: AT };
    const parts = { ...PARTS, state: 'answered' as const, answerIndex: 1, answerIndexes: [1, 3], answeredAt: AT };
    expect(answeredDetailFromServer([region, parts])).toBe('Both: Both regions, EU first\nTests: Unit and E2E tests\nChangelog: CHANGELOG.md');
    expect(answeredDetailFromServer([region, PARTS])).toBeUndefined();
    expect(answeredDetailFromServer([])).toBeUndefined();
  });

  it('the store keeps the tooltip with the answered line', async () => {
    vi.useFakeTimers();
    const store = createNeedsYouStore({
      inbox: async () => [SINGLE],
      team: async () => [],
      notes: async () => [],
      system: async () => ({}) as SystemInfo,
      send: async () => undefined,
      now: () => Date.parse(AT),
      storage: { getItem: () => null, setItem: () => undefined },
      undoMs: 5_000,
    });
    await store.reload();
    const item = store.getSnapshot().items.find((entry) => entry.key === 'inbox:batch-2') as NeedsItem;
    store.answer(item, { type: 'questions', answers: [{ questionId: 'batch-2:0', answerIndex: 0 }] }, 'needs');
    expect(store.getSnapshot().answered.get('inbox:batch-2')).toMatchObject({ summary: 'You answered “EU”', detail: 'EU: Acme EU (Frankfurt)' });
    store.undo('inbox:batch-2');
    vi.useRealTimers();
  });
});
