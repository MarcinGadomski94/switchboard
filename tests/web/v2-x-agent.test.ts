import { describe, expect, it } from 'vitest';
import type { Agent, Artifact, SessionDetail, WorkflowRun } from '../../src/core/api.ts';
import { remoteId } from '../../src/core/peers.ts';
import type { Plan, PlanItem } from '../../src/core/plans.ts';
import type { TakeoverPreview, TakeoverRun } from '../../src/core/takeover.ts';
import { agentMenu } from '../../src/web/v2/agent/header-model.ts';
import { moveBlockedReason, moveHeadline, moveTargets, moveTitle, repoLook, runTone, stepLook, targetLabel } from '../../src/web/v2/agent/move-model.ts';
import { openResult, resultItemOf, shownResults } from '../../src/web/v2/agent/results-bits.ts';
import { LOG_LOOKS, SCRUB_STEP, blockOf, moments, nextMoment, playOf, previousMoment } from '../../src/web/v2/agent/timeline-model.ts';
import { PLAY_MAX, type TimelineLane } from '../../src/web/views/session/timeline.ts';
import { agentProjects, notesHref, overviewItems, overviewSummary, reportedView } from '../../src/web/v2/agent/side-model.ts';

/** D131 · lane X · the agent view's integration pieces: one result drawer, the v2 move / continue dialogs, the side panel's added groups. */

function artifact(id: string, extra: Partial<Artifact> = {}): Artifact {
  return { id, sessionId: 'peer-own-id', title: `Result ${id}`, kind: 'markdown', language: null, createdBy: 'agent', versions: 2, size: 10, createdAt: '2026-10-25T10:00:00.000Z', updatedAt: '2026-10-25T11:00:00.000Z', ...extra };
}

describe('results in the agent view use the Results page row', () => {
  it('builds the row with the agent id this computer uses and its computer', () => {
    const machine = { id: 'm1', name: 'Studio-PC', state: 'online' as const };
    const row = resultItemOf(artifact('a1'), { name: 'agent-1', displayTitle: 'Checkout', title: null, folderPath: '/x/acme', machine }, 'r~m1~peer-own-id');
    expect(row.sessionId).toBe('r~m1~peer-own-id');
    expect(row.sessionTitle).toBe('Checkout');
    expect(row.sessionName).toBe('agent-1');
    expect(row.folderPath).toBe('/x/acme');
    expect(row.machine).toEqual(machine);
    expect(row.versions).toBe(2);
    const local = resultItemOf(artifact('a1'), { name: 'agent-1', folderPath: null, machine: null }, 'local-id');
    expect('machine' in local).toBe(false);
    expect(local.sessionTitle).toBeNull();
  });

  it('finds the open result: undefined while loading, null when missing', () => {
    expect(openResult(null, 'a1')).toBeUndefined();
    expect(openResult([artifact('a1')], 'a2')).toBeNull();
    expect(openResult([artifact('a1')], null)).toBeNull();
    expect(openResult([artifact('a1')], 'a1')?.id).toBe('a1');
  });

  it('hides the results waiting in their Undo window', () => {
    expect(shownResults([artifact('a1'), artifact('a2')], new Set(['a1'])).map((a) => a.id)).toEqual(['a2']);
  });
});

function preview(extra: Partial<TakeoverPreview> = {}): TakeoverPreview {
  return {
    source: { machine: { id: 'self', name: 'Mac' }, conversation: { kind: 'claude-transcript', files: [] }, repos: [] },
    target: { machine: { id: 'm1', name: 'Studio-PC' }, cli: { label: 'Claude Code', available: true, reason: null }, account: { name: 'Default' }, repos: [] },
    stopsTerminal: false,
    ok: true,
    blockers: [],
    placement: null,
    remembered: false,
    ...extra,
  } as unknown as TakeoverPreview;
}

