import { randomBytes } from 'node:crypto';
import { isRemoteId } from '../../../core/peers.ts';
import { type Plan, type PlanItem, itemLabel } from '../../../core/plans.ts';
import {
  DEFAULT_JIRA_TRANSITIONS,
  JIRA_COMMENTS,
  JIRA_IMPORT_MAX,
  JIRA_REFRESH_MS,
  JIRA_SYNC_MODES,
  type JiraPreview,
  type JiraSyncMode,
  type JiraTransitionNames,
  EDGE_PROPOSALS_MAX,
  EDGE_PROPOSAL_REASON_MAX,
  type PlanEdgeProposal,
  type PlanJiraActivity,
  type PlanJiraState,
  proposalText,
  proposeOrderMessage,
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
import { PlanError, type PlanService, type ReposAskEvent } from '../service.ts';
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
  /**
   * Sends a message to a session the normal way (queued while it works; a hooked session's
   * mailbox): the ask for the missing order. Without one, asking answers 409 `no-messages`.
   */
  readonly send?: (sessionId: string, text: string) => Promise<void>;
  /**
   * D112: the session an import from a folder creates to own its plan (`POST /api/plans/jira/import`).
   * Without it, that route answers 409 `no-sessions`.
   */
  readonly newSession?: PlanOwnerSessions;
}

/** D112: where an import from a folder creates its plan's session (the body's `folder`, CLI, model, effort, account, repos). */
export interface PlanOwnerPlace {
  readonly folder: string | null;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly effort?: unknown;
  readonly profileId?: unknown;
  /** A workspace folder's solution repos (the plan's `repos` and the session's solutions); ignored for a repo folder. */
  readonly repos: readonly string[] | null;
}

/** A refused session start, as `POST /api/sessions` answers it. */
export interface PlanOwnerRefusal {
  readonly ok: false;
  readonly status: number;
  readonly body: { readonly error: string; readonly message?: string; readonly errors?: ReadonlyArray<{ readonly field: string; readonly message: string }> };
}

/**
 * D112 · how the Jira lane creates (and, after a failed import, removes) the session that owns a
 * plan imported from a folder. The app wires it to `POST /api/sessions`' own path (`startNewSession`).
 */
export interface PlanOwnerSessions {
  /** Checks the place before anything is read or created: the folder exists and is a git repo or a workspace; a workspace names repos that exist. */
  check(place: PlanOwnerPlace): Promise<{ readonly ok: true; readonly kind: 'repo' | 'workspace' } | PlanOwnerRefusal>;
  /** Starts the session (idle, no first message) the way New session does; answers its id. */
  start(place: PlanOwnerPlace, naming: { readonly name: string; readonly title: string }): Promise<{ readonly ok: true; readonly sessionId: string } | PlanOwnerRefusal>;
  /** `true` when a session already has this short name (the name is made unique). */
  nameTaken(name: string): Promise<boolean>;
  /** Closes (its process stops) and deletes a session this lane started for an import that then failed. */
  discard(sessionId: string): Promise<void>;
}

/** The answer of an import. */
export interface JiraImportResult {
  readonly plan: Plan;
  readonly jira: PlanJiraState;
  readonly preview: JiraPreview;
  readonly askedForOrder: boolean;
  /** D115: the plan's agent was asked to pick its items' repositories (a workspace import without repos). */
  readonly askedForRepos: boolean;
}


/** D115: the items of a plan whose repositories the plan's agent still has to pick. */
export function itemsWithoutRepos(plan: Pick<Plan, 'reposPerItem' | 'items'>): PlanItem[] {
  return plan.reposPerItem === true ? plan.items.filter((item) => item.storedState === 'pending' && item.solutions.length === 0) : [];
}

/** D112: a refused session check / start as this lane's error (its first field error, else its message). */
function ownerRefusal(refusal: PlanOwnerRefusal): PlanJiraError {
  const first = refusal.body.errors?.[0];
  if (first) return new PlanJiraError(refusal.status, refusal.body.error, first.message, first.field);
  return new PlanJiraError(refusal.status, refusal.body.error, refusal.body.message ?? 'the session could not be started');
}

