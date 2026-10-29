import { describe, expect, it } from 'vitest';
import { type TeamMember, type TeamNeedsYouItem, type TeamRosterEntry, type TeamSuggestion, archivedMemberText, memberSessionArchived, parseHandoffTarget, shownMembers } from '../../src/core/team.ts';
import { TEAM_TEMPLATES, templateById } from '../../src/core/team-templates.ts';
import { clearDraftCache, draftAll, draftCharter } from '../../src/web/team/charter-draft.ts';
import {
  archivedMembersText,
  visibleMembers,
  visibleTeam,
  EMPTY_FORM,
  LEFT_COLUMN_KEY,
  type LeftColumnPress,
  isLeftColumnShortcut,
  leftStripLabel,
  needsToPulse,
  adoptNote,
  adoptedToast,
  bannerText,
  bannerVisible,
  budgetLine,
  canDropOnTeam,
  cardStatus,
  charterAskedToast,
  charterOfferText,
  formCharter,
  withCharter,
  confidenceOf,
  dropOrder,
  fitMemberModel,
  inOrder,
  pickMemberEffort,
  pickMemberModel,
  moveInOrder,
  sideAlong,
  formBody,
  formFromMember,
  formFromSuggestion,
  formFromTemplate,
  gateCheckboxLabel,
  headerCounts,
  idleLine,
  memberMenu,
  modelLine,
  movedToast,
  restoredOrder,
  sidebarTeamText,
  teamTitle,
  needsYouCounts,
  needsYouShape,
  newMemberSession,
  newMemberTemplates,
  phoneOrder,
  placeLabel,
  returnLabel,
  returnedToast,
  rhythmLine,
  splitSuggestions,
  syncedPeers,
  toggleGate,
} from '../../src/web/team/model.ts';

/** D100 · the Team page's pure rules (src/web/team/model.ts, charter-draft.ts). */

function member(patch: Partial<TeamMember> & { id: string }): TeamMember {
  return {
    teamId: 'team',
    name: patch.id,
    charter: { owns: '', produces: '', neverDoes: '' },
    charterDraft: null,
    templateId: null,
    machineId: 'm-self',
    sessionId: `s-${patch.id}`,
    workplace: { folders: [] },
    provider: 'claude',
    model: null,
    effort: null,
    rhythm: { loops: [], onHandoff: true },
    budget: { dailyPct: null, profileId: null },
    gates: ['outward-facing'],
    paused: false,
    pausedLoops: [],
    pausedBy: null,
    cliLoops: [],
    originalPlace: { place: 'none', folderId: null, index: null },
    access: [],
    order: null,
    createdAt: '2026-10-13T09:00:00.000Z',
    updatedAt: '2026-10-13T09:00:00.000Z',
    status: 'idle',
    sessionRef: `s-${patch.id}`,
    sessionTitle: null,
    machineName: 'Mac',
    local: true,
    cliLoopsUnmanaged: false,
    usedTodayPct: null,
    ...patch,
  };
}

function need(memberId: string, patch: Partial<TeamNeedsYouItem> = {}): TeamNeedsYouItem {
  return { id: `n-${memberId}-${Math.random()}`, source: 'inbox', kind: 'questions', memberId, memberName: memberId, label: `${memberId} · question`, title: 'Which board?', detail: '', createdAt: '2026-10-13T09:00:00.000Z', sessionRef: `s-${memberId}`, ...patch };
}

function suggestion(patch: Partial<TeamSuggestion> & { sessionId: string }): TeamSuggestion {
  return {
    title: patch.sessionId,
    folder: '/work/acme-app',
    evidence: { repos: 1, loops: 0, cliLoops: 0, events7d: 40, edits: 10, reads: 2, editRatio: 0.83 },
    templateId: 'developer',
    reason: '83% of its file tool calls edit: looks like implementation.',
    score: 45,
    charterDraft: null,
    ...patch,
  };
}