describe('the v2 move dialog', () => {
  it('lists online computers first and says why the others cannot take it', () => {
    const targets = moveTargets([
      { id: 'a', name: 'Studio-PC', state: 'offline' },
      { id: 'b', name: 'Laptop', state: 'online' },
      { id: 'c', name: 'Desk', state: 'reconnecting' },
    ]);
    expect(targets.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect(targets[1]?.reason).toBe('Studio-PC is offline');
    expect(targets[2]?.reason).toBe('Reconnecting to Desk…');
    expect(targets.map(targetLabel)).toEqual(['Laptop', 'Studio-PC (offline)', 'Desk (reconnecting)']);
  });

  it('says why Move is disabled, most actionable first', () => {
    const base = { preview: preview(), previewError: null, confirmed: false, clonePaths: {}, other: { name: 'Studio-PC', state: 'online' as const }, running: false };
    expect(moveBlockedReason(base)).toBeNull();
    expect(moveBlockedReason({ ...base, running: true })).toBe('It is moving now.');
    expect(moveBlockedReason({ ...base, other: { name: 'Studio-PC', state: 'offline' } })).toBe('Studio-PC is offline: it can move once it reconnects.');
    expect(moveBlockedReason({ ...base, other: { name: 'Studio-PC', state: 'reconnecting' } })).toBe('Reconnecting to Studio-PC…');
    expect(moveBlockedReason({ ...base, preview: null })).toBe('Checking both computers…');
    expect(moveBlockedReason({ ...base, preview: null, previewError: 'HTTP 502' })).toBe('HTTP 502');
    expect(moveBlockedReason({ ...base, preview: preview({ ok: false, blockers: ['The CLI is missing on Studio-PC'] }) })).toBe('The CLI is missing on Studio-PC');
    expect(moveBlockedReason({ ...base, preview: preview({ stopsTerminal: true }) })).toBe('Confirm that the terminal’s claude is stopped first.');
    expect(moveBlockedReason({ ...base, preview: preview({ stopsTerminal: true }), confirmed: true })).toBeNull();
    const clone = preview({ target: { ...preview().target, repos: [{ key: 'r', name: 'acme', action: 'clone', cloneTo: null, branch: 'main', uncommitted: 0, ahead: null, summary: '', worktreePath: null, matchedPath: null }] } as unknown as TakeoverPreview['target'] });
    expect(moveBlockedReason({ ...base, preview: clone })).toBe('Fill in where to clone each missing code project.');
    expect(moveBlockedReason({ ...base, preview: clone, clonePaths: { r: '/x/acme' } })).toBeNull();
  });

  it('reads marks, steps and runs as icon + word + colour', () => {
    expect(repoLook('✓')).toEqual({ icon: 'check-circle', word: 'Found', tone: 'green' });
    expect(repoLook('⚠').tone).toBe('amber');
    expect(repoLook('✖').word).toBe('Blocked');
    expect(stepLook('running')).toEqual({ icon: 'dot', word: 'Running', tone: 'blue' });
    expect(stepLook('failed').tone).toBe('red');
    expect(stepLook('pending').word).toBe('Waiting');
    const run = (extra: Partial<TakeoverRun>): TakeoverRun => ({ id: 'x', state: 'running', steps: [], error: null, rolledBack: null, rollbackNotes: [], result: null, leftovers: [], log: [], ...extra });
    expect(runTone(run({}))).toBe('blue');
    expect(runTone(run({ state: 'done' }))).toBe('green');
    expect(runTone(run({ state: 'failed' }))).toBe('red');
    expect(moveHeadline(run({}), 'Studio-PC')).toBe('Moving to Studio-PC…');
    expect(moveHeadline(run({ state: 'done' }), 'Studio-PC')).toBe('Moved');
    expect(moveHeadline(run({ state: 'failed', rolledBack: true }), 'Studio-PC')).toBe('The move failed. Everything was undone.');
    expect(moveTitle('move', 'Studio-PC')).toBe('Move to Studio-PC');
    expect(moveTitle('take-over', 'Studio-PC')).toBe('Move here from Studio-PC');
  });

  it('the agent ⋯ menu offers Continue in Switchboard for an agent started in a terminal', () => {
    const input = { conversation: false, closed: false, running: true, attached: true, hooked: true, machineName: null, offline: null, remote: { on: false, disabled: false, reason: null }, background: 0, movable: true, computers: 1, teammate: false, crews: 0 };
    const item = (list: ReturnType<typeof agentMenu>) => list.find((entry) => 'id' in entry && entry.id === 'continue-hooked');
    expect(item(agentMenu({ ...input, hookedContinue: true }))).toMatchObject({ label: 'Continue in Switchboard' });
    expect(item(agentMenu({ ...input, hookedContinue: true }))).not.toHaveProperty('disabledReason');
    expect(item(agentMenu({ ...input, hookedContinue: false }))).toHaveProperty('disabledReason');
    expect(item(agentMenu({ ...input, hookedContinue: true, offline: 'Studio-PC is offline' }))).toMatchObject({ disabledReason: 'Studio-PC is offline' });
    expect(item(agentMenu({ ...input, hooked: false }))).toBeUndefined();
  });
});

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, kind: 'subagent', name: id, description: null, solutionPath: null, branch: null, status: 'run', statusText: null, toolUseId: `tu-${id}`, ...extra } as Agent;
}

