import path from 'node:path';
import type { EventKind } from '../../core/model.ts';
import type { RepoContext } from '../db/context.ts';
import { AgentRepository } from '../db/repos/agents.ts';
import { ArtifactRepository } from '../db/repos/artifacts.ts';
import { EventRepository } from '../db/repos/events.ts';
import { LoopRepository } from '../db/repos/loops.ts';
import { QuestionRepository } from '../db/repos/questions.ts';
import { ScheduleRepository } from '../db/repos/schedules.ts';
import { SessionRepository } from '../db/repos/sessions.ts';
import { SystemItemRepository } from '../db/repos/system-items.ts';
import { ToolRepository } from '../db/repos/tools.ts';
import { WorktreeRepository } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type DemoData, type DemoSession, ageMinutes } from './data.ts';

/** Settings key that marks a database as holding the demo seed (value: {@link DemoSeedMarker}). */
export const DEMO_SEED_KEY = 'demo.seed';

/** Version of the seed mapping; stored in the marker. */
export const DEMO_SEED_VERSION = 1;

/** Stored under {@link DEMO_SEED_KEY}. */
export interface DemoSeedMarker {
  readonly version: number;
  readonly seededAt: string;
}

/** Why the demo seed refused to run. */
export class DemoSeedError extends Error {
  override name = 'DemoSeedError';
}

/** Options for {@link seedDemo}. */
export interface SeedDemoOptions {
  /** "Now" for the relative ages (`1m`, `38m`); default: the current time. */
  readonly now?: Date;
  /**
   * Where the prototype timeline's clock starts (its labels read 10:00 + t0 + minutes);
   * default: 10:00 local time on the day of `now`.
   */
  readonly timelineBase?: Date;
}

/** What {@link seedDemo} did. */
export interface SeedDemoResult {
  /** `false` when the database already held the demo seed (nothing written). */
  readonly seeded: boolean;
  readonly sessions: number;
}

const MINUTE = 60_000;

function minutesBefore(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * MINUTE).toISOString();
}

function minutesAfter(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * MINUTE).toISOString();
}

/** Repositories whose clock is fixed at `ts`, so seeded rows get the prototype's relative times. */
function at(store: Store, ts: string) {
  const ctx: RepoContext = { db: store.db, now: () => ts };
  return {
    sessions: new SessionRepository(ctx),
    agents: new AgentRepository(ctx),
    events: new EventRepository(ctx),
    questions: new QuestionRepository(ctx),
    systemItems: new SystemItemRepository(ctx),
    worktrees: new WorktreeRepository(ctx),
    artifacts: new ArtifactRepository(ctx),
    schedules: new ScheduleRepository(ctx),
    loops: new LoopRepository(ctx),
    tools: new ToolRepository(ctx),
  };
}

const WORK_TYPE: Readonly<Record<string, 'feature' | 'qa'>> = { 'feature-building': 'feature', 'test-authoring (QA)': 'qa' };
const MODE: Readonly<Record<string, 'single' | 'orchestrator'>> = { orchestrator: 'orchestrator', 'single-solution': 'single' };
const PHASE: Readonly<Record<string, 'ui-first' | 'integration'>> = { 'UI-first': 'ui-first', integration: 'integration' };

function chip(session: DemoSession, key: string): string | undefined {
  return session.chips.find((c) => c.k === key)?.v;
}

/** Solution name of an agent's folder (`microfrontends/acme-app-front` → `acme-app-front`), `null` for non-solutions. */
export function solutionOf(solutionPath: string): string | null {
  if (solutionPath === 'workspace root' || solutionPath === 'read-only' || !solutionPath.includes('/')) return null;
  return solutionPath.split('/').filter(Boolean).pop() ?? null;
}

/**
 * The stored summary of a demo schedule's last run: the prototype's "last" text
 * without the prefix the Schedules view adds from the run's result (M7.1,
 * `docs/schedules.md`): `OK · `, `Failed <age> ago · `, `Asked: `.
 */
export function runSummary(last: string): string {
  return last.replace(/^OK · /, '').replace(/^Failed [^·]* ago · /, '').replace(/^Asked: /, '');
}

/** Minutes between runs of the demo schedules (for spacing their run history). */
function periodMinutes(cron: string): number {
  if (cron.startsWith('0 */4')) return 240;
  if (cron.endsWith('* * 1')) return 7 * 1440;
  return 1440;
}

/**
 * Loads the prototype's mock data (data.ts) into `store` (gap #21): sessions with
 * their agents, chat / terminal / timeline events and open question batches,
 * system Inbox items, worktrees, artifacts, schedules with 14 runs, loops and the
 * embedded tools. Relative ages become timestamps before `now`. Runs in one
 * transaction at startup, before the server listens.
 *
 * Refuses (DemoSeedError) a database that holds non-demo sessions; a database
 * that already holds the seed is left as it is.
 */