describe('D100 · Team page: status and counts', () => {
  it('counts members, working ones and the ones that need the developer', () => {
    const members = [member({ id: 'a', status: 'working' }), member({ id: 'b', status: 'needs-you' }), member({ id: 'c' }), member({ id: 'd', status: 'paused' })];
    expect(headerCounts(members, [need('c')])).toBe('4 members · 1 working · 2 need you');
    expect(headerCounts([member({ id: 'a' })], [])).toBe('1 member · 0 working · 0 need you');
    expect(headerCounts([member({ id: 'a' })], [need('a')])).toBe('1 member · 0 working · 1 needs you');
  });

  it("the header counts who needs you by Team's one rule (as the crews list and the pinned rail do)", () => {
    // A waiting session counts with no item; an archived member never counts, even with an item.
    expect(headerCounts([member({ id: 'w', status: 'needs-you' })], [])).toBe('1 member · 0 working · 1 needs you');
    expect(headerCounts([member({ id: 'z', archived: true })], [need('z')])).toBe('1 member · 0 working · 0 need you');
  });

  it('colours a card needs-you when only Needs-you items wait, but keeps paused and offline', () => {
    const counts = needsYouCounts([need('a'), need('a'), need('p')]);
    expect(counts.get('a')).toBe(2);
    expect(cardStatus(member({ id: 'a', status: 'working' }), counts)).toBe('needs-you');
    expect(cardStatus(member({ id: 'p', status: 'paused' }), counts)).toBe('paused');
    expect(cardStatus(member({ id: 'x', status: 'offline' }), counts)).toBe('offline');
    expect(cardStatus(member({ id: 'y', status: 'working' }), counts)).toBe('working');
  });

  it('orders the phone list: waiting sessions, then other Needs-you items, then working, idle, paused, offline', () => {
    const members = [member({ id: 'off', status: 'offline' }), member({ id: 'idle' }), member({ id: 'items' }), member({ id: 'paused', status: 'paused' }), member({ id: 'work', status: 'working' }), member({ id: 'wait', status: 'needs-you' })];
    expect(phoneOrder(members, needsYouCounts([need('items')])).map((m) => m.id)).toEqual(['wait', 'items', 'work', 'idle', 'paused', 'off']);
  });

  it('titles the team "Team" until it is renamed, and names the model when known', () => {
    expect(teamTitle('Team')).toBe('Team');
    expect(teamTitle('Acme')).toBe('Team · Acme');
    expect(sidebarTeamText('Team', 4)).toBe('Team · 4 members');
    // D100 follow-up 2026-10-14: one entry per team, "<team name> · N members".
    expect(sidebarTeamText('Acme', 1)).toBe('Acme · 1 member');
    const available = [{ value: 'sonnet', label: 'Sonnet 5.5' }, { value: 'default', label: 'Default (recommended)' }];
    expect(modelLine({ current: 'sonnet', effort: 'high', available }, member({ id: 'a' }))).toBe('Sonnet 5.5 · high');
    expect(modelLine({ current: 'claude-x', effort: null, available }, member({ id: 'a' }))).toBe('claude-x');
    expect(modelLine({ current: null, effort: null, available }, member({ id: 'a', model: 'sonnet', effort: 'low' }))).toBe('Sonnet 5.5 · low');
    expect(modelLine(null, member({ id: 'a' }))).toBe('the session’s model');
    expect(modelLine({ current: 'default', effort: null, available }, member({ id: 'a' }))).toBe('the session’s model');
  });

  it('writes the work line, budget and rhythm', () => {
    expect(idleLine(member({ id: 'a', status: 'offline', machineName: 'Windows PC' }), null)).toBe('Windows PC is not reachable');
    expect(idleLine(member({ id: 'a', status: 'paused', pausedBy: 'budget' }), null)).toBe('Paused: over its daily budget');
    expect(idleLine(member({ id: 'a', status: 'paused', pausedBy: 'developer' }), null)).toBe('Paused by you');
    expect(idleLine(member({ id: 'a' }), need('a', { title: 'Merge into main?' }))).toBe('Merge into main?');
    expect(idleLine(member({ id: 'a', status: 'working' }), null)).toBe('Working…');
    expect(budgetLine(member({ id: 'a' }))).toBeNull();
    expect(budgetLine(member({ id: 'a', budget: { dailyPct: 20, profileId: null }, usedTodayPct: 12.4 }))).toBe('12% / 20% a day');
    expect(rhythmLine(member({ id: 'a', rhythm: { loops: [{ loopId: 'l1', label: null, prompt: 'p', scheduleText: 'every 30 min' }], onHandoff: true } }))).toBe('on hand-off · 1 loop');
    expect(rhythmLine(member({ id: 'a', rhythm: { loops: [], onHandoff: false } }))).toBe('no rhythm');
  });

  it('names the synced peers that are online', () => {
    expect(syncedPeers([{ name: 'Windows PC', state: 'online' }, { name: 'Laptop', state: 'offline' }])).toEqual(['Windows PC']);
  });
});

