import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, Question, SystemInfo } from '../../src/core/api.ts';
import type { MemoryEntry } from '../../src/core/memory.ts';
import type { TeamNeedsYouItem } from '../../src/core/team.ts';
import { batchAnswers, cardButtons, questionAnswer, questionReady, summaryOf, togglePick, answeredFromServer, isLinkAction } from '../../src/web/v2/shared/answer-model.ts';
import { commandOf, fromInbox, fromNote, inboxKindOf, memoryScopeOf, mergeNeedsYou, planIdOf, itemsOfSession, countByCrew, type NeedsItem } from '../../src/web/v2/shared/needs-you-model.ts';
import { NEEDS_KIND_LOOK } from '../../src/web/v2/glossary.ts';
import { DISMISSED_ALERTS_KEY, type NeedsYouDeps, createNeedsYouStore, usageAlerts } from '../../src/web/v2/shared/needs-you-store.ts';

const AT = '2026-10-25T12:00:00.000Z';
const LATER = '2026-10-25T12:05:00.000Z';

function question(id: string, options: string[], extra: Partial<Question> = {}): Question {
  return { id, batchId: 'b1', sessionId: 's1', source: 'acme-web-front', text: `Q ${id}?`, header: null, options: options.map((label) => ({ label })), multiSelect: false, state: 'open', answerIndex: null, answeredAt: null, ...extra };
}

function inbox(partial: Partial<InboxItem> & Pick<InboxItem, 'id' | 'kind'>): InboxItem {
  return { sessionId: 's1', source: 'asker', sourceTitle: 'Asker', status: 'need', title: 'Title', label: 'Label', detail: '', createdAt: AT, branches: [], ...partial };
}

