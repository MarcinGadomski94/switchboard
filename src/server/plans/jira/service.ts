import { isRemoteId } from '../../../core/peers.ts';
import type { Plan, PlanItem } from '../../../core/plans.ts';
import {
  DEFAULT_JIRA_TRANSITIONS,
  JIRA_COMMENTS,
  JIRA_IMPORT_MAX,
  JIRA_REFRESH_MS,
  JIRA_SYNC_MODES,
  type JiraPreview,
  type JiraSyncMode,
  type JiraTransitionNames,
  type PlanJiraActivity,
  type PlanJiraState,
  buildJiraPreview,
  checkTransitionName,
  findTransition,
  jiraCommentMarker,
  jiraDrift,
  jiraItemTodo,
  jiraPreviewItem,
  parseEpicKey,
  statusCategoryOf,
} from '../../../core/plans-jira.ts';
import type { Store } from '../../db/store.ts';
import type { HubBus, HubMessage } from '../../hub/bus.ts';
import { SYSTEM_CLOCK, type SchedulerClock } from '../../schedules/scheduler.ts';
import type { TodoService } from '../../todos/service.ts';
import { PlanError, type PlanService } from '../service.ts';
import { JiraClient, JiraError } from './client.ts';
import type { JiraCredentialSource } from './credentials.ts';
import type { PlanJiraItemRecord, PlanJiraRecord, PlanJiraStore } from './store.ts';

/** Why a Jira-lane call was refused: maps to the HTTP answer of the route. */
export class PlanJiraError extends Error {
  override name = 'PlanJiraError';
  readonly status: number;
  readonly code: string;
  readonly field: string | null;
  constructor(status: number, code: string, message: string, field: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }

  /** `{ error, message }`, with `errors: [{ field, message }]` on a field. */
  body(): Record<string, unknown> {
    return this.field !== null ? { error: this.code, message: this.message, errors: [{ field: this.field, message: this.message }] } : { error: this.code, message: this.message };
  }
}

/** The answer when Plans is switched off (Settings → Experimental → Plans). */
export function plansOff(): PlanJiraError {
  return new PlanJiraError(404, 'plans-off', 'Plans is off: switch it on in Settings → Experimental');
}

/** A {@link JiraError} as the route's answer: 502 (404 for an epic that is not there). */
export function fromJiraError(error: JiraError): PlanJiraError {
  if (error.code === 'not-found') return new PlanJiraError(404, 'jira-not-found', error.message);
  if (error.code === 'auth') return new PlanJiraError(502, 'jira-auth', error.message);
  if (error.code === 'unreachable') return new PlanJiraError(502, 'jira-unreachable', error.message);
  return new PlanJiraError(502, 'jira-failed', error.message);
}