describe('2026-10-27 (D137 follow-up, choice B) · archived members are hidden, not removed', () => {
  const entry = (id: string, archived?: boolean): TeamRosterEntry => ({ id, name: id, status: 'offline', sessionRef: `s-${id}`, machineName: 'Mac', local: true, current: null, turnStartedAt: null, lastActivityAt: null, ...(archived === undefined ? {} : { archived }) });

  it('the page shows only members whose session is not archived, and says how many are', () => {
    const list = [member({ id: 'a' }), member({ id: 'b', archived: true }), member({ id: 'c', archived: false })];
    expect(shownMembers(list).map((m) => m.id)).toEqual(['a', 'c']);
    expect(visibleMembers(list)).toEqual({ shown: [list[0], list[2]], archived: 1 });
    expect(visibleMembers([member({ id: 'x', archived: true })])).toEqual({ shown: [], archived: 1 });
    expect(archivedMembersText(1)).toBe('1 archived member');
    expect(archivedMembersText(3)).toBe('3 archived members');
    expect(archivedMembersText(0)).toBe('');
    // Counts leave them out (the header's "N members · …").
    expect(headerCounts(visibleMembers(list).shown, [])).toBe('2 members · 0 working · 0 need you');
  });

  it('a team summary: archived members leave its roster and its member count (the sidebar, v2 Crews)', () => {
    const team = { id: 't', name: 'Team', order: 0, members: 3, needsYou: 0, archived: 1, roster: [entry('a'), entry('b', true), entry('c', false)] };
    expect(visibleTeam(team)).toMatchObject({ members: 2, archived: 1, roster: [entry('a'), entry('c', false)] });
    // An older answer without `archived` (and without a roster) is left as it is.
    expect(visibleTeam({ id: 't', name: 'Team', order: 0, members: 2, needsYou: 0 })).toEqual({ id: 't', name: 'Team', order: 0, members: 2, needsYou: 0, archived: 0 });
    expect(sidebarTeamText('Team', visibleTeam(team).members)).toBe('Team · 2 members');
  });

  it('a session closed by a move to another computer (D65) is not archived: the member continues there', () => {
    expect(memberSessionArchived({ closedAt: '2026-10-27T09:00:00.000Z' })).toBe(true);
    expect(memberSessionArchived({ closedAt: '2026-10-27T09:00:00.000Z', movedTo: null })).toBe(true);
    expect(memberSessionArchived({ closedAt: '2026-10-27T09:00:00.000Z', movedTo: { machineId: 'm-pc', machineName: 'PC', sessionId: 's' } })).toBe(false);
    expect(memberSessionArchived({ closedAt: null })).toBe(false);
    expect(memberSessionArchived({})).toBe(false);
  });

  it('the refusal of new work names the member and the way back', () => {
    expect(archivedMemberText('Builder')).toBe("Builder's session is archived: restore it first");
  });
});

describe('D100 · Team page: places, notes and toasts', () => {
  it('names the original place and words the menu, the note and the toasts', () => {
    const layout = { folders: [{ id: 'f-1', name: 'Work', collapsed: false, sessionIds: [], parentId: null }] };
    expect(placeLabel({ place: 'folder', folderId: 'f-1', index: 0 }, layout)).toBe('Work');
    expect(placeLabel({ place: 'pinned', folderId: null, index: 0 }, layout)).toBe('Pinned');
    expect(placeLabel({ place: 'loose', folderId: null, index: 2 }, layout)).toBe('Sessions');
    expect(returnLabel('Work')).toBe('↩ Return to sessions (back to “Work”)');
    expect(adoptNote('Board watch', 'Work')).toBe(
      '“Board watch” leaves your session list and lives in Team from now on — history, worktrees, todos and loops included. ↩ Return to sessions on the member puts it back in “Work”, where it was. Switching Team off returns every member automatically.',
    );
    expect(adoptedToast('X', 'Tracker')).toBe('“X” moved from your session list into Team as Tracker');
    expect(returnedToast('X', 'Work')).toBe('“X” is back in your session list (Work) as a plain session');
  });
});

