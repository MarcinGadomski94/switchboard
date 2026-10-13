import { afterEach, describe, expect, it } from 'vitest';
import { TEAM_SETTING, type TeamCharter, charterInstruction, readCharter } from '../../../src/core/team.ts';
import { readTeamSyncMessage } from '../../../src/core/team-sync.ts';
import { TEAM_TEMPLATES, isTemplateCharter } from '../../../src/core/team-templates.ts';
import { TEAM_TOOLS, type TeamAgentApi, teamProposeCharter } from '../../../src/core/team-tools.ts';
import { NO_ATTACHMENTS } from '../../../src/server/attachments/service.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { LoopService } from '../../../src/server/loops/owned.ts';
import { CHARTER_OFFER_SETTING, TeamError, type TeamPeers, TeamService } from '../../../src/server/team/service.ts';
import { TodoService } from '../../../src/server/todos/service.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, spawnedArgv, until, waitForStatus } from '../../helpers/supervisor.ts';

/**
 * D105 · better charters against fake-claude as the member's agent: the ask is a
 * normal message in the member's own session; the agent's `team_propose_charter`
 * (the tool over the service, as the MCP helper calls it with the session's token)
 * makes a pending proposal; Needs you shows it; Accept replaces the charter and
 * re-sends the standing instruction; Dismiss; one ask per member; "Draft better
 * charters" for a team; the one-time offer; adopt with the ask; `howItWorks`
 * through the sync; the templates without the stale review-card wording.
 */

const SELF = { id: 'm-mac-0001', name: 'Mac' };

const peers = {
  self: async () => SELF,
  machines: async () => [],
  remoteSessions: () => [],
  remoteInbox: () => [],
  forward: async () => ({ status: 404, body: { error: 'not-found', message: 'no peers here' } }),
  ask: async () => ({ status: null, reason: 'no peers here' }),
  hasMachine: () => false,
  sidebarChanged: () => undefined,
} as unknown as TeamPeers;

interface Rig {
  readonly world: SupervisorWorld;
  readonly team: TeamService;
  readonly loops: LoopService;
  readonly todos: TodoService;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.team.close();
  await rig?.loops.close();
  rig?.todos.close();
  await rig?.world.cleanup();
  rig = undefined;
});

async function setup(): Promise<Rig> {
  const world = await makeSupervisorWorld();
  const bus = new HubBus();
  const todos = new TodoService({ store: world.store, bus });
  const loops = new LoopService({ store: world.store, deliver: async (session, text, mark) => void (await world.supervisor.sendMessage(session.id, text, 'service', NO_ATTACHMENTS, { loop: mark })) });
  const team = new TeamService({ dataDir: world.root, store: world.store, bus, supervisor: world.supervisor, loops, todos, peers, takeover: null, isHooked: async () => false, pushDelayMs: 10 });
  rig = { world, team, loops, todos };
  await team.init();
  await world.store.settings.set(TEAM_SETTING, true);
  await team.switchChanged();
  return rig;
}

/** A started session whose first turn ended (its process idle). */
async function idleSession(r: Rig, name: string) {
  const session = await r.world.supervisor.start(newSession({ name, task: 'first' }), r.world.place);
  await waitForStatus(r.world.store, session.id, ['done', 'idle']);
  await until(async () => (r.world.supervisor.isLive(session.id) && !r.world.supervisor.turnRunning(session.id)) || undefined, `${name} idle`);
  return session;
}

/** The member's agent calling `team_propose_charter` (the helper's API over the service, as its session). */
function agentApi(r: Rig, sessionId: string): TeamAgentApi {
  return async (method, path, body) => {
    expect([method, path]).toEqual(['POST', '/agent/v1/team/charter']);
    try {
      return { status: 201, body: await r.team.proposeCharter(sessionId, body as Record<string, unknown>) };
    } catch (error) {
      if (error instanceof TeamError) return { status: error.status, body: { error: error.code, message: error.message } };
      throw error;
    }
  };
}

/** The user-message texts of a session's events. */
async function userTexts(r: Rig, sessionId: string): Promise<string[]> {
  return (await r.world.store.events.list(sessionId)).flatMap((event) => {
    const payload = event.payload as { type?: string; text?: string } | null;
    return payload?.type === 'user' && typeof payload.text === 'string' ? [payload.text] : [];
  });
}

