import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NewSession } from '../../src/core/api.ts';
import {
  REPO_WORKTREE_NOTE_HEADER,
  SESSION_START_HEADER,
  SOLUTIONS_NOT_CHOSEN,
  agentWorktreesInstruction,
  asksMobileCoordination,
  firstTurnPayload,
  repoWorktreeNote,
  sessionStartBlock,
  withoutSessionStartBlock,
} from '../../src/core/first-turn.ts';
import type { WorktreeRecord } from '../../src/server/db/repos/worktrees.ts';
import { buildFirstTurn, sessionStartAnswers } from '../../src/server/sessions/first-turn.ts';
import { WorktreeError } from '../../src/server/worktrees/manager.ts';
import { folderRef } from '../helpers/folders.ts';
import { makeTempDir, removeTempDir } from '../helpers/net.ts';

function session(overrides: Partial<NewSession> = {}): NewSession {
  return {
    name: 'demo',
    task: 'Do the thing.',
    workType: 'feature',
    mode: 'single',
    solutions: ['web-front'],
    phase: 'ui-first',
    coordination: 'sequential',
    qa: null,
    worktrees: false,
    ultracode: false,
    ...overrides,
  };
}

/** The block's `- Label: value` lines (the header dropped). */
function items(s: NewSession, folders: readonly string[] = s.solutions): string[] {
  return sessionStartBlock({ session: s, folders, worktrees: [] }).split('\n').slice(SESSION_START_HEADER.length);
}

describe('sessionStartBlock (M5.2)', () => {
  it('opens with the confirmed-by-the-developer header', () => {
    const block = sessionStartBlock({ session: session(), folders: ['microfrontends/web-front'], worktrees: [] });
    expect(block.split('\n').slice(0, 2)).toEqual([...SESSION_START_HEADER]);
  });

  it('mobile coordination only for feature + single + a *-front, and only when given', () => {
    expect(items(session({ coordination: 'sequential' }))).toContain('- Mobile coordination: sequential');
    expect(items(session({ coordination: 'parallel-twin' }))).toContain('- Mobile coordination: parallel-twin');
    expect(items(session({ coordination: 'none' }))).toContain('- Mobile coordination: no counterpart');
    expect(items(session({ coordination: null })).some((line) => line.startsWith('- Mobile coordination'))).toBe(false);
    expect(items(session({ solutions: ['mobile'], coordination: 'none' })).some((line) => line.startsWith('- Mobile coordination'))).toBe(false);
    expect(items(session({ mode: 'orchestrator' })).some((line) => line.startsWith('- Mobile coordination'))).toBe(false);
    expect(asksMobileCoordination({ workType: 'feature', mode: 'single', solutions: ['microfrontends/auth-front'] })).toBe(true);
    expect(asksMobileCoordination({ workType: 'qa', mode: 'single', solutions: ['auth-front'] })).toBe(false);
  });

  it('QA: stack and sources, `—` for what was left empty; never mobile coordination', () => {
    const lines = items(session({ workType: 'qa', coordination: 'sequential', qa: { stack: 'both', confluenceUrl: ' ', figmaUrls: ['', ' '] } }));
    expect(lines).toEqual([
      '- Work type: test-authoring (QA)',
      '- Mode: single-solution',
      '- Solutions in scope: web-front',
      '- Phase: UI-first',
      '- Stack under test: both',
      '- Confluence page: —',
      '- Figma frames: —',
      '- Ultracode: off',
      '- Worktrees: no worktrees · edits in place',
    ]);
  });

  it('worktrees: one line per worktree with its absolute path and branch', () => {
    const s = session({ worktrees: true, ultracode: true, phase: 'integration', solutions: ['web-front', 'mobile'], mode: 'orchestrator' });
    const block = sessionStartBlock({
      session: s,
      folders: ['microfrontends/web-front', 'mobile'],
      worktrees: [
        { folder: 'microfrontends/web-front', path: '/w/microfrontends/web-front-wt-demo', branch: 'session/demo' },
        { folder: 'mobile', path: '/w/mobile-wt-demo', branch: 'session/demo' },
      ],
    });
    expect(block.split('\n').slice(SESSION_START_HEADER.length)).toEqual([
      '- Work type: feature-building',
      '- Mode: workspace orchestrator',
      '- Solutions in scope: microfrontends/web-front, mobile',
      '- Phase: integration',
      '- Ultracode: on',
      '- Worktrees (one per solution; make every change there, not in the main checkout):',
      '  - microfrontends/web-front: /w/microfrontends/web-front-wt-demo (branch session/demo)',
      '  - mobile: /w/mobile-wt-demo (branch session/demo)',
    ]);
  });
});