describe('D100 · Team page: suggestions', () => {
  it("uses the server's confidence when it sends one", () => {
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 5, confidence: 'high' }))).toBe('high');
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 150, confidence: 'low' }))).toBe('low');
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 150, confidence: 'medium' }))).toBe('medium');
  });

  it('rates confidence from the score and the pattern for an older machine without one', () => {
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 150 }))).toBe('high');
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 150, evidence: { repos: 1, loops: 0, cliLoops: 0, events7d: 150, edits: 3, reads: 7, editRatio: 0.3 } }))).toBe('medium');
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 30 }))).toBe('medium');
    expect(confidenceOf(suggestion({ sessionId: 'a', score: 5 }))).toBe('low');
  });

  it('splits suggestions from the not-suggested sessions with their reasons', () => {
    const list = [suggestion({ sessionId: 'a' }), suggestion({ sessionId: 'gone' }), suggestion({ sessionId: 'm' })];
    const sessions = [
      { id: 'a', title: 'A', hooked: false, attached: true, machineName: null },
      { id: 'quiet', title: 'Quiet', hooked: false, attached: true, machineName: null },
      { id: 'hooked', title: 'Hooked', hooked: true, attached: true, machineName: null },
      { id: 'term', title: 'Term', hooked: false, attached: false, machineName: null },
      { id: 'r~pc~1', title: 'Remote', hooked: false, attached: true, machineName: 'Windows PC' },
    ];
    const split = splitSuggestions(list, sessions, { dismissed: new Set(['gone']), members: new Set(['m']) });
    expect(split.suggested.map((s) => s.sessionId)).toEqual(['a']);
    expect(split.notSuggested.map((n) => [n.sessionId, n.reason, n.adoptable])).toEqual([
      ['gone', 'Dismissed', true],
      ['quiet', 'too little activity or no clear role to tell', true],
      ['hooked', 'A hooked terminal session: continue it in Switchboard first', false],
      ['term', 'It continues in a terminal: attach it here first', false],
      ['r~pc~1', 'Runs on Windows PC: its own machine suggests it', true],
    ]);
  });

  it('offers "new member" templates nobody covers yet, and shows the banner until Later saw every suggestion', () => {
    const extra = newMemberTemplates(TEAM_TEMPLATES, [{ templateId: 'planner' }], [member({ id: 'x', templateId: 'developer' })]);
    expect(extra.map((t) => t.id)).toEqual(['reviewer', 'release-manager']);
    expect(bannerVisible([], null)).toBe(false);
    expect(bannerVisible(['a'], null)).toBe(true);
    expect(bannerVisible(['a'], ['a'])).toBe(false);
    expect(bannerVisible(['a', 'b'], ['a'])).toBe(true);
    expect(bannerText(3)).toBe('Switchboard found 3 sessions that look like team members. Adopting one moves it from your session list into Team; you can return it any time.');
    expect(bannerText(1)).toBe('Switchboard found 1 session that looks like a team member. Adopting one moves it from your session list into Team; you can return it any time.');
  });

  it('drafts a charter from the template and the evidence, once (cached), without a model call', () => {
    clearDraftCache();
    const s = suggestion({ sessionId: 'a', title: 'PROJ-123 board', evidence: { repos: 2, loops: 1, cliLoops: 1, events7d: 80, edits: 0, reads: 30, editRatio: 0 }, templateId: 'on-call' });
    const draft = draftCharter(s, templateById('on-call'));
    expect(draft.owns).toBe('Watching logs and alerts for new problems. Continues the work of “PROJ-123 board” in acme-app.');
    expect(draft.produces).toBe('A short report per sweep; hand-offs for real problems with the evidence. Keeps its 2 recurring loops going.');
    expect(draft.neverDoes).toBe('Changes production or silences alerts. Stays within its 2 repositories.');
    expect(draftCharter(s, templateById('on-call'))).toBe(draft);
    const given = { owns: 'x', produces: 'y', neverDoes: 'z' };
    expect(draftCharter({ ...s, charterDraft: given }, null)).toBe(given);
    expect(draftAll([s], templateById).get('a')).toBe(draft);
  });
});