const DEVELOPER = TEAM_TEMPLATES.find((t) => t.id === 'developer')?.charter as TeamCharter;

const PROPOSAL = {
  owns: 'The Acme Studio feature in acme-app and acme-api: its editor and its preview.',
  produces: 'Commits on feature/studio with tests, and a short round note per feedback round.',
  howItWorks: 'Runs feedback rounds: the developer and the testers send feedback, it adjusts the feature and reports what changed.',
  neverDoes: 'Works outside acme-app and acme-api, or merges into the default branch.',
  notes: 'Based on 12 rounds in this session.',
};

describe('D105 · the charter ask and the proposal', () => {
  it('asks in the member\'s own session; the agent\'s team_propose_charter makes a pending proposal; Needs you shows it; Accept replaces the charter and re-sends the instruction', async () => {
    const r = await setup();
    const session = await idleSession(r, 'studio-one');
    const member = await r.team.adopt({ sessionId: session.id, name: 'Studio maintainer', templateId: 'developer', charter: DEVELOPER });
    await until(async () => (!r.world.supervisor.turnRunning(session.id) && r.world.supervisor.isLive(session.id)) || undefined, 'restarted and idle');

    const asked = await r.team.askCharter(member.id);
    // The ask is a normal message in its session: role, team and charter, and the tool to call.
    const text = await until(async () => (await userTexts(r, session.id)).find((t) => t.includes('team_propose_charter')), 'the ask');
    expect(text).toContain('Switchboard asks you, Studio maintainer in team Team, to draft a specific charter for yourself.');
    expect(text).toContain(`- owns: ${DEVELOPER.owns}`);
    expect(text).toContain('who gives you feedback');
    expect(text).toContain('never invent a responsibility');
    // Waiting for the agent: on the member, not in Needs you.
    expect((await r.team.member(member.id)).charterRequest).toMatchObject({ requestId: asked.requestId, state: 'asked', proposal: null });
    expect(await r.team.needsYou()).toEqual([]);

    // The agent proposes (the MCP tool, as the helper runs it).
    const result = await teamProposeCharter(agentApi(r, session.id), PROPOSAL);
    expect(result.isError).toBeUndefined();
    const items = await r.team.needsYou();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'charter', label: 'Studio maintainer · charter', title: 'Studio maintainer proposes a new charter', detail: PROPOSAL.notes });
    expect(items[0]?.charter?.before).toEqual(DEVELOPER);
    expect(items[0]?.charter?.after).toEqual({ owns: PROPOSAL.owns, produces: PROPOSAL.produces, howItWorks: PROPOSAL.howItWorks, neverDoes: PROPOSAL.neverDoes });
    expect((await r.team.member(member.id)).charterRequest).toMatchObject({ requestId: asked.requestId, state: 'proposed', notes: PROPOSAL.notes });
    // Nothing changed yet.
    expect((await r.team.member(member.id)).charter).toEqual(DEVELOPER);

    await until(async () => (!r.world.supervisor.turnRunning(session.id) && r.world.supervisor.isLive(session.id)) || undefined, 'idle after the ask');
    const pid = r.world.supervisor.pid(session.id);
    await r.team.decide(asked.requestId, 'approve');
    const after = await r.team.member(member.id);
    expect(after.charter.howItWorks).toBe(PROPOSAL.howItWorks);
    expect(after.charter.owns).toBe(PROPOSAL.owns);
    expect(after.charterRequest).toBeNull();
    expect(await r.team.needsYou()).toEqual([]);
    // The standing instruction is re-sent: the idle process restarts with the new charter.
    const newPid = await until(async () => {
      const now = r.world.supervisor.pid(session.id);
      return now !== null && now !== pid ? now : undefined;
    }, 'a restarted process');
    const spawn = await until(async () => (await spawnedArgv(r.world.logFile)).find((line) => line.pid === newPid && line.argv?.includes('-p')), 'its argv');
    const instruction = spawn.argv?.[(spawn.argv?.indexOf('--append-system-prompt') ?? -2) + 1] ?? '';
    expect(instruction).toContain(`How it works: ${PROPOSAL.howItWorks}`);
    expect(instruction).toContain(`owns: ${PROPOSAL.owns}`);
    expect((await r.team.view()).activity.map((a) => a.text)).toEqual(expect.arrayContaining(["Studio maintainer's new charter was accepted", 'Studio maintainer proposed a new charter: it waits in Needs you']));
  });

  it('Accept with the developer\'s edits; Dismiss records it; one ask per member; an ask can be cancelled', async () => {
    const r = await setup();
    const session = await idleSession(r, 'quiet');
    const member = await r.team.adopt({ sessionId: session.id, name: 'Tracker', charter: DEVELOPER });
    const first = await r.team.askCharter(member.id);
    // No duplicates while the ask is open, nor while its proposal is.
    await expect(r.team.askCharter(member.id)).rejects.toMatchObject({ status: 409, code: 'charter-open' });
    await r.team.proposeCharter(session.id, PROPOSAL);
    await expect(r.team.askCharter(member.id)).rejects.toMatchObject({ status: 409, code: 'charter-open' });
    const dismissed = await r.team.decide(first.requestId, 'dismiss');
    expect(dismissed.state).toBe('dismissed');
    expect((await r.team.member(member.id)).charter).toEqual(DEVELOPER);
    expect((await r.team.view()).activity.map((a) => a.text)).toContain("Tracker's charter proposal was dismissed");

    // A new ask; the developer edits the proposal (Edit… → Save).
    const second = await r.team.askCharter(member.id);
    expect(second.requestId).not.toBe(first.requestId);
    await r.team.proposeCharter(session.id, { ...PROPOSAL, notes: '' });
    const edited = { owns: 'The Acme Studio feature (editor only).', produces: PROPOSAL.produces, howItWorks: PROPOSAL.howItWorks, neverDoes: PROPOSAL.neverDoes };
    expect((await r.team.decide(second.requestId, 'approve', { charter: edited })).note).toBe('accepted with your edits');
    expect((await r.team.member(member.id)).charter).toEqual(edited);

    // An ask without a proposal: Accept is refused; Dismiss cancels it.
    const third = await r.team.askCharter(member.id);
    await expect(r.team.decide(third.requestId, 'approve')).rejects.toMatchObject({ status: 409, code: 'no-proposal' });
    await r.team.decide(third.requestId, 'dismiss');
    expect((await r.team.member(member.id)).charterRequest).toBeNull();

    // The tool refuses a proposal without the required fields.
    const refused = await teamProposeCharter(agentApi(r, session.id), { owns: 'x', produces: '', neverDoes: 'y' });
    expect(refused.isError).toBe(true);
  });

  it('Draft better charters asks every member without an open ask; the one-time offer counts template-only members until acted on', async () => {
    const r = await setup();
    const ids: string[] = [];
    for (const [index, name] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
      const session = await idleSession(r, name.toLowerCase());
      const charter = name === 'Charlie' ? { owns: 'The Acme billing export.', produces: 'Weekly CSVs.', neverDoes: 'Touches invoices.' } : { ...DEVELOPER, owns: `${DEVELOPER.owns} Continues the work of “${name} work” in acme-app.` };
      ids.push((await r.team.adopt({ sessionId: session.id, name, charter })).id);
    }
    // Alpha and Bravo carry template text (plus the draft's "Continues the work of …"): the offer is for 2.
    expect((await r.team.view()).charterOffer).toBe(2);
    await r.team.askCharter(ids[0] as string);
    expect((await r.team.view()).charterOffer).toBe(1);

    const answer = await r.team.askCharters({});
    expect(answer.asked.map((a) => a.name)).toEqual(['Bravo', 'Charlie']);
    expect(answer.skipped).toEqual([{ memberId: ids[0], name: 'Alpha', reason: 'asked already' }]);
    // Acted on: the offer is gone for good on this install.
    expect(await r.world.store.settings.get(CHARTER_OFFER_SETTING)).toBe('done');
    expect((await r.team.view()).charterOffer).toBe(0);
    // A second round skips everyone (all asks open).
    expect((await r.team.askCharters({ teamId: 'all' })).asked).toEqual([]);
  });

  it('Not now hides the offer for good; adopt with askCharter sends the ask', async () => {
    const r = await setup();
    const session = await idleSession(r, 'plain');
    const member = await r.team.adopt({ sessionId: session.id, name: 'Planner', templateId: 'planner', askCharter: true });
    expect((await r.team.member(member.id)).charterRequest?.state).toBe('asked');
    expect(await until(async () => (await userTexts(r, session.id)).find((t) => t.includes('Switchboard asks you, Planner in team Team')), 'the ask after adopt')).toBeTruthy();
    // Its ask is open: the offer leaves it out.
    expect((await r.team.view()).charterOffer).toBe(0);
    const other = await idleSession(r, 'other');
    await r.team.adopt({ sessionId: other.id, name: 'Reviewer', templateId: 'reviewer' });
    expect((await r.team.view()).charterOffer).toBe(1);
    await r.team.dismissCharterOffer();
    expect((await r.team.view()).charterOffer).toBe(0);
  });
});

