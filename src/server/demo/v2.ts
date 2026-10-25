import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type { RepoContext } from '../db/context.ts';
import { EventRepository } from '../db/repos/events.ts';
import { SessionRepository } from '../db/repos/sessions.ts';
import { TodoRepository } from '../db/repos/todos.ts';
import type { Store } from '../db/store.ts';
import { PLANS_DB_FILE, PlansDb } from '../plans/db.ts';
import type { DemoData } from './data.ts';
import { DEMO_FOLDER_ID } from './seed.ts';

/**
 * D131 · lane X · the demo's v2 layer (`docs/demo.md` → *The v2 layer*): plausible Acme
 * rows for the v2 pages the prototype-verbatim seed leaves empty: sidebar folders and
 * pins (Agents' folder tree), tasks with estimates and actuals (Tasks, Insights), three
 * projects with steps in every state (Projects), two crews with four teammates (Crews),
 * notes (Notes) and a week of usage (Insights). It runs only with `config.demoV2`
 * (`SWITCHBOARD_DEMO=1` and a default theme that is not `classic`), so the classic visual
 * oracle and the README screenshots keep the plain seed.
 *
 * Two parts: {@link seedDemoV2Files} writes rows before the app is built (the main
 * database and `plans.db`, which Plans reads when it starts); {@link seedDemoV2Api} adds
 * the rest through the app's own API, in process (`app.inject`), once Team and Project
 * memory run. Both run once per data folder (the `demo.v2` setting).
 */

/** Settings key that marks the v2 layer: `{ version, files, api }`. */
export const DEMO_V2_KEY = 'demo.v2';

/** Version of the v2 layer's mapping. */
export const DEMO_V2_VERSION = 1;

interface DemoV2Marker {
  readonly version: number;
  readonly files: boolean;
  readonly api: boolean;
}

const MINUTE = 60_000;

/** The teammates' own agents (Crews): name, status, minutes since their last activity, the task, the agent's last reply. */
export const DEMO_V2_TEAMMATES: ReadonlyArray<{ readonly id: string; readonly status: 'idle' | 'run' | 'done'; readonly age: number; readonly task: string; readonly reply: string; readonly role: string; readonly template: string; readonly crew: 'web' | 'mobile' }> = [
  {
    id: 'acme-web-lead',
    status: 'idle',
    age: 25,
    task: 'Lead the Acme web crew: split PROJ-123 into steps and keep the checkout work moving.',
    reply: 'PROJ-124 and PROJ-125 are merged. PROJ-126 waits for your review; PROJ-127 has a question about the card form.',
    role: 'Web lead',
    template: 'planner',
    crew: 'web',
  },
  {
    id: 'acme-web-reviewer',
    status: 'run',
    age: 4,
    task: 'Review every Acme web pull request against the style guide before it is merged.',
    reply: 'Reviewing PR #241 (checkout screen): two comments so far, both about spacing at 768.',
    role: 'Reviewer',
    template: 'reviewer',
    crew: 'web',
  },
  {
    id: 'acme-release-manager',
    status: 'done',
    age: 95,
    task: 'Cut the Acme web release on Thursdays and write the release notes.',
    reply: 'Release 4.12 is out. Notes are saved as a result; nothing is blocked for next week.',
    role: 'Release manager',
    template: 'release-manager',
    crew: 'web',
  },
  {
    id: 'acme-mobile-dev',
    status: 'run',
    age: 7,
    task: 'Build the Acme mobile checkout screens from the Figma frames at 360 and 768.',
    reply: 'The 360 layout matches Figma; working on the 768 tablet layout now.',
    role: 'Mobile developer',
    template: 'developer',
    crew: 'mobile',
  },
];

