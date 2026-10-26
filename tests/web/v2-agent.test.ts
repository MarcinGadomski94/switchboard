import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../src/web/views/session/chat.ts';
import { activityMark, activitySummary, chatRows, codeBlocks, durationText, hasCodeBlock, helpersSummary, laterText, repliesFrom, waitingBatches } from '../../src/web/v2/agent/chat-model.ts';
import { DEFAULT_VIEW, VIEW_SETTINGS_KEY, columnWidth, loadView, saveView, textMetrics } from '../../src/web/v2/agent/view-settings.ts';
import { MEMORY_SHOWN_FROM, YOU_FOLD_LINES, composerKey, composerMaxHeight, composerPlaceholder, dockStatus, foldsYou, joinWithdrawn, liveLine, resetTimeOf, splitDock, youWaitNote } from '../../src/web/v2/agent/composer-model.ts';
import { firstSentence, replyMenu, shortQuote, taskTitle, undoReason } from '../../src/web/v2/agent/reply-menu.ts';
import { agentMenu, ciView } from '../../src/web/v2/agent/header-model.ts';
import type { SessionPr } from '../../src/core/ci.ts';
import type { SessionCheckpoints } from '../../src/core/checkpoints.ts';

/** D131 · lane S · the agent view's pure models (`src/web/v2/agent/*-model.ts`, `view-settings.ts`, `reply-menu.ts`). */