describe('sessionStartBlock · D38: solutions chosen by the agent', () => {
  it('no solutions: "not chosen" with the instruction, no mobile coordination, edits in place without worktrees', () => {
    expect(items(session({ solutions: [], coordination: 'sequential' }))).toEqual([
      '- Work type: feature-building',
      '- Mode: single-solution',
      '- Solutions in scope: not chosen: determine them from the task and the router (AGENTS.md), name them in your one-line confirmation before you change anything, and ask if it is unclear',
      '- Phase: UI-first',
      '- Ultracode: off',
      '- Worktrees: no worktrees · edits in place',
    ]);
    expect(SOLUTIONS_NOT_CHOSEN.startsWith('not chosen: ')).toBe(true);
  });

  it('no solutions + worktrees: the agent creates one per solution it changes, on the ticket branch, at <repo>-wt-<name>', () => {
    const s = session({ name: 'free-talk', solutions: [], worktrees: true, branch: 'PROJ-12-free-talk', mode: 'orchestrator' });
    const lines = sessionStartBlock({ session: s, folders: [], worktrees: [], agentBranch: 'PROJ-12-free-talk' }).split('\n').slice(SESSION_START_HEADER.length);
    expect(lines).toEqual([
      '- Work type: feature-building',
      '- Mode: workspace orchestrator',
      `- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`,
      '- Phase: UI-first',
      '- Ultracode: off',
      "- Worktrees: for each solution you change, create a git worktree on branch PROJ-12-free-talk at <the solution repo's parent>/<repo>-wt-free-talk (git worktree add -b PROJ-12-free-talk <path>, from the repo's current HEAD) and make every change there, not in the main checkout",
    ]);
    // Without the service's branch, the session's own (the ticket branch).
    expect(sessionStartBlock({ session: s, folders: [], worktrees: [] })).toContain(`- Worktrees: ${agentWorktreesInstruction('PROJ-12-free-talk', 'free-talk')}`);
  });

  it('a scheduled run (no ticket branch): the instruction names session/{name}', () => {
    const s = session({ name: 'nightly-0929-0200', solutions: [], worktrees: true });
    const block = sessionStartBlock({ session: s, folders: [], worktrees: [], agentBranch: 'session/nightly-0929-0200' });
    expect(block).toContain('create a git worktree on branch session/nightly-0929-0200 at <the solution repo\'s parent>/<repo>-wt-nightly-0929-0200 (git worktree add -b session/nightly-0929-0200 <path>');
    // One paragraph, so the chat hides it like any answers block.
    expect(block.includes('\n\n')).toBe(false);
    expect(withoutSessionStartBlock(firstTurnPayload('Check the build.', block))).toBe('Check the build.');
  });

  it('QA without solutions: not chosen, the QA contract as before', () => {
    const lines = items(session({ workType: 'qa', solutions: [], qa: { stack: 'web', confluenceUrl: 'https://c/1', figmaUrls: ['https://f/1'] } }));
    expect(lines.slice(2, 5)).toEqual([`- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`, '- Phase: UI-first', '- Stack under test: web']);
  });

  it('buildFirstTurn: the service passes the branch the agent creates its worktrees on', async () => {
    const turn = await buildFirstTurn(session({ name: 'demo', solutions: [], worktrees: true }), {
      folder: folderRef('/does/not/exist/ws'),
      worktrees: [],
      resolveRepo: async () => {
        throw new Error('nothing to resolve');
      },
      agentBranch: 'PROJ-7-demo',
    });
    expect(turn.block).toContain(`- Solutions in scope: ${SOLUTIONS_NOT_CHOSEN}`);
    expect(turn.block).toContain(`- Worktrees: ${agentWorktreesInstruction('PROJ-7-demo', 'demo')}`);
    expect(turn.message).toBe(`Do the thing.\n\n${turn.block}`);
  });
});

describe('firstTurnPayload (M5.2)', () => {
  it('task first (trimmed), a blank line, then the block; an empty task gives no message', () => {
    expect(firstTurnPayload('  Fix it.\n', 'BLOCK')).toBe('Fix it.\n\nBLOCK');
    expect(firstTurnPayload(' \n ', 'BLOCK')).toBe('');
    expect(firstTurnPayload('', 'BLOCK')).toBe('');
  });
});

describe('sessionStartAnswers (M5.2): workspace folders', () => {
  let tmp = '';
  afterEach(async () => {
    if (tmp) await removeTempDir(tmp);
    tmp = '';
  });

  it('folders from the worktree records, else the resolver, else the name as given', async () => {
    tmp = await realpath(await makeTempDir('first-turn'));
    const root = path.join(tmp, 'work space');
    await mkdir(root, { recursive: true });
    const record = { repo: 'web-front', repoPath: path.join(root, 'microfrontends', 'web-front'), path: path.join(root, 'microfrontends', 'web-front-wt-demo'), branch: 'session/demo' } as WorktreeRecord;
    const resolved: string[] = [];
    const answers = await sessionStartAnswers(session({ solutions: ['web-front', 'mobile', 'nowhere', 'outside'], worktrees: true }), {
      folder: folderRef(root),
      worktrees: [record],
      resolveRepo: async (solution) => {
        resolved.push(solution);
        if (solution === 'mobile') return { solution, repoPath: path.join(root, 'mobile') };
        if (solution === 'outside') return { solution, repoPath: path.join(tmp, 'elsewhere') };
        throw new WorktreeError('solution-not-found', `no ${solution}`);
      },
    });
    expect(answers.folders).toEqual(['microfrontends/web-front', 'mobile', 'nowhere', 'outside']);
    expect(resolved).toEqual(['mobile', 'nowhere', 'outside']);
    expect(answers.worktrees).toEqual([{ folder: 'microfrontends/web-front', path: record.path, branch: 'session/demo' }]);
  });

  it('a name that resolves outside the folder (or not at all) is used as given', async () => {
    const sources = { worktrees: [], resolveRepo: async () => ({ solution: 'x', repoPath: '/x' }) };
    expect((await sessionStartAnswers(session({ solutions: ['a\\b'] }), { ...sources, folder: folderRef('/does/not/exist/switchboard') })).folders).toEqual(['a/b']);
    expect((await sessionStartAnswers(session(), { ...sources, folder: folderRef('/does/not/exist/switchboard') })).folders).toEqual(['web-front']);
    const turn = await buildFirstTurn(session({ task: '' }), { ...sources, folder: folderRef('/does/not/exist/switchboard') });
    expect(turn.message).toBe('');
    expect(turn.block).toContain('- Solutions in scope: web-front');
  });
});