export async function seedDemo(store: Store, data: DemoData, options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const now = options.now ?? new Date();
  const base = options.timelineBase ?? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0);

  if (await store.settings.get(DEMO_SEED_KEY)) return { seeded: false, sessions: 0 };
  if ((await store.sessions.list()).length > 0) {
    throw new DemoSeedError('SWITCHBOARD_DEMO=1 needs an empty data folder; this database holds real sessions');
  }

  const db = store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    await insertAll(store, data, now, base);
    const marker: DemoSeedMarker = { version: DEMO_SEED_VERSION, seededAt: now.toISOString() };
    await store.settings.set(DEMO_SEED_KEY, marker);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return { seeded: true, sessions: data.sessions.length };
}

async function insertAll(store: Store, data: DemoData, now: Date, base: Date): Promise<void> {
  const sessionIds = new Map<string, string>();

  for (const s of data.sessions) {
    const lastActivity = minutesBefore(now, ageMinutes(s.age));
    const repos = at(store, lastActivity);
    const workType = WORK_TYPE[chip(s, 'work') ?? ''] ?? null;
    const mode = MODE[chip(s, 'mode') ?? ''] ?? null;
    const phase = PHASE[chip(s, 'phase') ?? ''] ?? null;
    const solutions = [...new Set(s.agents.map((a) => solutionOf(a.solutionPath)).filter((x): x is string => x !== null))];
    const task = s.messages.find((m) => m.from === 'user')?.text ?? '';
    const session = await repos.sessions.create({
      id: s.name,
      name: s.name,
      task,
      claudeSessionId: s.resumeId,
      status: s.status,
      workType,
      mode,
      phase,
      solutions,
      worktrees: s.agents.some((a) => a.branch !== ''),
      ultracode: false,
      attached: true,
      lastActivityAt: lastActivity,
    });
    sessionIds.set(s.name, session.id);

    const agentIds = new Map<string, string>();
    for (const [index, a] of s.agents.entries()) {
      const agent = await repos.agents.create({
        sessionId: session.id,
        kind: index === 0 && (mode === 'orchestrator' || s.agents.length === 1) ? 'main' : 'subagent',
        name: a.name,
        description: a.description,
        solutionPath: a.solutionPath,
        branch: a.branch === '' ? null : a.branch,
        status: a.status,
        statusText: a.statusText,
      });
      agentIds.set(a.name, agent.id);
    }

    // Chat, then the terminal tail, then the timeline blocks (payload.channel tells them apart).
    const start = minutesAfter(base, s.t0);
    const end = minutesAfter(base, s.t0 + s.duration);
    for (const [index, m] of s.messages.entries()) {
      await repos.events.append({
        sessionId: session.id,
        ts: index === 0 ? start : end,
        kind: 'text',
        label: m.text,
        payload: { source: 'demo', channel: 'chat', role: m.from === 'user' ? 'user' : 'assistant', text: m.text, tools: m.tools ?? [] },
      });
    }
    for (const line of s.terminal) {
      await repos.events.append({ sessionId: session.id, ts: end, kind: 'tool', label: line, payload: { source: 'demo', channel: 'terminal', line } });
    }
    for (const lane of s.timeline) {
      for (const block of lane.blocks) {
        const kind: EventKind = block.kind;
        await repos.events.append({
          sessionId: session.id,
          agentId: agentIds.get(lane.agent) ?? null,
          ts: minutesAfter(base, s.t0 + block.start),
          endTs: minutesAfter(base, s.t0 + block.end),
          kind,
          label: block.label,
          payload: { source: 'demo', channel: 'timeline', lane: lane.agent, solution: lane.solution },
        });
      }
    }

    if (s.questions.length > 0) {
      await repos.questions.createBatch(
        {
          id: `demo-${s.name}`,
          sessionId: session.id,
          input: {
            questions: s.questions.map((q) => ({
              question: q.text,
              header: q.source,
              options: q.options.map((label) => ({ label, description: '' })),
              multiSelect: false,
            })),
          },
          createdAt: lastActivity,
        },
        s.questions.map((q) => ({ source: q.source, text: q.text, options: q.options.map((label) => ({ label })) })),
      );
    }
  }

  // Schedules with their 14-run strips (oldest first). The failed schedule's last run is
  // the system item's age ago; the others ran an hour ago.
  const failedRun = data.inbox.system.find((x) => x.schedule);
  const scheduleIds = new Map<string, string>();
  const lastRunIds = new Map<string, string>();
  for (const sch of data.schedules) {
    const repos = at(store, minutesBefore(now, 30 * 1440));
    const schedule = await repos.schedules.create({
      name: sch.name,
      description: sch.description,
      cron: sch.cron,
      template: { name: sch.name, task: sch.description },
      paused: false,
    });
    scheduleIds.set(sch.name, schedule.id);
    const lastAgo = failedRun && failedRun.schedule === sch.name ? ageMinutes(failedRun.age) : 60;
    const period = periodMinutes(sch.cron);
    for (const [index, result] of sch.runs.entries()) {
      // M7.1: a run ends `ago` minutes before now (the failed one when its system item was raised) and
      // started 5 minutes earlier; `running` / `need` runs have no end yet.
      const ago = lastAgo + (sch.runs.length - 1 - index) * period;
      const isLast = index === sch.runs.length - 1;
      const run = await repos.schedules.addRun({
        scheduleId: schedule.id,
        ts: minutesBefore(now, ago + 5),
        finishedAt: result === 'running' || result === 'need' ? null : minutesBefore(now, ago),
        result,
        summary: isLast ? runSummary(sch.last) : null,
        triggeredBy: 'cron',
      });
      if (isLast) lastRunIds.set(sch.name, run.id);
    }
  }

  // Worktrees from the Solutions rows (in place = no worktree row) + the merged one.
  for (const group of data.solutions.groups) {
    for (const sol of group.solutions) {
      for (const b of sol.branches) {
        if (!b.worktree) continue;
        const repos = at(store, now.toISOString());
        await repos.worktrees.create({
          repo: sol.name,
          repoPath: path.posix.join(group.folder, sol.name === 'mobile' ? '' : sol.name),
          branch: b.branch,
          path: `../${b.worktree}`,
          sessionId: sessionIds.get(b.owner) ?? null,
        });
      }
    }
  }

  for (const item of data.inbox.system) {
    const createdAt = minutesBefore(now, ageMinutes(item.age));
    const repos = at(store, createdAt);
    let worktreeId: string | null = null;
    if (item.worktree) {
      const wt = await repos.worktrees.create({
        repo: item.worktree.repo,
        repoPath: path.posix.join('microfrontends', item.worktree.repo),
        branch: item.worktree.branch,
        path: item.worktree.path,
        prNumber: item.worktree.prNumber,
        prState: 'MERGED',
        prCheckedAt: createdAt,
        removable: true,
      });
      worktreeId = wt.id;
    }
    await repos.systemItems.create({
      id: item.id,
      // The kinds M3.3 raises (docs/system-items.md); the label comes back from SYSTEM_ITEM_LABELS.
      kind: item.schedule ? 'schedule-run-failed' : item.worktree ? 'worktree-removable' : item.label,
      source: item.source,
      status: item.status,
      title: item.title,
      detail: item.detail,
      branches: item.branches.map((b) => ({ solution: b.solution, branch: b.branch })),
      actions: item.actions.map((label) => ({ id: label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'), label })),
      scheduleId: item.schedule ? (scheduleIds.get(item.schedule) ?? null) : null,
      scheduleRunId: item.schedule ? (lastRunIds.get(item.schedule) ?? null) : null,
      worktreeId,
      payload: item.fixSession
        ? {
            prefill: {
              name: item.fixSession.name,
              task: item.fixSession.task,
              solutions: [...item.fixSession.sols],
              mode: item.fixSession.mode === 'orch' ? 'orchestrator' : 'single',
              phase: item.fixSession.phase === 'ui' ? 'ui-first' : 'integration',
            },
          }
        : null,
      createdAt,
    });
  }

  for (const a of data.artifacts) {
    const repos = at(store, minutesBefore(now, ageMinutes(a.age)));
    await repos.artifacts.create({
      type: a.type,
      name: a.name,
      solution: a.solution,
      branch: a.branch ?? null,
      sessionId: sessionIds.get(a.session) ?? null,
      meta: a.meta,
    });
  }

  for (const loop of data.loops) {
    const sessionId = sessionIds.get(loop.session);
    if (!sessionId) continue;
    const repos = at(store, now.toISOString());
    await repos.loops.create({
      sessionId,
      kind: loop.loopKind,
      label: loop.kind,
      iteration: loop.iteration,
      cap: loop.cap,
      breakerCount: loop.breakerCount,
      breakerState: loop.breakerState,
      nextFireAt: loop.nextFireInMinutes === null ? null : minutesAfter(now, loop.nextFireInMinutes),
      expiresAt: loop.expiresInDays === null ? null : minutesAfter(now, loop.expiresInDays * 1440),
      iterations: [...loop.iterations],
      note: loop.note,
    });
  }

  await at(store, now.toISOString()).tools.replaceAll(
    data.tools.map((tool, position) => ({
      id: tool.id,
      name: tool.name,
      url: tool.url,
      description: tool.description,
      showInSidebar: true,
      position,
    })),
  );
}