/** Options of {@link PlanJiraService}. */
export interface PlanJiraServiceOptions {
  readonly store: Store;
  readonly plans: PlanService;
  readonly todos: TodoService;
  readonly bus: HubBus;
  /** The Jira tables in `plans.db` (opened on first use while Plans is on). */
  readonly db: () => Promise<PlanJiraStore>;
  /** Closes `plans.db`'s Jira connection (called when Plans is seen off). */
  readonly release?: () => void;
  readonly credentials: JiraCredentialSource;
  /** Whether Plans is on and `plans.db` open (Settings → Experimental → Plans). Off: every call answers 404 `plans-off`, no sync runs. */
  readonly enabled: () => boolean | Promise<boolean>;
  /** The HTTP client Jira is called with (tests: the real one, at the fake Jira). */
  readonly fetch?: typeof fetch;
  readonly clock?: SchedulerClock;
  /** How often a running plan's tickets are read again (default {@link JIRA_REFRESH_MS}). */
  readonly refreshMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** The fields the import reads (plus the acceptance-criteria field when Jira has one). */
const IMPORT_FIELDS = ['summary', 'description', 'status', 'assignee', 'components', 'issuelinks', 'timeoriginalestimate', 'issuetype'];

/** A write that keeps failing is given up after this many attempts (an activity line says so). */
const MAX_ATTEMPTS = 5;

/** The plan states in which the write mode follows the items. */
const FOLLOWED = new Set(['running', 'paused', 'done']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The core's note of an item the developer counted as done (no merge happened: no "merged" comment). */
const MARKED_DONE = 'marked done by the developer';

/**
 * D99 · Plans · Jira (`docs/plans.md` → *Jira import and status sync*): the import (an epic's
 * children → a draft plan through the core's {@link PlanService.createFromExternal} seam) and
 * the per-plan status sync (`off` / `read-only` / `write`). The write mode follows
 * `planChanged`: an item's run starts → "In Progress"; its PR opens → "In Review" and a comment
 * with the link; it waits on a developer question → a comment; it is merged → a comment
 * "Merged into <target>" (never Done). Every write is recorded (idempotent: a write event is
 * done once, a comment carries a marker a retry finds) and shown in the plan's Jira activity.
 * Runs on the machine that owns the plan; nothing runs while Plans is off.
 */
export class PlanJiraService {
  readonly #options: PlanJiraServiceOptions;
  readonly #clock: SchedulerClock;
  readonly #refreshMs: number;
  readonly #onError: (error: unknown) => void;
  /** One sync pass at a time per plan. */
  readonly #queues = new Map<string, Promise<void>>();
  /** Plans whose next pass is already queued. */
  readonly #queued = new Set<string>();
  #unsubscribe: (() => void) | null = null;
  #timer: unknown = null;
  /** The timer's refresh in flight. */
  #ticking: Promise<void> | null = null;
  #closed = false;

  constructor(options: PlanJiraServiceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#refreshMs = options.refreshMs ?? JIRA_REFRESH_MS;
    this.#onError = options.onError ?? ((error) => console.error('switchboard plans jira:', error instanceof Error ? error.message : 'failed'));
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Starts following the plans (`planChanged`) and the 30-minute refresh. */
  start(): void {
    if (this.#unsubscribe || this.#closed) return;
    this.#unsubscribe = this.#options.bus.subscribe((message) => this.#onMessage(message));
    this.#arm();
  }

  /** Stops following; waits for the passes in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    await this.idle();
  }

  /** Resolves once the queued passes are done (tests). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0 || this.#ticking !== null) {
      await this.#ticking;
      await Promise.all([...this.#queues.values()].map((run) => run.catch(() => undefined)));
    }
  }

  #arm(): void {
    if (this.#closed) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      const run = this.tick()
        .catch((error: unknown) => this.#onError(error))
        .finally(() => {
          if (this.#ticking === run) this.#ticking = null;
          this.#arm();
        });
      this.#ticking = run;
    }, this.#refreshMs);
  }

  /** The timer's work (tests call it directly): every running plan with a sync is read again, then followed. */
  async tick(): Promise<void> {
    if (!(await this.#enabled())) return;
    for (const record of await (await this.#jdb()).plans()) {
      if (record.sync === 'off') continue;
      const plan = await this.#options.plans.get(record.planId).catch(() => null);
      if (!plan || plan.state !== 'running') continue;
      await this.#refresh(record, plan, 'timer').catch((error: unknown) => this.#onError(error));
      this.#queue(record.planId);
    }
  }

  #onMessage(message: HubMessage): void {
    if (message.name !== 'planChanged') return;
    const { planId, state } = message.payload;
    if (isRemoteId(planId)) return;
    if (state === null) {
      // The plan was deleted: its Jira rows go too.
      void this.#enabled()
        .then(async (on) => (on ? (await this.#jdb()).deletePlan(planId) : undefined))
        .catch((error: unknown) => this.#onError(error));
      return;
    }
    if (FOLLOWED.has(state)) this.#queue(planId);
  }

  #queue(planId: string): void {
    if (this.#closed || this.#queued.has(planId)) return;
    this.#queued.add(planId);
    const previous = this.#queues.get(planId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        this.#queued.delete(planId);
        await this.#follow(planId);
      })
      .catch((error: unknown) => this.#onError(error));
    this.#queues.set(planId, run);
    void run.finally(() => {
      if (this.#queues.get(planId) === run) this.#queues.delete(planId);
    });
  }

  async #enabled(): Promise<boolean> {
    let on = false;
    try {
      on = await this.#options.enabled();
    } catch {
      on = false;
    }
    if (!on) this.#options.release?.();
    return on;
  }

  #jdb(): Promise<PlanJiraStore> {
    return this.#options.db();
  }

  async #gate(): Promise<void> {
    if (!(await this.#enabled())) throw plansOff();
  }

  async #client(): Promise<JiraClient> {
    const found = await this.#options.credentials.resolve();
    if (!found) throw new PlanJiraError(409, 'jira-not-configured', 'Jira is not set up on this machine: Settings → Integrations → Jira, or ATL_BASE_URL, ATL_USER and ATL_TOKEN in the environment');
    return new JiraClient(found.credentials, this.#options.fetch ? { fetch: this.#options.fetch } : {});
  }

  // ── import ──────────────────────────────────────────────────────────────

  async #source(sessionId: string): Promise<void> {
    const session = await this.#options.store.sessions.get(sessionId);
    if (!session) throw new PlanJiraError(404, 'not-found', `no session ${sessionId}`);
  }

  async #preview(client: JiraClient, epicKey: string): Promise<JiraPreview> {
    try {
      const epic = await client.issue(epicKey, ['summary', 'issuetype']);
      const acceptanceField = await client.acceptanceField().catch(() => null);
      const fields = acceptanceField ? [...IMPORT_FIELDS, acceptanceField] : IMPORT_FIELDS;
      const children = await client.search(`parent = ${epicKey} ORDER BY key ASC`, fields, JIRA_IMPORT_MAX);
      return buildJiraPreview({ baseUrl: client.baseUrl, epic, children: children.issues, acceptanceField, truncated: children.truncated });
    } catch (error) {
      if (error instanceof JiraError) throw fromJiraError(error);
      throw error;
    }
  }

  /**
   * `POST /api/sessions/{id}/plans/jira/preview` `{ epic }` (a key or an issue URL): the epic's
   * children, their dependencies, the outside links, the cycles left out, the unlinked items.
   * Nothing is created.
   */
  async preview(sessionId: string, body: unknown): Promise<JiraPreview> {
    await this.#gate();
    await this.#source(sessionId);
    const epicKey = parseEpicKey(isRecord(body) ? body['epic'] : undefined);
    if (!epicKey) throw new PlanJiraError(422, 'invalid', 'paste an epic key (PROJ-100) or its Jira link', 'epic');
    const preview = await this.#preview(await this.#client(), epicKey);
    if (preview.items.length === 0) throw new PlanJiraError(422, 'empty-epic', `${epicKey} has no child issues`, 'epic');
    return preview;
  }

  /**
   * `POST /api/sessions/{id}/plans/jira/import`: reads the epic again and creates a **draft** plan
   * through the core's seam: one item per child (title "KEY Summary", description with the
   * acceptance criteria, the key, no solutions: the developer picks them), the dependencies of
   * the preview (cycles and outside links left out), `external { jira, epicKey }`. Body: `epic`,
   * `targetBranch` (required), optional `title`, `baseBranch`, `repos`, `maxConcurrency`,
   * `sync` (default `off`), `transitions`. The merge mode is chosen at Start (the core requires it).
   */
  async importPlan(sessionId: string, body: unknown): Promise<{ readonly plan: Plan; readonly jira: PlanJiraState; readonly preview: JiraPreview }> {
    await this.#gate();
    await this.#source(sessionId);
    const input = isRecord(body) ? body : {};
    const epicKey = parseEpicKey(input['epic']);
    if (!epicKey) throw new PlanJiraError(422, 'invalid', 'paste an epic key (PROJ-100) or its Jira link', 'epic');
    const sync = checkSync(input['sync'], 'off');
    const transitions = checkTransitions(input['transitions'], DEFAULT_JIRA_TRANSITIONS);
    const client = await this.#client();
    const preview = await this.#preview(client, epicKey);
    if (preview.items.length === 0) throw new PlanJiraError(422, 'empty-epic', `${epicKey} has no child issues`, 'epic');
    const title = typeof input['title'] === 'string' && input['title'].trim() !== '' ? input['title'] : preview.suggestedTitle;
    const created = await this.#options.plans.createFromExternal({
      sourceSessionId: sessionId,
      title,
      targetBranch: typeof input['targetBranch'] === 'string' ? input['targetBranch'] : '',
      ...(typeof input['baseBranch'] === 'string' && input['baseBranch'] !== '' ? { baseBranch: input['baseBranch'] } : {}),
      ...(Array.isArray(input['repos']) ? { repos: input['repos'] as string[] } : {}),
      ...(typeof input['maxConcurrency'] === 'number' ? { maxConcurrency: input['maxConcurrency'] } : {}),
      external: { system: 'jira', key: epicKey },
      items: preview.items.map((item) => {
        const todo = jiraItemTodo(item);
        return { ref: item.key, key: item.key, title: todo.title, description: todo.description, estimateMinutes: item.estimateMinutes, solutions: [] };
      }),
      edges: preview.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    });
    await (await this.#jdb()).createPlan({
      planId: created.plan.id,
      epicKey,
      baseUrl: client.baseUrl,
      sync,
      transitions,
      items: preview.items.map((item) => ({ itemId: created.itemIds[item.key] as string, key: item.key, status: item.status, statusCategory: null, summary: item.summary })),
    });
    const notes = [`${preview.items.length} items and ${preview.edges.length} dependencies from ${epicKey}`, preview.cycles.length > 0 ? `${preview.cycles.length} link(s) left out (cycle)` : null, preview.externalLinks.length > 0 ? `${preview.externalLinks.length} link(s) outside the epic` : null, `sync ${sync}`].filter(Boolean);
    await (await this.#jdb()).addActivity(created.plan.id, { itemId: null, key: epicKey, kind: 'import', text: `Imported ${notes.join(' · ')}` });
    this.#options.bus.publish('planChanged', { planId: created.plan.id, state: created.plan.state });
    return { plan: created.plan, jira: await this.#state(created.plan), preview };
  }

  // ── a plan's Jira state and settings ────────────────────────────────────

  async #record(planId: string): Promise<PlanJiraRecord> {
    const record = await (await this.#jdb()).plan(planId);
    if (!record) throw new PlanJiraError(404, 'not-jira', 'this plan was not imported from Jira');
    return record;
  }

  async #plan(planId: string): Promise<Plan> {
    return this.#options.plans.get(planId);
  }

  async #state(plan: Plan): Promise<PlanJiraState> {
    const record = await this.#record(plan.id);
    const rows = await (await this.#jdb()).items(plan.id);
    return {
      planId: plan.id,
      epicKey: record.epicKey,
      epicUrl: `${record.baseUrl}/browse/${record.epicKey}`,
      sync: record.sync,
      transitions: record.transitions,
      lastRefreshAt: record.lastRefreshAt,
      items: rows
        .filter((row) => plan.items.some((item) => item.id === row.itemId))
        .map((row) => {
          const item = plan.items.find((candidate) => candidate.id === row.itemId) as PlanItem;
          return {
            itemId: row.itemId,
            key: row.key,
            url: `${record.baseUrl}/browse/${row.key}`,
            statusAtImport: row.statusAtImport,
            status: row.status,
            statusCategory: row.statusCategory,
            summary: row.summary,
            refreshedAt: row.refreshedAt,
            drift: record.sync === 'off' ? null : jiraDrift({ itemState: item.state, status: row.status, statusCategory: row.statusCategory, statusAtImport: row.statusAtImport }),
            syncNote: row.syncNote,
          };
        }),
      activity: await (await this.#jdb()).activity(plan.id),
    };
  }

  /** `GET /api/plans/{id}/jira`. @throws 404 `not-jira` for a plan that was not imported. */
  async state(planId: string): Promise<PlanJiraState> {
    await this.#gate();
    return this.#state(await this.#plan(planId));
  }

  /** `PUT /api/plans/{id}/jira` `{ sync?, transitions? }` (any time before the plan is done or cancelled). */
  async update(planId: string, body: unknown): Promise<PlanJiraState> {
    await this.#gate();
    const plan = await this.#plan(planId);
    const record = await this.#record(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanJiraError(409, 'finished', `the plan is ${plan.state}`);
    const input = isRecord(body) ? body : {};
    const sync = input['sync'] === undefined ? record.sync : checkSync(input['sync'], record.sync);
    const transitions = input['transitions'] === undefined ? record.transitions : checkTransitions(input['transitions'], record.transitions);
    const changes: string[] = [];
    if (sync !== record.sync) changes.push(`sync ${record.sync} → ${sync}`);
    if (JSON.stringify(transitions) !== JSON.stringify(record.transitions)) changes.push(`transitions "${transitions.inProgress}" / "${transitions.inReview}"`);
    if (changes.length > 0) {
      await (await this.#jdb()).updatePlan(planId, { sync, transitions });
      await (await this.#jdb()).addActivity(planId, { itemId: null, key: null, kind: 'settings', text: `Jira ${changes.join(', ')}` });
      this.#options.bus.publish('planChanged', { planId, state: plan.state });
    }
    return this.#state(plan);
  }

  /** `POST /api/plans/{id}/jira/refresh`: reads the tickets again now (a plan whose sync is not off). */
  async refreshNow(planId: string): Promise<PlanJiraState> {
    await this.#gate();
    const plan = await this.#plan(planId);
    const record = await this.#record(planId);
    if (record.sync === 'off') throw new PlanJiraError(409, 'sync-off', "the plan's Jira sync is off: choose read-only or write first");
    await this.#refresh(record, plan, 'developer');
    this.#options.bus.publish('planChanged', { planId, state: plan.state });
    return this.#state(await this.#plan(planId));
  }

  /**
   * Reads every item's ticket (title, status, description). A pending item's todo takes the
   * new title and description (a running item's agent already has its brief: only the drift
   * note shows). @throws {PlanJiraError} when Jira cannot be read (also recorded in the activity).
   */
  async #refresh(record: PlanJiraRecord, plan: Plan, by: 'developer' | 'timer'): Promise<void> {
    let client: JiraClient;
    try {
      client = await this.#client();
    } catch (error) {
      await (await this.#jdb()).addActivity(plan.id, { itemId: null, key: null, kind: 'error', text: `Refresh failed: ${(error as Error).message}` });
      throw error;
    }
    const rows = await (await this.#jdb()).items(plan.id);
    // The same fields as the import, so a pending item's todo is rebuilt exactly as the import made it.
    const acceptanceField = await client.acceptanceField().catch(() => null);
    const fields = acceptanceField ? [...IMPORT_FIELDS, acceptanceField] : IMPORT_FIELDS;
    let read = 0;
    let updated = 0;
    const failed: string[] = [];
    for (const row of rows) {
      const item = plan.items.find((candidate) => candidate.id === row.itemId);
      if (!item) continue;
      let issue;
      try {
        issue = await client.issue(row.key, fields);
      } catch (error) {
        if (!(error instanceof JiraError)) throw error;
        if (error.code === 'auth' || error.code === 'unreachable') {
          // Nothing else will read either: stop here, say so in the activity and to the caller.
          await (await this.#jdb()).addActivity(plan.id, { itemId: null, key: null, kind: 'error', text: `Refresh failed: ${error.message}` });
          throw fromJiraError(error);
        }
        failed.push(`${row.key}: ${error.message}`);
        continue;
      }
      read += 1;
      const fresh = jiraPreviewItem(issue, record.baseUrl, acceptanceField, false);
      await (await this.#jdb()).updateItem(row.itemId, { status: fresh.status, statusCategory: statusCategoryOf(issue), summary: fresh.summary, refreshedAt: this.#clock.now().toISOString() });
      if (item.storedState === 'pending') {
        const todo = await this.#options.store.todos.get(item.todoId);
        const next = jiraItemTodo(fresh);
        if (todo && (todo.title !== next.title || (todo.description ?? '') !== next.description)) {
          await this.#options.todos
            .update(todo.sessionId, todo.id, { title: next.title, description: next.description }, 'developer')
            .then(() => {
              updated += 1;
            })
            .catch((error: unknown) => failed.push(`${row.key}: its todo could not be updated (${(error as Error).message})`));
        }
      }
    }
    await (await this.#jdb()).updatePlan(plan.id, { lastRefreshAt: this.#clock.now().toISOString() });
    const summary = `Refreshed ${read} ticket(s)${updated > 0 ? `, ${updated} pending item(s) updated` : ''}${by === 'timer' ? ' (every 30 min)' : ''}`;
    await (await this.#jdb()).addActivity(plan.id, { itemId: null, key: null, kind: failed.length > 0 ? 'error' : 'refresh', text: failed.length > 0 ? `${summary}; failed: ${failed.join('; ')}` : summary });
  }

  // ── the write mode ──────────────────────────────────────────────────────

  async #follow(planId: string): Promise<void> {
    if (this.#closed || !(await this.#enabled())) return;
    const record = await (await this.#jdb()).plan(planId);
    if (!record || record.sync !== 'write') return;
    const plan = await this.#plan(planId).catch((error: unknown) => (error instanceof PlanError ? null : Promise.reject(error)));
    if (!plan || !FOLLOWED.has(plan.state)) return;
    const rows = await (await this.#jdb()).items(planId);
    const pass = new WritePass(this, plan, record, await this.#jdb());
    for (const row of rows) {
      const item = plan.items.find((candidate) => candidate.id === row.itemId);
      if (item) await this.#followItem(pass, item, row);
    }
    if (pass.wrote) this.#options.bus.publish('planChanged', { planId, state: plan.state });
  }

  async #followItem(pass: WritePass, item: PlanItem, row: PlanJiraItemRecord): Promise<void> {
    const { transitions } = pass.record;
    // 1. The run started.
    if (item.runSessionId !== null && item.storedState !== 'pending') await pass.transition(row, `start:${item.runSessionId}`, transitions.inProgress, 'its run started');
    // 2. Its pull request opened.
    if (item.prUrl) {
      await pass.transition(row, `pr-transition:${item.prUrl}`, transitions.inReview, 'its pull request opened');
      await pass.comment(row, `pr-comment:${item.prUrl}`, JIRA_COMMENTS.pr(item.prUrl));
    }
    // 3. A developer question: one comment per episode (the item enters `question` again → a new one).
    let current = row;
    if (item.state === 'question' && !row.questionOpen) {
      current = { ...row, questionOpen: true, questionCount: row.questionCount + 1 };
      await (await this.#jdb()).updateItem(row.itemId, { questionOpen: true, questionCount: current.questionCount });
    } else if (item.state !== 'question' && row.questionOpen) {
      current = { ...row, questionOpen: false };
      await (await this.#jdb()).updateItem(row.itemId, { questionOpen: false });
    }
    if (current.questionCount > 0) {
      const event = `question:${current.questionCount}`;
      const done = await (await this.#jdb()).write(row.itemId, event);
      if (current.questionOpen || done?.state === 'pending') await pass.comment(current, event, JIRA_COMMENTS.question());
    }
    // 4. Merged into the target (never Done: the team's process moves the ticket there).
    if (item.storedState === 'done' && item.note !== MARKED_DONE) await pass.comment(current, 'merged', JIRA_COMMENTS.merged(pass.plan.targetBranch));
  }

  /** @internal the pass's access to the client. */
  get internals(): { readonly client: () => Promise<JiraClient> } {
    return { client: () => this.#client() };
  }
}

/** One follow pass over a plan in write mode: one client, the writes it made. */
class WritePass {
  readonly plan: Plan;
  readonly record: PlanJiraRecord;
  readonly #service: PlanJiraService;
  readonly #db: PlanJiraStore;
  #client: JiraClient | null = null;
  wrote = false;

  constructor(service: PlanJiraService, plan: Plan, record: PlanJiraRecord, db: PlanJiraStore) {
    this.#service = service;
    this.plan = plan;
    this.record = record;
    this.#db = db;
  }

  async #jira(): Promise<JiraClient> {
    this.#client ??= await this.#service.internals.client();
    return this.#client;
  }

  async #log(row: PlanJiraItemRecord, kind: PlanJiraActivity['kind'], text: string): Promise<void> {
    await this.#db.addActivity(this.plan.id, { itemId: row.itemId, key: row.key, kind, text });
    this.wrote = true;
  }

  /** Runs one write event once: skipped when done / soft / given up; a failure is retried later, at most {@link MAX_ATTEMPTS} times. */
  async #once(row: PlanJiraItemRecord, event: string, write: (client: JiraClient) => Promise<void>): Promise<void> {
    const before = await this.#db.write(row.itemId, event);
    if (before && before.state !== 'pending') return;
    const attempts = (before?.attempts ?? 0) + 1;
    try {
      await write(await this.#jira());
    } catch (error) {
      const message = error instanceof JiraError || error instanceof PlanJiraError ? error.message : 'failed';
      const gone = error instanceof JiraError && error.code === 'not-found';
      if (gone || attempts >= MAX_ATTEMPTS) {
        await this.#db.setWrite(this.plan.id, row.itemId, event, 'failed', attempts);
        await this.#log(row, 'error', `${row.key}: gave up on ${event.split(':')[0]} after ${attempts} attempt(s): ${message}`);
      } else {
        await this.#db.setWrite(this.plan.id, row.itemId, event, 'pending', attempts);
        if (attempts === 1) await this.#log(row, 'error', `${row.key}: ${event.split(':')[0]} failed (will retry): ${message}`);
      }
      return;
    }
  }

  /** Moves the issue through the transition named `name` (resolved through its available transitions). A missing one is a soft failure. */
  async transition(row: PlanJiraItemRecord, event: string, name: string, why: string): Promise<void> {
    await this.#once(row, event, async (client) => {
      const issue = await client.issue(row.key, ['status']);
      const status = typeof (issue.fields['status'] as Record<string, unknown> | undefined)?.['name'] === 'string' ? ((issue.fields['status'] as Record<string, unknown>)['name'] as string) : null;
      if (status !== null && status.toLowerCase() === name.toLowerCase()) {
        await this.#db.setWrite(this.plan.id, row.itemId, event, 'done', 1);
        return;
      }
      const available = await client.transitions(row.key);
      const found = findTransition(available, name);
      if (!found) {
        const note = `no "${name}" transition for ${row.key} (available: ${available.map((entry) => entry.name).join(', ') || 'none'})`;
        await this.#db.setWrite(this.plan.id, row.itemId, event, 'soft', 1);
        await this.#db.updateItem(row.itemId, { syncNote: note });
        await this.#log(row, 'soft-failure', `${row.key}: ${note}; nothing else is held up`);
        return;
      }
      await client.transition(row.key, found.id);
      await this.#db.setWrite(this.plan.id, row.itemId, event, 'done', 1);
      await this.#db.updateItem(row.itemId, { status: found.to ?? name });
      await this.#log(row, 'transition', `${row.key} → ${found.to ?? found.name} (${why})`);
    });
  }

  /** Adds a comment ending with its marker, unless a comment with that marker is there already (a retry after a lost answer). */
  async comment(row: PlanJiraItemRecord, event: string, text: string): Promise<void> {
    await this.#once(row, event, async (client) => {
      const marker = jiraCommentMarker(this.plan.id, row.itemId, event);
      const existing = await client.comments(row.key);
      if (!existing.some((comment) => comment.text.includes(marker))) {
        await client.addComment(row.key, `${text} ${marker}`);
        await this.#log(row, 'comment', `${row.key}: commented "${text}"`);
      }
      await this.#db.setWrite(this.plan.id, row.itemId, event, 'done', 1);
    });
  }
}

// ── input checks ──────────────────────────────────────────────────────────

function checkSync(value: unknown, fallback: JiraSyncMode): JiraSyncMode {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !(JIRA_SYNC_MODES as readonly string[]).includes(value)) throw new PlanJiraError(422, 'invalid', `sync is one of ${JIRA_SYNC_MODES.join(', ')}`, 'sync');
  return value as JiraSyncMode;
}

function checkTransitions(value: unknown, fallback: JiraTransitionNames): JiraTransitionNames {
  if (value === undefined || value === null) return fallback;
  if (!isRecord(value)) throw new PlanJiraError(422, 'invalid', 'transitions is { inProgress, inReview }', 'transitions');
  const pick = (field: 'inProgress' | 'inReview'): string => {
    if (value[field] === undefined) return fallback[field];
    const name = checkTransitionName(value[field]);
    if (name === null) throw new PlanJiraError(422, 'invalid', `transitions.${field} is a transition name (1–60 characters)`, `transitions.${field}`);
    return name;
  };
  return { inProgress: pick('inProgress'), inReview: pick('inReview') };
}