const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function user(id: number, text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem {
  return { kind: 'user', key: `u:${id}`, id, text, origin: 'user', delivered: true, queued: null, attachments: [], cut: null, ...extra };
}
function agent(id: number, text: string, steps: Extract<ChatItem, { kind: 'agent' }>['steps'] = []): ChatItem {
  return { kind: 'agent', key: `a:${id}`, id, text, cut: null, steps };
}

const clock = (iso: string): string => iso.slice(11, 16);
const gapText = (from: number, to: number): string => `gap ${Math.round((to - from) / 60_000)}m`;

describe('chat rows', () => {
  const times = new Map<number, { ts: string; endTs: string | null }>([
    [1, { ts: at(0), endTs: null }],
    [2, { ts: at(1), endTs: null }],
    [3, { ts: at(1.1), endTs: at(1.8) }],
    [4, { ts: at(1.2), endTs: at(2) }],
    [5, { ts: at(2.5), endTs: null }],
    [6, { ts: at(3), endTs: null }],
    [7, { ts: at(3.2), endTs: null }],
    [8, { ts: at(120), endTs: null }],
    [9, { ts: at(121), endTs: null }],
  ]);
  const items: ChatItem[] = [
    user(1, 'Redesign the summary'),
    agent(2, 'I read the page.', [
      { id: 3, mark: '✓', label: 'Read · SummaryCard.tsx' },
      { id: 4, mark: '✓', label: 'Bash · npm test' },
    ]),
    agent(5, 'Rebuilt the card.\n\n```ts\nconst a = 1;\n```', [{ id: 6, mark: '●', label: 'Agent · Write tests', subagentId: 'sub1' }]),
    agent(7, 'One more thing.'),
    user(8, 'Thanks'),
    user(9, 'And the footer?'),
  ];
  const rows = chatRows({
    items,
    times,
    agents: [{ id: 'sub1', kind: 'subagent', name: 'helper', description: 'Writing tests', status: 'run', toolUseId: 't1' }],
    now: T0,
    clock,
    gapText,
  });

  it('turns user messages into pills and agent text into numbered replies, grouped per turn', () => {
    expect(rows.map((r) => r.kind)).toEqual(['you', 'reply', 'activity', 'reply', 'helpers', 'reply', 'gap', 'you', 'you']);
    const replies = rows.filter((r) => r.kind === 'reply');
    expect(replies.map((r) => (r.kind === 'reply' ? [r.n, r.cont, r.time] : null))).toEqual([
      [1, false, '12:01'],
      [1, true, '12:02'],
      [1, true, '12:03'],
    ]);
    // The turn that produced the replies started with the first message.
    expect(replies.every((r) => r.kind === 'reply' && r.turnEventId === 1)).toBe(true);
    // Consecutive messages of the developer are grouped; a gap of two hours draws a divider.
    const yous = rows.filter((r) => r.kind === 'you');
    expect(yous.map((r) => (r.kind === 'you' ? r.cont : null))).toEqual([false, false, true]);
    expect(rows[6]).toEqual({ kind: 'gap', key: `g:${T0 + 120 * 60_000}`, text: 'gap 117m' });
  });

  it('collapses tool steps into one activity row with its duration, and Agent calls into a helpers thread', () => {
    const act = rows[2];
    expect(act?.kind).toBe('activity');
    if (act?.kind !== 'activity') return;
    expect(act.summary).toBe('Read 1 file · ran tests');
    expect(act.mark).toBe('ok');
    expect(act.duration).toBe('0:54');
    expect(act.lines.map((l) => l.label)).toEqual(['Read · SummaryCard.tsx', 'Bash · npm test']);
    const helpers = rows[4];
    expect(helpers?.kind).toBe('helpers');
    if (helpers?.kind !== 'helpers') return;
    expect(helpers.helpers).toEqual([{ id: 6, agentId: 'sub1', name: 'Writing tests', state: 'working', detail: 'Writing tests' }]);
    expect(helpers.summary).toBe('1 helper · 1 still working');
  });

  it('knows which replies hold code', () => {
    const replies = rows.filter((r) => r.kind === 'reply');
    expect(replies.map((r) => r.kind === 'reply' && r.hasCode)).toEqual([false, true, false]);
    expect(repliesFrom(rows, 2)).toBe(1);
  });

  it('places question batches and lists the waiting ones', () => {
    const q: ChatItem = { kind: 'questions', key: 'q:b1', batchId: 'b1', questions: [], waiting: true };
    const out = chatRows({ items: [user(1, 'hi'), q], times, agents: [], now: T0, clock, gapText });
    expect(out.map((r) => r.kind)).toEqual(['you', 'questions']);
    expect(waitingBatches(out)).toEqual(['b1']);
  });

  it('keeps dividers and a message on its way (no time yet, counts as now)', () => {
    const divider: ChatItem = { kind: 'divider', key: 'd:3', id: 3, text: 'Continued from Old work', from: null, to: null, linkedSessionId: 's0' };
    const out = chatRows({ items: [user(1, 'hi'), divider, user(-1, 'queued one', { delivered: false, queued: 'turn' })], times, agents: [], now: T0 + 60_000, clock, gapText });
    expect(out[1]).toEqual({ kind: 'divider', key: 'd:3', id: 3, text: 'Continued from Old work', linkedSessionId: 's0', revert: null });
    expect(out[2]?.kind === 'you' && out[2].time).toBe(null);
  });
});

describe('activity words', () => {
  it('names one step and counts several by kind', () => {
    expect(activitySummary(['Bash · npm test -- checkout'])).toBe('Ran tests');
    expect(activitySummary(['Bash · ls -la'])).toBe('Ran ls -la');
    expect(activitySummary(['Read · a.ts'])).toBe('Read a.ts');
    expect(activitySummary(['Read · a.ts', 'Read · b.ts', 'Edit · a.ts', 'Bash · git status', 'Bash · ls'])).toBe('Read 2 files · edited 1 file · ran 2 commands');
    expect(activitySummary(['Permission · Bash rm', 'Permission · Bash rm'])).toBe('Used Permission 2 times');
  });
  it('marks failures over running over waiting', () => {
    expect(activityMark(['✓', '✕', '●'])).toBe('bad');
    expect(activityMark(['✓', '●'])).toBe('running');
    expect(activityMark(['⏸'])).toBe('waiting');
    expect(activityMark(['■'])).toBe('stopped');
    expect(activityMark(['✓'])).toBe('ok');
  });
  it('formats durations, gaps and helper threads', () => {
    expect(durationText(42_000)).toBe('0:42');
    expect(durationText(3_723_000)).toBe('1:02:03');
    expect(laterText(50 * 60_000)).toBe('50 minutes later');
    expect(laterText(130 * 60_000)).toBe('2 hours later');
    expect(helpersSummary([{ id: 1, agentId: null, name: 'a', state: 'done', detail: null }, { id: 2, agentId: null, name: 'b', state: 'failed', detail: null }])).toBe('2 helpers finished');
  });
  it('finds fenced code', () => {
    expect(hasCodeBlock('no code')).toBe(false);
    expect(codeBlocks('a\n```ts\nx\ny\n```\nb\n~~~\nz\n~~~')).toEqual(['x\ny', 'z']);
  });
});

describe('view settings', () => {
  const store = (): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  it('remembers density, full width and the side panel', () => {
    const s = store();
    expect(loadView(s)).toEqual(DEFAULT_VIEW);
    saveView(s, { density: 'compact', fullWidth: true, sideHidden: true });
    expect(loadView(s)).toEqual({ density: 'compact', fullWidth: true, sideHidden: true });
    s.data.set(VIEW_SETTINGS_KEY, '{broken');
    expect(loadView(s)).toEqual(DEFAULT_VIEW);
    expect(loadView(null)).toEqual(DEFAULT_VIEW);
  });
  it('caps the line length unless Full width with the details hidden', () => {
    expect(columnWidth({ fullWidth: false, sideHidden: true }, false)).toBe('84ch');
    expect(columnWidth({ fullWidth: true, sideHidden: true }, false)).toBe('none');
    expect(columnWidth({ fullWidth: true, sideHidden: false }, true)).toBe('84ch');
    expect(textMetrics('comfortable')).toEqual({ size: 15.5, lineHeight: 1.55, gap: 22 });
    expect(textMetrics('compact').size).toBe(14.5);
  });
});

describe('composer states', () => {
  const base = { machine: null, status: 'idle', activity: null, stoppable: false, backgroundStoppable: false, stoppedByYou: null, held: false, live: true, conversation: false } as const;
  it('shows the live line with its timer and Stop while working', () => {
    expect(liveLine({ ...base, status: 'run', stoppable: true, activity: { state: 'tool', text: 'Bash: npm test', time: '0:42' } })).toEqual({ kind: 'working', text: 'Bash: npm test', time: '0:42', action: 'stop' });
    expect(liveLine({ ...base, status: 'run', activity: { state: 'background', text: 'Waiting for GitHub Actions', time: '1:00' }, backgroundStoppable: true }).action).toBe('stop-background');
  });
  it('says offline, waiting for you, stopped by you, paused, held', () => {
    expect(liveLine({ ...base, machine: { name: 'Studio-PC', state: 'offline' }, status: 'run' }).kind).toBe('offline');
    expect(liveLine({ ...base, status: 'need' }).kind).toBe('needs');
    expect(liveLine({ ...base, status: 'need', stoppable: true, activity: { state: 'waiting', text: 'Waiting for you', time: '0:05' } })).toEqual({ kind: 'needs', text: 'Waiting for you · answer the card above', time: '0:05', action: 'stop' });
    expect(liveLine({ ...base, stoppedByYou: '13:44' })).toEqual({ kind: 'stopped', text: 'Stopped by you', time: '13:44', action: null });
    expect(liveLine({ ...base, status: 'paused' }).action).toBe('resume');
    expect(liveLine({ ...base, held: true }).kind).toBe('held');
    expect(liveLine(base).kind).toBe('idle');
  });
  it('lists queued and paused messages for the dock; every message stays in the chat as its bubble (fix after 2.0)', () => {
    const rows = chatRows({
      items: [user(1, 'a'), user(2, 'b', { queued: 'turn' }), user(3, 'c', { queued: 'credits', heldNote: 'Waiting for an account with allowance — Private back at 23:30' }), user(4, 'd', { notSent: true }), user(-1, 'e', { delivered: false })],
      times: new Map(),
      agents: [],
      now: T0,
      clock,
      gapText,
    });
    const split = splitDock(rows, true);
    expect(split.queued.map((r) => r.text)).toEqual(['b', 'e']);
    expect(split.paused.map((r) => r.text)).toEqual(['c']);
    expect(split.chat.map((r) => (r.kind === 'you' ? r.text : r.kind))).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Not working: a message on its way is not queued (it shows as sent at once).
    expect(splitDock(rows, false).queued.map((r) => r.text)).toEqual(['b']);
    // The note under a bubble the agent has not taken up.
    const you = (text: string) => rows.find((r): r is Extract<typeof r, { kind: 'you' }> => r.kind === 'you' && r.text === text)!;
    expect(youWaitNote(you('a'), true)).toBeNull();
    expect(youWaitNote(you('b'), false)).toBe('Queued · sends when this reply finishes');
    expect(youWaitNote(you('c'), false)).toBe('Paused — waiting for usage (resets 23:30)');
    expect(youWaitNote(you('e'), true)).toBe('Queued · sends when this reply finishes');
    expect(youWaitNote(you('e'), false)).toBeNull();
    expect(youWaitNote({ id: 9, queued: 'resume' }, false)).toBe('Queued · sends when the agent starts again');
    expect(resetTimeOf('Waiting for an account with allowance — Private back at 23:30')).toBe('23:30');
    expect(resetTimeOf(null)).toBe(null);
  });
  it('sends on Enter and ⌘↩, never while composing', () => {
    const key = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false };
    expect(composerKey(key)).toBe('send');
    expect(composerKey({ ...key, metaKey: true })).toBe('send');
    expect(composerKey({ ...key, shiftKey: true })).toBe(null);
    expect(composerKey({ ...key, isComposing: true })).toBe(null);
    expect(composerKey({ ...key, key: 'a' })).toBe(null);
    expect(composerPlaceholder({ conversation: false, working: true, blocked: null })).toBe('Send a follow-up. It waits until this reply finishes.');
    expect(composerPlaceholder({ conversation: true, working: false, blocked: null })).toBe('Ask a follow-up. Conversations never change files.');
    expect(composerPlaceholder({ conversation: false, working: false, blocked: 'Studio-PC is offline' })).toBe('Studio-PC is offline');
    expect(joinWithdrawn([' one ', '', 'two'])).toBe('one\n\ntwo');
  });
});