describe('D105 · howItWorks, templates, the tool', () => {
  it('howItWorks round-trips through the sync and reaches the charter instruction', async () => {
    const r = await setup();
    const session = await idleSession(r, 'synced');
    const member = await r.team.adopt({ sessionId: session.id, name: 'Studio', charter: { owns: 'a', produces: 'b', neverDoes: 'c', howItWorks: 'Rounds of feedback.' } });
    const message = readTeamSyncMessage(JSON.parse(JSON.stringify(await r.team.message())));
    expect(message?.snapshot.members.find((m) => m.id === member.id)?.charter.howItWorks).toBe('Rounds of feedback.');
    // A paired machine's newer edit of it arrives.
    const later = `${(Date.now() + 60_000).toString(36).padStart(9, '0')}.0001.m-pc-0002`;
    const theirs = (message?.snapshot.members ?? []).map((m) => (m.id === member.id ? { ...m, charter: { ...m.charter, howItWorks: 'Weekly rounds with the testers.' }, clock: later } : m));
    expect(await r.team.receive({ v: 1, machine: { id: 'm-pc-0002', name: 'PC' }, snapshot: { ...(message?.snapshot as NonNullable<typeof message>['snapshot']), members: theirs } })).toBe(true);
    expect((await r.team.member(member.id)).charter.howItWorks).toBe('Weekly rounds with the testers.');
    // A charter request with its proposal syncs too.
    await r.team.askCharter(member.id);
    await r.team.proposeCharter(session.id, PROPOSAL);
    const requests = readTeamSyncMessage(JSON.parse(JSON.stringify(await r.team.message())))?.snapshot.requests ?? [];
    expect(requests.find((q) => q.kind === 'charter')?.proposal?.howItWorks).toBe(PROPOSAL.howItWorks);

    expect(charterInstruction('Studio', 'Team', { owns: 'a', produces: 'b', neverDoes: 'c', howItWorks: 'Rounds.' }, [])).toContain('Produces: b. How it works: Rounds. Never does: c.');
    expect(charterInstruction('Studio', 'Team', { owns: 'a', produces: 'b', neverDoes: 'c' }, [])).not.toContain('How it works');
    expect(readCharter({ owns: 'a', produces: 'b', neverDoes: 'c', howItWorks: '  ' })).toEqual({ owns: 'a', produces: 'b', neverDoes: 'c' });
  });

  it('templates: no stale review-card wording; a template-only charter is recognised, a specific one is not', () => {
    for (const template of TEAM_TEMPLATES) expect(JSON.stringify(template.charter).toLowerCase(), template.id).not.toContain('review card');
    expect(DEVELOPER.produces).toBe('Commits on a work branch with tests; a pull request, or a merge into the epic branch, as the plan or its charter says.');
    expect(isTemplateCharter(DEVELOPER)).toBe(true);
    expect(isTemplateCharter({ ...DEVELOPER, produces: 'Commits on a work branch, with tests, and a review card when done.' })).toBe(true);
    expect(isTemplateCharter({ ...DEVELOPER, owns: `${DEVELOPER.owns} Continues the work of “Acme v2.1 fixes” in acme.app.` })).toBe(true);
    expect(isTemplateCharter({ ...DEVELOPER, howItWorks: 'Rounds.' })).toBe(false);
    expect(isTemplateCharter({ ...DEVELOPER, owns: 'The Acme Studio feature.' })).toBe(false);
    expect(TEAM_TOOLS.find((tool) => tool.name === 'team_propose_charter')?.description).toContain('PROPOSAL');
  });
});