/** The tasks (Tasks page): session, title, estimate, state, the minutes it took (done ones), priority. */
const TASKS: ReadonlyArray<{ readonly session: string; readonly title: string; readonly estimate: number | null; readonly state: 'open' | 'in_progress' | 'done'; readonly actual?: number; readonly priority: 'high' | 'medium' | 'low'; readonly doneAgo?: number }> = [
  { session: 'pair-talk-feature', title: 'Topic chips wrap at 360', estimate: 30, state: 'in_progress', priority: 'high' },
  { session: 'pair-talk-feature', title: 'PairTalkPage empty state', estimate: 20, state: 'open', priority: 'medium' },
  { session: 'pair-talk-feature', title: 'PairTalkService contract', estimate: 45, state: 'done', actual: 52, priority: 'high', doneAgo: 15 },
  { session: 'acme-alerts-integration', title: 'Alert thresholds per tenant', estimate: 60, state: 'open', priority: 'medium' },
  { session: 'acme-alerts-integration', title: 'Alerts swagger.yml', estimate: 30, state: 'done', actual: 25, priority: 'medium', doneAgo: 35 },
  { session: 'qa-pair-talk', title: 'Coverage matrix for PROJ-123', estimate: 40, state: 'in_progress', priority: 'high' },
  { session: 'button-rollout', title: 'AcmIconButton sizes', estimate: 25, state: 'done', actual: 31, priority: 'low', doneAgo: 50 },
  { session: 'acme-mobile-dev', title: 'Checkout at 768', estimate: 50, state: 'in_progress', priority: 'medium' },
];

/** One step of a demo project. */
interface DemoStep {
  readonly key: string;
  readonly title: string;
  readonly minutes: number;
  readonly after: readonly string[];
  readonly hold: boolean;
  readonly state: 'done' | 'running' | 'pending' | 'failed';
  /** The demo agent it runs in. */
  readonly run?: string;
  readonly waitingOn?: 'review' | 'question';
  /** Spans in minutes before now (`to` null = open). */
  readonly spans: ReadonlyArray<{ readonly kind: 'running' | 'waiting-you' | 'waiting-dependency'; readonly from: number; readonly to: number | null }>;
}

/** The demo projects (Projects): a running one with steps in every state, a finished one and a draft. */
const PROJECTS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly source: string; readonly branch: string; readonly state: 'running' | 'done' | 'draft'; readonly createdAgo: number; readonly steps: readonly DemoStep[] }> = [
  {
    id: 'demo-v2-checkout',
    title: 'PROJ-123 Acme checkout',
    source: 'pair-talk-feature',
    branch: 'feature/PROJ-123-acme-checkout',
    state: 'running',
    createdAgo: 210,
    steps: [
      { key: 'PROJ-124', title: 'Checkout API contract (ADR)', minutes: 45, after: [], hold: true, state: 'done', spans: [{ kind: 'running', from: 200, to: 160 }, { kind: 'waiting-you', from: 160, to: 150 }] },
      { key: 'PROJ-125', title: 'Receipt e-mail template', minutes: 30, after: [], hold: false, state: 'done', spans: [{ kind: 'running', from: 200, to: 170 }] },
      { key: 'PROJ-126', title: 'Checkout screen', minutes: 90, after: ['PROJ-124'], hold: true, state: 'running', run: 'prod-monitoring', waitingOn: 'review', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: 45 }, { kind: 'waiting-you', from: 45, to: null }] },
      { key: 'PROJ-127', title: 'Payment form', minutes: 60, after: ['PROJ-124'], hold: false, state: 'running', run: 'button-rollout', waitingOn: 'question', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: 20 }, { kind: 'waiting-you', from: 20, to: null }] },
      { key: 'PROJ-128', title: 'Order summary', minutes: 120, after: ['PROJ-124'], hold: false, state: 'running', run: 'reminder-func-fix', spans: [{ kind: 'waiting-dependency', from: 200, to: 150 }, { kind: 'running', from: 150, to: null }] },
      { key: 'PROJ-129', title: 'Wire checkout to the API', minutes: 60, after: ['PROJ-126', 'PROJ-127'], hold: false, state: 'pending', spans: [{ kind: 'waiting-dependency', from: 200, to: null }] },
      { key: 'PROJ-130', title: 'Checkout E2E', minutes: 45, after: ['PROJ-129', 'PROJ-128'], hold: false, state: 'pending', spans: [{ kind: 'waiting-dependency', from: 200, to: null }] },
    ],
  },
  {
    id: 'demo-v2-alerts',
    title: 'PROJ-140 Acme alerts digest',
    source: 'acme-alerts-integration',
    branch: 'feature/PROJ-140-alerts-digest',
    state: 'done',
    createdAgo: 2 * 1440,
    steps: [
      { key: 'PROJ-141', title: 'Digest e-mail', minutes: 40, after: [], hold: false, state: 'done', spans: [{ kind: 'running', from: 2 * 1440 - 30, to: 2 * 1440 - 75 }] },
      { key: 'PROJ-142', title: 'Digest schedule', minutes: 20, after: ['PROJ-141'], hold: false, state: 'done', spans: [{ kind: 'running', from: 2 * 1440 - 80, to: 2 * 1440 - 100 }] },
    ],
  },
  {
    id: 'demo-v2-loyalty',
    title: 'PROJ-150 Acme loyalty points',
    source: 'pair-talk-feature',
    branch: 'feature/PROJ-150-loyalty-points',
    state: 'draft',
    createdAgo: 30,
    steps: [
      { key: 'PROJ-151', title: 'Points ledger', minutes: 60, after: [], hold: false, state: 'pending', spans: [] },
      { key: 'PROJ-152', title: 'Points on the receipt', minutes: 30, after: ['PROJ-151'], hold: false, state: 'pending', spans: [] },
    ],
  },
];

