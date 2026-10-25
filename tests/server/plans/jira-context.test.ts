/**
 * D118 · Plans · Jira context (`docs/plans.md` → *Jira context (D118)*): a Jira plan's agents get
 * everything in Jira they need, read from Jira when it is sent (nothing new is stored): an item's
 * run's first message carries its ticket and the epic, the plan's agent gets the full epic in the
 * order / repositories asks, and the read-only `plan_jira_context` tool answers the full context.
 * Against the fake Jira (`tests/helpers/fake-jira.ts`, real REST v3 shapes; never the real Jira).
 * The plan core is real (store, TodoService, PlanService) with a fake git and run environment,
 * as in `jira.test.ts`; the context source is wired as `install.ts` wires it.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_RUN_MESSAGE_MAX } from '../../../src/core/plans.ts';
import { JIRA_TODO_CONTEXT_LINE } from '../../../src/core/plans-jira.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { openDatabase } from '../../../src/server/db/database.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import type { PlanGitPort, PlanRepoInput, PlanRepoState } from '../../../src/server/plans/git.ts';
import { JiraCredentialSource } from '../../../src/server/plans/jira/credentials.ts';
import { registerPlanJiraRoutes } from '../../../src/server/plans/jira/routes.ts';
import { PlanJiraService } from '../../../src/server/plans/jira/service.ts';
import { PlanJiraStore } from '../../../src/server/plans/jira/store.ts';
import type { BranchMergeInput, BranchMergePlan } from '../../../src/server/worktrees/branch-merge.ts';
import { type PlanEnvironment, PlanError, type PlanMergePort, PlanService } from '../../../src/server/plans/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { FakeClock } from '../../helpers/clock.ts';
import { type FakeJira, acmeEpicWithContext, adf, startFakeJira } from '../../helpers/fake-jira.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

class FakeGit implements PlanGitPort {
  async prepareTarget(_repoPath: string, target: string): Promise<{ ok: true; ref: string; created: boolean }> {
    return { ok: true, ref: target, created: false };
  }
  async targetFacts(): Promise<{ defaultBranches: string[]; protectedBranches: string[] }> {
    return { defaultBranches: ['main'], protectedBranches: [] };
  }
  async tip(): Promise<string> {
    return 'cafe000';
  }
  async inspect(input: PlanRepoInput): Promise<PlanRepoState> {
    return { repo: input.repo, hasWork: false, merged: false, pr: null, ghAvailable: true, conflict: false };
  }
}

class FakeMerger implements PlanMergePort {
  async check(input: BranchMergeInput): Promise<BranchMergePlan> {
    return { input, head: 'beef', targetTip: 'cafe', targetLocal: true, checkedOutAt: null, kind: 'fast-forward', tree: null };
  }
  async merge(): Promise<string> {
    return 'merged';
  }
  async openPullRequest(): Promise<string> {
    return 'https://git.acme.example/acme/acme-front/pull/1';
  }
}

interface Rig {
  store: Store;
  plans: PlanService;
  jira: PlanJiraService;
  app: FastifyInstance;
  fake: FakeJira;
  sourceId: string;
  /** Each run's first message, by run session id. */
  firstMessages: Map<string, string>;
  /** Messages sent to sessions (the asks): the Jira lane's own and the core's. */
  sent: Array<{ sessionId: string; text: string }>;
  errors: unknown[];
  close(): Promise<void>;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

