import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentStatusFromTask, mainAgentName, subagentFromToolUse } from '../../src/core/derive/agents.ts';
import {
  createdBranches,
  diffArtifactName,
  fileArtifactType,
  findPullRequests,
  locateFile,
  locateSessionFile,
  runsGh,
  sessionSolutionFolder,
} from '../../src/core/derive/artifacts.ts';
import { toolEventKind, toolLabel, userMessageKind } from '../../src/core/derive/event-kind.ts';
import { deriveSessionStatus } from '../../src/core/derive/status.ts';
import { clip, clipInput } from '../../src/core/event-payload.ts';
import { childEnv } from '../../src/server/supervisor/argv.ts';

describe('event kinds (gap #7)', () => {
  it.each([
    ['Read', 'plan'],
    ['Grep', 'plan'],
    ['Glob', 'plan'],
    ['WebSearch', 'plan'],
    ['mcp__codebase-memory-mcp__search_graph', 'plan'],
    ['Edit', 'impl'],
    ['Write', 'impl'],
    ['MultiEdit', 'impl'],
    ['Bash', 'impl'],
    ['ScheduleWakeup', 'loop'],
    ['CronCreate', 'loop'],
    ['AskUserQuestion', 'ask'],
    ['Agent', 'tool'],
    ['TodoWrite', 'tool'],
    ['WebFetch', 'tool'],
  ])('%s → %s', (name, kind) => {
    expect(toolEventKind(name)).toBe(kind);
  });

  it('a Bash rerun after a failed run of the same command is a loop (rebuild / self-heal)', () => {
    expect(toolEventKind('Bash', { rerunAfterError: true })).toBe('loop');
    expect(toolEventKind('Write', { rerunAfterError: true })).toBe('impl');
  });

  it('/loop messages are loop, other messages text', () => {
    expect(userMessageKind('/loop 1h Monitor production')).toBe('loop');
    expect(userMessageKind('  /loop')).toBe('loop');
    expect(userMessageKind('/looping')).toBe('text');
    expect(userMessageKind('Build the free talk page')).toBe('text');
  });

  it('labels tool calls in one line', () => {
    expect(toolLabel('Write', { file_path: '/w/contracts/free-talk.md', content: 'x' })).toBe('Write · free-talk.md');
    expect(toolLabel('Bash', { command: 'dotnet build\n--no-restore' })).toBe('Bash · dotnet build');
    expect(toolLabel('Grep', { pattern: 'FreeTalk' })).toBe('Grep · FreeTalk');
    expect(toolLabel('Agent', { description: 'spec table', subagent_type: 'figma-extractor' })).toBe('Agent · figma-extractor · spec table');
    expect(toolLabel('AskUserQuestion', { questions: [{ question: 'Wrap or scroll?' }] })).toBe('Wrap or scroll?');
    expect(toolLabel('TodoWrite', {})).toBe('TodoWrite');
  });
});

describe('agents (gap #8)', () => {
  it('names the main agent from the mode', () => {
    expect(mainAgentName('orchestrator', ['a', 'b'])).toBe('orchestrator');
    expect(mainAgentName('single', ['calendar-func'])).toBe('calendar-func');
    expect(mainAgentName('single', ['a', 'b'])).toBe('main');
    expect(mainAgentName(null, [])).toBe('main');
  });

  it('takes a subagent from its Agent call and its status from the task', () => {
    expect(subagentFromToolUse({ subagent_type: 'qa-web-playwright', description: 'AC 1-18' })).toEqual({
      name: 'qa-web-playwright',
      description: 'AC 1-18',
      subagentType: 'qa-web-playwright',
    });
    expect(subagentFromToolUse({})).toEqual({ name: 'agent', description: null, subagentType: null });
    expect(agentStatusFromTask('completed')).toBe('done');
    expect(agentStatusFromTask('failed')).toBe('fail');
    expect(agentStatusFromTask('killed')).toBe('idle');
    expect(agentStatusFromTask('running')).toBe('run');
    expect(agentStatusFromTask(null)).toBe('run');
  });
});

