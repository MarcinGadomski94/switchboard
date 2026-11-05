import { remoteId } from './peers.ts';
import { type MoveStash, stashNote } from './move-worktrees.ts';
import { type MoveOverwrite, overwriteNote } from './move-overwrite.ts';
import { type Leftover, type TakeoverRun, type TakeoverStepId, type TakeoverStepState, type TargetPlacement, TAKEOVER_STEP_LABELS } from './takeover.ts';
import type { WorkspaceFileChoice } from './workspace-move.ts';
import type { SourceCleanupReport } from './source-cleanup.ts';

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*): the moves list. Every take-over
 * a machine's runner drives (a session move, a teammate's move, each teammate of a
 * crew move) is one {@link MoveRecord} on that machine: active ones and recently
 * finished ones (kept {@link MOVE_RETENTION_MS}, or until dismissed). The UI reads the
 * merged list (`GET /api/moves`: this machine's and the paired machines'), follows it
 * live (`/hub` `movesChanged`), shows badges and a Home card, and reopens the move
 * dialog on a run from any tab, after a reload or on a phone. Pure; shared with the UI.
 */

/** How long a finished move stays listed (unless dismissed first). */
export const MOVE_RETENTION_MS = 24 * 60 * 60_000;

/** At most this many moves are kept per machine (the oldest finished ones go first). */
export const MOVE_KEEP_MAX = 50;

/** What the developer chose for a move (the take-over's request): what **Try again** opens the dialog with. */
export interface MoveChoices {
  /** D110 / D152: the chosen target folders; `null` = the target's saved folders (or the remembered ones). */
  readonly placement: TargetPlacement | null;
  readonly clonePaths: Readonly<Record<string, string>>;
  readonly workspaceFiles: WorkspaceFileChoice | null;
  readonly excludeRepos: readonly string[];
  readonly stashTargets: readonly string[];
  /** D157: the target checkouts whose diverged branch the developer confirmed overwriting (absent = none). */
  readonly overwriteTargets?: readonly string[];
  /** D156: clean up on the source after a successful move (absent = no). */
  readonly cleanupSource?: boolean;
}

/** One machine of a move, and the agent's session there (raw, as that machine knows it). */
export interface MoveEnd {
  readonly id: string;
  readonly name: string;
  /** The session on that machine: the source's always; the target's once it resumed there. */
  readonly sessionId: string | null;
}