describe('the side panel’s agents overview', () => {
  const run: WorkflowRun = { runId: 'wf_1', taskId: null, name: 'audit', summary: 'Audit the fixtures', status: 'idle', phase: null, phases: [], agentCount: 2, doneCount: 0, failedCount: 0, startedAt: null, endedAt: null, resume: { scriptPath: '/x/audit.js', args: null } } as unknown as WorkflowRun;
  const session = {
    status: 'idle',
    task: 'Fix the checkout\nmore',
    agents: [
      agent('main', { kind: 'main', toolUseId: null, solutionPath: 'microfrontends/acme-front', status: 'idle' }),
      agent('helper', { description: 'Write tests' }),
      agent('finished', { status: 'done' }),
      agent('w1', { kind: 'workflow', toolUseId: null, workflow: { runId: 'wf_1', index: 0, agentId: 'ag-1', phase: null, model: null } as Agent['workflow'], status: 'idle' }),
    ],
    workflows: [run],
  } as unknown as SessionDetail;

  it('lists the main agent, the helpers that have not finished and each run with its agents under it', () => {
    const items = overviewItems(session);
    expect(items.map((item) => (item.kind === 'workflow' ? `run:${item.runId}` : `${item.id}:${item.depth}`))).toEqual(['main:0', 'helper:0', 'run:wf_1', 'w1:1']);
    const main = items[0];
    expect(main?.kind === 'agent' && main.solution).toBe('acme-front');
    const helper = items[1];
    expect(helper?.kind === 'agent' && helper.opensChat).toBe(true);
    expect(helper?.kind === 'agent' && helper.status).toBe('working');
    const wf = items[2];
    expect(wf?.kind === 'workflow' && wf.resume).toContain('resumeFromRunId: "wf_1"');
    expect(overviewSummary(items)).toBe('3 agents · 1 working');
  });

  it('reads the printed table (D27), null when it does not parse', () => {
    expect(reportedView({ reportedTable: null } as unknown as SessionDetail)).toBeNull();
    const table = { text: '| Agent | Status |\n|---|---|\n| tests | ✅ done |', format: 'gfm', at: '2026-10-25T10:00:00.000Z' };
    const view = reportedView({ reportedTable: table } as unknown as SessionDetail);
    expect(view?.columns.map((c) => c.name)).toEqual(['Agent', 'Status']);
    expect(view?.rows[0]?.status).toBe('done');
  });
});

function plan(extra: Partial<Plan>): Plan {
  return { id: 'p1', title: 'Acme checkout', sourceSessionId: 'src', state: 'running', machine: null, items: [], progress: { done: 1, total: 3, percent: 33 }, ...extra } as unknown as Plan;
}

describe('the project line and the notes line', () => {
  it('finds the project an agent made or runs a step of', () => {
    const item = { id: 'i1', key: 'PROJ-12', title: 'Add the API', state: 'running', reason: null, runSessionId: 'step-agent', dependsOn: [], note: null } as unknown as PlanItem;
    const plans = [plan({ items: [item] })];
    expect(agentProjects(plans, 'src')).toMatchObject([{ planId: 'p1', role: 'source', progress: '1 of 3 steps done', href: '/projects/p1' }]);
    const step = agentProjects(plans, 'step-agent');
    expect(step).toHaveLength(1);
    expect(step[0]?.role).toBe('step');
    expect(step[0]?.step).toContain('Add the API');
    expect(agentProjects(plans, 'other')).toEqual([]);
  });

  it('matches a paired computer’s plan that names its sessions by their own ids', () => {
    const m1 = 'abcdefghijkl';
    const m2 = 'mnopqrstuvwx';
    const remote = plan({ id: remoteId(m1, 'p1'), sourceSessionId: 'own', machine: { id: m1, name: 'Studio-PC', state: 'online' } });
    expect(agentProjects([remote], remoteId(m1, 'own'))).toHaveLength(1);
    expect(agentProjects([remote], remoteId(m2, 'own'))).toHaveLength(0);
  });

  it('links Notes scoped to the folder', () => {
    expect(notesHref({ folder: '/x/acme ws' }, '/y')).toBe('/notes?scope=%2Fx%2Facme%20ws');
    expect(notesHref(null, '/y')).toBe('/notes?scope=%2Fy');
    expect(notesHref(null, null)).toBeNull();
  });
});

describe('the timeline’s playback', () => {
  const lane = (id: string, lefts: number[]): TimelineLane => ({ id, name: id, sub: '', blocks: lefts.map((left, index) => ({ id: index + (id === 'a' ? 0 : 100), kind: 'impl', label: 'x', left, width: 1, start: 0, end: 0, open: false, dim: false })) });
  const lanes = [lane('a', [0, 40.04, 75]), lane('b', [40, 90])];

  it('places a moment on the scrubber', () => {
    expect(playOf(0)).toBe(0);
    expect(playOf(40.04)).toBe(400);
    expect(playOf(120)).toBe(PLAY_MAX);
    expect(playOf(-3)).toBe(0);
    expect(playOf(Number.NaN)).toBe(0);
  });

  it('steps between events (Play with reduced motion, ⇧← / ⇧→)', () => {
    expect(moments(lanes)).toEqual([0, 400, 750, 900]);
    expect(nextMoment(lanes, 0)).toBe(400);
    expect(nextMoment(lanes, 400)).toBe(750);
    expect(nextMoment(lanes, 900)).toBe(PLAY_MAX);
    expect(previousMoment(lanes, 750)).toBe(400);
    expect(previousMoment(lanes, 0)).toBe(0);
    expect(SCRUB_STEP).toBe(10);
  });

  it('finds a log row’s block and reads each kind as icon + word + colour', () => {
    expect(blockOf(lanes, 101)).toEqual({ lane: 'b', left: 90, start: 0 });
    expect(blockOf(lanes, 7)).toBeNull();
    expect(LOG_LOOKS.ok).toEqual({ icon: 'check-circle', word: 'Done', tone: 'green' });
    expect(LOG_LOOKS.error.tone).toBe('red');
    expect(Object.keys(LOG_LOOKS).sort()).toEqual(['ask', 'error', 'impl', 'loop', 'ok', 'plan']);
  });
});