/** The notes (Notes page): what agents know about the Acme workspace. */
const NOTES: ReadonlyArray<{ readonly title: string; readonly text: string; readonly tags: readonly string[]; readonly pinned?: boolean }> = [
  { title: 'Breakpoints', text: 'Web covers 360, 640, 768, 1024, 1366 and 1920; mobile covers 360 to 1024 only.', tags: ['design'], pinned: true },
  { title: 'Checkout contract', text: 'PairTalkService.TopicId is required on both stacks (decided for PROJ-123).', tags: ['contract'] },
  { title: 'Release day', text: 'Acme web releases go out on Thursdays; nothing merges to master after 15:00 that day.', tags: ['process'] },
];

/** A week of usage per demo agent (Insights): turns and tokens per day, newest last. */
const USAGE: ReadonlyArray<{ readonly session: string; readonly model: string; readonly turns: readonly number[]; readonly kTokens: readonly number[] }> = [
  { session: 'pair-talk-feature', model: 'claude-opus-4-7', turns: [12, 18, 9, 22, 15, 26, 14], kTokens: [410, 620, 300, 780, 510, 900, 460] },
  { session: 'acme-alerts-integration', model: 'claude-opus-4-7', turns: [6, 0, 11, 8, 14, 9, 7], kTokens: [210, 0, 380, 260, 470, 300, 240] },
  { session: 'qa-pair-talk', model: 'claude-sonnet-4-6', turns: [0, 5, 7, 4, 9, 12, 6], kTokens: [0, 120, 160, 90, 210, 280, 140] },
  { session: 'button-rollout', model: 'claude-sonnet-4-6', turns: [8, 6, 0, 10, 5, 7, 4], kTokens: [180, 140, 0, 230, 110, 160, 90] },
  { session: 'acme-web-reviewer', model: 'claude-sonnet-4-6', turns: [3, 4, 2, 6, 3, 5, 4], kTokens: [60, 80, 40, 120, 60, 100, 80] },
];