describe('reply menu', () => {
  const checkpoints: SessionCheckpoints = { turns: [{ turn: 2, eventId: 10, at: at(0), firstLine: 'x' }], latestTurn: 2, running: false, unsupported: null, redo: null } as unknown as SessionCheckpoints;
  it('maps every action', () => {
    const items = replyMenu({ text: 'Done. Next I will add tests.\n```ts\nx()\n```', selection: null, turnEventId: 10, checkpoints, blocked: null, conversation: false });
    expect(items.map((i) => [i.id, i.disabledReason ?? null])).toEqual([
      ['copy', null],
      ['copy-code', null],
      ['save', null],
      ['task', null],
      ['undo', null],
    ]);
    expect(items[1]?.action).toEqual({ type: 'copy-code', text: 'x()' });
    expect(items[3]?.action).toEqual({ type: 'task', title: 'Done.' });
    expect(items[4]?.action).toEqual({ type: 'undo', turn: 2 });
  });
  it('disables with reasons', () => {
    const items = replyMenu({ text: 'Plain', selection: 'the summary card layout and more words', turnEventId: 99, checkpoints, blocked: null, conversation: false });
    expect(items.find((i) => i.id === 'copy-code')?.disabledReason).toBe('This reply has no code.');
    expect(items.find((i) => i.id === 'task')?.label).toBe('Add “the summary card layout…” to tasks');
    expect(items.find((i) => i.id === 'undo')?.disabledReason).toMatch(/No save point/);
    expect(undoReason({ turnEventId: 10, checkpoints: null, blocked: null, conversation: false }).reason).toBe('Reading the save points…');
    expect(undoReason({ turnEventId: 10, checkpoints, blocked: null, conversation: true }).reason).toBe('Conversations never change files.');
    const offline = replyMenu({ text: 'x', selection: null, turnEventId: 10, checkpoints, blocked: 'Studio-PC is offline', conversation: false });
    expect(offline.filter((i) => i.disabledReason === 'Studio-PC is offline').map((i) => i.id)).toEqual(['save', 'task', 'undo']);
  });
  it('makes task titles', () => {
    expect(firstSentence('## Plan\nI will fix it. Then test.')).toBe('## Plan');
    expect(taskTitle(null, 'I will fix it. Then test.')).toBe('I will fix it.');
    expect(taskTitle('  a   b ', 'x')).toBe('a b');
    expect(taskTitle(null, 'x'.repeat(200)).length).toBe(80);
    expect(shortQuote('abc', 2)).toBe('ab…');
  });
});

