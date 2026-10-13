import { isClock } from './hlc.ts';
import { type TeamAccessRecord, readAccessRecord } from './team-access.ts';
import {
  ACTIVITY_CAP,
  ACTIVITY_KINDS,
  EMPTY_CHARTER,
  HANDOFF_STATES,
  NO_BUDGET,
  type TeamActivityRecord,
  type TeamHandoffRecord,
  type TeamMemberRecord,
  type TeamRecord,
  type TeamRequestRecord,
  isGateKind,
  normalizeGates,
  readBudget,
  readCharter,
} from './team.ts';

/**
 * D100 · Team sync between paired machines (`docs/team.md` → *Sync*; D48 / D71 /
 * D98 style). The team definition is shared, **last writer wins per record** by its
 * hybrid clock (`core/hlc.ts`): the team (name), members (charter, rhythm, budget,
 * gates, which machine), hand-offs and Team requests; the activity feed is a union
 * by id, capped. Removals travel as tombstones. Secrets are never part of it (the
 * T2 access entries carry names and machines only).
 *
 * Exchange: `POST /api/team/sync` with a {@link TeamSyncMessage}; the answer is the
 * other machine's message. Both sides merge.
 */

/** Wire version of the exchange. */
export const TEAM_SYNC_VERSION = 1;

/** The exchange's route (peer API allow-list). */
export const TEAM_SYNC_PATH = '/api/team/sync';

/** Everything one machine knows of its teams. */
export interface TeamSnapshot {
  readonly teams: readonly TeamRecord[];
  readonly members: readonly TeamMemberRecord[];
  readonly handoffs: readonly TeamHandoffRecord[];
  readonly requests: readonly TeamRequestRecord[];
  /** The newest {@link ACTIVITY_CAP} lines per team at most. */
  readonly activity: readonly TeamActivityRecord[];
  /** D100-T2: the access records (names, hosts, fields, keychain references and where they are set up; never a value). An older peer sends none. */
  readonly access: readonly TeamAccessRecord[];
}

/** One side of the exchange. */
export interface TeamSyncMessage {
  readonly v: number;
  readonly machine: { readonly id: string; readonly name: string };
  readonly snapshot: TeamSnapshot;
}

/** An empty snapshot. */
export const EMPTY_SNAPSHOT: TeamSnapshot = { teams: [], members: [], handoffs: [], requests: [], activity: [], access: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 10_000): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function strOrNull(value: unknown, max = 10_000): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function strings(value: unknown, max = 50): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length <= 2_000).slice(0, max) : [];
}

/** The synced fields; `null` when the record cannot be one. */
function base(value: unknown): { readonly id: string; readonly teamId: string; readonly clock: string; readonly deleted: boolean; readonly raw: Record<string, unknown> } | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 100);
  const teamId = str(value['teamId'], 100) ?? str(value['id'], 100);
  const clock = value['clock'];
  if (!id || !teamId || !isClock(clock)) return null;
  return { id, teamId, clock, deleted: value['deleted'] === true, raw: value };
}

/** A team from a peer (`null` when malformed). */
export function readTeamRecord(value: unknown): TeamRecord | null {
  const b = base(value);
  if (!b) return null;
  const name = str(b.raw['name'], 100);
  if (!name) return null;
  return { id: b.id, name, clock: b.clock, deleted: b.deleted, createdAt: str(b.raw['createdAt'], 40) ?? '', updatedAt: str(b.raw['updatedAt'], 40) ?? '' };
}

/** A member from a peer (`null` when malformed; unknown fields dropped, missing ones defaulted). */
export function readMemberRecord(value: unknown): TeamMemberRecord | null {
  const b = base(value);
  if (!b) return null;
  const r = b.raw;
  const name = str(r['name'], 100);
  const machineId = str(r['machineId'], 100);
  const sessionId = str(r['sessionId'], 200);
  if (!name || !machineId || !sessionId) return null;
  const rhythm = isRecord(r['rhythm']) ? r['rhythm'] : {};
  const loops = Array.isArray(rhythm['loops'])
    ? rhythm['loops'].filter(isRecord).map((l) => ({ loopId: str(l['loopId'], 100) ?? '', label: strOrNull(l['label'], 200), prompt: str(l['prompt']) ?? '', scheduleText: str(l['scheduleText'], 200) ?? '' })).filter((l) => l.loopId !== '')
    : [];
  const place = isRecord(r['originalPlace']) ? r['originalPlace'] : {};
  const placeKind = place['place'];
  return {
    id: b.id,
    teamId: b.teamId,
    clock: b.clock,
    deleted: b.deleted,
    name,
    charter: readCharter(r['charter']) ?? EMPTY_CHARTER,
    charterDraft: r['charterDraft'] === null || r['charterDraft'] === undefined ? null : readCharter(r['charterDraft']),
    templateId: strOrNull(r['templateId'], 100),
    machineId,
    sessionId,
    workplace: { folders: strings(isRecord(r['workplace']) ? r['workplace']['folders'] : [], 20) },
    provider: strOrNull(r['provider'], 40),
    model: strOrNull(r['model'], 200),
    effort: strOrNull(r['effort'], 40),
    rhythm: { loops, onHandoff: rhythm['onHandoff'] !== false },
    budget: readBudget(r['budget']) ?? NO_BUDGET,
    gates: normalizeGates(Array.isArray(r['gates']) ? r['gates'].filter(isGateKind) : []),
    paused: r['paused'] === true,
    pausedLoops: strings(r['pausedLoops']),
    pausedBy: r['pausedBy'] === 'developer' || r['pausedBy'] === 'budget' ? r['pausedBy'] : null,
    cliLoops: strings(r['cliLoops']),
    originalPlace: {
      place: placeKind === 'pinned' || placeKind === 'folder' || placeKind === 'loose' ? placeKind : 'none',
      folderId: strOrNull(place['folderId'], 100),
      index: typeof place['index'] === 'number' && Number.isInteger(place['index']) ? place['index'] : null,
    },
    access: Array.isArray(r['access'])
      ? r['access'].filter(isRecord).map((a) => ({ id: str(a['id'], 100) ?? '', name: str(a['name'], 200) ?? '', setUpOn: strings(a['setUpOn']) })).filter((a) => a.id !== '')
      : [],
    createdAt: str(r['createdAt'], 40) ?? '',
    updatedAt: str(r['updatedAt'], 40) ?? '',
  };
}