function iso(now: Date, minutesAgo: number): string {
  return new Date(now.getTime() - minutesAgo * MINUTE).toISOString();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function markerOf(store: Store): Promise<DemoV2Marker | null> {
  const raw = await store.settings.get(DEMO_V2_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return { version: Number(value['version'] ?? 0), files: value['files'] === true, api: value['api'] === true };
}

/**
 * Part one, before the app is built: the teammates' agents with a short chat, the
 * tasks, a week of Insights rows (main database) and the projects (`plans.db`, opened
 * with its migrations, then written). Skipped when it ran on this data folder before.
 */
export async function seedDemoV2Files(store: Store, dataDir: string, data: DemoData, now: Date = new Date()): Promise<boolean> {
  if ((await markerOf(store))?.files) return false;
  const db = store.db;
  const todoIds = new Map<string, string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const mate of DEMO_V2_TEAMMATES) {
      const ts = iso(now, mate.age);
      const ctx: RepoContext = { db, now: () => ts };
      const sessions = new SessionRepository(ctx);
      const events = new EventRepository(ctx);
      await sessions.create({
        id: mate.id,
        name: mate.id,
        task: mate.task,
        claudeSessionId: randomUUID(),
        status: mate.status,
        workType: 'feature',
        mode: 'single',
        phase: null,
        solutions: [],
        worktrees: false,
        ultracode: false,
        attached: true,
        cwd: data.solutions.root,
        folderId: DEMO_FOLDER_ID,
        root: data.solutions.root,
        rootKind: 'workspace',
        lastActivityAt: ts,
      });
      const start = iso(now, mate.age + 12);
      await events.append({ sessionId: mate.id, ts: start, kind: 'text', label: mate.task, payload: { source: 'demo', type: 'user', text: mate.task, origin: 'task', delivered: true } });
      await events.append({ sessionId: mate.id, ts, kind: 'text', label: mate.reply, payload: { source: 'demo', type: 'assistant', text: mate.reply, messageId: null } });
    }

    for (const task of TASKS) {
      const created = iso(now, (task.doneAgo ?? 30) + (task.actual ?? 20) + 60);
      const ctx: RepoContext = { db, now: () => created };
      await new TodoRepository(ctx).import(task.session, [
        {
          title: task.title,
          description: null,
          plan: 'No plan: demo task.',
          priority: task.priority,
          estimateMinutes: task.estimate,
          state: task.state,
          addedBy: 'developer',
          createdAt: created,
          doneAt: task.state === 'done' ? iso(now, task.doneAgo ?? 30) : null,
          ...(task.state === 'open' ? {} : { startedAt: iso(now, (task.doneAgo ?? 0) + (task.actual ?? 15)), startedBy: 'developer' as const }),
        },
      ]);
      if (task.actual !== undefined) {
        db.prepare("UPDATE session_todos SET actual_ms = ?, actual_tokens = ? WHERE session_id = ? AND title = ?").run(task.actual * MINUTE, task.actual * 4_200, task.session, task.title);
      }
    }

    // The projects' steps are tasks of their source agent (Plans links each step to one).
    for (const project of PROJECTS) {
      const ctx: RepoContext = { db, now: () => iso(now, project.createdAgo) };
      const repo = new TodoRepository(ctx);
      for (const step of project.steps) {
        const title = `${step.key} ${step.title}`;
        const running = step.spans.find((span) => span.kind === 'running');
        await repo.import(project.source, [
          {
            title,
            description: `${project.title}: ${step.title.toLowerCase()}.`,
            plan: 'No plan: demo step.',
            priority: 'medium',
            estimateMinutes: step.minutes,
            state: step.state === 'done' ? 'done' : step.state === 'running' ? 'in_progress' : 'open',
            addedBy: 'developer',
            createdAt: iso(now, project.createdAgo),
            doneAt: step.state === 'done' ? iso(now, step.spans.at(-1)?.to ?? project.createdAgo - 60) : null,
            ...(step.state === 'pending' ? {} : { startedAt: iso(now, running?.from ?? project.createdAgo), startedBy: 'developer' as const }),
          },
        ]);
        const row = db.prepare('SELECT id FROM session_todos WHERE session_id = ? AND title = ? ORDER BY position DESC LIMIT 1').get(project.source, title);
        if (row) todoIds.set(`${project.id}/${step.key}`, String(row['id']));
      }
    }

    for (const usage of USAGE) {
      const session = db.prepare('SELECT provider, root FROM sessions WHERE id = ?').get(usage.session);
      if (!session) continue;
      usage.turns.forEach((turns, index) => {
        if (turns === 0) return;
        const day = new Date(now.getTime() - (usage.turns.length - 1 - index) * 1440 * MINUTE).toISOString().slice(0, 10);
        const tokens = (usage.kTokens[index] ?? 0) * 1000;
        db.prepare(
          `INSERT INTO insight_turns_daily (day, session_id, provider, model, profile_id, folder, kind, turns, error_turns, tokens, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, unsplit_tokens, duration_ms, reverts, redos)
           VALUES (?, ?, ?, ?, ?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
           ON CONFLICT (day, session_id, provider, model, profile_id) DO NOTHING`,
        ).run(
          day,
          usage.session,
          String(session['provider'] ?? 'claude'),
          usage.model,
          `default-${String(session['provider'] ?? 'claude')}`,
          String(session['root'] ?? ''),
          turns,
          turns > 10 ? 1 : 0,
          tokens,
          Math.round(tokens * 0.08),
          Math.round(tokens * 0.07),
          Math.round(tokens * 0.15),
          Math.round(tokens * 0.7),
          turns * 95_000,
          turns > 15 ? 1 : 0,
        );
      });
    }
    await store.settings.set(DEMO_V2_KEY, { version: DEMO_V2_VERSION, files: true, api: false });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  await seedProjects(dataDir, todoIds, now);
  return true;
}

/** The projects into `plans.db` (created with its migrations when missing), before Plans opens it. */
async function seedProjects(dataDir: string, todoIds: ReadonlyMap<string, string>, now: Date): Promise<void> {
  (await PlansDb.open(dataDir)).close();
  const db = new DatabaseSync(path.join(dataDir, PLANS_DB_FILE));
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const project of PROJECTS) {
      const started = project.state === 'draft' ? null : iso(now, project.createdAgo - 10);
      db.prepare(
        `INSERT INTO plans (id, title, source_session_id, target_branch, repos, base_branch, merge_mode, max_concurrency, usage_threshold, answers, state, created_at, updated_at, started_at)
         VALUES (?, ?, ?, ?, ?, 'dev', ?, 3, 85, NULL, ?, ?, ?, ?)`,
      ).run(project.id, project.title, project.source, project.branch, JSON.stringify(['web']), project.state === 'draft' ? null : 'agents-with-holds', project.state, iso(now, project.createdAgo), iso(now, 1), started);
      const itemIds = new Map<string, string>();
      project.steps.forEach((step, position) => {
        const id = `${project.id}-${step.key.toLowerCase()}`;
        itemIds.set(step.key, id);
        const running = step.spans.find((span) => span.kind === 'running');
        const stepStarted = step.state === 'pending' ? null : iso(now, running?.from ?? project.createdAgo);
        const done = step.state === 'done' ? iso(now, step.spans.at(-1)?.to ?? project.createdAgo - 60) : null;
        const waitingSince = step.waitingOn ? iso(now, step.spans.at(-1)?.from ?? 20) : null;
        db.prepare(
          `INSERT INTO plan_items (id, plan_id, todo_id, key, title, estimate_minutes, hold, solutions, state, waiting_on, run_session_id, branch, position, created_at, updated_at, started_at, waiting_since, merged_at, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          project.id,
          todoIds.get(`${project.id}/${step.key}`) ?? null,
          step.key,
          step.title,
          step.minutes,
          step.hold ? 1 : 0,
          step.state,
          step.waitingOn ?? null,
          step.run ?? null,
          step.state === 'pending' ? null : `${step.key}-${slug(step.title)}`,
          position,
          iso(now, project.createdAgo),
          iso(now, 1),
          stepStarted,
          waitingSince,
          done,
          done,
        );
        for (const span of step.spans) db.prepare('INSERT INTO plan_item_spans (plan_id, item_id, kind, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(project.id, id, span.kind, iso(now, span.from), span.to === null ? null : iso(now, span.to));
      });
      for (const step of project.steps) {
        for (const before of step.after) db.prepare('INSERT INTO plan_edges (plan_id, from_item, to_item) VALUES (?, ?, ?)').run(project.id, itemIds.get(before) as string, itemIds.get(step.key) as string);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

/** How {@link seedDemoV2Api} reaches the app (its own loopback guard: host and token cookie). */
export interface DemoV2Access {
  readonly port: number;
  readonly token: string;
  readonly onError?: (error: unknown) => void;
}

/**
 * Part two, through the app's own API (in process): the sidebar's folders and pins,
 * the two crews with the teammates (Team's adopt, no charter ask) and the notes. Each
 * call that fails is reported and skipped (a demo that shows a little less still starts).
 */
export async function seedDemoV2Api(app: FastifyInstance, store: Store, data: DemoData, access: DemoV2Access): Promise<boolean> {
  const marker = await markerOf(store);
  if (!marker?.files || marker.api) return false;
  const headers = { host: `127.0.0.1:${access.port}`, cookie: `sb_token=${access.token}`, 'content-type': 'application/json' };
  const call = async (method: 'POST' | 'PUT', url: string, body: unknown): Promise<Record<string, unknown> | null> => {
    const response = await app.inject({ method, url, headers, payload: JSON.stringify(body) });
    if (response.statusCode >= 300) {
      access.onError?.(new Error(`demo v2: ${method} ${url} → ${response.statusCode} ${response.body.slice(0, 200)}`));
      return null;
    }
    return response.json() as Record<string, unknown>;
  };
  const folderId = (answer: Record<string, unknown> | null, name: string): string | undefined => (answer?.['folders'] as Array<{ id: string; name: string }> | undefined)?.find((folder) => folder.name === name)?.id;

  // Agents: folders (with a subfolder) and pins (D54, D58).
  await call('POST', '/api/sidebar/place', { sessionId: 'pair-talk-feature', place: 'pinned' });
  await call('POST', '/api/sidebar/place', { sessionId: 'acme-alerts-integration', place: 'pinned' });
  const web = folderId(await call('POST', '/api/sidebar/folders', { name: 'Acme web' }), 'Acme web');
  if (web) {
    await call('POST', '/api/sidebar/place', { sessionId: 'pair-talk-feature', place: 'folder', folderId: web });
    await call('POST', '/api/sidebar/place', { sessionId: 'qa-pair-talk', place: 'folder', folderId: web });
  }
  const maintenance = folderId(await call('POST', '/api/sidebar/folders', { name: 'Maintenance' }), 'Maintenance');
  if (maintenance) {
    await call('POST', '/api/sidebar/place', { sessionId: 'reminder-func-fix', place: 'folder', folderId: maintenance });
    await call('POST', '/api/sidebar/place', { sessionId: 'prod-monitoring', place: 'folder', folderId: maintenance });
    const releases = folderId(await call('POST', '/api/sidebar/folders', { name: 'Releases', parentId: maintenance }), 'Releases');
    if (releases) await call('POST', '/api/sidebar/place', { sessionId: 'button-rollout', place: 'folder', folderId: releases });
  }

  // Crews: the first crew renamed, a second one, the teammates adopted.
  await call('PUT', '/api/team', { name: 'Acme web' });
  const mobile = await call('POST', '/api/team/teams', { name: 'Acme mobile' });
  for (const mate of DEMO_V2_TEAMMATES) {
    await call('POST', '/api/team/members', { sessionId: mate.id, name: mate.role, templateId: mate.template, ...(mate.crew === 'mobile' && typeof mobile?.['id'] === 'string' ? { teamId: mobile['id'] } : {}) });
  }

  // Notes: what agents know about the workspace folder.
  for (const note of NOTES) await call('POST', '/api/memory/entries', { scope: data.solutions.root, title: note.title, text: note.text, tags: note.tags, ...(note.pinned ? { pinned: true } : {}) });

  await store.settings.set(DEMO_V2_KEY, { version: DEMO_V2_VERSION, files: true, api: true });
  return true;
}