/** A move as the moves list carries it (`GET /api/moves`, `movesChanged`). */
export interface MoveRecord {
  /** The take-over run's id; a paired machine's move: `r~<machine>~<id>`. */
  readonly id: string;
  /** The paired machine whose runner drives it; absent = this machine. */
  readonly machine?: { readonly id: string; readonly name: string; readonly state: string };
  /** `teammate` when the agent is a crew member (its move, or its crew's); D155: `chat` for a chat's move. */
  readonly kind: 'agent' | 'teammate' | 'chat';
  /** The agent's title (as the source names it). */
  readonly title: string;
  readonly member: { readonly id: string; readonly name: string; readonly teamId: string; readonly teamName: string } | null;
  readonly source: MoveEnd;
  readonly target: MoveEnd;
  /**
   * The agent's session as the machine that answers names it: the source's session
   * (a remote id when the source is another machine); after a successful move, the
   * new session on the target. Computed per machine ({@link viewMove}).
   */
  readonly agentSessionId: string;
  readonly state: TakeoverRun['state'];
  /** The step running now; a finished move: the step that failed (`null` when it succeeded). */
  readonly step: { readonly id: TakeoverStepId; readonly label: string; readonly detail: string | null } | null;
  readonly steps: readonly TakeoverStepState[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
  /** The failure: the step, the reason. */
  readonly error: { readonly step: TakeoverStepId; readonly message: string } | null;
  /** `true` = undone, `false` = the undo left something (`rollbackNotes`), `null` = nothing had changed. */
  readonly rolledBack: boolean | null;
  readonly rollbackNotes: readonly string[];
  /** Switchboard on the machine that drove it restarted while it ran (it never finished there). */
  readonly interrupted: boolean;
  readonly leftovers: ReadonlyArray<Leftover & { readonly machineId: string | null }>;
  readonly stashes: readonly MoveStash[];
  /** D157: branches the move overwrote on the target, each kept on its backup branch (absent from an older record). */
  readonly overwrites?: readonly MoveOverwrite[];
  readonly choices: MoveChoices;
  /** D156: the clean-up on the source after the move (what was removed, what is left to remove by hand); absent when not asked for. */
  readonly sourceCleanup?: SourceCleanupReport | null;
}

/** `GET /api/moves/{id}`: a move with the git commands both machines ran (while the runner still has them). */
export interface MoveDetail extends MoveRecord {
  readonly log: readonly string[];
}

/** The `movesChanged` payload: the move as it is now (`removed`: dismissed or past the retention). */
export interface MovesChanged {
  readonly move: MoveRecord;
  readonly removed?: boolean;
}

/** The short words of each step in a badge ("Moving to Desk… (copying the chat)"). */
export const MOVE_STEP_SHORT: Readonly<Record<TakeoverStepId, string>> = {
  checks: 'checking',
  stop: 'pausing the agent',
  capture: 'pushing its work',
  transfer: 'copying the chat',
  apply: 'restoring the code',
  resume: 'starting it there',
  finish: 'cleaning up',
};

/** The session id `viewer` uses for `rawId` on machine `machineId`. */
export function sessionIdFor(viewerId: string, machineId: string, rawId: string): string {
  return machineId === viewerId ? rawId : remoteId(machineId, rawId);
}

/** The keys that say "the same agent" across machines: its source session, and its member when it has one. */
export function moveAgentKeys(move: Pick<MoveRecord, 'source' | 'target' | 'member' | 'state'>): string[] {
  const keys: string[] = [];
  if (move.source.sessionId) keys.push(`session:${move.source.id}:${move.source.sessionId}`);
  if (move.state === 'done' && move.target.sessionId) keys.push(`session:${move.target.id}:${move.target.sessionId}`);
  if (move.member) keys.push(`member:${move.member.id}`);
  return keys;
}

/** `record` as machine `viewerId` shows it: the agent's session in its own addressing. */
export function viewMove<T extends MoveRecord>(record: T, viewerId: string): T {
  const done = record.state === 'done' && record.target.sessionId !== null;
  const agentSessionId = done ? sessionIdFor(viewerId, record.target.id, record.target.sessionId as string) : sessionIdFor(viewerId, record.source.id, record.source.sessionId ?? '');
  return { ...record, agentSessionId };
}

/**
 * A paired machine's move as this machine (`viewerId`) lists it: its id namespaced,
 * the machine tagged, its leftovers' machine named from here, the agent's session in
 * this machine's addressing. `null` for something that is not a move.
 */
export function moveFromPeer(machine: { readonly id: string; readonly name: string; readonly state: string }, viewerId: string, value: unknown): MoveRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as MoveRecord;
  if (typeof record.id !== 'string' || typeof record.source !== 'object' || record.source === null || typeof record.target !== 'object' || record.target === null) return null;
  const leftovers = (Array.isArray(record.leftovers) ? record.leftovers : []).map((leftover) => {
    const owner = leftover.machineId ?? machine.id;
    return { ...leftover, machineId: owner === viewerId ? null : owner };
  });
  const { machine: _theirs, ...rest } = record;
  return viewMove({ ...rest, id: remoteId(machine.id, record.id), machine: { id: machine.id, name: machine.name, state: machine.state }, leftovers, steps: Array.isArray(record.steps) ? record.steps : [], stashes: Array.isArray(record.stashes) ? record.stashes : [], overwrites: Array.isArray(record.overwrites) ? record.overwrites : [], rollbackNotes: Array.isArray(record.rollbackNotes) ? record.rollbackNotes : [] }, viewerId);
}

/** The moves still listed at `now`: running ones, and finished ones younger than {@link MOVE_RETENTION_MS}; at most {@link MOVE_KEEP_MAX} (newest first). */
export function prunedMoves<T extends Pick<MoveRecord, 'state' | 'endedAt' | 'startedAt'>>(records: readonly T[], now: number): T[] {
  const kept = records.filter((record) => record.state === 'running' || record.endedAt === null || now - Date.parse(record.endedAt) < MOVE_RETENTION_MS);
  const sorted = [...kept].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  const running = sorted.filter((record) => record.state === 'running');
  const finished = sorted.filter((record) => record.state !== 'running');
  return [...running, ...finished.slice(0, Math.max(0, MOVE_KEEP_MAX - running.length))];
}

/** "Moving to Desk… (copying the chat)". */
export function moveBadgeText(move: Pick<MoveRecord, 'target' | 'step' | 'state'>): string {
  const step = move.state === 'running' && move.step ? ` (${MOVE_STEP_SHORT[move.step.id] ?? move.step.label.toLowerCase()})` : '';
  return `Moving to ${move.target.name}…${step}`;
}