describe('D100 · Team page: the member form and menu', () => {
  it('fills from a template, a suggestion and a member', () => {
    const planner = templateById('planner');
    const form = formFromTemplate(planner);
    expect(form.name).toBe('Planner');
    expect(form.templateLoops.map((l) => [l.label, l.cron, l.kept])).toEqual([['Morning planning', '0 9 * * 1-5', true]]);
    expect(form.gates).toEqual(['outward-facing', 'external-write']);
    const fromSuggestion = formFromSuggestion(suggestion({ sessionId: 'a' }), templateById('developer'), { owns: 'o', produces: 'p', neverDoes: 'n' }, ['l1']);
    expect([fromSuggestion.name, fromSuggestion.owns, fromSuggestion.loopIds, fromSuggestion.templateLoops]).toEqual(['Developer', 'o', ['l1'], []]);
    const fromMember = formFromMember(member({ id: 'a', name: 'Tracker', budget: { dailyPct: 15, profileId: null }, gates: ['outward-facing', 'release'] }));
    expect([fromMember.name, fromMember.budget, fromMember.gates]).toEqual(['Tracker', '15', ['outward-facing', 'release']]);
  });

  it('checks the form and builds the body; the always-on gate stays', () => {
    expect(formBody({ ...EMPTY_FORM, name: '  ' })).toEqual({ ok: false, errors: { name: 'Name the role.' } });
    expect(formBody({ ...EMPTY_FORM, name: 'T', budget: '120' })).toMatchObject({ ok: false, errors: { budget: expect.any(String) } });
    const ok = formBody({ ...EMPTY_FORM, name: ' Tracker  one ', owns: ' the board ', budget: '20', model: 'opus', loopIds: ['l1'] });
    expect(ok).toEqual({
      ok: true,
      body: {
        name: 'Tracker one',
        charter: { owns: 'the board', produces: '', neverDoes: '' },
        templateId: null,
        rhythm: { loopIds: ['l1'], onHandoff: true },
        budget: { dailyPct: 20, profileId: null },
        gates: ['outward-facing', 'merge-default-branch'],
        model: 'opus',
        effort: null,
      },
    });
    expect(toggleGate(['outward-facing'], 'outward-facing')).toEqual(['outward-facing']);
    expect(toggleGate(['outward-facing', 'release'], 'merge-default-branch')).toEqual(['outward-facing', 'merge-default-branch', 'release']);
    expect(toggleGate(['outward-facing', 'release'], 'release')).toEqual(['outward-facing']);
    expect(gateCheckboxLabel('outward-facing')).toBe('Anything outward-facing (always)');
    expect(newMemberSession({ folder: 'f-1' })).toMatchObject({ task: '', folder: 'f-1', worktrees: false });
  });

  it('builds the ⋯ menu with Move to each other machine and Return last', () => {
    const items = memberMenu(member({ id: 'a' }), [{ id: 'm-pc', name: 'Windows PC', state: 'online' }, { id: 'm-old', name: 'Laptop', state: 'offline' }], 'm-self', 'Work');
    expect(items.map((i) => i.label)).toEqual(['Give a task…', 'Edit charter…', 'Redraft charter', 'Model & effort…', 'Budget…', 'Schedule…', '⏸ Pause', 'Move to Windows PC…', 'Move to Laptop…', '↩ Return to sessions (back to “Work”)']);
    expect(items.find((i) => i.label === 'Move to Laptop…')?.disabled).toBe(true);
    expect(items[items.length - 1]?.separator).toBe(true);
    const remote = memberMenu(member({ id: 'b', machineId: 'm-pc', paused: true }), [{ id: 'm-pc', name: 'Windows PC', state: 'online' }], 'm-self', 'Sessions');
    expect(remote.map((i) => i.label)).toContain('Move to this machine…');
    expect(remote.map((i) => i.label)).toContain('▶ Resume');
  });

  it('D100 follow-up 2026-10-14: the menu moves a member left / right (up / down on a phone), disabled at the ends', () => {
    const at = (index: number, vertical = false) => memberMenu(member({ id: 'a' }), [], 'm-self', 'Work', { index, count: 3, vertical });
    const labels = (items: ReturnType<typeof memberMenu>) => items.filter((i) => i.id.startsWith('order-')).map((i) => [i.label, i.disabled === true]);
    expect(labels(at(0))).toEqual([['Move left', true], ['Move right', false]]);
    expect(labels(at(1))).toEqual([['Move left', false], ['Move right', false]]);
    expect(labels(at(2, true))).toEqual([['Move up', false], ['Move down', true]]);
    // Placed after Pause, before Return; a team of one has nothing to move.
    expect(at(1).map((i) => i.label)).toEqual(['Give a task…', 'Edit charter…', 'Redraft charter', 'Model & effort…', 'Budget…', 'Schedule…', '⏸ Pause', 'Move left', 'Move right', '↩ Return to sessions (back to “Work”)']);
    expect(labels(memberMenu(member({ id: 'a' }), [], 'm-self', 'Work', { index: 0, count: 1, vertical: false }))).toEqual([]);
  });

  it('D100 follow-up 2026-10-14: the Team page\'s address names the team (/team = the last-used one, /team/all = All teams)', async () => {
    // A .tsx module: loaded at run time (the tests' tsconfig has no JSX), as tests/web/search.test.ts does.
    const ROUTER = '../../src/web/router.tsx';
    type RouteLike = { readonly view: string; readonly teamId?: string };
    const { parseRoute, routePath } = (await import(/* @vite-ignore */ ROUTER)) as { parseRoute: (path: string) => RouteLike; routePath: (route: RouteLike) => string };
    expect(parseRoute('/team')).toEqual({ view: 'team' });
    expect(parseRoute('/team/abc-1')).toEqual({ view: 'team', teamId: 'abc-1' });
    expect(parseRoute('/team/all')).toEqual({ view: 'team', teamId: 'all' });
    expect(routePath({ view: 'team' })).toBe('/team');
    expect(routePath({ view: 'team', teamId: 'a b' })).toBe('/team/a%20b');
  });

  it('D100 follow-up 2026-10-14: ⋯ Move to team ▸ <name> lists the other teams; a team name in parentheses names the receiver\'s team', () => {
    const teams = [{ id: 'team', name: 'Team' }, { id: 'g', name: 'Growth' }, { id: 'o', name: 'Ops' }];
    const items = memberMenu({ ...member({ id: 'a' }), teamId: 'g' }, [], 'm-self', 'Work', undefined, teams).filter((i) => i.id === 'team');
    expect(items.map((i) => [i.label, i.teamId])).toEqual([['Move to team ▸ Team', 'team'], ['Move to team ▸ Ops', 'o']]);
    expect(items[0]?.separator).toBe(true);
    expect(parseHandoffTarget('Developer (Growth)', ['Team', 'Growth'])).toEqual({ name: 'Developer', team: 'Growth' });
    expect(parseHandoffTarget('Developer (growth)', ['Team', 'Growth'])).toEqual({ name: 'Developer', team: 'growth' });
    // Not a team: the whole text is the role name.
    expect(parseHandoffTarget('QA (nightly)', ['Team', 'Growth'])).toEqual({ name: 'QA (nightly)', team: null });
    expect(parseHandoffTarget('Developer', ['Team'])).toEqual({ name: 'Developer', team: null });
  });

  it('D100 follow-up 2026-10-14: a dragged card drops on another team\'s tab only (never its own team, All teams or a team gone)', () => {
    const teams = [{ id: 'team' }, { id: 'g' }, { id: 'o' }];
    expect(canDropOnTeam(teams, 'g', 'team')).toBe(true);
    expect(canDropOnTeam(teams, 'g', 'o')).toBe(true);
    // One team per session: its own team is no move.
    expect(canDropOnTeam(teams, 'g', 'g')).toBe(false);
    // No team id on an older record: the first team.
    expect(canDropOnTeam(teams, undefined, 'team')).toBe(false);
    expect(canDropOnTeam(teams, '', 'g')).toBe(true);
    expect(canDropOnTeam(teams, 'g', 'all')).toBe(false);
    expect(canDropOnTeam(teams, 'g', 'gone')).toBe(false);
    expect(canDropOnTeam(teams, 'g', '')).toBe(false);
    expect(movedToast('Developer', 'Growth')).toBe('Moved Developer to Growth');
  });

  it('D100 follow-up 2026-10-14: Undo of a move puts the old team\'s order back (leavers dropped, newcomers after)', () => {
    // Back at the end after the move back: b goes back between a and c.
    expect(restoredOrder(['a', 'b', 'c'], ['a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    // Already in place: nothing to save.
    expect(restoredOrder(['a', 'b'], ['a', 'b'])).toBeNull();
    // c left meanwhile, d joined meanwhile.
    expect(restoredOrder(['b', 'a', 'c'], ['a', 'd', 'b'])).toEqual(['b', 'a', 'd']);
  });

  it('D100 follow-up 2026-10-14: the model dropdown: a template\'s model pre-selected when the CLI lists it, else the session\'s; efforts only where the model has them', () => {
    const options = [
      { value: 'default', label: 'Default (recommended)', efforts: ['low', 'medium', 'high'] },
      { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'max'] },
      { value: 'haiku', label: 'Haiku 4.5' },
    ];
    const session = { model: 'haiku', effort: null };
    // The template's suggestion is on offer: taken with its effort.
    expect(fitMemberModel({ ...EMPTY_FORM, model: 'opus', effort: 'high' }, options, session)).toMatchObject({ model: 'opus', effort: 'high' });
    // Not on offer: the session's current model.
    expect(fitMemberModel({ ...EMPTY_FORM, model: 'sonnet', effort: 'medium' }, options, session)).toMatchObject({ model: 'haiku', effort: '' });
    // No session model (the CLI's default): `default`; an effort the model lacks is dropped.
    expect(fitMemberModel({ ...EMPTY_FORM, model: 'haiku', effort: 'low' }, options, { model: null, effort: null })).toMatchObject({ model: 'haiku', effort: '' });
    expect(fitMemberModel(EMPTY_FORM, options, { model: null, effort: 'high' })).toMatchObject({ model: 'default', effort: 'high' });
    // A pick keeps the effort only when the new model has it (the header's rule).
    const opusHigh = { ...EMPTY_FORM, model: 'opus', effort: 'max' };
    expect(pickMemberModel(opusHigh, options, 'default')).toMatchObject({ model: 'default', effort: '' });
    expect(pickMemberModel({ ...opusHigh, effort: 'high' }, options, 'default')).toMatchObject({ model: 'default', effort: 'high' });
    expect(pickMemberModel(opusHigh, options, 'haiku')).toMatchObject({ model: 'haiku', effort: '' });
    expect(pickMemberEffort(opusHigh, null)).toMatchObject({ effort: '' });
    // Nothing chosen yet (the list did not load): the body leaves the session's model alone.
    const body = formBody({ ...EMPTY_FORM, name: 'T' });
    expect(body.ok && 'model' in body.body).toBe(false);
  });

  it('D100 follow-up 2026-10-14: the order model: drop before / after, move one place, an optimistic order', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(dropOrder(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(dropOrder(ids, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
    expect(dropOrder(ids, 'b', 'c', 'before')).toBeNull();
    expect(dropOrder(ids, 'b', 'a', 'after')).toBeNull();
    expect(dropOrder(ids, 'b', 'b', 'after')).toBeNull();
    expect(dropOrder(ids, 'x', 'b', 'after')).toBeNull();
    expect(moveInOrder(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveInOrder(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveInOrder(ids, 'a', -1)).toBeNull();
    expect(moveInOrder(ids, 'd', 1)).toBeNull();
    const rect = { left: 100, top: 10, width: 200, height: 40 };
    expect(sideAlong('x', { x: 150, y: 0 }, rect)).toBe('before');
    expect(sideAlong('x', { x: 250, y: 0 }, rect)).toBe('after');
    expect(sideAlong('y', { x: 0, y: 40 }, rect)).toBe('after');
    const items = ids.map((id) => ({ id }));
    expect(inOrder(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(inOrder(items, null).map((i) => i.id)).toEqual(ids);
  });

  it('answers each Needs-you shape its own way', () => {
    expect(needsYouShape({ source: 'team', kind: 'gate' })).toBe('request');
    expect(needsYouShape({ source: 'team', kind: 'access' })).toBe('request');
    expect(needsYouShape({ source: 'team', kind: 'access', access: {} as never })).toBe('access');
    expect(needsYouShape({ source: 'inbox', kind: 'questions' })).toBe('question');
    expect(needsYouShape({ source: 'inbox', kind: 'permission' })).toBe('permission');
    // D102: a plan's "Ready to merge" item (its Merge action) is answered in place.
    expect(needsYouShape({ source: 'inbox', kind: 'system', inbox: { actions: [{ id: 'plan-merge', label: 'Merge' }] } })).toBe('merge');
    expect(needsYouShape({ source: 'inbox', kind: 'system' })).toBe('other');
    // D105: a charter proposal (Accept / Edit… / Dismiss).
    expect(needsYouShape({ source: 'team', kind: 'charter' })).toBe('charter');
  });
});

describe('D105 · better charters (Team page rules)', () => {
  it('the form carries howItWorks only when filled in; Edit… fills the form with a proposal', () => {
    expect(formCharter({ owns: ' a ', produces: 'b', howItWorks: '  ', neverDoes: 'c' })).toEqual({ owns: 'a', produces: 'b', neverDoes: 'c' });
    expect(formCharter({ owns: 'a', produces: 'b', howItWorks: ' Rounds. ', neverDoes: 'c' })).toEqual({ owns: 'a', produces: 'b', howItWorks: 'Rounds.', neverDoes: 'c' });
    const ok = formBody({ ...EMPTY_FORM, name: 'Studio', howItWorks: 'Feedback rounds.' });
    expect(ok.ok && ok.body.charter).toEqual({ owns: '', produces: '', howItWorks: 'Feedback rounds.', neverDoes: '' });
    const filled = withCharter({ ...EMPTY_FORM, name: 'Studio', budget: '10' }, { owns: 'o', produces: 'p', howItWorks: 'h', neverDoes: 'n' });
    expect([filled.owns, filled.produces, filled.howItWorks, filled.neverDoes, filled.budget]).toEqual(['o', 'p', 'h', 'n', '10']);
    expect(formFromMember(member({ id: 'a', charter: { owns: 'o', produces: 'p', howItWorks: 'h', neverDoes: 'n' } })).howItWorks).toBe('h');
  });

  it('Redraft charter in the menu is disabled while an ask or a proposal is open, or the member is paused / offline', () => {
    const redraft = (extra: Partial<TeamMember>) => memberMenu(member({ id: 'a', ...extra }), [], 'm-self', 'Work').find((i) => i.id === 'redraft');
    expect(redraft({})?.disabled).toBe(false);
    expect(redraft({ charterRequest: { requestId: 'r', state: 'asked', proposal: null, notes: '', at: '' } })?.disabled).toBe(true);
    expect(redraft({ paused: true })?.disabled).toBe(true);
    expect(redraft({ status: 'offline' })?.disabled).toBe(true);
  });

  it('the offer and the toast say what happened', () => {
    expect(charterOfferText(3)).toBe("Switchboard can draft specific charters for your 3 members from their own sessions. Each member's agent proposes one; nothing changes until you accept it.");
    expect(charterOfferText(1)).toContain('your 1 member from');
    expect(charterAskedToast({ asked: [{ name: 'Studio' }], skipped: [] })).toBe('Asked Studio to draft a specific charter. Their proposals show in Needs you.');
    expect(charterAskedToast({ asked: [{ name: 'A' }, { name: 'B' }], skipped: [{ name: 'C', reason: 'asked already' }] })).toBe('Asked 2 members to draft a specific charter (skipped: C, asked already). Their proposals show in Needs you.');
    expect(charterAskedToast({ asked: [], skipped: [] })).toBe('No member was asked.');
  });
});

describe('D100 follow-up 2026-10-16: the left column folds to a slim strip', () => {
  const press = (key: string, extra: Partial<LeftColumnPress> = {}): LeftColumnPress => ({ key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...extra });
  const free = { typing: false, modalOpen: false };

  it('"[" toggles it, only bare and never while typing, in a modal, on a repeat, while composing or when taken', () => {
    expect(LEFT_COLUMN_KEY).toBe('[');
    expect(isLeftColumnShortcut(press('['), free)).toBe(true);
    expect(isLeftColumnShortcut(press(']'), free)).toBe(false);
    expect(isLeftColumnShortcut(press('b'), free)).toBe(false);
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) expect(isLeftColumnShortcut(press('[', { [modifier]: true }), free), modifier).toBe(false);
    expect(isLeftColumnShortcut(press('[', { repeat: true }), free)).toBe(false);
    expect(isLeftColumnShortcut(press('[', { isComposing: true }), free)).toBe(false);
    expect(isLeftColumnShortcut(press('[', { defaultPrevented: true }), free)).toBe(false);
    expect(isLeftColumnShortcut(press('['), { typing: true, modalOpen: false })).toBe(false);
    expect(isLeftColumnShortcut(press('['), { typing: false, modalOpen: true })).toBe(false);
  });

  it('a new Needs-you item pulses the badge once (never an item already known or already pulsed)', () => {
    expect(needsToPulse(['inbox:a', 'inbox:b'], new Set(['inbox:a']), new Set())).toEqual(['inbox:b']);
    expect(needsToPulse(['inbox:a', 'inbox:b'], new Set(['inbox:a']), new Set(['inbox:b']))).toEqual([]);
    expect(needsToPulse([], new Set(), new Set())).toEqual([]);
  });

  it("the strip's label names the shortcut, the count and new activity", () => {
    expect(leftStripLabel(0, false)).toBe('Show Needs you and Activity ([)');
    expect(leftStripLabel(1, false)).toBe('Show Needs you and Activity ([) · 1 needs you');
    expect(leftStripLabel(3, true)).toBe('Show Needs you and Activity ([) · 3 need you · new activity');
  });
});