async function setup(options: { solutions?: string[] } = {}): Promise<Rig> {
  const dir = await makeTempDir('plans-jira-context');
  const clock = new FakeClock(new Date('2026-10-20T09:15:00Z'));
  const store = await openTempStore(dir, { now: () => clock.now() });
  const bus = new HubBus();
  const todos = new TodoService({ store, bus, now: () => clock.now().getTime() });
  const source = await store.sessions.create({ name: 'source', claudeSessionId: 'c-source', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: options.solutions ?? ['acme-front'], worktrees: false, workType: 'feature', mode: 'single', phase: 'ui-first' });
  const firstMessages = new Map<string, string>();
  const sent: Array<{ sessionId: string; text: string }> = [];
  let runs = 0;
  const env: PlanEnvironment = {
    async repos(sourceSessionId, names) {
      const owner = await store.sessions.get(sourceSessionId);
      if (!owner) throw new PlanError(404, 'not-found', 'no session');
      return { kind: 'workspace', repos: (names ?? owner.solutions).map((name) => ({ name, repoPath: `/repos/${name}` })) };
    },
    async run(input) {
      runs += 1;
      const session = await store.sessions.create({ name: `run-${runs}`, claudeSessionId: `c-${runs}`, status: 'run', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: Object.keys(input.from ?? {}), worktrees: true });
      firstMessages.set(session.id, input.task(input.branch));
      return { ok: true, sessionId: session.id, branch: input.branch };
    },
    async usageHeld() {
      return null;
    },
    async stopTurn() {
      return 'stopped';
    },
    async send(sessionId, text) {
      sent.push({ sessionId, text });
    },
    async notice() {},
    async mergeNotice() {},
    async closeMergeNotice() {},
  };
  const errors: unknown[] = [];
  const git = new FakeGit();
  const plans = new PlanService({ dataDir: dir, store, bus, todos, git, merger: new FakeMerger(), env, clock, onError: (error) => errors.push(error) });
  await plans.start();
  const fake = await startFakeJira(acmeEpicWithContext());
  const credentials = new JiraCredentialSource({ env: { ATL_BASE_URL: fake.url, ATL_USER: fake.email, ATL_TOKEN: fake.token }, store: null });
  const db = await openDatabase(`${dir}/plans.db`);
  const jiraStore = new PlanJiraStore(db, () => clock.now());
  const on = () => plans.state().available;
  const jira = new PlanJiraService({ store, plans, todos, bus, db: async () => jiraStore, credentials, enabled: on, clock, send: async (sessionId, text) => void sent.push({ sessionId, text }), onError: (error) => errors.push(error) });
  // As install.ts wires it.
  const offContext = plans.setContextSource({ itemContext: (input) => jira.itemContext(input), askContext: (planId) => jira.askContext(planId) });
  jira.start();
  const app = Fastify();
  await registerPlanJiraRoutes(app, jira, credentials, on);
  await app.ready();
  const made: Rig = {
    store,
    plans,
    jira,
    app,
    fake,
    sourceId: source.id,
    firstMessages,
    sent,
    errors,
    async close() {
      offContext();
      await app.close();
      await jira.close();
      await plans.close();
      db.close();
      await store.close();
      await fake.close();
      await removeTempDir(dir);
    },
  };
  rig = made;
  return made;
}

async function settle(r: Rig): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await r.plans.idle();
    await r.jira.idle();
  }
}

async function importEpic(r: Rig): Promise<{ planId: string; ids: Record<string, string> }> {
  const answer = await r.app.inject({ method: 'POST', url: `/api/sessions/${r.sourceId}/plans/jira/import`, payload: { epic: 'PROJ-10', targetBranch: 'feature/PROJ-10-acme-checkout' } });
  expect(answer.statusCode, answer.body).toBe(201);
  const body = answer.json();
  const ids: Record<string, string> = {};
  for (const item of body.plan.items) ids[item.key] = item.id;
  return { planId: body.plan.id, ids };
}

/** Starts the plan with PROJ-12 ready (its dependency on PROJ-11 removed) and answers PROJ-12's run's first message. */
async function startCart(r: Rig, planId: string, ids: Record<string, string>): Promise<{ message: string; runId: string }> {
  await r.plans.removeEdge(planId, ids['PROJ-11'] as string, ids['PROJ-12'] as string);
  await r.plans.startPlan(planId, { mergeMode: 'developer' });
  await settle(r);
  const cart = (await r.plans.get(planId)).items.find((entry) => entry.key === 'PROJ-12');
  expect(cart?.state).toBe('running');
  const runId = cart?.runSessionId as string;
  return { message: r.firstMessages.get(runId) as string, runId };
}