describe('header', () => {
  const pr = (over: Partial<SessionPr>): SessionPr => ({ worktreeId: 'w', repo: 'acme', branch: 'PROJ-1', number: 42, url: 'https://example.invalid/pr/42', state: 'OPEN', checks: 'green', summary: null, review: null, ready: true, attempts: 0, maxAttempts: 3, stopped: null, checkedAt: null, ...over });
  it('words the automatic-tests chip', () => {
    expect(ciView([])).toBe(null);
    expect(ciView([pr({})])?.label).toBe('Automatic tests: passing ✓');
    expect(ciView([pr({ checks: 'pending' })])?.state).toBe('running');
    expect(ciView([pr({ checks: 'red', attempts: 1 })])?.label).toBe('Automatic tests: failing ✗ · sent back, try 2 of 3');
    expect(ciView([pr({ checks: 'red', attempts: 3, stopped: 'cap' })])?.label).toBe('Automatic tests: failing ✗ · gave up');
    expect(ciView([pr({ state: 'MERGED' })])?.state).toBe('merged');
    expect(ciView([pr({})])?.pr).toEqual({ number: 42, url: 'https://example.invalid/pr/42' });
  });
  it('lists the agent ⋯ menu with reasons', () => {
    const input = { conversation: false, closed: false, running: true, attached: true, hooked: false, machineName: null, offline: null, remote: { on: false, disabled: false, reason: null }, background: 0, movable: true, computers: 0, teammate: false, crews: 1 };
    const ids = (list: ReturnType<typeof agentMenu>): string[] => list.map((i) => ('sep' in i ? '-' : i.id));
    expect(ids(agentMenu(input))).toEqual(['rename', 'pause', 'stop-background', 'move', '-', 'terminal', 'remote', 'claude-app', '-', 'routine', 'notes', 'teammate', '-', 'close']);
    const menu = agentMenu(input);
    const reason = (id: string): string | undefined => {
      const item = menu.find((i) => !('sep' in i) && i.id === id);
      return item && !('sep' in item) ? item.disabledReason : undefined;
    };
    expect(reason('stop-background')).toBe('Nothing is running in the background.');
    expect(reason('move')).toBe('No other computer is paired and online.');
    const offline = agentMenu({ ...input, machineName: 'Studio-PC', offline: 'Studio-PC is offline' });
    expect(offline.filter((i) => !('sep' in i) && i.disabledReason).length).toBeGreaterThan(6);
    expect(ids(agentMenu({ ...input, conversation: true }))).toEqual(['rename', '-', '-', 'notes', 'continue-agent', '-', 'close', 'delete']);
    expect(ids(agentMenu({ ...input, teammate: true, closed: true, running: false }))).toContain('return');
  });
});