/** A hand-off from a peer (`null` when malformed). */
export function readHandoffRecord(value: unknown): TeamHandoffRecord | null {
  const b = base(value);
  if (!b) return null;
  const r = b.raw;
  const to = str(r['toMemberId'], 100);
  const state = r['state'];
  if (!to || !(HANDOFF_STATES as readonly unknown[]).includes(state)) return null;
  return {
    id: b.id,
    teamId: b.teamId,
    clock: b.clock,
    deleted: b.deleted,
    fromMemberId: strOrNull(r['fromMemberId'], 100),
    toMemberId: to,
    brief: str(r['brief']) ?? '',
    expected: str(r['expected']) ?? '',
    state: state as TeamHandoffRecord['state'],
    links: strings(r['links'], 20),
    todoId: strOrNull(r['todoId'], 100),
    notifiedAt: strOrNull(r['notifiedAt'], 40),
    planRef: strOrNull(r['planRef'], 200),
    createdAt: str(r['createdAt'], 40) ?? '',
    updatedAt: str(r['updatedAt'], 40) ?? '',
  };
}

/** A Team request from a peer (`null` when malformed). */
export function readRequestRecord(value: unknown): TeamRequestRecord | null {
  const b = base(value);
  if (!b) return null;
  const r = b.raw;
  const memberId = str(r['memberId'], 100);
  const kind = r['kind'];
  const state = r['state'];
  if (!memberId || (kind !== 'gate' && kind !== 'budget' && kind !== 'access') || !['open', 'approved', 'declined', 'dismissed'].includes(state as string)) return null;
  const action = isRecord(r['action']) ? r['action'] : null;
  let parsedAction: TeamRequestRecord['action'] = null;
  if (action?.['type'] === 'resume-member') parsedAction = { type: 'resume-member' };
  else if (action?.['type'] === 'external' && typeof action['ref'] === 'string') parsedAction = { type: 'external', ref: action['ref'] };
  return {
    id: b.id,
    teamId: b.teamId,
    clock: b.clock,
    deleted: b.deleted,
    memberId,
    kind,
    gate: isGateKind(r['gate']) ? r['gate'] : null,
    title: str(r['title'], 500) ?? '',
    detail: str(r['detail'], 4_000) ?? '',
    state: state as TeamRequestRecord['state'],
    action: parsedAction,
    note: strOrNull(r['note'], 4_000),
    createdAt: str(r['createdAt'], 40) ?? '',
    updatedAt: str(r['updatedAt'], 40) ?? '',
  };
}

/** An activity line from a peer (`null` when malformed). */
export function readActivityRecord(value: unknown): TeamActivityRecord | null {
  if (!isRecord(value)) return null;
  const id = str(value['id'], 100);
  const teamId = str(value['teamId'], 100);
  const at = str(value['at'], 40);
  const text = str(value['text'], 1_000);
  const kind = value['kind'];
  if (!id || !teamId || !at || text === null || !(ACTIVITY_KINDS as readonly unknown[]).includes(kind)) return null;
  return { id, teamId, at, kind: kind as TeamActivityRecord['kind'], memberId: strOrNull(value['memberId'], 100), text };
}

function list<T>(value: unknown, read: (item: unknown) => T | null, max: number): T[] {
  return Array.isArray(value) ? value.slice(0, max).map(read).filter((item): item is T => item !== null) : [];
}

/** A sync message (a request body or an answer); `null` when it is not one. */
export function readTeamSyncMessage(value: unknown): TeamSyncMessage | null {
  if (!isRecord(value) || typeof value['v'] !== 'number' || !isRecord(value['machine']) || !isRecord(value['snapshot'])) return null;
  const machine = value['machine'];
  const id = str(machine['id'], 100);
  if (!id) return null;
  const s = value['snapshot'];
  return {
    v: value['v'],
    machine: { id, name: str(machine['name'], 200) ?? id },
    snapshot: {
      teams: list(s['teams'], readTeamRecord, 20),
      members: list(s['members'], readMemberRecord, 500),
      handoffs: list(s['handoffs'], readHandoffRecord, 5_000),
      requests: list(s['requests'], readRequestRecord, 2_000),
      activity: list(s['activity'], readActivityRecord, ACTIVITY_CAP * 20),
      access: list(s['access'], readAccessRecord, 2_000),
    },
  };
}

/**
 * Last writer wins per record: the incoming records whose clock is later than the
 * local copy's (or that are not here yet). Equal clocks keep the local copy.
 */
export function newerRecords<T extends { readonly id: string; readonly clock: string }>(local: readonly T[], incoming: readonly T[]): T[] {
  const mine = new Map(local.map((record) => [record.id, record.clock]));
  return incoming.filter((record) => {
    const clock = mine.get(record.id);
    return clock === undefined || record.clock > clock;
  });
}

/** Activity lines of `incoming` not in `local` (by id). */
export function newActivity(local: readonly TeamActivityRecord[], incoming: readonly TeamActivityRecord[]): TeamActivityRecord[] {
  const ids = new Set(local.map((line) => line.id));
  return incoming.filter((line) => !ids.has(line.id));
}