function count(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('D118 · the preview shows what the agents get', () => {
  it('counts per ticket and the epic description; the import itself reads none of it', async () => {
    const r = await setup();
    const answer = await r.app.inject({ method: 'POST', url: `/api/sessions/${r.sourceId}/plans/jira/preview`, payload: { epic: 'PROJ-10' } });
    expect(answer.statusCode, answer.body).toBe(200);
    const preview = answer.json();
    expect(preview.epic).toMatchObject({ description: 'The Acme checkout epic: carts, payments and receipts.\n\nNotes\n\nAsk Acme design.', acceptanceCriteria: '- A customer can pay for the cart\n- A receipt is emailed', counts: { comments: 1, subtasks: 0, links: 1, attachments: 0 } });
    const counts = Object.fromEntries(preview.items.map((item: { key: string; counts: unknown }) => [item.key, item.counts]));
    // PROJ-12: two remote links and "clones PROJ-98" (outside); its sub-tasks are not plan items.
    expect(counts['PROJ-12']).toEqual({ comments: 2, subtasks: 2, links: 3, attachments: 2 });
    expect(counts['PROJ-15']).toEqual({ comments: 0, subtasks: 0, links: 1, attachments: 0 });
    expect(preview.items.map((item: { key: string }) => item.key)).toEqual(['PROJ-11', 'PROJ-12', 'PROJ-13', 'PROJ-14', 'PROJ-15']);
    const before = r.fake.calls(/remotelink/).length;
    await importEpic(r);
    // The import reads no remote links (only the ask's epic does).
    expect(r.fake.calls(/remotelink/).length - before).toBe(1);
  });
});

describe('D118 · the run reads its Jira context at start', () => {
  it("the first message has the ticket's and the epic's context once, after the brief and before the merge rule; the todo is a short summary", async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r);
    const todo = await r.store.todos.get((await r.plans.get(planId)).items.find((entry) => entry.key === 'PROJ-12')?.todoId as string);
    expect(todo?.description?.endsWith(JIRA_TODO_CONTEXT_LINE)).toBe(true);
    const { message } = await startCart(r, planId, ids);
    expect(message.length).toBeLessThanOrEqual(PLAN_RUN_MESSAGE_MAX);
    expect(message).toContain('Jira context (read from Jira when this run started, 2026-10-20 09:15 UTC):');
    // The ticket.
    expect(message).toContain('Ticket PROJ-12 Cart page');
    expect(message).toContain('Acceptance criteria:\n- Lists the items\n- Shows the total');
    expect(message).toContain('- PROJ-21 Cart empty state (To Do)\n  Show "Your cart is empty".');
    expect(message).toContain('- PROJ-22 Cart totals row (Done)');
    expect(message).toContain('- PROJ-12 clones PROJ-98 Old cart page (Done)');
    expect(message).toContain('- Cart page (Figma): https://www.figma.com/design/AcmeFile/Cart?node-id=1-2');
    expect(message).toContain('Attachments (names only, not downloaded): cart-mockup.png, totals.pdf');
    expect(message).toContain('Comments (2, oldest first):\n- Ada Acme, 2026-10-01:\n  Use the new price formatter.\n- Grace Acme, 2026-10-02:\n  Design updated: empty state added.');
    // The epic, shortened, with the tool named.
    expect(message).toContain('Epic context: PROJ-10 Acme checkout (shortened; the full text is available via plan_jira_context)');
    expect(message).toContain('- A customer can pay for the cart');
    // Once each: the imported todo text is left out (the fresh text replaces it).
    expect(count(message, 'Show the cart.')).toBe(1);
    expect(count(message, 'Lists the items')).toBe(1);
    expect(message).not.toContain(JIRA_TODO_CONTEXT_LINE);
    // Placement: after the brief, before the merge rule.
    expect(message.indexOf('This is PROJ-12, an item of the plan')).toBeLessThan(message.indexOf('Jira context ('));
    expect(message.indexOf('Jira context (')).toBeLessThan(message.indexOf('When the work is done:'));
    // Read-only: nothing was written to Jira.
    expect(r.fake.calls(/^POST /)).toEqual([]);
  });

  it('reads Jira fresh at start: a comment added after the import is in the first message', async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r);
    r.fake.issues.get('PROJ-12')?.comments.push({ id: '9', body: adf('Late change: show prices with VAT.'), author: 'Grace Acme', created: '2026-10-19T16:00:00.000+0000' });
    const { message } = await startCart(r, planId, ids);
    expect(message).toContain('- Grace Acme, 2026-10-19:\n  Late change: show prices with VAT.');
    expect(message).toContain('Comments (3, oldest first)');
  });

  it("a Jira failure at start still starts the run, with the imported text and the note", async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r);
    r.fake.failNext(/^GET \/rest\/api\/3\/issue\//, 503, { count: 50 });
    const { message } = await startCart(r, planId, ids);
    expect(message).toContain("Jira couldn't be read at start; use plan_jira_context (Jira answered 503: Fake Jira failure.).");
    // The imported text (the todo) is there instead.
    expect(message).toContain('Show the cart.');
    expect(message).toContain(JIRA_TODO_CONTEXT_LINE);
    const activity = (await r.app.inject({ method: 'GET', url: `/api/plans/${planId}/jira` })).json().activity as Array<{ text: string }>;
    expect(activity.some((line) => line.text.startsWith("Could not read Jira for PROJ-12's run at its start"))).toBe(true);
  });

  it('a plan imported before D118 (the long imported todo, the same stored rows) gets the full context once', async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r);
    // What the pre-D118 import stored: the plan_jira / plan_jira_items rows (unchanged since D99) and a todo whose
    // description is the whole ticket (description, "Acceptance criteria:", the "Jira: <url> · …" line), up to 4,000 characters.
    const cart = (await r.plans.get(planId)).items.find((entry) => entry.key === 'PROJ-12');
    const preD118 = `Show the cart.\n\nAcceptance criteria:\n- Lists the items\n- Shows the total\n\nJira: ${r.fake.url}/browse/PROJ-12 · components acme-front`;
    const todo = await r.store.todos.get(cart?.todoId as string);
    await r.store.todos.setFields(todo?.id as string, { description: preD118 });
    // A description the developer rewrote (no "Jira:" line) is kept next to the context.
    const api = await r.store.todos.get((await r.plans.get(planId)).items.find((entry) => entry.key === 'PROJ-11')?.todoId as string);
    await r.store.todos.setFields(api?.id as string, { description: 'My own notes: reuse the Acme cart store.' });
    const { message } = await startCart(r, planId, ids);
    expect(message).toContain('Ticket PROJ-12 Cart page');
    expect(message).toContain('Epic context: PROJ-10 Acme checkout');
    expect(message).toContain('Use the new price formatter.');
    expect(count(message, 'Show the cart.')).toBe(1);
    expect(count(message, 'Lists the items')).toBe(1);
    expect(count(message, 'Shows the total')).toBe(1);
    const first = (await r.plans.get(planId)).items.find((entry) => entry.key === 'PROJ-11');
    const apiMessage = r.firstMessages.get(first?.runSessionId as string) ?? '';
    expect(apiMessage).toContain('My own notes: reuse the Acme cart store.');
    expect(apiMessage).toContain('Ticket PROJ-11 Cart API');
    expect(apiMessage).toContain('Acceptance criteria:\nCart answers 200 with items.');
  });
});

