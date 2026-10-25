import type { TeamActivityRecord, TeamHandoff, TeamMember, TeamMemberStatus, TeamNeedsYouItem, TeamSummary } from '../../../core/team.ts';
import type { Machine } from '../../../core/peers.ts';
import { stripActor } from '../../team/activity.ts';
import { cardStatus, moveInOrder, needsYouCounts, restoredOrder, rhythmLine } from '../../team/model.ts';
import { CREW_WORDS, type V2Status, computerStateToV2, teammateStatusToV2 } from '../glossary.ts';

/**
 * D131 · lane P · the Crews pages' pure rules (a v2 "crew" is a team, D100; a "teammate" is a
 * member). DOM-free, unit-tested in `tests/web/v2-crews.test.ts`. The classic Team model keeps
 * the order and move rules (`src/web/team/model.ts`); this adds the v2 reading: a crew's
 * counts and computers, the reorder and Undo orders, the teammate's status and budget meter,
 * the deep link (`/crews/<id>?member=<id>&tab=access`) and the move-to-computer choices.
 */

// ── a crew ──────────────────────────────────────────────────────────────

/** A crew card's numbers and computers. */
export interface CrewStats {
  readonly members: number;
  readonly working: number;
  readonly needs: number;
  /** The computers its teammates run on (by name, in first-seen order), each with its local flag. */
  readonly computers: readonly { readonly name: string; readonly local: boolean }[];
}

/** A crew's counts from `GET /api/team/teams` (its roster). */
export function crewStats(crew: Pick<TeamSummary, 'members' | 'needsYou' | 'roster'>): CrewStats {
  const roster = crew.roster ?? [];
  const seen = new Map<string, boolean>();
  for (const entry of roster) if (!seen.has(entry.machineName)) seen.set(entry.machineName, entry.local);
  return {
    members: crew.members,
    working: roster.filter((entry) => entry.status === 'working').length,
    needs: crew.needsYou,
    computers: [...seen].map(([name, local]) => ({ name, local })),
  };
}

/** A crew's initials for its square avatar ("Acme Mobile" → "AM"). */
export function crewInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.map((word) => word[0] ?? '').join('').slice(0, 2) || '?').toUpperCase();
}

/** The crews in their order (the server answers them ordered; an optimistic order wins while it saves). */
export function orderedCrews<T extends { readonly id: string }>(crews: readonly T[], pending: readonly string[] | null): T[] {
  if (!pending) return [...crews];
  const at = new Map(pending.map((id, index) => [id, index]));
  return [...crews].sort((a, b) => (at.get(a.id) ?? pending.length) - (at.get(b.id) ?? pending.length));
}

/** The order after Move up (-1) / Move down (+1); `null` at the end it moves towards. */
export function moveCrew(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  return moveInOrder(ids, id, delta);
}

/** The order after dropping crew `dragged` onto crew `target` (it takes the target's place), `null` when nothing changes. */
export function dropCrew(ids: readonly string[], dragged: string, target: string): string[] | null {
  const from = ids.indexOf(dragged);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = ids.filter((id) => id !== dragged);
  next.splice(to, 0, dragged);
  return next;
}

/** Why Move up / Move down cannot be used (`null` = it can). */
export function moveCrewReason(ids: readonly string[], id: string, delta: -1 | 1): string | null {
  const at = ids.indexOf(id);
  if (delta < 0 && at === 0) return 'Already first.';
  if (delta > 0 && at === ids.length - 1) return 'Already last.';
  return null;
}

// ── a teammate ──────────────────────────────────────────────────────────

/** A teammate's v2 status: needs you also while Needs-you items of it wait (paused and offline win). */
export function teammateStatus(member: Pick<TeamMember, 'id' | 'status'>, items: readonly Pick<TeamNeedsYouItem, 'memberId'>[]): V2Status {
  const status: TeamMemberStatus = cardStatus(member, needsYouCounts(items as readonly TeamNeedsYouItem[]));
  return teammateStatusToV2(status);
}

/** The rhythm in plain words: "Picks up hand-offs · 2 routines", "On request". */
export function rhythmText(member: Pick<TeamMember, 'rhythm'>): string {
  const line = rhythmLine(member);
  if (line === 'no rhythm') return 'On request';
  return line.replace('on hand-off', 'Picks up hand-offs').replace(/(\d+) loops?/, (_all, n: string) => `${n} routine${n === '1' ? '' : 's'}`);
}

/** The budget meter: the share of its daily budget used today, and the words. */
export interface BudgetMeter {
  /** 0–100: how much of its own daily share is used (the bar's width). */
  readonly fill: number;
  readonly text: string;
  readonly over: boolean;
}

/** The meter of a teammate's budget (`null` = no budget set). */
export function budgetMeter(member: Pick<TeamMember, 'budget' | 'usedTodayPct'>): BudgetMeter | null {
  const daily = member.budget.dailyPct;
  if (daily === null) return null;
  const used = member.usedTodayPct;
  if (used === null) return { fill: 0, text: `${daily}% of the account a day`, over: false };
  const fill = daily <= 0 ? 100 : Math.min(100, Math.round((used / daily) * 100));
  return { fill, text: `${Math.round(used)}% of ${daily}% today`, over: used > daily };
}