const QUESTION = inbox({ id: 'b1', kind: 'questions', title: 'Which quarter?', label: 'Question', questions: [question('q1', ['Q2', 'Q3'])] });
const MULTI = inbox({ id: 'b2', kind: 'questions', title: 'Which pages?', label: 'Question', createdAt: LATER, questions: [question('q2', ['Checkout', 'Payments', 'Emails'], { multiSelect: true })] });
const PERMISSION = inbox({ id: 'p1', kind: 'permission', title: 'Bash', label: 'Permission', detail: 'Deploy', actions: [{ id: 'allow-once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }], permission: { requestId: 'r1', toolName: 'Bash', input: { command: 'npm run deploy:staging' }, description: 'Publish to staging', decisionReason: null, agentId: null, agent: null } });
const WAITING = inbox({ id: 'w1', kind: 'system', systemKind: 'turn-waiting', label: 'Waiting for you', title: 'Waiting for you: Reviewer', detail: 'Approve test plan?', actions: [{ id: 'open-session', label: 'Open session' }, { id: 'dismiss', label: 'Dismiss' }] });
const READY = inbox({ id: 'r1', kind: 'system', label: 'Ready to merge', title: 'PROJ-103 Emails ready', detail: 'Change request #47', route: '/plans/p100', actions: [{ id: 'plan-merge', label: 'Merge' }, { id: 'open-plan', label: 'Open plan' }] });
const STOPPED = inbox({ id: 'st1', kind: 'system', label: 'Stopped', title: 'Stopped: PROJ-109', detail: 'No API key', actions: [{ id: 'open-session', label: 'Open session' }, { id: 'dismiss', label: 'Dismiss' }] });
const ROUTINE = inbox({ id: 'rf1', kind: 'system', sessionId: null, source: 'Nightly check', label: 'Scheduled run failed', title: 'Nightly check failed', actions: [{ id: 'open-fix-session', label: 'Open fix session' }, { id: 'retry-run', label: 'Retry run' }, { id: 'dismiss', label: 'Dismiss' }] });
const PICK = inbox({ id: 'pk1', kind: 'system', label: 'Pick repositories', title: '2 items wait', route: '/plans/p100', actions: [{ id: 'plan-ask-repos', label: 'Ask again' }, { id: 'open-plan', label: 'Open plan' }, { id: 'dismiss', label: 'Dismiss' }] });
const MEMORY = inbox({ id: 'm1', kind: 'system', sessionId: null, label: 'Memory', title: '1 memory proposal', route: '/memory?scope=%2Fw%2Fcheckout', actions: [{ id: 'open-memory', label: 'Review' }, { id: 'dismiss', label: 'Dismiss' }] });
const UPDATE = inbox({ id: 'u1', kind: 'system', sessionId: null, label: 'Update available', title: 'Switchboard 2.0.1', actions: [{ id: 'whats-new', label: "What's new" }, { id: 'dismiss', label: 'Dismiss' }] });
const PEER = inbox({ id: 'r~studio~b9', kind: 'questions', machine: { id: 'studio', name: 'Studio-PC', state: 'online' }, questions: [question('q9', ['A', 'B'])] });

const CREW_INBOX: TeamNeedsYouItem = { id: 'w1', source: 'inbox', kind: 'system', memberId: 'm-rev', memberName: 'Reviewer/QA', label: 'Reviewer/QA · waiting', title: 'Waiting for you', detail: '', createdAt: AT, sessionRef: 's1', teamId: 't-core', teamName: 'Acme Core', inbox: WAITING };
const ACCESS: TeamNeedsYouItem = { id: 'req-a', source: 'team', kind: 'access', memberId: 'm-dev', memberName: 'Mobile developer', label: 'Mobile developer · access', title: 'Needs an API key for App Store Connect', detail: 'To upload test builds', createdAt: AT, sessionRef: 's7', teamId: 't-mob', teamName: 'Acme Mobile' };
const CHARTER: TeamNeedsYouItem = { id: 'req-c', source: 'team', kind: 'charter', memberId: 'm-des', memberName: 'Designer', label: 'Designer · charter', title: 'Charter', detail: 'notes', createdAt: AT, sessionRef: 's8', teamId: 't-mob', teamName: 'Acme Mobile', charter: { before: { owns: '', produces: '', neverDoes: '' }, after: { owns: 'the screens', produces: 'designs', neverDoes: 'never ships', howItWorks: 'Turns briefs into screens.' }, notes: 'notes' } };
const GATE: TeamNeedsYouItem = { id: 'req-g', source: 'team', kind: 'gate', memberId: 'm-rel', memberName: 'Release manager', label: 'gate', title: 'Resume Release manager?', detail: 'Paused by budget', createdAt: AT, sessionRef: 's9', teamId: 't-core', teamName: 'Acme Core', request: { id: 'req-g', teamId: 't-core', memberId: 'm-rel', kind: 'gate', gate: null, title: 'Resume?', detail: '', state: 'open', action: { type: 'resume-member' }, note: null, createdAt: AT, updatedAt: AT } };

function note(id: string, status: MemoryEntry['status'] = 'proposed'): MemoryEntry {
  return { id, scope: '/w/checkout', scopeKind: 'workspace', scopeKey: null, scopeLabel: null, title: 'Currency', text: 'Prices are shown in the local currency.', tags: [], authorKind: 'agent', authorSessionId: 's1', authorLabel: 'Developer', status, pinned: false, createdAt: AT, updatedAt: AT, decidedAt: null, decidedBy: null, proposedTitle: null, proposedText: null } as MemoryEntry;
}

describe('D131 · needs you: every source merged into one list', () => {
  it('classifies every Inbox item by what it asks', () => {
    expect([QUESTION, MULTI, PERMISSION, WAITING, READY, STOPPED, ROUTINE, PICK, MEMORY, UPDATE].map(inboxKindOf)).toEqual(['question', 'multi', 'approval', 'ask', 'ready', 'stopped', 'routine', 'pick', 'note', 'alert']);
    expect(inboxKindOf(inbox({ id: 'c', kind: 'system', label: 'CI keeps failing', actions: [{ id: 'try-again', label: 'Try again' }] }))).toBe('stopped');
    expect(inboxKindOf(inbox({ id: 'c', kind: 'system', label: 'Ready to merge', actions: [{ id: 'merge-pr', label: 'Merge PR' }] }))).toBe('ready');
    expect(inboxKindOf(inbox({ id: 'c', kind: 'system', label: 'Confirm done', actions: [] }))).toBe('ready');
  });

  it('turns each into an item with its source, agent, computer and words', () => {
    const q = fromInbox(QUESTION);
    expect(q).toMatchObject({ key: 'inbox:b1', source: 'inbox', kind: 'question', title: 'Q q1?', agent: { sessionId: 's1', name: 'Asker' }, computer: null });
    expect(fromInbox(PERMISSION)).toMatchObject({ kind: 'approval', command: 'npm run deploy:staging', text: 'Publish to staging' });
    expect(fromInbox(WAITING)).toMatchObject({ kind: 'ask', title: 'Reviewer', quote: 'Approve test plan?' });
    expect(fromInbox(PEER)).toMatchObject({ key: 'inbox:r~studio~b9', computer: { id: 'studio', name: 'Studio-PC', state: 'online' } });
    // The live state of a paired computer wins over the item's copy.
    expect(fromInbox(PEER, { studio: 'offline' }).computer?.state).toBe('offline');
    expect(fromInbox(PEER, { studio: 'reconnecting' }).computer?.state).toBe('reconnecting');
    expect(fromInbox(ROUTINE).agent).toEqual({ sessionId: null, name: 'Routine failed' });
    expect(commandOf({ requestId: 'r', toolName: 'Edit', input: { file_path: '/w/a.ts' }, description: null, decisionReason: null, agentId: null, agent: null })).toBe('Edit /w/a.ts');
    expect(commandOf({ requestId: 'r', toolName: 'Fetch', input: { q: 1 }, description: null, decisionReason: null, agentId: null, agent: null })).toBe('Fetch {"q":1}');
    expect(memoryScopeOf(MEMORY)).toBe('/w/checkout');
    expect(memoryScopeOf({ route: '/memory' })).toBeNull();
    expect(planIdOf('/plans/p100')).toBe('p100');
    expect(planIdOf('/memory?scope=x')).toBeNull();
  });

  it('merges all sources once, newest first: crew tags on Inbox items, crew requests, notes, usage', () => {
    const items = mergeNeedsYou({
      inbox: [QUESTION, MULTI, PERMISSION, WAITING, READY, MEMORY, PEER],
      team: [CREW_INBOX, ACCESS, CHARTER, GATE],
      notes: { '/w/checkout': [note('n1'), note('n2', 'approved')] },
      usage: [{ key: 'credits:p', title: 'Out of usage, now using paid extra', text: 'Personal · €12.40 left of €50', createdAt: '2026-10-25T11:00:00.000Z' }],
    });
    const keys = items.map((item) => item.key);
    // Each once: the crew's copy of w1 is the Inbox's (it only adds the crew).
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('inbox:w1');
    expect(keys).not.toContain('crew:w1');
    expect(items.find((item) => item.key === 'inbox:w1')?.crew).toEqual({ id: 't-core', name: 'Acme Core', teammate: 'Reviewer/QA', memberId: 'm-rev' });
    // The memory summary item became its scope's proposed notes (the approved one is not asked again).
    expect(keys).not.toContain('inbox:m1');
    expect(keys).toContain('notes:n1');
    expect(keys).not.toContain('notes:n2');
    expect(items.find((item) => item.key === 'notes:n1')).toMatchObject({ kind: 'note', quote: 'Prices are shown in the local currency.', context: 'Folder · checkout' });
    // Crew requests.
    expect(items.find((item) => item.key === 'crew:req-a')).toMatchObject({ kind: 'access', crew: { id: 't-mob', name: 'Acme Mobile', teammate: 'Mobile developer' } });
    expect(items.find((item) => item.key === 'crew:req-c')).toMatchObject({ kind: 'jd', title: 'Proposed job description for Designer' });
    expect(items.find((item) => item.key === 'crew:req-c')?.quote).toContain('Turns briefs into screens.');
    expect(items.find((item) => item.key === 'crew:req-g')).toMatchObject({ kind: 'approval' });
    // Usage.
    expect(items.find((item) => item.key === 'usage:credits:p')).toMatchObject({ kind: 'alert', source: 'usage', agent: null });
    // Newest first, the oldest (usage at 11:00) last.
    expect(keys[0]).toBe('inbox:b2');
    expect(keys.at(-1)).toBe('usage:credits:p');
    // Without notes read for the scope, the summary item stays (its Review link).
    expect(mergeNeedsYou({ inbox: [MEMORY], team: [], notes: {}, usage: [] }).map((item) => item.kind)).toEqual(['note']);
    // Hidden keys (answered here, not yet gone from the server) are left out.
    expect(mergeNeedsYou({ inbox: [QUESTION, PERMISSION], team: null, notes: {}, usage: [] }, new Set(['inbox:b1'])).map((item) => item.key)).toEqual(['inbox:p1']);
    expect(itemsOfSession(items, 's1').length).toBeGreaterThan(0);
    expect(countByCrew(items).get('t-mob')).toBe(2);
    expect(countByCrew(items).get('t-core')).toBe(2);
  });

  it('a crew Inbox item this page has not read yet still shows (from the crew’s copy)', () => {
    const items = mergeNeedsYou({ inbox: [], team: [CREW_INBOX], notes: {}, usage: [] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'inbox:w1', kind: 'ask', crew: { teammate: 'Reviewer/QA' } });
  });

  it('usage alerts: an account on paid extra usage, or out of usage', () => {
    const system = {
      cli: 'claude',
      cliVersion: '2',
      signedIn: true,
      ghSignedIn: true,
      cpu: 10,
      ramUsed: 1,
      ramTotal: 2,
      processes: 0,
      accountUsage: [
        { cli: 'claude', profileId: 'work', name: 'Work', active: true, pct: 72, exhaustedUntil: null, windows: [{ key: 'session', label: '5h', pct: 72, resetsAt: null }] },
        { cli: 'claude', profileId: 'personal', name: 'Personal', active: false, pct: 100, exhaustedUntil: '2099-01-01T14:05:00.000Z', windows: [] },
        { cli: 'claude', profileId: 'paid', name: 'Paid', active: false, pct: 100, exhaustedUntil: null, windows: [], credits: { until: '2099-01-01T00:00:00.000Z', remaining: 12.4, limit: 50, currency: 'EUR' } },
      ],
    } as unknown as SystemInfo;
    const alerts = usageAlerts(system, Date.parse(AT), () => AT);
    expect(alerts.map((alert) => alert.key)).toEqual(expect.arrayContaining([expect.stringMatching(/^out:personal:/)]));
    expect(alerts.find((alert) => alert.key.startsWith('out:personal'))?.title).toBe('Personal is out of usage');
    expect(usageAlerts(null, 0, () => AT)).toEqual([]);
  });
});

describe('D131 · answering: the buttons, the drafts and the summaries', () => {
  const item = (raw: InboxItem): NeedsItem => fromInbox(raw);

  it('each kind offers the prototype’s buttons, in v2 words', () => {
    const ids = (raw: InboxItem | NeedsItem): string[] => cardButtons('key' in raw ? raw : item(raw)).map((button) => `${button.id}:${button.label}`);
    expect(ids(PERMISSION)).toEqual(['allow-once:Allow once', 'deny:Deny']);
    expect(ids(inbox({ ...PERMISSION, actions: [{ id: 'allow-once', label: 'Allow once' }, { id: 'always-allow', label: 'Always allow' }, { id: 'deny', label: 'Deny' }] }))).toEqual(['allow-once:Allow once', 'always-allow:Always allow', 'deny:Deny']);
    expect(ids(READY)).toEqual(['plan-merge:Combine', 'send-back:Send back', 'open-plan:Open project', 'changes:View changes']);
    expect(ids(WAITING)).toEqual(['not-waiting:Not waiting']);
    expect(ids(STOPPED)).toEqual(['retry:Try again', 'open-session:Open chat', 'dismiss:Dismiss']);
    expect(ids(ROUTINE)).toEqual(['open-fix-session:Fix it in a new agent', 'open-routine:Open routine', 'retry-run:Try again', 'dismiss:Dismiss']);
    expect(ids(PICK)).toEqual(['plan-ask-repos:Ask again', 'open-plan:Open project', 'dismiss:Dismiss']);
    expect(ids(MEMORY)).toEqual(['open-memory:Review notes', 'dismiss:Dismiss']);
    const merged = mergeNeedsYou({ inbox: [MEMORY], team: [ACCESS, CHARTER, GATE], notes: { '/w/checkout': [note('n1')] }, usage: [{ key: 'u', title: 't', text: '', createdAt: AT }] });
    const by = (key: string): NeedsItem => merged.find((entry) => entry.key === key) as NeedsItem;
    expect(ids(by('notes:n1'))).toEqual(['note-approve:Approve', 'note-edit:Edit first', 'note-reject:Reject']);
    expect(ids(by('crew:req-a'))).toEqual(['add-key:Add key', 'not-now:Not now']);
    expect(ids(by('crew:req-c'))).toEqual(['jd-accept:Accept', 'jd-edit:Edit', 'jd-dismiss:Dismiss']);
    expect(ids(by('crew:req-g'))).toEqual(['approve:Approve', 'decline:Deny']);
    expect(ids(by('usage:u'))).toEqual(['ok:OK', 'manage:Manage usage']);
    // Add key opens the teammate's Access tab; View changes the agent's Changes tab.
    expect(cardButtons(by('crew:req-a'))[0]?.intent).toEqual({ type: 'open', target: { type: 'path', path: '/crews/t-mob?member=m-dev&tab=access' } });
    expect(cardButtons(item(READY)).at(-1)?.intent).toEqual({ type: 'open', target: { type: 'agent', sessionId: 's1', tab: 'changes' } });
    expect(isLinkAction('open-plan')).toBe(true);
    expect(isLinkAction('plan-merge')).toBe(false);
  });

  it('single and multi-select drafts, Other…, and whole batches', () => {
    const single = question('q1', ['Q2', 'Q3']);
    const multi = question('q2', ['A', 'B', 'C'], { multiSelect: true });
    expect(questionReady(single, undefined)).toBe(false);
    expect(questionAnswer(single, { index: 1 })).toEqual({ questionId: 'q1', answerIndex: 1 });
    expect(questionAnswer(single, { other: true, text: '  H1 ' })).toEqual({ questionId: 'q1', text: 'H1' });
    expect(questionAnswer(single, { other: true, text: '   ' })).toBeNull();
    let draft = togglePick(undefined, 2);
    draft = togglePick(draft, 0);
    expect(draft.picks).toEqual([0, 2]);
    draft = togglePick(draft, 2);
    expect(draft.picks).toEqual([0]);
    // Classic's shapes: one option alone → answerIndex, own words alone → text, several → answerIndexes.
    expect(questionAnswer(multi, draft)).toEqual({ questionId: 'q2', answerIndex: 0 });
    expect(questionAnswer(multi, { picks: [1], other: true, text: 'my own' })).toEqual({ questionId: 'q2', answerIndexes: [1], text: 'my own' });
    expect(questionAnswer(multi, { picks: [], other: true, text: 'only mine' })).toEqual({ questionId: 'q2', text: 'only mine' });
    expect(questionAnswer(multi, { picks: [2, 0] })).toEqual({ questionId: 'q2', answerIndexes: [0, 2] });
    // A ticked Other… needs its words (classic's isAnswered).
    expect(questionAnswer(multi, { picks: [1], other: true, text: '  ' })).toBeNull();
    expect(questionAnswer(multi, { picks: [] })).toBeNull();
    expect(batchAnswers([single, multi], { q1: { index: 0 } })).toBeNull();
    expect(batchAnswers([single, multi], { q1: { index: 0 }, q2: { picks: [2] } })).toEqual([
      { questionId: 'q1', answerIndex: 0 },
      { questionId: 'q2', answerIndex: 2 },
    ]);
  });

  it('the compact card’s words for every answer', () => {
    expect(summaryOf(item(QUESTION), { type: 'questions', answers: [{ questionId: 'q1', answerIndex: 1 }] })).toBe('You answered “Q3”');
    expect(summaryOf(item(MULTI), { type: 'questions', answers: [{ questionId: 'q2', answerIndexes: [0, 2], text: 'Refunds' }] })).toBe('You chose Checkout, Emails, Refunds');
    expect(summaryOf(item(PERMISSION), { type: 'permission', decision: 'allow-once' })).toBe('You allowed it once');
    expect(summaryOf(item(PERMISSION), { type: 'permission', decision: 'deny' })).toBe('You denied it');
    expect(summaryOf(item(WAITING), { type: 'reply', text: 'Yes' })).toBe('You replied “Yes”');
    expect(summaryOf(item(WAITING), { type: 'not-waiting' })).toBe('You marked it “not waiting”');
    expect(summaryOf(item(READY), { type: 'server', actionId: 'plan-merge' })).toBe('You combined it');
    expect(summaryOf(item(READY), { type: 'send-back', comment: 'x' })).toBe('You sent it back with a note');
    expect(summaryOf(item(STOPPED), { type: 'server', actionId: 'dismiss' })).toBe('You dismissed it');
    expect(summaryOf(item(UPDATE), { type: 'server', actionId: 'whats-new' })).toBe('You chose “What’s new”');
    // Answered elsewhere (another browser, a phone, claude.ai): the server's record.
    expect(answeredFromServer([question('q1', ['Q2', 'Q3'], { state: 'answered', answerIndex: 1 })])).toBe('You answered “Q3”');
    expect(answeredFromServer([question('q1', ['A'], { state: 'answered', answerIndex: null, answeredOn: 'claude.ai' })])).toBe('Answered on claude.ai');
    expect(answeredFromServer([question('q1', ['A'])])).toBeNull();
  });
});

describe('D131 · the store: answering anywhere answers it everywhere, with Undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<NeedsYouDeps> = {}) {
    let list: InboxItem[] = [QUESTION, PERMISSION];
    const sent: Array<{ key: string; type: string }> = [];
    const storage = new Map<string, string>();
    const store = createNeedsYouStore({
      inbox: async () => list,
      team: async () => [],
      notes: async () => [],
      system: async () => ({}) as SystemInfo,
      send: async (item, action) => {
        sent.push({ key: item.key, type: action.type });
        list = list.filter((entry) => `inbox:${entry.id}` !== item.key);
      },
      now: () => Date.parse(LATER),
      storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value) },
      undoMs: 5_000,
      ...overrides,
    });
    return { store, sent, storage, setList: (next: InboxItem[]) => (list = next) };
  }

  it('an answer hides the item at once everywhere, is sent after the Undo window, and stays gone', async () => {
    const { store, sent } = setup();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().items.length));
    await store.reload();
    expect(store.getSnapshot()).toMatchObject({ loaded: true, error: null });
    expect(store.getSnapshot().items.map((item) => item.key)).toEqual(['inbox:b1', 'inbox:p1']);
    const target = store.getSnapshot().items[0] as NeedsItem;
    store.answer(target, { type: 'questions', answers: [{ questionId: 'q1', answerIndex: 0 }] }, 'home');
    // Gone from the list (every view reads the same snapshot), remembered as answered, pending.
    expect(store.getSnapshot().items.map((item) => item.key)).toEqual(['inbox:p1']);
    expect(store.getSnapshot().pending.has('inbox:b1')).toBe(true);
    expect(store.getSnapshot().answered.get('inbox:b1')).toMatchObject({ summary: 'You answered “Q2”', where: 'home', at: LATER });
    // A reload meanwhile (the server still lists it) does not bring it back.
    await store.reload();
    expect(store.getSnapshot().items.map((item) => item.key)).toEqual(['inbox:p1']);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([{ key: 'inbox:b1', type: 'questions' }]);
    expect(store.getSnapshot().pending.size).toBe(0);
    await vi.runAllTimersAsync();
    expect(store.getSnapshot().items.map((item) => item.key)).toEqual(['inbox:p1']);
    expect(seen.length).toBeGreaterThan(2);
  });

  it('Undo within the window takes the answer back (nothing is sent); after it, Undo is too late', async () => {
    const { store, sent } = setup();
    await store.reload();
    const target = store.getSnapshot().items[1] as NeedsItem;
    store.answer(target, { type: 'permission', decision: 'deny' }, 'needs');
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.undo(target.key)).toBe(true);
    expect(store.getSnapshot().items.map((item) => item.key)).toEqual(['inbox:b1', 'inbox:p1']);
    expect(store.getSnapshot().answered.has(target.key)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([]);
    store.answer(target, { type: 'permission', decision: 'allow-once' }, 'needs');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.undo(target.key)).toBe(false);
    expect(sent).toEqual([{ key: 'inbox:p1', type: 'permission' }]);
  });

  it('a refused answer brings the item back with the reason; flush sends at once (page hidden)', async () => {
    const { store } = setup({
      send: async () => {
        throw new Error('the batch is not open');
      },
    });
    await store.reload();
    const target = store.getSnapshot().items[0] as NeedsItem;
    store.answer(target, { type: 'questions', answers: [{ questionId: 'q1', answerIndex: 1 }] }, 'chat');
    expect(store.getSnapshot().items).toHaveLength(1);
    await store.flush();
    expect(store.getSnapshot().items.map((item) => item.key)).toContain('inbox:b1');
    expect(store.getSnapshot().errors.get('inbox:b1')).toBe('the batch is not open');
    expect(store.getSnapshot().answered.has('inbox:b1')).toBe(false);
  });

  it('a usage alert dismissed (OK) stays dismissed on this browser', async () => {
    const system = { accountUsage: [{ cli: 'claude', profileId: 'personal', name: 'Personal', active: true, pct: 100, exhaustedUntil: '2099-01-01T14:05:00.000Z', windows: [] }] } as unknown as SystemInfo;
    const { store, storage } = setup();
    await store.reload();
    store.usageChanged(system);
    const alert = store.getSnapshot().items.find((item) => item.source === 'usage') as NeedsItem;
    expect(alert).toMatchObject({ kind: 'alert', title: 'Personal is out of usage' });
    store.answer(alert, { type: 'dismiss-local' }, 'home');
    expect(store.getSnapshot().items.some((item) => item.source === 'usage')).toBe(false);
    expect(JSON.parse(storage.get(DISMISSED_ALERTS_KEY) ?? '[]')).toEqual([alert.id]);
    store.usageChanged(system);
    expect(store.getSnapshot().items.some((item) => item.source === 'usage')).toBe(false);
  });

  it('an Inbox that cannot be read says why; Team being off only means no crew items', async () => {
    const { store } = setup({
      inbox: async () => {
        throw new Error('down');
      },
      team: async () => {
        throw new Error('team is off');
      },
    });
    await store.reload();
    expect(store.getSnapshot()).toMatchObject({ loaded: false, error: 'down', items: [] });
  });

  it('a paired computer going offline updates its items’ computer state', async () => {
    const { store, setList } = setup();
    setList([PEER]);
    await store.reload();
    expect(store.getSnapshot().items[0]?.computer?.state).toBe('online');
    store.computersChanged({ studio: 'offline' });
    expect(store.getSnapshot().items[0]?.computer?.state).toBe('offline');
  });
});

