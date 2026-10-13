import { describe, expect, it } from 'vitest';
import type { TeamMember, TeamNeedsYouItem, TeamSuggestion } from '../../src/core/team.ts';
import { TEAM_TEMPLATES, templateById } from '../../src/core/team-templates.ts';
import { clearDraftCache, draftAll, draftCharter } from '../../src/web/team/charter-draft.ts';
import {
  EMPTY_FORM,
  adoptNote,
  adoptedToast,
  bannerText,
  bannerVisible,
  budgetLine,
  cardStatus,
  confidenceOf,
  formBody,
  formFromMember,
  formFromSuggestion,
  formFromTemplate,
  gateCheckboxLabel,
  headerCounts,
  idleLine,
  memberMenu,
  modelLine,
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
    expect(sidebarTeamText('Acme', 1)).toBe('Team · Acme · 1 member');
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
  it('rates confidence from the score and the pattern', () => {
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
      ['quiet', 'too little activity to tell', true],
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
    expect(items.map((i) => i.label)).toEqual(['Give a task…', 'Edit charter…', 'Model & effort…', 'Budget…', 'Schedule…', '⏸ Pause', 'Move to Windows PC…', 'Move to Laptop…', '↩ Return to sessions (back to “Work”)']);
    expect(items.find((i) => i.label === 'Move to Laptop…')?.disabled).toBe(true);
    expect(items[items.length - 1]?.separator).toBe(true);
    const remote = memberMenu(member({ id: 'b', machineId: 'm-pc', paused: true }), [{ id: 'm-pc', name: 'Windows PC', state: 'online' }], 'm-self', 'Sessions');
    expect(remote.map((i) => i.label)).toContain('Move to this machine…');
    expect(remote.map((i) => i.label)).toContain('▶ Resume');
  });

  it('answers each Needs-you shape its own way', () => {
    expect(needsYouShape({ source: 'team', kind: 'gate' })).toBe('request');
    expect(needsYouShape({ source: 'inbox', kind: 'questions' })).toBe('question');
    expect(needsYouShape({ source: 'inbox', kind: 'permission' })).toBe('permission');
    expect(needsYouShape({ source: 'inbox', kind: 'review' })).toBe('review');
    expect(needsYouShape({ source: 'inbox', kind: 'system' })).toBe('other');
  });
});
