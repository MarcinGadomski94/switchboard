import type { SessionModelOption } from '../../core/api.ts';
import { modelLabel } from '../../core/model-choice.ts';
import type { Machine } from '../../core/peers.ts';
import type { SidebarLayout } from '../../core/sidebar-layout.ts';
import {
  ALWAYS_ON_GATE,
  DEFAULT_TEAM_NAME,
  GATE_KINDS,
  GATE_LABELS,
  TEAM_NAME_MAX,
  type TeamCharter,
  type TeamGateKind,
  type TeamMember,
  type TeamMemberStatus,
  type TeamNeedsYouItem,
  type TeamOriginalPlace,
  type TeamSuggestion,
} from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import type { MemberBody } from './api.ts';

/**
 * D100 · the Team page's pure rules (`docs/team.md` → *The Team page*): status words
 * and order, the header's counts, the suggestions' confidence and split, the member
 * form and its body, the member menu, the texts of the notes and toasts. Kept free
 * of React so they are unit-tested (`tests/web/team.test.ts`).
 */

// ── status ───────────────────────────────────────────────────────────────

/** How a status shows on a card: its icon and word. */
export const STATUS_META: Readonly<Record<TeamMemberStatus, { readonly icon: string; readonly label: string }>> = {
  working: { icon: '●', label: 'Working' },
  'needs-you': { icon: '!', label: 'Needs you' },
  idle: { icon: '○', label: 'Idle' },
  paused: { icon: '⏸', label: 'Paused' },
  offline: { icon: '⌁', label: 'Offline' },
};

/** The page's title: "Team", or "Team · <name>" once the developer renamed it. */
export function teamTitle(name: string): string {
  return name === DEFAULT_TEAM_NAME ? 'Team' : `Team · ${name}`;
}

/** The sidebar entry: "Team · 4 members", or "Team · <name> · 4 members" once renamed. */
export function sidebarTeamText(name: string, members: number): string {
  return `${teamTitle(name)} · ${membersLabel(members)}`;
}

/**
 * The member panel's model: the session's model and effort as the CLI names them
 * ("Sonnet 5.5 · high"), else the model recorded on the member, else "the session's model".
 */
export function modelLine(session: { readonly current: string | null; readonly effort: string | null; readonly available: readonly SessionModelOption[] | null } | null | undefined, member: Pick<TeamMember, 'model' | 'effort'>): string {
  const value = session?.current ?? member.model;
  if (!value || value === 'default') return 'the session’s model';
  const label = modelLabel(session?.available ?? null, value).replace(/\s*\([^)]*\)\s*$/, '').trim() || value;
  const effort = session?.effort ?? member.effort;
  return effort ? `${label} · ${effort}` : label;
}

/** "1 member" / "3 members". */
export function membersLabel(count: number): string {
  return `${count} member${count === 1 ? '' : 's'}`;
}

/** Open Needs-you items per member id. */
export function needsYouCounts(items: readonly TeamNeedsYouItem[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item.memberId, (out.get(item.memberId) ?? 0) + 1);
  return out;
}

/** A member needs the developer: its session waits, or it has open Needs-you items. */
export function needsYou(member: Pick<TeamMember, 'id' | 'status'>, counts: ReadonlyMap<string, number>): boolean {
  return member.status === 'needs-you' || (counts.get(member.id) ?? 0) > 0;
}

/** The status a card is coloured by: `needs-you` also when only Needs-you items wait. */
export function cardStatus(member: Pick<TeamMember, 'id' | 'status'>, counts: ReadonlyMap<string, number>): TeamMemberStatus {
  if (member.status === 'offline' || member.status === 'paused') return member.status;
  return needsYou(member, counts) ? 'needs-you' : member.status;
}

/** The header's line: "3 members · 1 working · 2 need you". */
export function headerCounts(members: readonly Pick<TeamMember, 'id' | 'status'>[], items: readonly TeamNeedsYouItem[]): string {
  const counts = needsYouCounts(items);
  const working = members.filter((member) => member.status === 'working').length;
  const waiting = members.filter((member) => needsYou(member, counts)).length;
  return `${membersLabel(members.length)} · ${working} working · ${waiting} need${waiting === 1 ? 's' : ''} you`;
}

/**
 * The phone's list order: the members whose session waits for the developer first,
 * then the ones with other Needs-you items (more first), then working, idle, paused,
 * offline (stable within each).
 */