describe('D135 · a proposed change of an approved note in Needs you', () => {
  const target = { ...note('t1', 'approved'), title: 'Currency', text: 'Prices are shown in EUR.' } as MemoryEntry;
  const edit = { ...note('e1'), text: 'Prices are shown in the local currency.', changeKind: 'edit', targetId: 't1', reason: 'Localised now.', targetTitle: 'Currency', targetText: 'Prices are shown in EUR.', target } as MemoryEntry;
  const removal = { ...note('r1'), title: 'Currency', text: 'Prices are shown in EUR.', changeKind: 'retract', targetId: 't1', reason: 'Gone.', targetTitle: 'Currency', targetText: 'Prices are shown in EUR.', target } as MemoryEntry;

  it('is a note-edit / note-removal item labelled "Note edit" / "Note removal", with the change buttons', () => {
    const items = mergeNeedsYou({ inbox: [MEMORY], team: [], notes: { '/w/checkout': [edit, removal, note('n1')] }, usage: [] });
    expect(items.map((item) => [item.key, item.kind])).toEqual([
      ['notes:e1', 'note-edit'],
      ['notes:r1', 'note-removal'],
      ['notes:n1', 'note'],
    ]);
    expect(NEEDS_KIND_LOOK['note-edit'].label).toBe('Note edit');
    expect(NEEDS_KIND_LOOK['note-removal'].label).toBe('Note removal');
    const editItem = fromNote(edit, null);
    expect(editItem).toMatchObject({ title: 'Change what agents know?', text: 'Currency', quote: 'Prices are shown in the local currency.', memory: { target: { id: 't1' } } });
    expect(cardButtons(editItem).map((button) => `${button.id}:${button.label}`)).toEqual(['note-approve:Approve', 'note-edit:Edit first', 'note-reject:Reject']);
    const removalItem = fromNote(removal, null);
    expect(removalItem.title).toBe('Remove from what agents know?');
    expect(cardButtons(removalItem).map((button) => `${button.id}:${button.label}`)).toEqual(['note-approve:Approve removal', 'note-reject:Reject']);
    expect(summaryOf(editItem, { type: 'note', decision: 'approve' })).toBe('You approved the edit');
    expect(summaryOf(removalItem, { type: 'note', decision: 'approve' })).toBe('You removed the note');
    expect(summaryOf(removalItem, { type: 'note', decision: 'reject' })).toBe('You kept the note');
  });
});
