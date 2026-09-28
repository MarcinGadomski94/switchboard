import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  type HistoryRoot,
  type HistorySession,
  type HistoryTranscript,
  buildHistoryRows,
  clip,
  commandHead,
  filterHistory,
  formatHistoryDate,
  historyBranchLine,
  isTerminalConversation,
  relativeToRoot,
  sessionModeLine,
  solutionOfPath,
} from '../../src/core/history.ts';
import {
  type TranscriptFacts,
  TRANSCRIPT_FACTS_VERSION,
  TranscriptParser,
  isCurrentFacts,
  parseTranscript,
  projectFolderPrefix,
  slugForCwd,
} from '../../src/core/transcript.ts';
import { slugForCwd as fakeSlug } from '../../tools/fake-claude/transcript.ts';
import { FIXTURE_IDS, FIXTURE_SANDBOX, asTerminal, fixtureLines, ndjson, withSessionId, withoutTypes } from '../helpers/transcripts.ts';

type Line = Record<string, unknown>;

async function facts(name: keyof typeof FIXTURE_IDS, transform: (lines: Line[]) => Line[] = (l) => l): Promise<TranscriptFacts> {
  return parseTranscript(FIXTURE_IDS[name], ndjson(transform(await fixtureLines(name, FIXTURE_SANDBOX))));
}

/** The lines up to and including the one whose uuid starts with `prefix`. */
function upTo(prefix: string): (lines: Line[]) => Line[] {
  return (lines) => {
    const index = lines.findIndex((line) => typeof line['uuid'] === 'string' && line['uuid'].startsWith(prefix));
    if (index < 0) throw new Error(`no line ${prefix}`);
    return lines.slice(0, index + 1);
  };
}

const ROOT = '/Users/dev/work space';

function baseFacts(fields: Partial<TranscriptFacts>): TranscriptFacts {
  return {
    v: TRANSCRIPT_FACTS_VERSION,
    sessionId: 'id-1',
    startCwd: ROOT,
    cwds: [ROOT],
    gitBranch: 'HEAD',
    startedAt: '2026-09-27T10:00:00.000Z',
    lastActivityAt: '2026-09-27T10:05:00.000Z',
    entrypoint: 'cli',
    entrypoints: ['cli'],
    firstPrompt: 'Fix the login page',
    firstCommand: null,
    startedWithCommand: false,
    lastPrompt: 'Fix the login page',
    humanTurns: 1,
    customTitle: null,
    aiTitle: null,
    lastText: 'Fixed.',
    prNumber: null,
    prompts: 'Fix the login page',
    badLines: 0,
    remoteControl: false,
    ...fields,
  };
}

function session(fields: Partial<HistorySession>): HistorySession {
  return {
    id: 'sb-1',
    name: 'pay-flow',
    claudeSessionId: 'claude-1',
    status: 'done',
    task: 'Build the pay flow.',
    workType: 'feature',
    mode: 'orchestrator',
    phase: 'ui-first',
    solutions: ['alpha-front', 'mobile'],
    createdAt: '2026-09-26T16:40:00.000Z',
    worktrees: [],
    folder: null,
    folderPath: null,
    ...fields,
  };
}

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const OLD = NOW - 60 * 60_000;

/** A workspace folder History reads under (D14): plain paths are unsaved workspaces. */
function workspaceRoot(root: string, folder: string | null = null): HistoryRoot {
  return { path: root, kind: 'workspace', folder, folderPath: root, repoName: null };
}

function rows(sessions: HistorySession[], transcripts: HistoryTranscript[], roots: ReadonlyArray<string | HistoryRoot> = [ROOT], caseInsensitive = false) {
  const folders = roots.map((root) => (typeof root === 'string' ? workspaceRoot(root) : root));
  return buildHistoryRows({ sessions, transcripts, roots: folders, caseInsensitive, now: NOW });
}

