import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { FAKE_WORKFLOW_NAME, FAKE_WORKFLOW_SUMMARY } from '../../tools/fake-claude/scenarios.ts';
import { fakeAgentBrief, fakeAgentLabel, fakeAgentText } from '../../tools/fake-claude/workflow.ts';
import { cleanWorkflowBrief, deriveWorkflowRun, parseAgentMeta, parseJournal, parseRunFile, parseScriptMeta, parseWorkflowProgress } from '../../src/core/derive/workflows.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, spawnFake, userLine } from '../helpers/fake-claude.ts';

/**
 * D51 `[fake:workflow <seconds> <P>x<A>]` (`docs/fake-claude.md`): a background
 * Workflow whose agents stream `task_progress` snapshots and write the CLI's files
 * (journal, per-agent meta + transcript, script, and the run file at the end),
 * which Switchboard's parsers read back as the real ones.
 */
const SID = '0b7e6c1d-5151-4222-8333-44445555d051';

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-workflow');
});

afterEach(async () => {
  for (const run of runs) run.kill('SIGKILL');
  runs = [];
  await env.cleanup();
});

function start(): FakeRun {
  const run = spawnFake([...BASELINE, '--replay-user-messages', '--session-id', SID], { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir } });
  runs.push(run);
  return run;
}

const isResult = (l: JsonObject): boolean => l['type'] === 'result';
const isProgress = (l: JsonObject): boolean => l['type'] === 'system' && l['subtype'] === 'task_progress';
const isNotification = (l: JsonObject): boolean => l['type'] === 'system' && l['subtype'] === 'task_notification';

async function sessionDir(): Promise<string> {
  const projects = path.join(env.configDir, 'projects');
  const [folder] = await readdir(projects).catch(() => []);
  return path.join(projects, folder ?? '', SID);
}

describe('fake-claude · D51 grid workflow', () => {
  it('streams progress snapshots and writes the run folder, the agents\' files and the run file', async () => {
    const run = start();
    run.send(userLine('Audit the fixtures [fake:workflow 3 2x2]'));
    await run.waitFor(isResult, 1);
    const launch = run.lines.find((l) => l['type'] === 'user' && typeof l['tool_use_result'] === 'object' && l['tool_use_result'] !== null);
    const detail = launch?.['tool_use_result'] as JsonObject;
    const runId = String(detail['runId']);
    // The session's folder next to its transcript (`<projects>/<slug>/<sessionId>`).
    const dir = path.resolve(String(detail['transcriptDir']), '..', '..', '..');
    expect(path.basename(dir)).toBe(SID);
    expect(path.dirname(path.dirname(dir))).toBe(path.join(env.configDir, 'projects'));
    expect(detail['transcriptDir']).toBe(path.join(dir, 'subagents', 'workflows', runId));

    await run.waitFor(isNotification, 1, 10_000);
    const progress = run.lines.filter(isProgress);
    expect(progress.length).toBeGreaterThanOrEqual(10);
    expect(progress.every((l) => l['task_id'] === detail['taskId'])).toBe(true);
    // Queued first (no agent id, no start), then started, progressing, done; phase 2 after phase 1.
    const first = parseWorkflowProgress(progress[0]?.['workflow_progress']);
    expect(first.phases.map((p) => p.title)).toEqual(['Audit', 'Review']);
    expect(first.agents.map((a) => [a.index, a.state, a.agentId, a.startedAt])).toEqual([
      [1, 'start', null, null],
      [2, 'start', null, null],
    ]);
    const last = parseWorkflowProgress(progress.at(-1)?.['workflow_progress']);
    expect(last.agents.map((a) => [a.label, a.phaseTitle, a.state])).toEqual([
      [fakeAgentLabel(0, 1), 'Audit', 'done'],
      [fakeAgentLabel(0, 2), 'Audit', 'done'],
      [fakeAgentLabel(1, 1), 'Review', 'done'],
      [fakeAgentLabel(1, 2), 'Review', 'done'],
    ]);

    const folder = path.join(dir, 'subagents', 'workflows', runId);
    const journal = parseJournal(await readFile(path.join(folder, 'journal.jsonl'), 'utf8'));
    expect(journal.filter((e) => e.type === 'started')).toHaveLength(4);
    expect(journal.filter((e) => e.type === 'result')).toHaveLength(4);
    const files = await readdir(folder);
    expect(files.filter((f) => f.endsWith('.meta.json'))).toHaveLength(4);
    const agentId = last.agents[0]?.agentId ?? '';
    expect(parseAgentMeta(JSON.parse(await readFile(path.join(folder, `agent-${agentId}.meta.json`), 'utf8')))).toEqual({ label: fakeAgentLabel(0, 1), phase: 'Audit' });
    const transcript = (await readFile(path.join(folder, `agent-${agentId}.jsonl`), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as JsonObject);
    expect(transcript.every((e) => e['isSidechain'] === true && e['agentId'] === agentId)).toBe(true);
    expect(cleanWorkflowBrief(String((transcript[0]?.['message'] as JsonObject)['content']))).toBe(fakeAgentBrief(0, 1));
    expect(JSON.stringify(transcript.at(-1))).toContain(fakeAgentText(fakeAgentLabel(0, 1)));

    const runFile = parseRunFile(JSON.parse(await readFile(path.join(dir, 'workflows', `${runId}.json`), 'utf8')));
    expect(runFile).toMatchObject({ runId, taskId: detail['taskId'], name: FAKE_WORKFLOW_NAME, summary: FAKE_WORKFLOW_SUMMARY, status: 'completed', phases: ['Audit', 'Review'] });
    const scripts = await readdir(path.join(dir, 'workflows', 'scripts'));
    expect(scripts).toEqual([`${FAKE_WORKFLOW_NAME}-${runId}.js`]);
    expect(parseScriptMeta(await readFile(path.join(dir, 'workflows', 'scripts', scripts[0] ?? ''), 'utf8'))).toEqual({ name: FAKE_WORKFLOW_NAME, summary: FAKE_WORKFLOW_SUMMARY, phases: ['Audit', 'Review'] });

    // Read back as Switchboard does: the run is done with its four agents.
    const derived = deriveWorkflowRun({ runId, launch: null, runFile, progress: null, journal, metas: new Map(), transcripts: new Map(), script: null, ended: null, running: false });
    expect(derived.run).toMatchObject({ status: 'done', agentCount: 4, doneCount: 4, phase: 'Review' });
    run.end();
    expect((await run.exited).code).toBe(0);
  });

  it('without a grid, D43\'s launch is unchanged: nothing is written, no progress', async () => {
    const run = start();
    run.send(userLine('Audit [fake:workflow 0.5]'));
    await run.waitFor(isNotification, 1, 5_000);
    expect(run.lines.some(isProgress)).toBe(false);
    const entries = await readdir(await sessionDir()).catch(() => []);
    expect(entries).toEqual([]);
    run.end();
    await run.exited;
  });
});
