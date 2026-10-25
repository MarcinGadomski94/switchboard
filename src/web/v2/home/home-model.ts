import type { ArtifactListItem, Folder, NewSimpleSession, SessionActivity, SessionListItem, SessionModelOption } from '../../../core/api.ts';
import type { SessionPr } from '../../../core/ci.ts';
import { ciChip } from '../../../core/ci.ts';
import { simpleShortName, simpleTitle } from '../../../core/simple-session.ts';
import { HOME_WORDS } from '../glossary.ts';
import type { NeedsItem } from '../shared/needs-you-model.ts';
import { type Speed, speedModel as sharedSpeedModel } from '../shared/speed.ts';

/**
 * D131 · Home's pure part (lane H; `README.md`): which agents are "Working now",
 * what is "Done today", the top of the Needs-you queue, the greeting and the
 * summary line, the start box's folder and its `POST /api/sessions` body.
 * DOM-free and unit-tested (`tests/web/v2-home.test.ts`); `index.tsx` renders it.
 */

// ── Working now ─────────────────────────────────────────────────────────

/** When an agent last did something (its last activity, else its start), as a number for sorting. */
function lastAt(session: Pick<SessionListItem, 'lastActivityAt' | 'createdAt'>): number {
  const at = Date.parse(session.lastActivityAt ?? session.createdAt);
  return Number.isFinite(at) ? at : 0;
}

/** Newest activity first; equal times keep the list's order. */
export function byRecentActivity<T extends Pick<SessionListItem, 'lastActivityAt' | 'createdAt'>>(a: T, b: T): number {
  return lastAt(b) - lastAt(a);
}

/**
 * The agents working now, on every computer (the list already merges the paired
 * ones): open, not a conversation, its turn running (`run`). Sorted by their most
 * recent activity. An agent on a computer that went offline keeps its card (greyed).
 */
export function workingNow(sessions: readonly SessionListItem[]): SessionListItem[] {
  return sessions.filter((session) => !session.closedAt && session.kind !== 'chat' && session.status === 'run').sort(byRecentActivity);
}

/** How many helpers (subagents, workflow agents) work for it now: the live activity's agents besides the main one. */
export function helpersOf(activity: SessionActivity | null): number {
  if (!activity) return 0;
  return Math.max(0, Object.keys(activity.agents).length - 1);
}

// ── Done today ────────────────────────────────────────────────────────

/** `true` when `iso` falls on the same local day as `now`. */
export function isToday(iso: string | null | undefined, now: number): boolean {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return false;
  const today = new Date(now);
  return at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
}

/** A row of "Done today": a finished agent (with its Ready-for-approval item, when it has one) or a new result. */
export type DoneRow =
  | { readonly type: 'agent'; readonly key: string; readonly at: string; readonly session: SessionListItem; readonly ready: NeedsItem | null }
  | { readonly type: 'result'; readonly key: string; readonly at: string; readonly artifact: ArtifactListItem };

/**
 * What got done today, newest first:
 * - agents (not conversations) that finished today (`done`, closed or not), and any
 *   agent active today whose work waits for approval (a `ready` item: a project
 *   step or a change request to Combine), with that item;
 * - results saved (or given a new version) today.
 */
export function doneToday(sessions: readonly SessionListItem[], artifacts: readonly ArtifactListItem[], items: readonly NeedsItem[], now: number): DoneRow[] {
  const readyOf = new Map<string, NeedsItem>();
  for (const item of items) {
    const id = item.agent?.sessionId;
    if (item.kind === 'ready' && id && !readyOf.has(id)) readyOf.set(id, item);
  }
  const rows: DoneRow[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id) || session.kind === 'chat') continue;
    const ready = readyOf.get(session.id) ?? null;
    const at = session.lastActivityAt ?? session.createdAt;
    if (!isToday(at, now)) continue;
    if (session.status !== 'done' && !ready) continue;
    seen.add(session.id);
    rows.push({ type: 'agent', key: `agent:${session.id}`, at, session, ready });
  }
  for (const artifact of artifacts) {
    if (!isToday(artifact.updatedAt, now)) continue;
    rows.push({ type: 'result', key: `result:${artifact.machine?.id ?? ''}:${artifact.id}`, at: artifact.updatedAt, artifact });
  }
  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}

/** How many Done-today rows show before "Show more". */
export const DONE_LIMIT = 5;

/** The automatic tests of an agent's change request in v2 words ("Change request #42 · automatic tests passed"), `null` without one. */
export function testsLine(prs: readonly SessionPr[] | null | undefined): { readonly text: string; readonly tone: 'green' | 'red' | 'grey' | 'violet' } | null {
  const chip = prs ? ciChip(prs) : null;
  if (!chip) return null;
  const pr = HOME_WORDS.changeRequest(chip.pr.number);
  switch (chip.state) {
    case 'failed':
      return { text: `${pr} · ${HOME_WORDS.testsFailed}`, tone: 'red' };
    case 'running':
      return { text: `${pr} · ${HOME_WORDS.testsRunning}`, tone: 'grey' };
    case 'merged':
      return { text: `${pr} · ${HOME_WORDS.combined}`, tone: 'violet' };
    default:
      return { text: `${pr} · ${HOME_WORDS.testsPassed}`, tone: 'green' };
  }
}