describe('artifacts (gap #9)', () => {
  const root = path.join(path.sep, 'ws');
  const at = (...parts: string[]) => path.join(root, ...parts);

  it('maps paths to solutions with the router layout', () => {
    expect(locateFile(root, at('microfrontends', 'acme-app-front', 'Pages', 'A.razor'))).toMatchObject({
      solution: 'acme-app-front',
      relative: 'Pages/A.razor',
      worktree: false,
    });
    expect(locateFile(root, at('mobile', 'mobile-followups', 'from-x.md'))).toMatchObject({ solution: 'mobile', relative: 'mobile-followups/from-x.md' });
    expect(locateFile(root, at('deprecated', 'microfrontends', 'old-chat-front', 'a.cs'))).toMatchObject({ solution: 'old-chat-front' });
    expect(locateFile(root, at('infrastructure', 'main.tf'))).toMatchObject({ solution: 'infrastructure', relative: 'main.tf' });
    expect(locateFile(root, at('contracts', 'free-talk.md'))).toMatchObject({ solution: null, relative: 'contracts/free-talk.md' });
    expect(locateFile(root, 'contracts/rel.md')).toMatchObject({ solution: null, relative: 'contracts/rel.md' });
    expect(locateFile(root, path.join(path.sep, 'elsewhere', 'x.md'))).toMatchObject({ solution: null, outside: true });
    expect(locateFile(root, at('microfrontends', 'AGENTS.md'))).toMatchObject({ solution: null, relative: 'microfrontends/AGENTS.md' });
  });

  it('maps a worktree folder `<repo>-wt-<session>` back to its repo (gap #1)', () => {
    expect(locateFile(root, at('microfrontends', 'acme-app-front-wt-free-talk', 'a.cs'), 'free-talk')).toMatchObject({
      solution: 'acme-app-front',
      relative: 'a.cs',
      worktree: true,
    });
    expect(locateFile(root, at('mobile-wt-free-talk', 'Views', 'V.xaml'), 'free-talk')).toMatchObject({
      solution: 'mobile',
      relative: 'Views/V.xaml',
      worktree: true,
    });
    expect(locateFile(root, at('mobile-wt-free-talk', 'x'), 'other-session')).toMatchObject({ solution: null });
  });

  it.each([
    ['coverage-matrix.md', 'QA'],
    ['qa/coverage-matrix.md', 'QA'],
    ['mobile-followups/from-acme-app-front.md', 'FOLLOWUP'],
    ['contracts/free-talk.md', 'CONTRACT'],
    ['docs/contracts/push.md', 'CONTRACT'],
    ['docs/derivations.md', 'DOC'],
    ['README.MD', 'DOC'],
    ['src/a.ts', null],
    ['contracts/schema.json', null],
  ])('%s → %s', (file, type) => {
    expect(fileArtifactType(file)).toBe(type);
  });

  it('finds PR URLs in gh output', () => {
    const out = 'Creating pull request\nhttps://github.com/acme/notifications-microservice/pull/88\nhttps://github.com/acme/notifications-microservice/pull/88';
    expect(findPullRequests(out)).toEqual([
      { url: 'https://github.com/acme/notifications-microservice/pull/88', owner: 'acme', repo: 'notifications-microservice', number: 88 },
    ]);
    expect(runsGh('cd microservices/x && gh pr create --fill')).toBe(true);
    expect(runsGh('echo gh pr create')).toBe(false);
  });

  it('finds branches a command creates, with the folder it ran in', () => {
    expect(createdBranches('cd microfrontends/acme-app-front && git checkout -b feature/free-talk-360')).toEqual([
      { branch: 'feature/free-talk-360', dir: 'microfrontends/acme-app-front' },
    ]);
    expect(createdBranches('git -C mobile switch -c feature/x; git branch -d old')).toEqual([{ branch: 'feature/x', dir: 'mobile' }]);
    expect(createdBranches('git worktree add ../repo-wt-s -b session/s HEAD')).toEqual([{ branch: 'session/s', dir: null }]);
    expect(createdBranches('git branch topic')).toEqual([{ branch: 'topic', dir: null }]);
    expect(createdBranches('git checkout main && git status')).toEqual([]);
    expect(createdBranches('echo "git checkout -b fake"')).toEqual([]);
  });

  it('names a DIFF by the common folder and the file count', () => {
    expect(diffArtifactName(['Pages/FreeTalk/A.razor', 'Pages/FreeTalk/B.cs'])).toBe('Pages/FreeTalk · 2 files');
    expect(diffArtifactName(['a.cs'])).toBe('1 file');
    expect(diffArtifactName(['Views/A.xaml', 'Models/B.cs'])).toBe('2 files');
  });
});