export function phoneOrder<T extends Pick<TeamMember, 'id' | 'status'>>(members: readonly T[], counts: ReadonlyMap<string, number>): T[] {
  const rank = (member: T): number => {
    if (member.status === 'offline') return 5;
    if (member.status === 'needs-you') return 0;
    if ((counts.get(member.id) ?? 0) > 0) return 1;
    return { working: 2, idle: 3, paused: 4 }[member.status as 'working' | 'idle' | 'paused'] ?? 3;
  };
  return members
    .map((member, index) => ({ member, index, rank: rank(member), needs: counts.get(member.id) ?? 0 }))
    .sort((a, b) => a.rank - b.rank || b.needs - a.needs || a.index - b.index)
    .map((entry) => entry.member);
}

/** The card's work line when the session shows no live activity. */
export function idleLine(member: Pick<TeamMember, 'status' | 'pausedBy' | 'machineName'>, firstNeed: TeamNeedsYouItem | null): string {
  if (member.status === 'offline') return `${member.machineName} is not reachable`;
  if (firstNeed) return firstNeed.title;
  if (member.status === 'paused') return member.pausedBy === 'budget' ? 'Paused: over its daily budget' : 'Paused by you';
  if (member.status === 'needs-you') return 'Waiting for you';
  if (member.status === 'working') return 'Working…';
  return 'Idle: waiting for a hand-off or its next loop';
}

/** "12% / 20% a day", "20% a day", or `null` without a budget. */
export function budgetLine(member: Pick<TeamMember, 'budget' | 'usedTodayPct'>): string | null {
  if (member.budget.dailyPct === null) return null;
  return member.usedTodayPct === null ? `${member.budget.dailyPct}% a day` : `${Math.round(member.usedTodayPct)}% / ${member.budget.dailyPct}% a day`;
}