// ── Needs you (top N) ─────────────────────────────────────────────────

/** The first `limit` items of the queue (newest first, as the store keeps them), and how many wait in all. */
export function topNeeds(items: readonly NeedsItem[], limit: number): { readonly shown: readonly NeedsItem[]; readonly total: number; readonly more: boolean } {
  return { shown: items.slice(0, Math.max(0, limit)), total: items.length, more: items.length > limit };
}

/** Home shows this many cards on a computer, and on a phone (the prototype's 3 and 2). */
export const HOME_NEEDS_LIMIT = { wide: 3, phone: 2 } as const;

// ── Header ────────────────────────────────────────────────────────────

/** "Good morning" (5–11), "Good afternoon" (12–17), "Good evening" (18–4), by the local hour. */
export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour >= 5 && hour < 12) return HOME_WORDS.morning;
  if (hour >= 12 && hour < 18) return HOME_WORDS.afternoon;
  return HOME_WORDS.evening;
}

/** "Sunday 25 October" (the browser's language for the names). */
export function dateLine(now: number, locale?: string): string {
  const at = new Date(now);
  const weekday = at.toLocaleDateString(locale ?? 'en-GB', { weekday: 'long' });
  const month = at.toLocaleDateString(locale ?? 'en-GB', { month: 'long' });
  return `${weekday} ${at.getDate()} ${month}`;
}

/** "7 things need you", "1 thing needs you", "Nothing needs you". */
export function needsSummary(count: number): string {
  if (count <= 0) return HOME_WORDS.nothingNeedsYou;
  return count === 1 ? HOME_WORDS.oneNeedsYou : HOME_WORDS.manyNeedYou(count);
}

/** "2 working · 3 done today". */
export function workSummary(working: number, done: number): string {
  return `${working} ${HOME_WORDS.working} · ${done} ${HOME_WORDS.doneToday}`;
}

// ── The start box ──────────────────────────────────────────────────────

/** The start box's speed (Smart / Fast). */
export type { Speed } from '../shared/speed.ts';

/** The model each speed starts with (the CLI's aliases: `--model opus` / `--model sonnet`). */
export { SPEED_ALIAS as SPEED_MODEL } from '../shared/speed.ts';

/**
 * The model a speed starts with on a computer whose CLI reported `options`
 * (`GET /api/models`): the shared Smart / Fast mapping (`shared/speed.ts`).
 */
export function speedModel(speed: Speed, options: readonly Pick<SessionModelOption, 'value' | 'label'>[] | null): string | null {
  return sharedSpeedModel(speed, options);
}

/** Where this browser remembers the start box's last folder and speed (per computer: `<machine or "local">`). */
export const START_PREFS_KEY = 'switchboard.v2.home.start';

/** The start box's remembered choices. */
export interface StartPrefs {
  /** The last folder started in, per computer (`local` = this one). */
  readonly folders: Readonly<Record<string, string>>;
  readonly speed: Speed;
  /** The last computer (`null` = this one). */
  readonly machine: string | null;
}

/** The prefs as stored, or the defaults (Smart, this computer, no folder). */
export function readStartPrefs(raw: string | null): StartPrefs {
  try {
    const value = raw ? (JSON.parse(raw) as Partial<StartPrefs>) : {};
    const folders = value.folders && typeof value.folders === 'object' ? Object.fromEntries(Object.entries(value.folders).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    return { folders, speed: value.speed === 'fast' ? 'fast' : 'smart', machine: typeof value.machine === 'string' && value.machine ? value.machine : null };
  } catch {
    return { folders: {}, speed: 'smart', machine: null };
  }
}

/** The key of a computer in {@link StartPrefs.folders}. */
export function machineKey(machine: string | null): string {
  return machine ?? 'local';
}

/**
 * The folder the start box opens with: the one this browser last started in on
 * that computer (while it is still saved), else the saved folder a session last
 * started in, else the default folder, else the first; `null` with none saved.
 */
export function startFolder(folders: readonly Pick<Folder, 'id' | 'isDefault' | 'lastUsedAt'>[], remembered: string | null | undefined): string | null {
  if (remembered && folders.some((folder) => folder.id === remembered)) return remembered;
  let best: Pick<Folder, 'id' | 'lastUsedAt'> | null = null;
  for (const folder of folders) {
    if (!folder.lastUsedAt) continue;
    if (!best || (best.lastUsedAt ?? '') < folder.lastUsedAt) best = folder;
  }
  if (best) return best.id;
  return (folders.find((folder) => folder.isDefault) ?? folders[0])?.id ?? null;
}

/**
 * The `POST /api/sessions` body of a start from the box: the simple form's
 * (D56): the message as the task and the title it gives, a free short name, the
 * folder, no separate copy, and the speed's model ({@link speedModel}).
 */
export function startBody(text: string, folder: string | null, model: string | null, takenNames: readonly string[]): NewSimpleSession {
  const task = text.trim();
  const title = simpleTitle('', task);
  return {
    simple: true,
    name: simpleShortName('', task, takenNames),
    task,
    ...(folder ? { folder } : {}),
    worktrees: false,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
  };
}

/** `true` when the box can start (some words typed). */
export function canStartFrom(text: string): boolean {
  return text.trim().length > 0;
}