describe('session status', () => {
  const live = { live: true as const, openRequests: 0, turnRunning: false, runningAgents: 0, lastOutcome: null };
  const ended = { live: false as const, stopReason: null, exitCode: 0, signal: null, spawnFailed: false, lastOutcome: null };

  it('live: need > run > last outcome > idle', () => {
    expect(deriveSessionStatus({ ...live, openRequests: 1, turnRunning: true })).toBe('need');
    expect(deriveSessionStatus({ ...live, turnRunning: true, lastOutcome: 'error' })).toBe('run');
    expect(deriveSessionStatus({ ...live, runningAgents: 1, lastOutcome: 'success' })).toBe('run');
    expect(deriveSessionStatus({ ...live, lastOutcome: 'success' })).toBe('done');
    expect(deriveSessionStatus({ ...live, lastOutcome: 'error' })).toBe('fail');
    expect(deriveSessionStatus(live)).toBe('idle');
  });

  it('ended: a Switchboard stop is paused whatever the exit; otherwise fail unless a clean exit', () => {
    for (const stopReason of ['pause', 'detach'] as const) {
      expect(deriveSessionStatus({ ...ended, stopReason, exitCode: 0 })).toBe('paused');
      expect(deriveSessionStatus({ ...ended, stopReason, exitCode: 1 })).toBe('paused');
      expect(deriveSessionStatus({ ...ended, stopReason, exitCode: null, signal: 'SIGKILL' })).toBe('paused');
    }
    expect(deriveSessionStatus({ ...ended, exitCode: 1 })).toBe('fail');
    expect(deriveSessionStatus({ ...ended, exitCode: null, signal: 'SIGKILL' })).toBe('fail');
    expect(deriveSessionStatus({ ...ended, spawnFailed: true, exitCode: null })).toBe('fail');
    expect(deriveSessionStatus({ ...ended, exitCode: 0, lastOutcome: 'success' })).toBe('done');
    expect(deriveSessionStatus({ ...ended, exitCode: 0, lastOutcome: 'error' })).toBe('fail');
  });
});

describe('payload clipping and the child env', () => {
  it('cuts long strings and marks it', () => {
    expect(clip('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(clip('ab', 3)).toEqual({ text: 'ab', truncated: false });
    expect(clipInput({ a: 'abcdef', b: [{ c: 'xyzxyz' }], n: 1 }, 3)).toEqual({ input: { a: 'abc', b: [{ c: 'xyz' }], n: 1 }, truncated: true });
  });

  it('drops CLAUDECODE, CLAUDE_CODE_*, CLAUDE_PID, CLAUDE_EFFORT; keeps CLAUDE_CONFIG_DIR and the rest', () => {
    expect(
      childEnv({ CLAUDECODE: '1', CLAUDE_CODE_X: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'h', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', HOME: '/h' }),
    ).toEqual({ CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', HOME: '/h' });
  });
});

describe('artifacts in a repo folder (D14)', () => {
  const repo = path.join('/w', 'solo');
  const worktree = path.join('/w', 'solo-wt-demo');

  it('every file of a repo session belongs to its one solution, in its worktree or in the main checkout', () => {
    const inWorktree = { root: repo, kind: 'repo' as const, cwd: worktree };
    expect(locateSessionFile(inWorktree, 'docs/x.md', 'demo')).toEqual({ solution: 'solo', relative: 'docs/x.md', worktree: true, outside: false });
    expect(locateSessionFile(inWorktree, path.join(repo, 'contracts', 'a.md'), 'demo')).toEqual({ solution: 'solo', relative: 'contracts/a.md', worktree: false, outside: false });
    expect(locateSessionFile(inWorktree, path.join('/w', 'elsewhere', 'a.md'), 'demo')).toMatchObject({ solution: null, outside: true });
    expect(sessionSolutionFolder(inWorktree, 'src/app.ts', 'demo')).toBe('solo/');
    // In place (cwd = the repo); a worktree made later by "Move … to worktree" still maps to the repo.
    const inPlace = { root: repo, kind: 'repo' as const, cwd: repo };
    expect(locateSessionFile(inPlace, 'README.md', 'demo')).toEqual({ solution: 'solo', relative: 'README.md', worktree: false, outside: false });
    expect(locateSessionFile(inPlace, path.join(worktree, 'README.md'), 'demo')).toEqual({ solution: 'solo', relative: 'README.md', worktree: true, outside: false });
    expect(sessionSolutionFolder(inPlace, path.join('/w', 'other', 'x'), 'demo')).toBeNull();
  });

  it('a workspace session keeps the router layout', () => {
    const place = { root: '/ws', kind: 'workspace' as const, cwd: '/ws' };
    expect(locateSessionFile(place, '/ws/microfrontends/web-front/src/a.ts', 'demo')).toMatchObject({ solution: 'web-front', relative: 'src/a.ts' });
    expect(sessionSolutionFolder(place, '/ws/microfrontends/web-front/src/a.ts', 'demo')).toBe('microfrontends/web-front');
  });
});

describe('D59 · a plain folder session\'s files', () => {
  it('belong to no solution: inside the folder by their path, else outside; no solution folder', () => {
    const root = path.join('/w', 'notes');
    const place = { root, kind: 'plain' as const, cwd: root };
    expect(locateSessionFile(place, 'microfrontends/x-front/a.md', 'demo')).toEqual({ solution: null, relative: 'microfrontends/x-front/a.md', worktree: false, outside: false });
    expect(locateSessionFile(place, path.join(root, 'todo.txt'))).toEqual({ solution: null, relative: 'todo.txt', worktree: false, outside: false });
    expect(locateSessionFile(place, path.join('/w', 'elsewhere', 'a.md'))).toMatchObject({ solution: null, outside: true });
    expect(sessionSolutionFolder(place, 'mobile/a.md', 'demo')).toBeNull();
  });
});