describe('header folder trail', () => {
  it('walks the folder tree outward', async () => {
    const { folderTrail, baseName } = await import('../../src/web/v2/agent/header-model.ts');
    const layout = { folders: [{ id: 'a', name: 'Checkout', sessionIds: [], parentId: null }, { id: 'b', name: 'Payments', sessionIds: ['s1'], parentId: 'a' }] };
    expect(folderTrail(layout, 's1')).toEqual([{ id: 'a', name: 'Checkout' }, { id: 'b', name: 'Payments' }]);
    expect(folderTrail(layout, 'none')).toEqual([]);
    expect(folderTrail(null, 's1')).toEqual([]);
    expect(baseName('/Users/x/acme-checkout/')).toBe('acme-checkout');
  });
});

describe('how it works (Smart / Fast) and results in the chat', () => {
  it('maps the models to Smart and Fast', async () => {
    const { speedModels, speedOf, depthOptions, howSummary, exactModel } = await import('../../src/web/v2/agent/how-model.ts');
    const available = [
      { value: 'default', label: 'Default (recommended)' },
      { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high'] },
      { value: 'sonnet', label: 'Sonnet 5' },
    ];
    expect(speedModels(available)).toEqual({ smart: 'opus', fast: 'sonnet' });
    expect(speedModels(null)).toEqual({ smart: null, fast: null });
    expect(speedOf({ current: 'sonnet', effort: null, available })).toBe('fast');
    expect(speedOf({ current: null, effort: null, available })).toBe('smart');
    expect(speedOf({ current: 'haiku', effort: null, available: null })).toBe('fast');
    expect(depthOptions({ current: 'opus', effort: 'high', available }).map((d) => d.label)).toEqual(['Default', 'Light', 'Normal', 'Deep']);
    expect(depthOptions({ current: 'sonnet', effort: null, available })).toEqual([]);
    expect(howSummary({ current: 'opus', effort: 'high', available })).toBe('Smart · Deep');
    expect(exactModel({ current: 'opus', effort: null, available })).toBe('Opus 5.5');
    expect(exactModel(null)).toBe('Default');
  });
  it('places results after the last message before they were saved', async () => {
    const { placeResults, resultMeta } = await import('../../src/web/v2/agent/chat-model.ts');
    const rows = chatRows({
      items: [user(1, 'a'), agent(2, 'b')],
      times: new Map([
        [1, { ts: at(0), endTs: null }],
        [2, { ts: at(5), endTs: null }],
      ]),
      agents: [],
      now: T0,
      clock,
      gapText,
    });
    const placed = placeResults(rows, [
      { id: 'r1', title: 'Plan', kind: 'markdown', meta: 'Markdown · v1', createdAt: at(2) },
      { id: 'r2', title: 'Old', kind: 'csv', meta: 'Table · v1', createdAt: at(-10) },
      { id: 'r3', title: 'New', kind: 'pdf', meta: 'Pdf · v1', createdAt: at(9) },
    ]);
    expect(placed.map((r) => (r.kind === 'results' ? `res:${r.results.map((x) => x.id).join('+')}` : r.kind))).toEqual(['res:r2', 'you', 'res:r1', 'reply', 'res:r3']);
    expect(resultMeta('csv', 2)).toBe('Table · v2');
    expect(resultMeta('mermaid', 1)).toBe('Diagram · v1');
  });
});

describe('fix after 2.0 · the dock status row', () => {
  const working = { kind: 'working' as const, text: 'Running tests', time: '0:42', action: 'stop' as const };
  it('merges the live line, tasks, memory and the queue into one row', () => {
    const row = dockStatus({ live: working, tasks: { total: 3, done: 1, current: 'Fix the login' }, memory: { pct: 64, offer: false, running: null }, queued: 2, paused: 0 });
    expect(row.parts.map((p) => p.id)).toEqual(['live', 'tasks', 'memory', 'queue']);
    expect(row.text).toBe('Running tests 0:42 · Tasks 1/3 · Memory 64% · 2 queued');
    expect(row.parts[0]?.tone).toBe('blue');
    expect(row.parts[1]?.title).toBe('Tasks · 1 of 3 done · Fix the login');
    expect(row.offer).toBe(false);
  });
  it('shows only what is relevant: no tasks, memory under 50 %, nothing waiting', () => {
    const row = dockStatus({ live: { kind: 'idle', text: 'Idle', time: null, action: null }, tasks: { total: 0, done: 0, current: null }, memory: { pct: MEMORY_SHOWN_FROM - 1, offer: false, running: null }, queued: 0, paused: 0 });
    expect(row.parts.map((p) => p.id)).toEqual(['live']);
    expect(row.text).toBe('Idle');
    expect(dockStatus({ live: working, tasks: null, memory: null, queued: 0, paused: 0 }).parts).toHaveLength(1);
  });
  it('the clean-slate offer only when the memory part offers it; amber from 80 %', () => {
    const offer = dockStatus({ live: working, tasks: null, memory: { pct: 84, offer: true, running: null }, queued: 0, paused: 0 });
    expect(offer.offer).toBe(true);
    expect(offer.parts[1]).toMatchObject({ id: 'memory', text: 'Memory 84%', tone: 'amber' });
    expect(dockStatus({ live: working, tasks: null, memory: { pct: 84, offer: false, running: null }, queued: 0, paused: 0 }).offer).toBe(false);
    const running = dockStatus({ live: working, tasks: null, memory: { pct: 90, offer: true, running: 'Writing a summary…' }, queued: 0, paused: 0 });
    expect(running.offer).toBe(false);
    expect(running.parts[1]?.text).toBe('Writing a summary…');
  });
  it('queued and paused messages are one line', () => {
    expect(dockStatus({ live: working, tasks: null, memory: null, queued: 1, paused: 2 }).parts[1]).toMatchObject({ id: 'queue', text: '1 queued · 2 paused', tone: 'amber' });
  });
  it('the box grows to about a fifth of the visible height, never under 4 lines', () => {
    expect(composerMaxHeight(900, 22)).toBe(198);
    expect(composerMaxHeight(844, 22)).toBe(186);
    expect(composerMaxHeight(300, 22)).toBe(106);
    expect(composerMaxHeight(844, 22, 0.17)).toBe(143);
  });
  it('your message folds after 12 lines', () => {
    expect(YOU_FOLD_LINES).toBe(12);
    expect(foldsYou(Array.from({ length: 12 }, () => 'x').join('\n'))).toBe(false);
    expect(foldsYou(Array.from({ length: 13 }, () => 'x').join('\n'))).toBe(true);
    expect(foldsYou('y'.repeat(90 * 13))).toBe(true);
  });
});