/** "on hand-off · 2 loops", "2 loops", "on hand-off", "no rhythm". */
export function rhythmLine(member: Pick<TeamMember, 'rhythm'>): string {
  const parts: string[] = [];
  if (member.rhythm.onHandoff) parts.push('on hand-off');
  const loops = member.rhythm.loops.length;
  if (loops > 0) parts.push(`${loops} loop${loops === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' · ') : 'no rhythm';
}

/** "needs you for: merging, releases" (the gates besides the always-on one). */
export function gatesLine(gates: readonly TeamGateKind[]): string {
  const extra = gates.filter((gate) => gate !== ALWAYS_ON_GATE);
  return extra.length === 0 ? 'needs you for: anything outward-facing' : `needs you for: ${extra.map((gate) => GATE_LABELS[gate]).join(', ')}`;
}

/** The paired machines this page is synced with now (connected), by name. */
export function syncedPeers(machines: readonly Pick<Machine, 'name' | 'state'>[]): string[] {
  return machines.filter((machine) => machine.state === 'online').map((machine) => machine.name);
}

// ── places ───────────────────────────────────────────────────────────────

/** Where a returned session goes, as the menu and the toast name it: its folder, "Pinned" or "Sessions". */
export function placeLabel(place: TeamOriginalPlace, layout: Pick<SidebarLayout, 'folders'> | null): string {
  if (place.place === 'pinned') return 'Pinned';
  if (place.place === 'folder' && place.folderId) return layout?.folders.find((folder) => folder.id === place.folderId)?.name ?? 'its folder';
  return 'Sessions';
}

/** The menu's last item: "↩ Return to sessions (back to “Work”)". */
export function returnLabel(place: string): string {
  return `↩ Return to sessions (back to “${place}”)`;
}

/** The adopt form's note. */
export function adoptNote(title: string, place: string): string {
  return `“${title}” leaves your session list and lives in Team from now on — history, worktrees, todos and loops included. ↩ Return to sessions on the member puts it back in “${place}”, where it was. Switching Team off returns every member automatically.`;
}

/** The toast after an adoption. */
export function adoptedToast(title: string, role: string): string {
  return `“${title}” moved from your session list into Team as ${role}`;
}

/** The toast after a return. */
export function returnedToast(title: string, place: string): string {
  return `“${title}” is back in your session list (${place}) as a plain session`;
}

// ── suggestions ──────────────────────────────────────────────────────────

/** A suggestion's confidence pill; `new` = a template no session matched ("new member"). */
export type Confidence = 'high' | 'medium' | 'low' | 'new';

/** The pill's words. */
export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = { high: 'high', medium: 'medium', low: 'low', new: 'new member' };

/** How sure the heuristic is: a busy session with a clear pattern is high; some activity medium; little low. */
export function confidenceOf(suggestion: Pick<TeamSuggestion, 'score' | 'evidence' | 'templateId'>): Exclude<Confidence, 'new'> {
  const { evidence } = suggestion;
  const pattern = evidence.loops + evidence.cliLoops > 0 || (evidence.editRatio !== null && (evidence.editRatio >= 0.5 || evidence.editRatio < 0.2));
  if (suggestion.score >= 100 && pattern) return 'high';
  if (suggestion.score >= 30) return 'medium';
  return 'low';
}

/** One "Why:" line from the evidence (the server's reason plus the counts). */
export function evidenceLine(suggestion: Pick<TeamSuggestion, 'reason' | 'evidence'>): string {
  const e = suggestion.evidence;
  const counts = [`${e.events7d} event${e.events7d === 1 ? '' : 's'} in 7 days`];
  if (e.loops > 0) counts.push(`${e.loops} Switchboard loop${e.loops === 1 ? '' : 's'}`);
  if (e.cliLoops > 0) counts.push(`${e.cliLoops} CLI loop${e.cliLoops === 1 ? '' : 's'}`);
  if (e.repos > 1) counts.push(`${e.repos} repos`);
  return `${suggestion.reason} (${counts.join(', ')})`;
}

/** Why an ordinary session is not suggested. */
export const TOO_LITTLE = 'too little activity to tell';

/** A session that is not suggested, and why. */
export interface NotSuggested {
  readonly sessionId: string;
  readonly title: string;
  readonly reason: string;
  /** It can still be adopted (Adopt anyway…). */
  readonly adoptable: boolean;
}

/** The fields of a session the split reads. */
export interface SessionLike {
  readonly id: string;
  readonly title: string;
  readonly hooked: boolean;
  readonly attached: boolean;
  /** A paired machine's name (`null` = this machine). */
  readonly machineName: string | null;
}

/**
 * The review's two lists: the suggestions (in the server's order, the dismissed ones
 * left out), and "Not suggested": the dismissed ones and the open sessions the server
 * left out: hooked, in a terminal, on another machine, or with too little activity to
 * tell (the server suggests only evidence that matches a template). Members are in neither.
 */
export function splitSuggestions(
  suggestions: readonly TeamSuggestion[],
  sessions: readonly SessionLike[],
  options: { readonly dismissed: ReadonlySet<string>; readonly members: ReadonlySet<string> },
): { readonly suggested: TeamSuggestion[]; readonly notSuggested: NotSuggested[] } {
  const suggested: TeamSuggestion[] = [];
  const notSuggested: NotSuggested[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    seen.add(suggestion.sessionId);
    if (options.members.has(suggestion.sessionId)) continue;
    if (options.dismissed.has(suggestion.sessionId)) notSuggested.push({ sessionId: suggestion.sessionId, title: suggestion.title, reason: 'Dismissed', adoptable: true });
    else suggested.push(suggestion);
  }
  for (const session of sessions) {
    if (seen.has(session.id) || options.members.has(session.id)) continue;
    if (session.hooked) notSuggested.push({ sessionId: session.id, title: session.title, reason: 'A hooked terminal session: continue it in Switchboard first', adoptable: false });
    else if (!session.attached) notSuggested.push({ sessionId: session.id, title: session.title, reason: 'It continues in a terminal: attach it here first', adoptable: false });
    else if (session.machineName) notSuggested.push({ sessionId: session.id, title: session.title, reason: `Runs on ${session.machineName}: its own machine suggests it`, adoptable: true });
    // The server suggests only sessions whose evidence matches a template's pattern; the rest carry too little signal.
    else notSuggested.push({ sessionId: session.id, title: session.title, reason: TOO_LITTLE, adoptable: true });
  }
  return { suggested, notSuggested };
}

/** Templates no suggestion and no member uses yet: offered as "new member" cards (Create…), at most `max`. */
export function newMemberTemplates(templates: readonly TeamTemplate[], suggested: readonly Pick<TeamSuggestion, 'templateId'>[], members: readonly Pick<TeamMember, 'templateId'>[], max = 2): TeamTemplate[] {
  const used = new Set<string>([...suggested.map((s) => s.templateId), ...members.flatMap((m) => (m.templateId ? [m.templateId] : []))]);
  return templates.filter((template) => !used.has(template.id)).slice(0, max);
}

/** The banner shows while there are suggestions that were not there when the developer chose "Later". */
export function bannerVisible(suggestionIds: readonly string[], laterIds: readonly string[] | null): boolean {
  if (suggestionIds.length === 0) return false;
  if (laterIds === null) return true;
  const later = new Set(laterIds);
  return suggestionIds.some((id) => !later.has(id));
}

/** The banner's text. */
export function bannerText(count: number): string {
  return `Switchboard found ${count} session${count === 1 ? '' : 's'} that look${count === 1 ? 's like a team member' : ' like team members'}. Adopting one moves it from your session list into Team; you can return it any time.`;
}

// ── the member form ──────────────────────────────────────────────────────

/** A template loop the form offers to create (kept = created in the new session). */
export interface FormLoop {
  readonly key: string;
  readonly label: string;
  readonly prompt: string;
  readonly cron?: string;
  readonly everyMinutes?: number;
  readonly kept: boolean;
}

/** The Adopt / Create / Settings form. */
export interface MemberForm {
  readonly name: string;
  readonly owns: string;
  readonly produces: string;
  readonly neverDoes: string;
  readonly templateId: string | null;
  readonly onHandoff: boolean;
  /** The session's Switchboard loops in the rhythm (adopt / settings), by id. */
  readonly loopIds: readonly string[];
  /** A template's suggested loops (create). */
  readonly templateLoops: readonly FormLoop[];
  readonly model: string;
  readonly effort: string;
  /** Whole % of the daily allowance, `''` = no budget. */
  readonly budget: string;
  readonly gates: readonly TeamGateKind[];
  /** Create: the saved folder the new session starts in (`''` = the default). */
  readonly folder: string;
}

/** An empty form. */
export const EMPTY_FORM: MemberForm = {
  name: '',
  owns: '',
  produces: '',
  neverDoes: '',
  templateId: null,
  onHandoff: true,
  loopIds: [],
  templateLoops: [],
  model: '',
  effort: '',
  budget: '',
  gates: [ALWAYS_ON_GATE, 'merge-default-branch'],
  folder: '',
};

/** A form filled from a template (create, or a suggestion that looks like it). */
export function formFromTemplate(template: TeamTemplate | null, name?: string): MemberForm {
  if (!template) return { ...EMPTY_FORM, name: name ?? '' };
  return {
    ...EMPTY_FORM,
    name: name ?? template.name,
    owns: template.charter.owns,
    produces: template.charter.produces,
    neverDoes: template.charter.neverDoes,
    templateId: template.id,
    onHandoff: template.rhythm.onHandoff,
    templateLoops: template.rhythm.loops.map((loop, index) => ({ key: `t${index}`, label: loop.label, prompt: loop.prompt, ...(loop.cron ? { cron: loop.cron } : {}), ...(loop.everyMinutes ? { everyMinutes: loop.everyMinutes } : {}), kept: true })),
    model: template.model.model ?? '',
    effort: template.model.effort ?? '',
    gates: [ALWAYS_ON_GATE, ...template.gates.filter((gate) => gate !== ALWAYS_ON_GATE)],
  };
}

/** A form filled from a suggestion: its template's defaults, the role named after the template, the drafted charter, its live loops in the rhythm. */
export function formFromSuggestion(suggestion: Pick<TeamSuggestion, 'templateId'>, template: TeamTemplate | null, draft: TeamCharter | null, loopIds: readonly string[]): MemberForm {
  const base = formFromTemplate(template);
  return { ...base, ...(draft ? { owns: draft.owns, produces: draft.produces, neverDoes: draft.neverDoes } : {}), templateId: template?.id ?? suggestion.templateId, templateLoops: [], loopIds };
}

/** A form showing a member's settings. */
export function formFromMember(member: TeamMember): MemberForm {
  return {
    ...EMPTY_FORM,
    name: member.name,
    owns: member.charter.owns,
    produces: member.charter.produces,
    neverDoes: member.charter.neverDoes,
    templateId: member.templateId,
    onHandoff: member.rhythm.onHandoff,
    loopIds: member.rhythm.loops.map((loop) => loop.loopId),
    model: member.model ?? '',
    effort: member.effort ?? '',
    budget: member.budget.dailyPct === null ? '' : String(member.budget.dailyPct),
    gates: [...member.gates],
  };
}

/** Toggles a gate (the always-on one stays). */
export function toggleGate(gates: readonly TeamGateKind[], gate: TeamGateKind): TeamGateKind[] {
  if (gate === ALWAYS_ON_GATE) return [...gates];
  const next = gates.includes(gate) ? gates.filter((g) => g !== gate) : [...gates, gate];
  return [ALWAYS_ON_GATE, ...GATE_KINDS.filter((kind) => kind !== ALWAYS_ON_GATE && next.includes(kind))];
}

/** The gate checkboxes' labels ("Anything outward-facing (always)"). */
export function gateCheckboxLabel(gate: TeamGateKind): string {
  const text = GATE_LABELS[gate];
  const cap = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return gate === ALWAYS_ON_GATE ? `${cap} (always)` : cap;
}

/** What the form would send, or the problems that keep it from being sent. */
export type FormCheck = { readonly ok: true; readonly body: Omit<MemberBody, 'sessionId' | 'session'> } | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** Checks the form and builds the body's member fields (the caller adds `sessionId` or `session`). */
export function formBody(form: MemberForm): FormCheck {
  const errors: Record<string, string> = {};
  const name = form.name.replace(/\s+/g, ' ').trim();
  if (name === '') errors['name'] = 'Name the role.';
  else if (name.length > TEAM_NAME_MAX) errors['name'] = `At most ${TEAM_NAME_MAX} characters.`;
  let dailyPct: number | null = null;
  if (form.budget.trim() !== '') {
    const pct = Number(form.budget.trim());
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) errors['budget'] = 'A whole % from 1 to 100, or empty for no budget.';
    else dailyPct = pct;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      charter: { owns: form.owns.trim(), produces: form.produces.trim(), neverDoes: form.neverDoes.trim() },
      templateId: form.templateId,
      rhythm: { loopIds: [...form.loopIds], onHandoff: form.onHandoff },
      budget: { dailyPct, profileId: null },
      gates: [...form.gates],
      model: form.model.trim() === '' ? null : form.model.trim(),
      effort: form.effort.trim() === '' ? null : form.effort.trim(),
    },
  };
}

/** The NewSession body of a created member's session (an empty first message; the folder, else the default). */
export function newMemberSession(form: Pick<MemberForm, 'folder'>): Record<string, unknown> {
  return { task: '', workType: 'feature', mode: 'single', solutions: [], phase: 'ui-first', coordination: 'none', qa: null, worktrees: false, ultracode: false, ...(form.folder ? { folder: form.folder } : {}) };
}

// ── the member menu ──────────────────────────────────────────────────────

/** One item of the member's ⋯ menu (`separator` draws a line before it). */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly separator?: boolean;
  readonly disabled?: boolean;
  /** `move`: the target machine. */
  readonly machineId?: string;
}

/** The member menu: Give a task…, Edit charter…, Model & effort…, Budget…, Schedule…, Pause / Resume, Move to <PC>…, then Return to sessions. */
export function memberMenu(member: Pick<TeamMember, 'paused' | 'status' | 'machineId'>, machines: readonly Pick<Machine, 'id' | 'name' | 'state'>[], selfId: string, returnPlace: string): MenuItem[] {
  const offline = member.status === 'offline';
  const items: MenuItem[] = [
    { id: 'task', label: 'Give a task…', disabled: offline },
    { id: 'charter', label: 'Edit charter…' },
    { id: 'model', label: 'Model & effort…' },
    { id: 'budget', label: 'Budget…' },
    { id: 'schedule', label: 'Schedule…', disabled: offline },
    member.paused ? { id: 'resume', label: '▶ Resume', disabled: offline } : { id: 'pause', label: '⏸ Pause', disabled: offline },
  ];
  // Every machine the member can move to: this one (when it runs elsewhere) and the paired ones it does not run on.
  const targets = [{ id: selfId, name: 'this machine', state: 'online' as const }, ...machines].filter((machine) => machine.id !== member.machineId);
  for (const target of targets) items.push({ id: 'move', label: `Move to ${target.name}…`, machineId: target.id, disabled: offline || target.state !== 'online' });
  items.push({ id: 'return', label: returnLabel(returnPlace), separator: true, disabled: offline });
  return items;
}

// ── Needs you ────────────────────────────────────────────────────────────

/** How a Needs-you item is answered in place. */
export type NeedsYouShape = 'question' | 'permission' | 'review' | 'request' | 'other';

/** The answer shape of an item. */
export function needsYouShape(item: Pick<TeamNeedsYouItem, 'source' | 'kind'>): NeedsYouShape {
  if (item.source === 'team') return 'request';
  if (item.kind === 'questions') return 'question';
  if (item.kind === 'permission') return 'permission';
  if (item.kind === 'review') return 'review';
  return 'other';
}

/** "09:12" for today, else "13 Oct" (the activity feed's time column). */
export function activityTime(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
