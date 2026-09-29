import { describe, expect, it } from 'vitest';
import {
  type AgentMeta,
  type AgentTranscriptFacts,
  NO_TRANSCRIPT,
  type WorkflowRunInput,
  cleanWorkflowBrief,
  deriveWorkflowRun,
  parseAgentMeta,
  parseJournal,
  parseRunFile,
  parseScriptMeta,
  parseWorkflowProgress,
  progressStatus,
  resultText,
  runStatus,
  scanAgentEntries,
  scriptFileName,
  workflowAgentEvents,
  workflowAgentKey,
  workflowAgents,
  workflowLaunch,
} from '../../src/core/derive/workflows.ts';

/**
 * D51 (`docs/derivations.md` → *Workflow agents*): the Workflow run and its agents
 * from the CLI's launch result, its `task_progress` snapshots and its files. The
 * shapes are those of CLI 2.1.284 (read in its binary and real session folders);
 * every fixture here is synthetic.
 */

const T0 = Date.parse('2026-09-29T10:00:00.000Z');
const at = (s: number): number => T0 + s * 1000;
const iso = (s: number): string => new Date(at(s)).toISOString();

function agentEntry(fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'workflow_agent', model: 'claude-opus-5-5', attempt: 1, ...fields };
}

function base(overrides: Partial<WorkflowRunInput> = {}): WorkflowRunInput {
  return {
    runId: 'wf_abc123-def',
    launch: { runId: 'wf_abc123-def', taskId: 'wk1', name: 'audit', summary: 'Audit the repos' },
    runFile: null,
    progress: null,
    journal: [],
    metas: new Map(),
    transcripts: new Map(),
    script: null,
    ended: null,
    running: true,
    ...overrides,
  };
}

describe('workflowLaunch', () => {
  it('takes the structured result, else the text; never launches on an error or a bad run id', () => {
    const text = 'Workflow launched in background. Task ID: wk1\nSummary: Audit the repos\nTranscript dir: /x/sess/subagents/workflows/wf_abc123-def\nRun ID: wf_abc123-def\n';
    expect(workflowLaunch(text, { status: 'async_launched', taskId: 'wk1', workflowName: 'audit', runId: 'wf_abc123-def', summary: 'Audit the repos' })).toEqual({
      runId: 'wf_abc123-def',
      taskId: 'wk1',
      name: 'audit',
      summary: 'Audit the repos',
    });
    expect(workflowLaunch(text, undefined)).toEqual({ runId: 'wf_abc123-def', taskId: 'wk1', name: null, summary: 'Audit the repos' });
    // An older text without `Run ID:`: the run folder at the end of `Transcript dir:`.
    expect(workflowLaunch('Workflow launched in background. Task ID: wk2\nTranscript dir: /x/y/wf_0001-aaa\n', undefined)?.runId).toBe('wf_0001-aaa');
    expect(workflowLaunch(text, { error: 'script failed to compile' })).toBeNull();
    expect(workflowLaunch('Workflow launched in background. Task ID: wk3\nRun ID: ../../etc\n', undefined)).toBeNull();
    expect(workflowLaunch('some other text', undefined)).toBeNull();
    expect(workflowLaunch('x', { runId: 'wf_../../x', taskId: 'wk1' })).toBeNull();
  });
});