describe('D118 · the plan agent gets the full epic in its asks', () => {
  it('the order ask after the import ends with the full epic', async () => {
    const r = await setup();
    await importEpic(r);
    expect(r.sent).toHaveLength(1);
    const ask = r.sent[0]?.text ?? '';
    expect(ask).toContain('Please propose the missing order');
    expect(ask).toContain('Epic context (read from Jira now): PROJ-10 Acme checkout');
    expect(ask).toContain('The Acme checkout epic: carts, payments and receipts.');
    expect(ask).toContain('- A customer can pay for the cart');
    expect(ask).toContain('- Acme checkout spec: https://acme.atlassian.net/wiki/spaces/ACME/pages/100/Checkout');
    expect(ask).toContain('- Grace Acme, 2026-09-20:\n  Scope agreed with Acme product.');
  });

  it("a workspace plan's repositories ask and Ask again carry the full epic too", async () => {
    const r = await setup({ solutions: [] });
    const { planId } = await importEpic(r);
    expect(r.sent[0]?.text).toContain('pick');
    expect(r.sent[0]?.text).toContain('Epic context (read from Jira now): PROJ-10 Acme checkout');
    const again = await r.app.inject({ method: 'POST', url: `/api/plans/${planId}/solutions/ask` });
    expect(again.statusCode, again.body).toBe(200);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]?.text).toContain('Epic context (read from Jira now): PROJ-10 Acme checkout');
    expect(count(r.sent[1]?.text ?? '', 'Epic context (')).toBe(1);
  });
});