/** The agent's name in a move's texts: the teammate's name, else the agent's title. */
export function moveAgentName(move: Pick<MoveRecord, 'member' | 'title'>): string {
  return move.member?.name ?? move.title;
}

/** One line on how a move ended (or where it is). */
export function moveOutcomeText(move: Pick<MoveRecord, 'state' | 'step' | 'target' | 'source' | 'error' | 'rolledBack' | 'rollbackNotes' | 'interrupted' | 'member' | 'title'>): string {
  const name = moveAgentName(move);
  if (move.state === 'running') return moveBadgeText(move);
  if (move.state === 'done') return `${name} now runs on ${move.target.name}.`;
  const step = move.error ? TAKEOVER_STEP_LABELS[move.error.step] : 'The move';
  const reason = (move.error?.message ?? 'the move failed').replace(/[.\s]+$/, '');
  const undo = move.interrupted ? '' : move.rolledBack === false ? ` Undoing it left something behind: ${move.rollbackNotes.join('; ')}.` : move.rolledBack === true ? ' Everything was undone.' : '';
  return `${step} failed: ${reason}.${undo} ${name} still runs on ${move.source.name}.`;
}

/** The stash note of a move (D153: kept on the target; how to restore it), or `''`. */
export function moveStashText(stashes: readonly MoveStash[]): string {
  return stashes.map(stashNote).join(' ');
}

/** D157: the overwrite note of a move (the replaced commits are kept on a backup branch), or `''`. */
export function moveOverwriteText(overwrites: readonly MoveOverwrite[] | undefined): string {
  return (overwrites ?? []).map((entry) => `${overwriteNote(entry)}.`).join(' ');
}

/** The Needs-you item of a failed move: its title. */
export function moveFailedTitle(move: Pick<MoveRecord, 'member' | 'title' | 'target'>): string {
  return `Couldn’t move ${moveAgentName(move)} to ${move.target.name}`;
}

/** The Needs-you item of a failed move: the reason, the step, what was undone or left, the stash note. */
export function moveFailedDetail(move: Pick<MoveRecord, 'state' | 'step' | 'target' | 'source' | 'error' | 'rolledBack' | 'rollbackNotes' | 'interrupted' | 'member' | 'title' | 'leftovers' | 'stashes'> & Pick<Partial<MoveRecord>, 'overwrites'>): string {
  const parts = [moveOutcomeText(move)];
  if (move.leftovers.length > 0) parts.push(`${move.leftovers.length} temporary branch${move.leftovers.length === 1 ? ' is' : 'es are'} still on the remote: open the move to delete ${move.leftovers.length === 1 ? 'it' : 'them'}.`);
  const stash = moveStashText(move.stashes);
  if (stash) parts.push(stash);
  const overwritten = moveOverwriteText(move.overwrites);
  if (overwritten) parts.push(overwritten);
  return parts.join(' ');
}

/** What a run says now, as a record's fields (the server's {@link MoveRecord} without the identity). */
export function runFields(run: TakeoverRun): Pick<MoveRecord, 'state' | 'step' | 'steps' | 'error' | 'rolledBack' | 'rollbackNotes' | 'leftovers' | 'stashes' | 'overwrites' | 'sourceCleanup'> {
  const running = run.steps.find((step) => step.status === 'running') ?? null;
  const failed = run.error ? (run.steps.find((step) => step.id === run.error?.step) ?? null) : null;
  const current = run.state === 'running' ? (running ?? failed) : failed;
  return {
    state: run.state,
    step: current ? { id: current.id, label: current.label, detail: current.detail } : null,
    steps: run.steps.map((step) => ({ ...step })),
    error: run.error,
    rolledBack: run.rolledBack,
    rollbackNotes: [...run.rollbackNotes],
    leftovers: run.leftovers.map((leftover) => ({ ...leftover })),
    stashes: (run.stashes ?? []).map((stash) => ({ ...stash })),
    overwrites: (run.overwrites ?? []).map((entry) => ({ ...entry })),
    ...(run.sourceCleanup ? { sourceCleanup: run.sourceCleanup } : {}),
  };
}

/** The record as a take-over run (the dialog's progress view). */
export function moveAsRun(move: MoveRecord, log: readonly string[] = []): TakeoverRun {
  return {
    id: move.id,
    state: move.state,
    steps: move.steps,
    error: move.error,
    rolledBack: move.rolledBack,
    rollbackNotes: move.rollbackNotes,
    result: move.state === 'done' && move.target.sessionId ? { sessionId: move.agentSessionId, machineName: move.target.name, machineId: move.target.id, local: !move.agentSessionId.startsWith('r~') } : null,
    leftovers: move.leftovers,
    log,
    stashes: move.stashes,
    overwrites: move.overwrites ?? [],
    ...(move.sourceCleanup ? { sourceCleanup: move.sourceCleanup } : {}),
  };
}