describe('buildFirstTurn · repo folder (D14): only the worktree note, no router answers', () => {
  const repo = folderRef('/w/switchboard', 'repo');
  const noResolve = async (): Promise<never> => {
    throw new Error('a repo folder resolves nothing');
  };
  const repoSession = { ...session({ solutions: ['switchboard'] }), workType: null, mode: null, phase: null, coordination: null };

  it('without a worktree the task goes out alone', async () => {
    const turn = await buildFirstTurn(repoSession, { folder: repo, worktrees: [], resolveRepo: noResolve });
    expect(turn).toEqual({ message: 'Do the thing.', block: '' });
    expect(await buildFirstTurn({ ...repoSession, task: '  ' }, { folder: repo, worktrees: [], resolveRepo: noResolve })).toEqual({ message: '', block: '' });
  });

  it('with its worktree the task + the note (worktree, branch, base, main checkout)', async () => {
    const record = { repo: 'switchboard', repoPath: '/w/switchboard', path: '/w/switchboard-wt-demo', branch: 'session/demo', baseRef: 'main' } as WorktreeRecord;
    const turn = await buildFirstTurn({ ...repoSession, worktrees: true }, { folder: repo, worktrees: [record], resolveRepo: noResolve });
    const note = repoWorktreeNote({ path: record.path, branch: 'session/demo', base: 'main', repoPath: '/w/switchboard' });
    expect(turn).toEqual({ message: `Do the thing.\n\n${note}`, block: note });
    expect(note.split('\n')).toEqual([
      REPO_WORKTREE_NOTE_HEADER,
      '- Worktree: /w/switchboard-wt-demo (branch session/demo, from main); it is your working folder: make every change here.',
      '- Main checkout: /w/switchboard (leave it as it is).',
    ]);
    expect(turn.message).not.toContain(SESSION_START_HEADER[0]);
    expect(turn.message).not.toContain('Work type');
    // The chat shows only what the developer typed.
    expect(withoutSessionStartBlock(turn.message)).toBe('Do the thing.');
    expect(withoutSessionStartBlock(note)).toBe('');
  });
});

describe('withoutSessionStartBlock (chat display)', () => {
  const block = [...SESSION_START_HEADER, '- Work type: feature-building'].join('\n');

  it('shows the task the developer typed, not the appended answers block', () => {
    expect(withoutSessionStartBlock(firstTurnPayload('Fix the login page.', block))).toBe('Fix the login page.');
  });

  it('keeps any other message as it is', () => {
    expect(withoutSessionStartBlock('Commit when green.')).toBe('Commit when green.');
    expect(withoutSessionStartBlock(`Quote:\n${SESSION_START_HEADER[0]}`)).toBe(`Quote:\n${SESSION_START_HEADER[0]}`);
  });

  it('shows nothing for a message that is only the block', () => {
    expect(withoutSessionStartBlock(block)).toBe('');
  });

  it('a session started without a task: the block goes in front of the first message, which the chat shows (bug 2026-09-28)', () => {
    // SessionSupervisor joins the outbox (the block) and the typed text with a blank line.
    expect(withoutSessionStartBlock(`${block}\n\napply rules from AGENTS.md.`)).toBe('apply rules from AGENTS.md.');
    expect(withoutSessionStartBlock(`${block}\n\nFirst paragraph.\n\nSecond paragraph.`)).toBe('First paragraph.\n\nSecond paragraph.');
    const note = repoWorktreeNote({ path: '/src/tool-wt-x', branch: 'session/x', base: 'main', repoPath: '/src/tool' });
    expect(withoutSessionStartBlock(`${note}\n\nStart with the tests.`)).toBe('Start with the tests.');
    // Another outbox note before the block (e.g. the restart note) stays, the text after it too.
    expect(withoutSessionStartBlock(`Restart note.\n\n${block}\n\nMy first message.`)).toBe('Restart note.\n\nMy first message.');
    // A task with paragraphs keeps them all when the block follows.
    expect(withoutSessionStartBlock(firstTurnPayload('Para one.\n\nPara two.', block))).toBe('Para one.\n\nPara two.');
  });
});