describe('D118 · plan_jira_context (the agent route)', () => {
  const ask = (r: Rig, sessionId: string, url: string) => r.app.inject({ method: 'GET', url, headers: { 'x-switchboard-session': sessionId } });

  it("answers a run session its own ticket and the epic, the plan's session any item or the epic, and refuses others", async () => {
    const r = await setup();
    const { planId, ids } = await importEpic(r);
    const { runId } = await startCart(r, planId, ids);
    r.fake.issues.get('PROJ-12')?.comments.push({ id: '9', body: adf('Read now, not at the start.'), author: 'Ada Acme', created: '2026-10-20T10:00:00.000+0000' });
    // The run session: no plan id, no item.
    const own = await ask(r, runId, '/agent/v1/plans/jira/context');
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ planId, epicKey: 'PROJ-10', item: 'PROJ-12' });
    const text = own.json().text as string;
    expect(text).toContain('Ticket PROJ-12 Cart page');
    expect(text).toContain('Read now, not at the start.');
    expect(text).toContain('Epic PROJ-10 Acme checkout');
    expect(text).toContain('Scope agreed with Acme product.');
    // With the plan id, only the epic.
    const epicOnly = await ask(r, runId, `/agent/v1/plans/${planId}/jira/context?part=epic`);
    expect(epicOnly.json().text).not.toContain('Ticket PROJ-12');
    // The plan's own session: an item by key, or the epic by default.
    const bySource = await ask(r, r.sourceId, `/agent/v1/plans/${planId}/jira/context?item=proj-15`);
    expect(bySource.statusCode, bySource.body).toBe(200);
    expect(bySource.json().text).toContain('- PROJ-15 is blocked by PROJ-99 Mail service (In Progress)');
    expect((await ask(r, r.sourceId, `/agent/v1/plans/${planId}/jira/context`)).json()).toMatchObject({ item: null });
    // Refused: a session that is neither the plan's nor its run's, an unknown item, no plan id outside a run.
    const stranger = await r.store.sessions.create({ name: 'stranger', claudeSessionId: 'c-stranger', status: 'idle', cwd: '/ws', root: '/ws', rootKind: 'workspace', solutions: [], worktrees: false });
    expect((await ask(r, stranger.id, `/agent/v1/plans/${planId}/jira/context`)).statusCode).toBe(404);
    expect((await ask(r, stranger.id, '/agent/v1/plans/jira/context')).statusCode).toBe(404);
    expect((await ask(r, r.sourceId, `/agent/v1/plans/${planId}/jira/context?item=PROJ-77`)).statusCode).toBe(404);
    expect((await ask(r, r.sourceId, `/agent/v1/plans/${planId}/jira/context?part=nope`)).statusCode).toBe(422);
    // Read-only.
    expect(r.fake.calls(/^POST /)).toEqual([]);
  });

  it('answers 404 not-jira for a plan that is not from Jira, also with a stored 1.x Plans switch set to off (D132: no switch)', async () => {
    const r = await setup();
    const plain = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Acme by hand', targetBranch: 'feature/acme' });
    const answer = await ask(r, r.sourceId, `/agent/v1/plans/${plain.id}/jira/context`);
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error).toBe('not-jira');
    await r.store.settings.set('experimental.plans', false);
    const still = await ask(r, r.sourceId, `/agent/v1/plans/${plain.id}/jira/context`);
    expect(still.statusCode).toBe(404);
    expect(still.json().error).toBe('not-jira');
  });
});

describe('D131 lane P · the developer’s read of the Jira context (GET /api/plans/{id}/jira/context)', () => {
  it('answers the epic by default, an item’s ticket with the epic when named, and refuses a plan not from Jira', async () => {
    const r = await setup();
    const { planId } = await importEpic(r);
    const epic = await r.app.inject({ method: 'GET', url: `/api/plans/${planId}/jira/context` });
    expect(epic.statusCode, epic.body).toBe(200);
    expect(epic.json()).toMatchObject({ planId, epicKey: 'PROJ-10', item: null });
    expect(epic.json().text).toContain('Epic PROJ-10 Acme checkout');
    expect(epic.json().text).not.toContain('Ticket PROJ-');
    const item = await r.app.inject({ method: 'GET', url: `/api/plans/${planId}/jira/context?item=proj-15` });
    expect(item.statusCode, item.body).toBe(200);
    expect(item.json()).toMatchObject({ item: 'PROJ-15' });
    expect(item.json().text).toContain('- PROJ-15 is blocked by PROJ-99 Mail service (In Progress)');
    expect((await r.app.inject({ method: 'GET', url: `/api/plans/${planId}/jira/context?item=PROJ-77` })).statusCode).toBe(404);
    expect((await r.app.inject({ method: 'GET', url: `/api/plans/${planId}/jira/context?part=nope` })).statusCode).toBe(422);
    const plain = await r.plans.create({ sourceSessionId: r.sourceId, title: 'Acme by hand', targetBranch: 'feature/acme' });
    const refused = await r.app.inject({ method: 'GET', url: `/api/plans/${plain.id}/jira/context` });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error).toBe('not-jira');
    // Read-only.
    expect(r.fake.calls(/^POST /)).toEqual([]);
  });
});