// ── what the UI shows ────────────────────────────────────────────────────

/** The running move of an agent (its session as this machine names it), a teammate, or a crew; `null` when none. */
export function activeMove(moves: readonly MoveRecord[], of: { readonly sessionId?: string; readonly memberId?: string; readonly teamId?: string }): MoveRecord | null {
  return (
    moves.find((move) => {
      if (move.state !== 'running') return false;
      if (of.sessionId !== undefined && move.agentSessionId === of.sessionId) return true;
      if (of.memberId !== undefined && move.member?.id === of.memberId) return true;
      return of.teamId !== undefined && move.member?.teamId === of.teamId;
    }) ?? null
  );
}

/** A `movesChanged` applied to the list: the move replaced (or added first), a removed one dropped. */
export function applyMoveChange(moves: readonly MoveRecord[], change: { readonly move: MoveRecord; readonly removed?: boolean }): MoveRecord[] {
  const rest = moves.filter((move) => move.id !== change.move.id);
  if (change.removed) return rest;
  const at = moves.findIndex((move) => move.id === change.move.id);
  if (at < 0) return [change.move, ...rest];
  const out = [...moves];
  out[at] = change.move;
  return out;
}

/** Home's Moves card: the running moves (oldest first) and the finished ones (newest first). */
export function homeMoves(moves: readonly MoveRecord[], now: number): { readonly running: MoveRecord[]; readonly finished: MoveRecord[] } {
  const listed = moves.filter((move) => move.state === 'running' || move.endedAt === null || now - Date.parse(move.endedAt) < MOVE_RETENTION_MS);
  return {
    running: listed.filter((move) => move.state === 'running').sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0)),
    finished: listed.filter((move) => move.state !== 'running').sort((a, b) => ((a.endedAt ?? '') < (b.endedAt ?? '') ? 1 : (a.endedAt ?? '') > (b.endedAt ?? '') ? -1 : 0)),
  };
}

/** What a failed move's **Try again** reopens: the dialog for the same agent and computer, with the last choices. */
export interface MoveRetry {
  /** A teammate's move opens its Move to computer dialog; D155: a chat's its chat move dialog; any other agent the agent's Move dialog. */
  readonly kind: 'agent' | 'teammate' | 'chat';
  /** The agent's session as `viewerId` names it (it stayed on the source). */
  readonly sessionId: string;
  /** The target as the take-over request names it: `null` = this machine (a peer's agent comes here). */
  readonly targetMachine: string | null;
  /** The target's id (a teammate's move names it always). */
  readonly targetId: string;
  /** The other machine's name (the dialog's title). */
  readonly machineName: string;
  readonly title: string;
  readonly member: MoveRecord['member'];
  readonly choices: MoveChoices;
}

/** The {@link MoveRetry} of a failed move for machine `viewerId`. */
export function moveRetry(move: Pick<MoveRecord, 'kind' | 'source' | 'target' | 'title' | 'member' | 'choices'>, viewerId: string): MoveRetry {
  const here = move.target.id === viewerId;
  return {
    kind: move.kind,
    sessionId: sessionIdFor(viewerId, move.source.id, move.source.sessionId ?? ''),
    targetMachine: here ? null : move.target.id,
    targetId: move.target.id,
    machineName: here ? move.source.name : move.target.name,
    title: move.title,
    member: move.member,
    choices: move.choices,
  };
}

/** The choices of a take-over request (what a record keeps for Try again). */
export function choicesOf(request: { readonly placement?: TargetPlacement; readonly clonePaths?: Readonly<Record<string, string>>; readonly workspaceFiles?: WorkspaceFileChoice; readonly excludeRepos?: readonly string[]; readonly stashTargets?: readonly string[]; readonly overwriteTargets?: readonly string[]; readonly cleanupSource?: boolean }): MoveChoices {
  return {
    placement: request.placement ?? null,
    clonePaths: { ...(request.clonePaths ?? {}) },
    workspaceFiles: request.workspaceFiles ?? null,
    excludeRepos: [...(request.excludeRepos ?? [])],
    stashTargets: [...(request.stashTargets ?? [])],
    ...(request.overwriteTargets && request.overwriteTargets.length > 0 ? { overwriteTargets: [...request.overwriteTargets] } : {}),
    ...(request.cleanupSource === true ? { cleanupSource: true } : {}),
  };
}