/** Checks the budget field: a whole percentage 1–100, or empty for none. */
export function checkBudget(value: string): { readonly ok: true; readonly dailyPct: number | null } | { readonly ok: false; readonly message: string } {
  const text = value.trim().replace(/%$/, '');
  if (text === '') return { ok: true, dailyPct: null };
  const pct = Number(text);
  if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { ok: false, message: 'A whole percentage from 1 to 100, or empty for no budget.' };
  return { ok: true, dailyPct: pct };
}

// ── the deep link ───────────────────────────────────────────────────────

/** A teammate's tabs in its panel. */
export type TeammateTab = 'overview' | 'access';

/** `?member=<id>&tab=access` (Needs you's Add key) → which teammate and tab the crew page opens. */
export function crewQuery(search: string): { readonly member: string | null; readonly tab: TeammateTab } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const member = params.get('member');
  return { member: member && member.trim() !== '' ? member : null, tab: params.get('tab') === 'access' ? 'access' : 'overview' };
}

/** The address of a crew page with a teammate's tab open. */
export function crewHref(crewId: string, member: string | null = null, tab: TeammateTab = 'overview'): string {
  const base = `/crews/${encodeURIComponent(crewId)}`;
  if (!member) return base;
  return `${base}?member=${encodeURIComponent(member)}${tab === 'access' ? '&tab=access' : ''}`;
}

// ── moving ──────────────────────────────────────────────────────────────

/** The crew's order to save after Undo of a move (the member back in its old place), `null` when unchanged. */
export function undoOrder(before: readonly string[], current: readonly string[]): string[] | null {
  return restoredOrder(before, current);
}

/** One computer a teammate can move to. */
export interface ComputerChoice {
  readonly id: string;
  readonly name: string;
  readonly current: boolean;
  readonly state: 'online' | 'reconnecting' | 'offline';
  /** Why it cannot be picked, `null` = it can. */
  readonly disabledReason: string | null;
}

/**
 * The computers of the Move to computer… picker (D100's move, D65's take-over): this one and every
 * paired one; the teammate's own is marked current; an offline or reconnecting one is disabled
 * with the reason. `self` = this computer.
 */
export function computerChoices(member: Pick<TeamMember, 'machineId' | 'local' | 'status' | 'machineName'>, self: { readonly id: string; readonly name: string }, machines: readonly Pick<Machine, 'id' | 'name' | 'state'>[]): ComputerChoice[] {
  const list: ComputerChoice[] = [{ id: self.id, name: self.name, current: member.local, state: 'online', disabledReason: null }];
  for (const machine of machines) {
    const state = computerStateToV2(machine.state);
    list.push({ id: machine.id, name: machine.name, current: !member.local && machine.id === member.machineId, state, disabledReason: state === 'online' ? null : state === 'reconnecting' ? 'Reconnecting… can’t move there now.' : 'Offline · can’t move there now.' });
  }
  return list;
}

/** Why Move to computer… is off for this teammate (its computer is offline, or there is nowhere else), `null` = it can. */
export function moveComputerReason(member: Pick<TeamMember, 'status' | 'machineName'>, machines: readonly Pick<Machine, 'state'>[]): string | null {
  if (member.status === 'offline') return `${member.machineName} is offline; it can move once it reconnects.`;
  if (machines.length === 0) return 'Pair another computer first (Settings › Computers).';
  if (member.status === 'working') return 'It is working; it moves once its current reply is done.';
  return null;
}

// ── the lists ───────────────────────────────────────────────────────────

/** One row of the crew activity list. */
export interface ActivityRow {
  readonly id: string;
  readonly at: string;
  readonly who: string;
  readonly text: string;
}

/** The crew activity rows (newest first): the actor's name and the text without it. */
export function activityRows(activity: readonly TeamActivityRecord[], members: readonly Pick<TeamMember, 'id' | 'name'>[], limit = 30): ActivityRow[] {
  const names = new Map(members.map((member) => [member.id, member.name]));
  return activity.slice(0, limit).map((entry) => {
    const who = entry.memberId ? (names.get(entry.memberId) ?? 'A teammate') : 'Crew';
    return { id: entry.id, at: entry.at, who, text: stripActor(entry.text, who) };
  });
}

/** One hand-off row: from → to, the brief and its state. */
export interface HandoffRow {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly brief: string;
  readonly state: TeamHandoff['state'];
}

/** The crew's hand-offs (open and accepted first, then done; newest first). */
export function handoffRows(handoffs: readonly TeamHandoff[], members: readonly Pick<TeamMember, 'id' | 'name'>[]): HandoffRow[] {
  const names = new Map(members.map((member) => [member.id, member.name]));
  const rank = (state: TeamHandoff['state']): number => (state === 'open' || state === 'accepted' ? 0 : 1);
  return [...handoffs]
    .sort((a, b) => rank(a.state) - rank(b.state) || b.createdAt.localeCompare(a.createdAt))
    .map((handoff) => ({ id: handoff.id, from: handoff.fromMemberId ? (names.get(handoff.fromMemberId) ?? 'A teammate') : 'You', to: names.get(handoff.toMemberId) ?? 'A teammate', brief: handoff.brief, state: handoff.state }));
}

/** A crew's line: "3 teammates · 1 working". */
export function crewLine(stats: Pick<CrewStats, 'members' | 'working'>): string {
  return `${CREW_WORDS.teammates(stats.members)} · ${stats.working} ${CREW_WORDS.working}`;
}