describe('transcript facts (M7.4, docs/spike-m0.md → Sample parse)', () => {
  it('tx-main: prompts, title, branch, times and the final reply', async () => {
    const tx = await facts('tx-main');
    expect(tx).toMatchObject({
      v: TRANSCRIPT_FACTS_VERSION,
      sessionId: FIXTURE_IDS['tx-main'],
      startCwd: `${FIXTURE_SANDBOX}/tx main`,
      cwds: [`${FIXTURE_SANDBOX}/tx main`],
      gitBranch: 'feature/tx-probe',
      entrypoint: 'sdk-cli',
      entrypoints: ['sdk-cli'],
      firstPrompt: 'Create a file named notes.txt containing the text ALPHA using the Write tool. Then reply with the single word DONE.',
      lastPrompt: 'Reply with exactly the word: finished',
      humanTurns: 2,
      customTitle: 'sb-tx-probe',
      aiTitle: null,
      lastText: 'finished',
      firstCommand: null,
      startedWithCommand: false,
      prNumber: null,
      startedAt: '2026-09-27T21:19:49.586Z',
      badLines: 0,
    });
    expect(tx.prompts.split('\n')).toHaveLength(2);
    expect(isCurrentFacts(tx)).toBe(true);
    expect(isCurrentFacts({ ...tx, v: 0 })).toBe(false);
  });

  it('handoff: a session resumed from another folder keeps both working folders', async () => {
    const handoff = await facts('handoff');
    expect(handoff.cwds).toEqual([`${FIXTURE_SANDBOX}/handoff`, `${FIXTURE_SANDBOX}/handoff-elsewhere`]);
    expect(handoff.humanTurns).toBe(4);
    expect(handoff.lastText).toBe('tangerine, kestrel');
  });

  it('a forked file (two leaves) follows the newest leaf, like the CLI (M0.4 handoff-conc)', async () => {
    expect((await facts('handoff-conc')).lastText).toBe('lantern, walnut');
    // Cut right after the terminal's new turn started (thinking only, no text yet): the newest leaf's
    // chain goes back to "walnut … OK", not to the other branch's later "lantern, walnut, quokka".
    const cut = await facts('handoff-conc', upTo('0743703f'));
    expect(cut.lastText).toBe('OK');
  });

  it('skips the synthetic "No response requested." line (M0.4 handoff-mid)', async () => {
    expect((await facts('handoff-mid')).lastText).toBe('marigold');
    const cut = await facts('handoff-mid', upTo('0bf92d23'));
    expect(cut.lastText).toMatch(/^I'll remember the code word: \*\*marigold\*\*/);
  });

  it('tells prompts from commands, meta lines, tool results, interrupts and notifications', () => {
    const env = { isSidechain: false, entrypoint: 'cli', cwd: ROOT, sessionId: 's', gitBranch: 'HEAD' };
    const user = (uuid: string, content: unknown, extra: Line = {}): Line => ({ ...env, type: 'user', uuid, parentUuid: null, timestamp: `2026-09-27T10:00:0${uuid}.000Z`, message: { role: 'user', content }, ...extra });
    const parser = new TranscriptParser('s');
    parser.push(user('1', '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }));
    parser.push(user('2', '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>1h  Watch   the build</command-args>'));
    parser.push(user('3', '<local-command-stdout>ok</local-command-stdout>'));
    parser.push(user('4', [{ type: 'tool_result', tool_use_id: 't', content: 'done' }]));
    parser.push(user('5', [{ type: 'text', text: '[Request interrupted by user]' }]));
    parser.push(user('6', 'A background agent finished', { turnOrigin: 'task_notification' }));
    parser.push(user('7', 'Queued by the system', { promptSource: 'system' }));
    parser.push(user('8', [{ type: 'text', text: 'Now fix the build' }, { type: 'image' }]));
    parser.push({ type: 'custom-title', customTitle: 'first', sessionId: 's' });
    parser.push({ type: 'custom-title', customTitle: 'second', sessionId: 's' });
    parser.push({ type: 'ai-title', aiTitle: 'AI title', sessionId: 's' });
    parser.push({ type: 'pr-link', prNumber: 41, prUrl: 'u', sessionId: 's' });
    parser.push({ type: 'pr-link', prNumber: 42, prUrl: 'u', sessionId: 's' });
    parser.pushLine('not json');
    parser.pushLine('[1,2]');
    parser.pushLine('   ');
    const result = parser.finish();
    expect(result).toMatchObject({
      firstCommand: '/loop 1h Watch the build',
      startedWithCommand: true,
      firstPrompt: 'Now fix the build',
      lastPrompt: 'Now fix the build',
      humanTurns: 1,
      entrypoint: 'cli',
      customTitle: 'second',
      aiTitle: 'AI title',
      prNumber: 42,
      lastText: null,
      badLines: 2,
      startedAt: '2026-09-27T10:00:01.000Z',
      lastActivityAt: '2026-09-27T10:00:08.000Z',
    });
  });

  it('a command after the first prompt does not make the session command-started; sidechain lines are ignored', () => {
    const env = { entrypoint: 'cli', cwd: ROOT, sessionId: 's' };
    const parser = new TranscriptParser('s');
    parser.push({ ...env, type: 'user', uuid: 'a', isSidechain: true, message: { content: 'sidechain prompt' }, cwd: '/elsewhere' });
    parser.push({ ...env, type: 'user', uuid: 'b', isSidechain: false, message: { content: 'Typed first' } });
    parser.push({ ...env, type: 'user', uuid: 'c', parentUuid: 'b', isSidechain: false, message: { content: '<command-name>/compact</command-name>' } });
    parser.push({ ...env, type: 'assistant', uuid: 'd', parentUuid: 'c', isSidechain: true, message: { id: 'm0', content: [{ type: 'text', text: 'sidechain text' }] } });
    expect(parser.finish()).toMatchObject({ firstPrompt: 'Typed first', firstCommand: '/compact', startedWithCommand: false, startCwd: ROOT, lastText: null });
  });

  it('joins the text blocks of one message written as several lines', () => {
    const env = { isSidechain: false, entrypoint: 'cli', cwd: ROOT, sessionId: 's' };
    const parser = new TranscriptParser('s');
    parser.push({ ...env, type: 'user', uuid: 'u', parentUuid: null, message: { content: 'Go' } });
    parser.push({ ...env, type: 'assistant', uuid: 'a1', parentUuid: 'u', message: { id: 'm1', content: [{ type: 'text', text: 'Part one.' }] } });
    parser.push({ ...env, type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
    parser.push({ ...env, type: 'assistant', uuid: 'a3', parentUuid: 'a2', message: { id: 'm1', content: [{ type: 'text', text: 'Part two.' }] } });
    expect(parser.finish().lastText).toBe('Part one.\nPart two.');
  });

  it('slugs like the CLI (the fake keeps its own copy) and shares the root prefix with every subfolder slug', () => {
    for (const cwd of ['/Users/dev/work space/tx main', `/Users/dev/${'a'.repeat(230)}/b`, '/tmp/slug chars (a+b) ż_é.v2@#1']) {
      expect(slugForCwd(cwd)).toBe(fakeSlug(cwd));
    }
    const root = '/Users/dev/work space';
    expect(slugForCwd(`${root}/microfrontends/alpha-front`).startsWith(projectFolderPrefix(root))).toBe(true);
    const longRoot = `/Users/dev/${'x'.repeat(210)}`;
    expect(slugForCwd(`${longRoot}/mobile`).startsWith(projectFolderPrefix(longRoot))).toBe(true);
    expect(projectFolderPrefix(longRoot)).toHaveLength(200);
  });
});

describe('History rows (M7.4, gap #5)', () => {
  it('a stored session: DB name, mode line and status; the transcript\'s last reply; worktree branches and PR', () => {
    const stored = session({
      worktrees: [
        { repo: 'alpha-front', branch: 'session/pay-flow', prNumber: 231, prState: 'MERGED' },
        { repo: 'mobile', branch: 'session/pay-flow', prNumber: null, prState: null },
      ],
      solutions: ['alpha-front', 'mobile', 'contracts'],
    });
    const [row] = filterHistory(rows([stored], [{ facts: baseFacts({ sessionId: 'claude-1', entrypoint: 'sdk-cli', entrypoints: ['sdk-cli', 'cli'], lastText: 'All   done.\nPR opened.' }), mtimeMs: OLD }]), '');
    expect(row).toEqual({
      claudeSessionId: 'claude-1',
      sessionId: 'sb-1',
      startedAt: '2026-09-26T16:40:00.000Z',
      name: 'pay-flow',
      displayTitle: 'pay-flow',
      mode: 'orch · feature · UI-first',
      summary: 'All done. PR opened.',
      branches: [
        { solution: 'alpha-front', branch: 'session/pay-flow' },
        { solution: 'mobile', branch: 'session/pay-flow' },
      ],
      solutions: ['contracts'],
      outcome: 'PR #231 merged',
      status: 'done',
      folder: null,
      folderPath: null,
    });
    expect(historyBranchLine(row!)).toBe('alpha-front ⎇ session/pay-flow · mobile ⎇ session/pay-flow · contracts');
  });

  it('a stored session without a transcript shows its task and status; more PRs read "+n"; a transcript PR link counts', () => {
    const noTranscript = session({ id: 'sb-2', claudeSessionId: 'claude-2', name: 'in-place', status: 'run', mode: 'single', workType: 'qa', phase: null, solutions: ['alpha-front'] });
    const twoPrs = session({
      id: 'sb-3',
      claudeSessionId: 'claude-3',
      name: 'two-prs',
      worktrees: [
        { repo: 'a', branch: 'b', prNumber: 7, prState: 'OPEN' },
        { repo: 'c', branch: 'd', prNumber: 8, prState: 'MERGED' },
      ],
    });
    const linked = session({ id: 'sb-4', claudeSessionId: 'claude-4', name: 'linked', status: 'paused' });
    const items = filterHistory(rows([noTranscript, twoPrs, linked], [{ facts: baseFacts({ sessionId: 'claude-4', prNumber: 12 }), mtimeMs: OLD }]), undefined);
    const byName = Object.fromEntries(items.map((item) => [item.name, item]));
    expect(byName['in-place']).toMatchObject({ summary: 'Build the pay flow.', outcome: 'running', mode: 'single · QA', branches: [], solutions: ['alpha-front'] });
    expect(byName['two-prs']?.outcome).toBe('PR #7 open +1');
    expect(byName['linked']?.outcome).toBe('PR #12');
  });

  it('terminal-started sessions: title → ai-title → first prompt → command; terminal mode; active / ended by mtime', () => {
    const t = (fields: Partial<TranscriptFacts>, mtimeMs = OLD): HistoryTranscript => ({ facts: baseFacts(fields), mtimeMs });
    const items = filterHistory(
      rows([], [
        t({ sessionId: 'c1', customTitle: 'my title', aiTitle: 'ai', startedAt: '2026-09-27T10:00:00.000Z' }),
        t({ sessionId: 'c2', aiTitle: 'AI named', startedAt: '2026-09-27T09:00:00.000Z' }, NOW - ACTIVE_WINDOW_MS + 1_000),
        t({ sessionId: 'c3', firstPrompt: `Please ${'x'.repeat(80)}`, startedAt: '2026-09-27T08:00:00.000Z', prNumber: 5 }),
        t({
          sessionId: 'c4',
          firstPrompt: null,
          prompts: '',
          lastPrompt: null,
          lastText: null,
          firstCommand: '/loop 1h Monitor production errors',
          startedWithCommand: true,
          startedAt: '2026-09-27T07:00:00.000Z',
        }),
      ]),
      '',
    );
    expect(items.map((i) => [i.claudeSessionId, i.name, i.mode, i.outcome, i.status, i.sessionId])).toEqual([
      ['c1', 'my title', 'terminal', 'ended', 'idle', null],
      ['c2', 'AI named', 'terminal', 'active', 'run', null],
      ['c3', `Please ${'x'.repeat(52)}…`, 'terminal', 'PR #5', 'idle', null],
      ['c4', '/loop 1h Monitor production errors', 'terminal · /loop 1h', 'ended', 'idle', null],
    ]);
    expect(items[3]?.summary).toBe('');
  });

  it('terminal folders become solutions and the start branch a branch ref', () => {
    const [item] = filterHistory(
      rows([], [
        {
          facts: baseFacts({
            startCwd: `${ROOT}/microfrontends/alpha-front`,
            cwds: [`${ROOT}/microfrontends/alpha-front`, `${ROOT}/microfrontends/alpha-front/src`, `${ROOT}/mobile/App`, ROOT, '/elsewhere'],
            gitBranch: 'feature/login',
          }),
          mtimeMs: OLD,
        },
      ]),
      '',
    );
    expect(item?.branches).toEqual([{ solution: 'alpha-front', branch: 'feature/login' }]);
    expect(item?.solutions).toEqual(['mobile']);
  });

  it('hides headless files not in the DB, stubs, other roots, and every transcript row without a root', () => {
    const transcripts: HistoryTranscript[] = [
      { facts: baseFacts({ sessionId: 'headless', entrypoint: 'sdk-cli', entrypoints: ['sdk-cli'] }), mtimeMs: OLD },
      { facts: baseFacts({ sessionId: 'stub', firstPrompt: null, firstCommand: null, prompts: '', lastText: null, entrypoint: null }), mtimeMs: OLD },
      { facts: baseFacts({ sessionId: 'other-root', startCwd: `${ROOT}2/app`, cwds: [`${ROOT}2/app`] }), mtimeMs: OLD },
      { facts: baseFacts({ sessionId: 'no-cwd', startCwd: null, cwds: [] }), mtimeMs: OLD },
      { facts: baseFacts({ sessionId: 'kept' }), mtimeMs: OLD },
    ];
    expect(filterHistory(rows([], transcripts), '').map((i) => i.claudeSessionId)).toEqual(['kept']);
    expect(filterHistory(rows([], transcripts, []), '')).toEqual([]);
  });

  it('D16: a terminal row is marked terminal and carries its first prompt (else command) and start cwd; stored rows are not', () => {
    const items = filterHistory(
      rows([session({ claudeSessionId: 'stored' })], [
        { facts: baseFacts({ sessionId: 'p1', firstPrompt: `Fix   the\nlogin ${'y'.repeat(300)}`, startCwd: `${ROOT}/mobile` }), mtimeMs: OLD },
        { facts: baseFacts({ sessionId: 'c1', firstPrompt: null, firstCommand: '/loop 1h Watch', startedWithCommand: true }), mtimeMs: OLD },
      ]),
      '',
    );
    const byId = Object.fromEntries(items.map((item) => [item.claudeSessionId, item]));
    expect(byId['p1']).toMatchObject({ terminal: true, cwd: `${ROOT}/mobile` });
    expect(byId['p1']?.firstPrompt).toBe(`Fix the login ${'y'.repeat(225)}…`);
    expect(byId['c1']).toMatchObject({ terminal: true, firstPrompt: '/loop 1h Watch', cwd: ROOT });
    expect(byId['claude-1']).toBeUndefined();
    expect(byId['stored']?.terminal).toBeUndefined();
    expect(isTerminalConversation(baseFacts({}))).toBe(true);
    expect(isTerminalConversation(baseFacts({ entrypoint: 'sdk-cli' }))).toBe(false);
    expect(isTerminalConversation(baseFacts({ firstPrompt: null }))).toBe(false);
    expect(isTerminalConversation(baseFacts({ startCwd: null }))).toBe(false);
  });

  it('a stored session keeps one row even when its file mixes sdk-cli and cli, and a newer duplicate file wins', () => {
    const stored = session({ claudeSessionId: 'mixed' });
    const items = filterHistory(
      rows([stored], [
        { facts: baseFacts({ sessionId: 'mixed', entrypoint: 'sdk-cli', entrypoints: ['sdk-cli', 'cli'], lastText: 'older' }), mtimeMs: OLD },
        { facts: baseFacts({ sessionId: 'mixed', entrypoint: 'sdk-cli', entrypoints: ['sdk-cli', 'cli'], lastText: 'newer' }), mtimeMs: OLD + 1 },
      ]),
      '',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'pay-flow', summary: 'newer', sessionId: 'sb-1' });
  });

  it('compares the root case-insensitively when asked (macOS, Windows) and accepts either root form', () => {
    const facts1 = baseFacts({ startCwd: '/users/DEV/Work Space/x', cwds: ['/users/DEV/Work Space/x'] });
    expect(filterHistory(rows([], [{ facts: facts1, mtimeMs: OLD }], [ROOT], true), '')).toHaveLength(1);
    expect(filterHistory(rows([], [{ facts: facts1, mtimeMs: OLD }], [ROOT], false), '')).toHaveLength(0);
    expect(filterHistory(rows([], [{ facts: baseFacts({}), mtimeMs: OLD }], ['/real/root', ROOT]), '')).toHaveLength(1);
  });

  it('D14: each row carries its folder; a terminal row belongs to the most specific folder; in a repo folder its one solution', () => {
    const repoRoot = `${ROOT}/other/switchboard`;
    const roots: HistoryRoot[] = [
      workspaceRoot(ROOT, 'ws-id'),
      { path: repoRoot, kind: 'repo', folder: 'repo-id', folderPath: repoRoot, repoName: 'switchboard' },
    ];
    const stored = session({ folder: 'ws-id', folderPath: ROOT });
    const all = filterHistory(
      rows(
        [stored],
        [
          { facts: baseFacts({ sessionId: 'in-ws', startCwd: `${ROOT}/mobile`, cwds: [`${ROOT}/mobile`], gitBranch: 'main', startedAt: '2026-09-28T01:00:00.000Z' }), mtimeMs: OLD },
          {
            facts: baseFacts({ sessionId: 'in-repo', startCwd: `${repoRoot}/src`, cwds: [`${repoRoot}/src`, `${ROOT}/nugets/typography-nuget`], gitBranch: 'dev', startedAt: '2026-09-28T02:00:00.000Z' }),
            mtimeMs: OLD,
          },
        ],
        roots,
      ),
      '',
    );
    const byId = Object.fromEntries(all.map((item) => [item.claudeSessionId, item]));
    expect(byId['claude-1']).toMatchObject({ folder: 'ws-id', folderPath: ROOT });
    expect(byId['in-ws']).toMatchObject({ folder: 'ws-id', folderPath: ROOT, branches: [{ solution: 'mobile', branch: 'main' }] });
    expect(byId['in-repo']).toMatchObject({ folder: 'repo-id', folderPath: repoRoot, branches: [{ solution: 'switchboard', branch: 'dev' }], solutions: ['typography-nuget'] });
  });

  it('lists newest first and searches the row, the task, every prompt, the whole last reply and the folders', () => {
    const stored = session({ task: 'Refactor the checkout basket' });
    const long = `${'word '.repeat(80)}needle-at-the-end`;
    const transcripts: HistoryTranscript[] = [
      { facts: baseFacts({ sessionId: 't1', startedAt: '2026-09-27T01:00:00.000Z', prompts: 'first\nsecond mentions kestrel', lastText: long }), mtimeMs: OLD },
      { facts: baseFacts({ sessionId: 't2', startedAt: '2026-09-28T01:00:00.000Z', cwds: [ROOT, `${ROOT}/nugets/typography-nuget`] }), mtimeMs: OLD },
    ];
    const all = rows([stored], transcripts);
    expect(all.map((r) => r.item.claudeSessionId)).toEqual(['t2', 't1', 'claude-1']);
    expect(all[1]?.item.summary.endsWith('…')).toBe(true);
    expect(filterHistory(all, 'KESTREL').map((i) => i.claudeSessionId)).toEqual(['t1']);
    expect(filterHistory(all, 'needle-at-the-end').map((i) => i.claudeSessionId)).toEqual(['t1']);
    expect(filterHistory(all, 'checkout basket').map((i) => i.claudeSessionId)).toEqual(['claude-1']);
    expect(filterHistory(all, 'typography').map((i) => i.claudeSessionId)).toEqual(['t2']);
    expect(filterHistory(all, '  ended ').map((i) => i.claudeSessionId)).toEqual(['t2', 't1']);
    expect(filterHistory(all, 'nothing like this')).toEqual([]);
  });
});

describe('History helpers', () => {
  it('maps folders to solutions by the router layout', () => {
    expect(solutionOfPath('')).toBeNull();
    expect(solutionOfPath('microfrontends/auth-front/src')).toBe('auth-front');
    expect(solutionOfPath('nugets/typography-nuget')).toBe('typography-nuget');
    expect(solutionOfPath('microservices')).toBe('microservices');
    expect(solutionOfPath('other/switchboard/.spike')).toBe('switchboard');
    expect(solutionOfPath('mobile/App')).toBe('mobile');
    expect(solutionOfPath('infrastructure')).toBe('infrastructure');
    expect(solutionOfPath('deprecated/microfrontends/old-front/x')).toBe('old-front');
    expect(solutionOfPath('deprecated/mobile/App')).toBe('mobile');
    expect(solutionOfPath('functions\\calendar-func')).toBe('calendar-func');
  });

  it('relativeToRoot needs a separator after the root', () => {
    expect(relativeToRoot('/a/ws', '/a/ws/', false)).toBe('');
    expect(relativeToRoot('/a/ws/x/y', '/a/ws', false)).toBe('x/y');
    expect(relativeToRoot('/a/ws2/x', '/a/ws', false)).toBeNull();
    expect(relativeToRoot('C:\\ws\\x', 'C:\\ws', false)).toBe('x');
  });

  it('formats dates, clips text, heads commands and builds mode lines', () => {
    const local = new Date(2026, 8, 26, 16, 40).toISOString();
    expect(formatHistoryDate(local)).toBe('09-26 16:40');
    expect(formatHistoryDate('nope')).toBe('');
    expect(clip('  a\n\n b  ', 10)).toBe('a b');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(commandHead('/loop 1h Watch it')).toBe('/loop 1h');
    expect(commandHead('/clear')).toBe('/clear');
    expect(sessionModeLine({ mode: 'orchestrator', workType: 'qa', phase: null })).toBe('orch · QA');
    expect(sessionModeLine({ mode: null, workType: null, phase: 'integration' })).toBe('integration');
    expect(sessionModeLine({ mode: null, workType: null, phase: null, origin: 'terminal' })).toBe('terminal · moved');
  });
});

describe('fixture helpers', () => {
  it('turn a recorded transcript into a terminal session with another id', async () => {
    const lines = asTerminal(withSessionId(withoutTypes(await fixtureLines('tx-main', '/tmp/ws'), 'custom-title', 'agent-name'), 'new-id'));
    const parsed = parseTranscript('new-id', ndjson(lines));
    expect(parsed).toMatchObject({ entrypoint: 'cli', entrypoints: ['cli'], customTitle: null, startCwd: '/tmp/ws/tx main' });
    expect(lines.every((line) => line['sessionId'] === undefined || line['sessionId'] === 'new-id')).toBe(true);
  });
});