/**
 * D112: the owning session's title, "Plan · <plan title>": the plan title the developer can edit
 * in the dialog, else (when it is empty) the epic summary. A session title is at most 80 characters.
 */
export function planOwnerTitle(planTitle: string, epicSummary = ''): string {
  const title = `Plan · ${planTitle.trim() || epicSummary.trim() || 'Jira epic'}`;
  return title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`;
}

/** D112: the owning session's short name, `plan-<epic key>` (kebab-case, at most 64 characters). */
export function planOwnerName(epicKey: string): string {
  const slug = epicKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return `plan-${slug || 'epic'}`;
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
  /** D115 follow-ups: stops following the plans' repositories ask. */
  #offReposAsk: (() => void) | null = null;
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
    // D115 follow-ups: the plans' repositories ask (sent, failed, not answered in time) is a line of a Jira plan's activity.
    this.#offReposAsk = this.#options.plans.onReposAsk((event) => this.#reposAskLine(event));
    this.#arm();
  }

  /** Stops following; waits for the passes in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#offReposAsk?.();
    this.#offReposAsk = null;
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

  /** The epic of a body (`epic`: a key or an issue URL), else 422 on `epic`. */
  #epicOf(body: unknown): string {
    const epicKey = parseEpicKey(isRecord(body) ? body['epic'] : undefined);
    if (!epicKey) throw new PlanJiraError(422, 'invalid', 'paste an epic key (PROJ-100) or its Jira link', 'epic');
    return epicKey;
  }

  /** Reads the epic (and its children); an epic without children is 422 `empty-epic`. */
  async #readEpic(client: JiraClient, epicKey: string): Promise<JiraPreview> {
    const preview = await this.#preview(client, epicKey);
    if (preview.items.length === 0) throw new PlanJiraError(422, 'empty-epic', `${epicKey} has no child issues`, 'epic');
    return preview;
  }

  /**
   * `POST /api/sessions/{id}/plans/jira/preview` `{ epic }` (a key or an issue URL): the epic's
   * children, their dependencies, the outside links, the cycles left out, the unlinked items.
   * Nothing is created. D112: `sessionId` `null` is `POST /api/plans/jira/preview` (an import
   * from a folder: there is no session yet).
   */
  async preview(sessionId: string | null, body: unknown): Promise<JiraPreview> {
    await this.#gate();
    if (sessionId !== null) await this.#source(sessionId);
    const epicKey = this.#epicOf(body);
    return this.#readEpic(await this.#client(), epicKey);
  }

  /** What an import body asks for besides its place, checked before anything is read or created. */
  #importInput(body: unknown): { readonly input: Record<string, unknown>; readonly epicKey: string; readonly sync: JiraSyncMode; readonly transitions: JiraTransitionNames } {
    const input = isRecord(body) ? body : {};
    const epicKey = this.#epicOf(input);
    // An epic's plan merges into a target branch: the import keeps requiring one (D99 follow-up 2026-10-15: a plan without a target is made by hand or by an agent).
    if (typeof input['targetBranch'] !== 'string' || input['targetBranch'].trim() === '') throw new PlanJiraError(422, 'invalid', "give the target branch (the epic's feature branch, e.g. feature/PROJ-100-acme-epic)", 'targetBranch');
    return { input, epicKey, sync: checkSync(input['sync'], 'off'), transitions: checkTransitions(input['transitions'], DEFAULT_JIRA_TRANSITIONS) };
  }

  /**
   * `POST /api/sessions/{id}/plans/jira/import`: reads the epic again and creates a **draft** plan
   * through the core's seam: one item per child (title "KEY Summary", description with the
   * acceptance criteria, the key, no solutions: the developer picks them), the dependencies of
   * the preview (cycles and outside links left out), `external { jira, epicKey }`. Body: `epic`,
   * `targetBranch` (required), optional `title`, `baseBranch`, `repos`, `maxConcurrency`,
   * `sync` (default `off`), `transitions`. The merge mode is chosen at Start (the core requires it).
   */
  async importPlan(sessionId: string, body: unknown): Promise<JiraImportResult> {
    await this.#gate();
    await this.#source(sessionId);
    const checked = this.#importInput(body);
    const client = await this.#client();
    const preview = await this.#readEpic(client, checked.epicKey);
    return this.#createPlan(sessionId, checked, client, preview);
  }

  /**
   * D112 · `POST /api/plans/jira/import`: an import from a **folder** instead of a session. The
   * body is an import's (`epic`, `targetBranch`, …) plus where the plan runs: `folder` (a saved
   * folder's id), `provider`, `model`, `effort`, `profileId` and, for a workspace, `repos`.
   * Everything that can be checked is checked first (the body, the folder and repos, Jira's epic),
   * so a refusal leaves nothing behind. Then a new session "Plan · <plan title>" (the epic summary
   * when the plan title is empty) starts in that
   * folder the way New session starts one (idle: no first message), with the repos (if given) as its
   * solutions, and owns the plan as its source session. D115: a workspace needs no repos: the plan's
   * agent (that session) is asked to pick each item's repositories. If the plan then cannot be made, that
   * session is closed and deleted again (and a plan already made is removed) before the error is
   * answered.
   */
  async importIntoNewSession(body: unknown): Promise<JiraImportResult & { readonly sessionId: string }> {
    await this.#gate();
    const sessions = this.#options.newSession;
    if (!sessions) throw new PlanJiraError(409, 'no-sessions', 'this Switchboard cannot start a session for the plan');
    const checked = this.#importInput(body);
    const raw = checked.input;
    if (raw['folder'] !== undefined && raw['folder'] !== null && typeof raw['folder'] !== 'string') throw new PlanJiraError(422, 'invalid', 'folder must be the id of a saved folder', 'folder');
    if (raw['repos'] !== undefined && raw['repos'] !== null && (!Array.isArray(raw['repos']) || !raw['repos'].every((name) => typeof name === 'string' && name.trim() !== ''))) {
      throw new PlanJiraError(422, 'invalid', 'repos must be a list of solution names', 'repos');
    }
    const place: PlanOwnerPlace = {
      folder: typeof raw['folder'] === 'string' && raw['folder'] !== '' ? raw['folder'] : null,
      provider: raw['provider'],
      model: raw['model'],
      effort: raw['effort'],
      profileId: raw['profileId'],
      repos: Array.isArray(raw['repos']) ? [...new Set(raw['repos'] as string[])] : null,
    };
    const where = await sessions.check(place);
    if (!where.ok) throw ownerRefusal(where);
    const client = await this.#client();
    const preview = await this.#readEpic(client, checked.epicKey);
    let name = planOwnerName(checked.epicKey);
    for (let n = 2; await sessions.nameTaken(name); n += 1) name = `${planOwnerName(checked.epicKey)}-${n}`;
    const started = await sessions.start(place, { name, title: planOwnerTitle(typeof raw['title'] === 'string' ? raw['title'] : '', preview.epic.summary) });
    if (!started.ok) throw ownerRefusal(started);
    const repos = where.kind === 'workspace' ? place.repos : null;
    let planId: string | null = null;
    try {
      const result = await this.#createPlan(started.sessionId, { ...checked, input: { ...raw, repos: repos ?? undefined } }, client, preview, (id) => {
        planId = id;
      });
      return { ...result, sessionId: started.sessionId };
    } catch (error) {
      // No leftovers: the plan (when it was made) and the session go again.
      if (planId !== null) await this.#options.plans.remove(planId).catch((cause: unknown) => this.#onError(cause));
      await sessions.discard(started.sessionId).catch((cause: unknown) => this.#onError(cause));
      throw error;
    }
  }

  /** The import's writes: the draft plan through the core's seam, its Jira rows, the activity line and the ask for the order. */
  async #createPlan(
    sessionId: string,
    checked: { readonly input: Record<string, unknown>; readonly epicKey: string; readonly sync: JiraSyncMode; readonly transitions: JiraTransitionNames },
    client: JiraClient,
    preview: JiraPreview,
    made?: (planId: string) => void,
  ): Promise<JiraImportResult> {
    const { input, epicKey, sync, transitions } = checked;
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
    made?.(created.plan.id);
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
    // D99-Jira-q1 (b): items without links → the source session's agent is asked to propose the missing order.
    // D115: a workspace plan without repos → the same message (or its own) asks it to pick each item's repositories.
    const order = preview.unlinked.length > 0;
    const repos = itemsWithoutRepos(created.plan).length > 0;
    let asked = false;
    if (order || repos) {
      asked = await this.#ask(created.plan, { order, repos })
        .then(() => true)
        .catch(async (error: unknown) => {
          const what = order && repos ? 'propose the missing order and pick the repositories' : order ? 'propose the missing order' : 'pick the repositories';
          const message = error instanceof Error ? error.message : 'failed';
          await (await this.#jdb()).addActivity(created.plan.id, { itemId: null, key: epicKey, kind: 'error', text: `Could not ask the session to ${what}: ${message}${repos ? ' (use Ask again on the plan)' : ''}` });
          // D115 follow-ups: the Inbox says so too (with Ask again).
          if (repos) await this.#options.plans.reposAskFailed(created.plan.id, message, 'import');
          return false;
        });
      if (asked && repos) {
        await (await this.#jdb()).addActivity(created.plan.id, { itemId: null, key: epicKey, kind: 'ask-repos', text: `Asked the plan's agent to pick the repositories of ${itemsWithoutRepos(created.plan).length} item(s)` });
        // D115 follow-ups: the "not picked in time" check is kept in plans.db (it survives a restart).
        await this.#options.plans.reposAsked(created.plan.id, 'import');
      }
    }
    this.#options.bus.publish('planChanged', { planId: created.plan.id, state: created.plan.state });
    return { plan: created.plan, jira: await this.#state(created.plan), preview, askedForOrder: asked && order, askedForRepos: asked && repos };
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

  // ── proposed order (D99-Jira-q1 ruling (b)) ─────────────────────────────

  /**
   * Sends the plan's source session the ask: the missing order ({@link proposeOrderMessage}) and/or
   * (D115) the items' repositories (the core's {@link PlanService.reposAskText}), in one message.
   * The import then tells the core it was sent (its "not picked in time" check) or failed.
   */
  async #ask(plan: Plan, what: { readonly order: boolean; readonly repos: boolean } = { order: true, repos: false }): Promise<void> {
    if (!this.#options.send) throw new PlanJiraError(409, 'no-messages', 'this Switchboard cannot send the session a message');
    const parts: string[] = [];
    if (what.order) {
      const linked = new Set(plan.edges.flatMap((edge) => [edge.from, edge.to]));
      const label = new Map(plan.items.map((item) => [item.id, itemLabel(item)]));
      parts.push(
        proposeOrderMessage({
          planId: plan.id,
          planTitle: plan.title,
          items: plan.items.map((item) => ({ label: itemLabel(item), title: item.title, unlinked: !linked.has(item.id) })),
          edges: plan.edges.map((edge) => ({ from: label.get(edge.from) ?? edge.from, to: label.get(edge.to) ?? edge.to })),
        }),
      );
    }
    if (what.repos) {
      const ask = await this.#options.plans.reposAskText(plan.id, what.order);
      if (ask) parts.push(ask.text);
    }
    await this.#options.send(plan.sourceSessionId, parts.join('\n\n'));
  }

  /** D115 follow-ups: the core's repositories ask as a line of a Jira plan's activity (the import writes its own). */
  async #reposAskLine(event: ReposAskEvent): Promise<void> {
    if (event.via === 'import' || event.via === 'agent') return;
    if (!(await this.#enabled())) return;
    if (event.kind === 'late') {
      await this.checkRepos(event.planId);
      return;
    }
    const db = await this.#jdb();
    if (!(await db.plan(event.planId))) return;
    if (event.kind === 'failed') await db.addActivity(event.planId, { itemId: null, key: null, kind: 'error', text: `Could not ask the session to pick the repositories: ${event.message ?? 'failed'}` });
    else await db.addActivity(event.planId, { itemId: null, key: null, kind: 'ask-repos', text: `Asked the plan's agent${event.via === 'again' ? ' again' : ''} to pick the repositories of ${event.items} item(s)` });
    this.#options.bus.publish('planChanged', { planId: event.planId, state: (await this.#options.plans.get(event.planId).catch(() => null))?.state ?? null });
  }

  /** D115 (the core's "not picked in time" check; tests call it): notes in a Jira plan's activity that its agent has not picked the repositories of some items yet. Answers how many wait. */
  async checkRepos(planId: string): Promise<number> {
    if (!(await this.#enabled())) return 0;
    const plan = await this.#options.plans.get(planId).catch(() => null);
    if (!plan || plan.state === 'done' || plan.state === 'cancelled') return 0;
    const waiting = itemsWithoutRepos(plan);
    if (waiting.length === 0) return 0;
    const db = await this.#jdb();
    if (await db.plan(planId)) {
      await db.addActivity(planId, { itemId: null, key: null, kind: 'error', text: `The plan's agent has not picked the repositories of ${waiting.length} item(s) in time after the ask (${waiting.map((item) => itemLabel(item)).join(', ')}): use Ask again on the plan or in the Inbox, or set them yourself` });
      this.#options.bus.publish('planChanged', { planId, state: plan.state });
    }
    return waiting.length;
  }

  /**
   * D115 · `POST /api/plans/{id}/solutions/ask`: the plan page's **Ask again** (the Inbox's runs
   * through the Plans hook): the core asks the plan's source session again to pick the
   * repositories of the items that have none and re-arms its check (refusals: 409 `finished`,
   * `nothing-to-pick`, `not-sent`). A Jira plan's activity gets the line.
   */
  async askForRepos(planId: string): Promise<{ readonly asked: true; readonly sessionId: string; readonly items: number }> {
    await this.#gate();
    return this.#options.plans.askForRepos(planId, 'again');
  }

  /** `POST /api/plans/{id}/proposals/ask`: the developer's **Propose order** on a draft plan. */
  async askForOrder(planId: string): Promise<{ readonly asked: true; readonly sessionId: string }> {
    await this.#gate();
    const plan = await this.#plan(planId);
    if (plan.state !== 'draft') throw new PlanJiraError(409, 'not-draft', 'the order is proposed for a draft plan (before it starts)');
    if (plan.items.length < 2) throw new PlanJiraError(422, 'too-few', 'a plan needs two items for an order');
    try {
      await this.#ask(plan);
    } catch (error) {
      if (error instanceof PlanJiraError) throw error;
      throw new PlanJiraError(409, 'not-sent', `the source session could not be asked: ${error instanceof Error ? error.message : 'failed'}`);
    }
    return { asked: true, sessionId: plan.sourceSessionId };
  }

  async #views(plan: Plan): Promise<PlanEdgeProposal[]> {
    const label = new Map(plan.items.map((item) => [item.id, itemLabel(item)]));
    return (await (await this.#jdb()).proposals(plan.id))
      .filter((row) => label.has(row.fromItemId) && label.has(row.toItemId))
      .map((row) => {
        const from = label.get(row.fromItemId) as string;
        const to = label.get(row.toItemId) as string;
        return { ...row, from, to, text: proposalText(from, to) };
      });
  }

  /** `GET /api/plans/{id}/proposals`: every proposal of the plan (pending first is the UI's choice), oldest first. */
  async proposals(planId: string): Promise<PlanEdgeProposal[]> {
    await this.#gate();
    return this.#views(await this.#plan(planId));
  }

  /**
   * `POST /agent/v1/plans/{planId}/proposals` (the `plan_propose_dependencies` tool, the plan's
   * source session only): stores each proposal as pending. Skipped (with the reason): an unknown
   * item, the same item twice, a dependency the plan has, a pair proposed before.
   */
  async propose(sessionId: string, planId: string, body: unknown): Promise<{ readonly added: PlanEdgeProposal[]; readonly skipped: ReadonlyArray<{ readonly from: string; readonly to: string; readonly why: string }> }> {
    await this.#gate();
    await this.#options.plans.agentPlan(sessionId, planId);
    const plan = await this.#plan(planId);
    if (plan.state === 'done' || plan.state === 'cancelled') throw new PlanJiraError(409, 'finished', `the plan is ${plan.state}`);
    const list = isRecord(body) && Array.isArray(body['proposals']) ? (body['proposals'] as unknown[]) : null;
    if (!list || list.length === 0) throw new PlanJiraError(422, 'invalid', 'give proposals: [{ from, to, reason }]', 'proposals');
    if (list.length > EDGE_PROPOSALS_MAX) throw new PlanJiraError(422, 'invalid', `at most ${EDGE_PROPOSALS_MAX} proposals at once`, 'proposals');
    const find = (ref: unknown): PlanItem | null => {
      if (typeof ref !== 'string' || ref.trim() === '') return null;
      const value = ref.trim().replace(/^\[|\]$/g, '');
      return plan.items.find((item) => item.id === value) ?? plan.items.find((item) => item.key !== null && item.key === value.toUpperCase()) ?? null;
    };
    const db = await this.#jdb();
    const addedIds: string[] = [];
    const skipped: Array<{ from: string; to: string; why: string }> = [];
    for (const raw of list) {
      const entry = isRecord(raw) ? raw : {};
      const from = find(entry['from']);
      const to = find(entry['to']);
      const names = { from: String(entry['from'] ?? ''), to: String(entry['to'] ?? '') };
      const reason = typeof entry['reason'] === 'string' ? entry['reason'].trim().slice(0, EDGE_PROPOSAL_REASON_MAX) : '';
      if (!from || !to) skipped.push({ ...names, why: `no item ${!from ? names.from : names.to} in the plan` });
      else if (from.id === to.id) skipped.push({ ...names, why: 'an item cannot wait on itself' });
      else if (plan.edges.some((edge) => edge.from === from.id && edge.to === to.id)) skipped.push({ ...names, why: 'the plan has this dependency already' });
      else {
        const id = randomBytes(5).toString('hex');
        if (await db.addProposal({ id, planId, fromItemId: from.id, toItemId: to.id, reason: reason === '' ? '(no reason given)' : reason })) addedIds.push(id);
        else skipped.push({ ...names, why: 'proposed before' });
      }
    }
    if (addedIds.length > 0) this.#options.bus.publish('planChanged', { planId, state: plan.state });
    const views = await this.#views(plan);
    return { added: views.filter((view) => addedIds.includes(view.id)), skipped };
  }

  /**
   * Accept or reject one proposal (`proposalId`) or every pending one (`null`). Accept adds the
   * dependency through the core (`PlanService.addEdge`): a cycle is refused there, and the
   * proposal stays pending with the reason (`note`). A single refused Accept answers 409 `cycle`.
   */
  async decide(planId: string, proposalId: string | null, action: 'accept' | 'reject'): Promise<{ readonly proposals: PlanEdgeProposal[]; readonly refused: ReadonlyArray<{ readonly id: string; readonly text: string; readonly reason: string }> }> {
    await this.#gate();
    const plan = await this.#plan(planId);
    const db = await this.#jdb();
    const all = await this.#views(plan);
    const chosen = proposalId === null ? all.filter((entry) => entry.state === 'pending') : all.filter((entry) => entry.id === proposalId);
    if (proposalId !== null && chosen.length === 0) throw new PlanJiraError(404, 'not-found', `no proposal ${proposalId} in plan ${planId}`);
    if (proposalId !== null && chosen[0]?.state !== 'pending') throw new PlanJiraError(409, 'decided', `the proposal was ${chosen[0]?.state} already`);
    const refused: Array<{ id: string; text: string; reason: string }> = [];
    for (const entry of chosen) {
      if (action === 'reject') {
        await db.decideProposal(entry.id, { state: 'rejected', note: null });
        continue;
      }
      try {
        await this.#options.plans.addEdge(planId, { from: entry.fromItemId, to: entry.toItemId });
        await db.decideProposal(entry.id, { state: 'accepted', note: null });
      } catch (error) {
        if (!(error instanceof PlanError)) throw error;
        await db.decideProposal(entry.id, { state: 'pending', note: error.message });
        refused.push({ id: entry.id, text: entry.text, reason: error.message });
      }
    }
    this.#options.bus.publish('planChanged', { planId, state: plan.state });
    if (proposalId !== null && refused.length > 0) throw new PlanJiraError(409, (refused[0]?.reason ?? '').includes('cycle') ? 'cycle' : 'refused', refused[0]?.reason ?? 'refused');
    return { proposals: await this.#views(await this.#plan(planId)), refused };
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
    if (item.storedState === 'done' && item.note !== MARKED_DONE && pass.plan.targetBranch !== null) await pass.comment(current, 'merged', JIRA_COMMENTS.merged(pass.plan.targetBranch));
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