describe('the files and the stream', () => {
  it('parseWorkflowProgress: phases and agents by index (the latest entry wins), times as ISO, logs skipped', () => {
    const progress = parseWorkflowProgress([
      { type: 'workflow_phase', index: 2, title: 'Review' },
      { type: 'workflow_phase', index: 1, title: 'Audit' },
      agentEntry({ index: 1, label: 'audit:a', phaseIndex: 1, phaseTitle: 'Audit', state: 'start', queuedAt: at(0) }),
      agentEntry({ index: 1, label: 'audit:a', phaseIndex: 1, phaseTitle: 'Audit', agentId: 'a1', state: 'progress', startedAt: at(1), lastToolName: 'Read', lastToolSummary: 'a.md', lastProgressAt: at(2) }),
      { type: 'workflow_log', message: 'hello' },
      { nothing: true },
    ]);
    expect(progress.phases).toEqual([
      { index: 1, title: 'Audit' },
      { index: 2, title: 'Review' },
    ]);
    expect(progress.agents).toHaveLength(1);
    expect(progress.agents[0]).toMatchObject({ index: 1, agentId: 'a1', state: 'progress', startedAt: iso(1), lastToolName: 'Read', lastProgressAt: iso(2) });
    expect(parseWorkflowProgress('nope')).toEqual({ agents: [], phases: [] });
  });

  it('parseRunFile: the final record; not a run file without a valid runId', () => {
    const file = parseRunFile({
      runId: 'wf_abc123-def',
      taskId: 'wk1',
      workflowName: 'audit',
      summary: 'Audit the repos',
      status: 'completed',
      startTime: at(0),
      durationMs: 90_000,
      phases: [{ title: 'Audit', detail: 'one per repo' }, { title: 'Review' }],
      defaultModel: 'claude-opus-5-5',
      workflowProgress: [agentEntry({ index: 1, label: 'audit:a', agentId: 'a1', state: 'done', startedAt: at(1), durationMs: 30_000 })],
    });
    expect(file).toMatchObject({ runId: 'wf_abc123-def', taskId: 'wk1', name: 'audit', status: 'completed', startedAt: iso(0), endedAt: iso(90), phases: ['Audit', 'Review'], defaultModel: 'claude-opus-5-5' });
    expect(file?.progress.agents).toHaveLength(1);
    expect(parseRunFile({ runId: '../x' })).toBeNull();
    expect(parseRunFile(null)).toBeNull();
  });

  it('parseJournal: started / result / failed; launched, cut and foreign lines skipped', () => {
    const text = [
      '{"type":"launched"}',
      '{"type":"started","key":"v2:1","agentId":"a1","label":"audit:a","phase":"Audit"}',
      '{"type":"result","key":"v2:1","agentId":"a1","result":{"ok":true}}',
      '{"type":"failed","key":"v2:2","agentId":"a2"}',
      '{"type":"started","key":"v2:3","agentId":"../bad","label":"x"}',
      '{"type":"started","key":"v2:4","agentId":"a4","lab',
    ].join('\n');
    expect(parseJournal(text)).toEqual([
      { type: 'started', agentId: 'a1', label: 'audit:a', phase: 'Audit' },
      { type: 'result', agentId: 'a1', result: { ok: true } },
      { type: 'failed', agentId: 'a2' },
    ]);
  });

  it('parseAgentMeta / parseScriptMeta / scriptFileName', () => {
    expect(parseAgentMeta({ agentType: 'workflow-subagent', description: 'review:x', workflowPhase: 'Review', spawnDepth: 1 })).toEqual({ label: 'review:x', phase: 'Review' });
    expect(parseAgentMeta('x')).toBeNull();
    const script = "export const meta = {\n  name: 'proj-audit',\n  description: \"Audit: {every} repo\",\n  phases: [\n    { title: 'Audit', detail: 'one per repo' },\n    { title: `Review` },\n  ],\n}\nconst name = 'other'\n";
    expect(parseScriptMeta(script)).toEqual({ name: 'proj-audit', summary: 'Audit: {every} repo', phases: ['Audit', 'Review'] });
    expect(parseScriptMeta('await agent("x")')).toEqual({ name: null, summary: null, phases: [] });
    expect(scriptFileName('proj-audit-wf_abc123-def.js', 'wf_abc123-def')).toBe('proj-audit');
    expect(scriptFileName('wf_abc123-def.js', 'wf_abc123-def')).toBeNull();
    expect(scriptFileName('proj-audit-wf_other.js', 'wf_abc123-def')).toBeNull();
  });

  it('scanAgentEntries: cwd and first time from the head, then the last time, model and tool as it grows', () => {
    const head = scanAgentEntries(NO_TRANSCRIPT, [{ type: 'user', cwd: '/ws', timestamp: iso(1), message: { role: 'user', content: 'brief' } }], 100);
    expect(head).toEqual({ cwd: '/ws', firstAt: iso(1), lastAt: iso(1), model: null, lastTool: null, bytes: 100 });
    const later = scanAgentEntries(
      head,
      [
        { type: 'assistant', cwd: '/elsewhere', timestamp: iso(5), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\nmore' } }] } },
        { type: 'assistant', timestamp: iso(6), message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      ],
      400,
    );
    expect(later).toEqual({ cwd: '/ws', firstAt: iso(1), lastAt: iso(6), model: 'claude-opus-5-5', lastTool: { name: 'Bash', summary: 'npm test', at: iso(5) }, bytes: 400 });
  });

  it('progressStatus / runStatus: the CLI\'s states and final statuses', () => {
    expect(progressStatus({ state: 'start', startedAt: null, agentId: null })).toEqual({ status: 'idle', queued: true });
    expect(progressStatus({ state: 'start', startedAt: iso(1), agentId: 'a1' })).toEqual({ status: 'run', queued: false });
    expect(progressStatus({ state: 'progress', startedAt: iso(1), agentId: 'a1' })).toEqual({ status: 'run', queued: false });
    expect(progressStatus({ state: 'done', startedAt: iso(1), agentId: 'a1' })).toEqual({ status: 'done', queued: false });
    expect(progressStatus({ state: 'error', startedAt: null, agentId: null })).toEqual({ status: 'fail', queued: false });
    expect(runStatus('completed')).toBe('done');
    expect(runStatus('failed')).toBe('fail');
    expect(runStatus('killed')).toBe('idle');
    expect(runStatus('stopped')).toBe('idle');
  });
});

describe('deriveWorkflowRun', () => {
  const snapshot = parseWorkflowProgress([
    { type: 'workflow_phase', index: 1, title: 'Audit' },
    { type: 'workflow_phase', index: 2, title: 'Review' },
    agentEntry({ index: 1, label: 'audit:a', phaseIndex: 1, phaseTitle: 'Audit', agentId: 'a1', state: 'done', startedAt: at(1), durationMs: 20_000 }),
    agentEntry({ index: 2, label: 'audit:b', phaseIndex: 1, phaseTitle: 'Audit', agentId: 'a2', state: 'done', startedAt: at(1), durationMs: 25_000 }),
    agentEntry({ index: 3, label: 'review:a', phaseIndex: 2, phaseTitle: 'Review', agentId: 'a3', state: 'progress', startedAt: at(30), lastToolName: 'Read', lastToolSummary: 'a.md', lastProgressAt: at(32) }),
    agentEntry({ index: 4, label: 'review:b', phaseIndex: 2, phaseTitle: 'Review', state: 'start', queuedAt: at(30) }),
  ]);

  it('live: the snapshot\'s agents (done, running with its action, queued) and the run\'s phase and counts', () => {
    const { run, agents } = deriveWorkflowRun(base({ progress: snapshot, launchedAt: iso(0) }));
    expect(run).toEqual({
      runId: 'wf_abc123-def',
      taskId: 'wk1',
      name: 'audit',
      summary: 'Audit the repos',
      status: 'run',
      phase: 'Review',
      phases: ['Audit', 'Review'],
      agentCount: 4,
      doneCount: 2,
      failedCount: 0,
      startedAt: iso(0),
      endedAt: null,
    });
    expect(agents.map((a) => [a.id, a.label, a.status, a.statusText, a.workflow.phase])).toEqual([
      ['wf_abc123-def--1', 'audit:a', 'done', null, 'Audit'],
      ['wf_abc123-def--2', 'audit:b', 'done', null, 'Audit'],
      ['wf_abc123-def--3', 'review:a', 'run', null, 'Review'],
      ['wf_abc123-def--4', 'review:b', 'idle', 'queued', 'Review'],
    ]);
    expect(agents[0]?.workflow).toMatchObject({ startedAt: iso(1), endedAt: iso(21), model: 'claude-opus-5-5', action: null });
    expect(agents[2]?.workflow.action).toEqual({ tool: 'Read', summary: 'a.md', since: iso(32) });
    expect(agents[3]?.workflow).toMatchObject({ agentId: null, index: 4, startedAt: null });
  });

  it('the transcript\'s newer last tool wins over an older snapshot; its cwd and size come along', () => {
    const facts: AgentTranscriptFacts = { cwd: '/ws/microfrontends/x-front', firstAt: iso(30), lastAt: iso(40), model: 'claude-opus-5-5', lastTool: { name: 'Bash', summary: 'npm test', at: iso(40) }, bytes: 2048 };
    const { agents } = deriveWorkflowRun(base({ progress: snapshot, transcripts: new Map([['a3', facts]]) }));
    expect(agents[2]?.workflow).toMatchObject({ action: { tool: 'Bash', summary: 'npm test', since: iso(40) }, cwd: '/ws/microfrontends/x-front', version: 2048 });
  });

  it('a queued entry of an older snapshot that the journal shows started is the same agent (no double row, the same id)', () => {
    const { agents } = deriveWorkflowRun(base({ progress: snapshot, journal: [{ type: 'started', agentId: 'a4', label: 'review:b', phase: 'Review' }] }));
    expect(agents.map((a) => [a.id, a.status])).toEqual([
      ['wf_abc123-def--1', 'done'],
      ['wf_abc123-def--2', 'done'],
      ['wf_abc123-def--3', 'run'],
      ['wf_abc123-def--4', 'run'],
    ]);
  });

  it('after a restart (no snapshot, no launch): the journal and metas give the agents; a run nobody runs any more was cut off', () => {
    const journal = parseJournal(
      [
        '{"type":"started","agentId":"a1","label":"audit:a","phase":"Audit"}',
        '{"type":"started","agentId":"a2","label":"audit:b","phase":"Audit"}',
        '{"type":"result","agentId":"a1","result":{"ok":true}}',
        '{"type":"started","agentId":"a3","label":"audit:c","phase":"Audit"}',
        '{"type":"failed","agentId":"a3"}',
      ].join('\n'),
    );
    const metas = new Map<string, AgentMeta>([['a5', { label: 'audit:e', phase: 'Audit' }]]);
    const script = { name: 'from-script', summary: 'From the script', phases: ['Audit'] };
    const running = deriveWorkflowRun(base({ launch: null, journal, metas, script, running: true }));
    expect(running.run).toMatchObject({ name: 'from-script', summary: 'From the script', status: 'run', agentCount: 4, doneCount: 1, failedCount: 1, taskId: null });
    expect(running.agents.map((a) => [a.label, a.status])).toEqual([
      ['audit:a', 'done'],
      ['audit:b', 'run'],
      ['audit:c', 'fail'],
      ['audit:e', 'run'],
    ]);
    expect(running.agents[0]?.result).toEqual({ text: '```json\n{\n  "ok": true\n}\n```', isError: false });
    expect(running.agents[2]?.result).toEqual({ text: 'The agent failed.', isError: true });

    const stopped = deriveWorkflowRun(base({ launch: null, journal, metas, script, running: false }));
    expect(stopped.run.status).toBe('idle');
    expect(stopped.agents.map((a) => a.status)).toEqual(['done', 'idle', 'fail', 'idle']);
  });

  it('the run file is final: its status and list win; the stream\'s end without it', () => {
    const runFile = parseRunFile({
      runId: 'wf_abc123-def',
      taskId: 'wk1',
      workflowName: 'audit-final',
      status: 'completed',
      startTime: at(0),
      durationMs: 60_000,
      phases: [{ title: 'Audit' }],
      workflowProgress: [agentEntry({ index: 1, label: 'audit:a', phaseIndex: 1, phaseTitle: 'Audit', agentId: 'a1', state: 'done', startedAt: at(1), durationMs: 10_000 })],
    });
    const done = deriveWorkflowRun(base({ runFile, progress: snapshot, running: true }));
    expect(done.run).toMatchObject({ name: 'audit-final', status: 'done', agentCount: 1, doneCount: 1, phase: 'Audit', endedAt: iso(60) });

    const killed = deriveWorkflowRun(base({ progress: snapshot, ended: 'killed' }));
    expect(killed.run.status).toBe('idle');
    expect(killed.agents.map((a) => a.status)).toEqual(['done', 'done', 'idle', 'idle']);
    expect(killed.agents[3]?.statusText).toBeNull();
    expect(deriveWorkflowRun(base({ progress: snapshot, ended: 'failed' })).run.status).toBe('fail');
  });

  it('an error entry fails its agent with the CLI\'s error as its result', () => {
    const progress = parseWorkflowProgress([agentEntry({ index: 1, label: 'x', state: 'error', error: 'blocked by the classifier' })]);
    const { agents, run } = deriveWorkflowRun(base({ progress }));
    expect(agents[0]).toMatchObject({ status: 'fail', result: { text: 'blocked by the classifier', isError: true } });
    expect(run.failedCount).toBe(1);
  });

  it('workflowAgents: `Session.agents` entries named by label, described by phase, placed by the cwd', () => {
    const { agents } = deriveWorkflowRun(base({ progress: snapshot, transcripts: new Map([['a3', { ...NO_TRANSCRIPT, cwd: '/ws/x-front' }]]) }));
    const api = workflowAgents(agents, (cwd) => (cwd.endsWith('x-front') ? 'x-front/' : null));
    expect(api[2]).toEqual({
      id: 'wf_abc123-def--3',
      kind: 'workflow',
      name: 'review:a',
      description: 'Review',
      solutionPath: 'x-front/',
      branch: null,
      status: 'run',
      statusText: null,
      toolUseId: null,
      workflow: agents[2]?.workflow,
    });
    expect(api[0]?.solutionPath).toBeNull();
    expect(workflowAgentKey('wf_a', 'a7', 7)).toBe('wf_a--7');
    expect(workflowAgentKey('wf_a', null, 7)).toBe('wf_a--7');
    expect(workflowAgentKey('wf_a', 'a7', null)).toBe('wf_a--a7');
  });
});

describe('a workflow agent\'s chat', () => {
  it('cleanWorkflowBrief drops the CLI\'s frame and dedents; other text stays', () => {
    const framed = '[Workflow harness — computed task] The task text below was computed at runtime. The computed task text follows:\n  Check the repo.\n    - indented item\n  Report.';
    expect(cleanWorkflowBrief(framed)).toBe('Check the repo.\n  - indented item\nReport.');
    expect(cleanWorkflowBrief('Just a prompt')).toBe('Just a prompt');
  });

  it('workflowAgentEvents: the brief, tool calls with their results, text blocks of one message merged', () => {
    const envelope = { isSidechain: true, agentId: 'a1', cwd: '/ws', sessionId: 's' };
    const entries = [
      { ...envelope, type: 'user', uuid: 'u1', parentUuid: null, timestamp: iso(1), message: { role: 'user', content: '[Workflow harness — x] The computed task text follows:\n  Read a.md' } },
      { ...envelope, type: 'attachment', uuid: 'x1', parentUuid: 'u1', timestamp: iso(1), attachment: { type: 'environment' } },
      { ...envelope, type: 'assistant', uuid: 'm1', parentUuid: 'x1', timestamp: iso(2), message: { id: 'msg1', model: 'claude', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/ws/a.md' } }] } },
      { ...envelope, type: 'user', uuid: 'r1', parentUuid: 'm1', timestamp: iso(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } },
      { ...envelope, type: 'assistant', uuid: 'm2', parentUuid: 'r1', timestamp: iso(4), message: { id: 'msg2', model: 'claude', content: [{ type: 'text', text: 'First part.' }] } },
      { ...envelope, type: 'assistant', uuid: 'm3', parentUuid: 'm2', timestamp: iso(4), message: { id: 'msg2', model: 'claude', content: [{ type: 'text', text: 'Second part.' }] } },
    ];
    const events = workflowAgentEvents(entries, 'session-1', 'wf_x--a1');
    expect(events.map((e) => [e.id, e.kind, (e.payload as { type: string }).type])).toEqual([
      [1, 'text', 'agent-prompt'],
      [2, 'plan', 'tool'],
      [3, 'text', 'assistant'],
    ]);
    expect(events.every((e) => e.sessionId === 'session-1' && e.agentId === 'wf_x--a1')).toBe(true);
    expect(events[0]?.payload).toEqual({ type: 'agent-prompt', text: 'Read a.md' });
    expect(events[1]).toMatchObject({ endTs: iso(3), payload: { name: 'Read', toolUseId: 't1', result: 'contents', isError: false } });
    expect(events[2]?.payload).toEqual({ type: 'assistant', text: 'First part.\n\nSecond part.', messageId: 'msg2' });
  });

  it('resultText: a string as it is, anything else as a JSON block', () => {
    expect(resultText('done')).toBe('done');
    expect(resultText({ a: 1 })).toBe('```json\n{\n  "a": 1\n}\n```');
  });
});
