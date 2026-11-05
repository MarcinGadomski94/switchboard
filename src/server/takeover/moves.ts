import { parseRemoteId } from '../../core/peers.ts';
import {
  type MoveDetail,
  type MoveRecord,
  choicesOf,
  moveAgentKeys,
  moveAgentName,
  moveFailedDetail,
  moveFailedTitle,
  moveFromPeer,
  prunedMoves,
  runFields,
  viewMove,
} from '../../core/moves.ts';
import type { TakeoverRun } from '../../core/takeover.ts';
import type { Store } from '../db/store.ts';
import type { HubBus } from '../hub/bus.ts';
import type { SystemItemService } from '../inbox/system-items.ts';
import type { PeerService } from '../peers/service.ts';
import type { TakeoverRunMeta, TakeoverRunner } from './runner.ts';

/** The setting the moves are kept in across a restart (D154: no migration; at most `MOVE_KEEP_MAX` small records, finished ones for `MOVE_RETENTION_MS`). */
export const MOVES_SETTING = 'takeover.moves';

/** How often finished moves past the retention are dropped. */
const PRUNE_MS = 10 * 60_000;

/** A change of a step's detail only (the transfer's KB) is published at most this often per move. */
const DETAIL_PUBLISH_MS = 500;

/** A refusal of the moves routes. */
export class MovesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The crew member a session is (the moves list names it), from Team. */
export type MoveMemberLookup = (machineId: string, sessionId: string) => MoveRecord['member'];

/** Options of {@link MoveLog}. */
export interface MoveLogOptions {
  readonly runner: Pick<TakeoverRunner, 'subscribe' | 'get'>;
  readonly store: Pick<Store, 'settings' | 'sessions'>;
  readonly bus: HubBus;
  readonly peers: Pick<PeerService, 'self' | 'machines' | 'remoteMoves' | 'forward' | 'remoteSessions'>;
  readonly systemItems: Pick<SystemItemService, 'moveFailedNotice' | 'closeMoveFailedNotices'>;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*): this machine's moves list. It
 * follows every take-over this machine's runner drives (the agent's Move, Move here, a
 * teammate's move, each teammate of a crew move) and keeps one {@link MoveRecord} per
 * run: published as `/hub` `movesChanged` on every step change (a detail-only change at
 * most every 500 ms), kept in the setting `takeover.moves` (so they survive a restart;
 * a move that was running then is marked interrupted), finished ones for
 * 24 hours (`MOVE_RETENTION_MS`) or until dismissed. A move that fails raises a "Move failed"
 * Needs-you item; a later success of the same agent (here or on a paired machine) closes it.
 */
export class MoveLog {
  readonly #o: MoveLogOptions;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  /** Raw records (this machine's runs), by run id. */
  readonly #records = new Map<string, MoveRecord>();
  readonly #publishTimers = new Map<string, NodeJS.Timeout>();
  #members: MoveMemberLookup | null = null;
  #unsubscribe: Array<() => void> = [];
  #pruneTimer: NodeJS.Timeout | undefined;
  #saveTimer: NodeJS.Timeout | undefined;
  #saving: Promise<void> = Promise.resolve();
  /** One change at a time per move (the record's async parts: names, the item). */
  readonly #queues = new Map<string, Promise<void>>();
  #selfId: string | null = null;
  #started = false;
  #closed = false;

  constructor(options: MoveLogOptions) {
    this.#o = options;
    this.#onError = options.onError ?? ((error) => console.error('switchboard moves:', error));
    this.#now = options.now ?? Date.now;
  }

  /** Team (D100) hook: names the crew member a moved session is. */
  useMembers(lookup: MoveMemberLookup | null): void {
    this.#members = lookup;
  }

  /** Reads the kept moves (a running one is marked interrupted), then follows the runner and the paired machines' moves. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#selfId = (await this.#o.peers.self()).id;
    const stored = await this.#o.store.settings.get(MOVES_SETTING);
    const interrupted: MoveRecord[] = [];
    for (const value of Array.isArray(stored) ? stored : []) {
      const record = readRecord(value);
      if (!record) continue;
      if (record.state === 'running') {
        const step = record.step ?? { id: 'checks' as const, label: 'Checking both machines', detail: null };
        const ended = new Date(this.#now()).toISOString();
        const failed: MoveRecord = {
          ...record,
          state: 'failed',
          step,
          steps: record.steps.map((entry) => (entry.status === 'running' ? { ...entry, status: 'failed', detail: 'Switchboard restarted' } : entry)),
          error: { step: step.id, message: `Switchboard on this computer restarted during the move, so it stopped there; check where ${moveAgentName(record)} runs before trying again (what was started is undone the next time the agent is used, at the latest after 30 minutes)` },
          rolledBack: null,
          interrupted: true,
          endedAt: ended,
          updatedAt: ended,
        };
        this.#records.set(failed.id, failed);
        interrupted.push(failed);
      } else {
        this.#records.set(record.id, record);
      }
    }
    this.#prune(false);
    if (interrupted.length > 0) await this.#save();
    for (const record of interrupted) await this.#raiseFailed(record).catch((error: unknown) => this.#onError(error));
    this.#unsubscribe.push(this.#o.runner.subscribe((run, meta) => this.#onRun(run, meta)));
    this.#unsubscribe.push(
      this.#o.bus.subscribe((message) => {
        // A paired machine's move of the same agent succeeded: this machine's failure items for it close.
        if (message.name !== 'movesChanged' || !message.payload.move.machine || message.payload.move.state !== 'done') return;
        const move = message.payload.move;
        void this.#o.systemItems.closeMoveFailedNotices(moveAgentKeys(move), move.endedAt ?? new Date(this.#now()).toISOString(), 'moved').catch((error: unknown) => this.#onError(error));
      }),
    );
    this.#pruneTimer = setInterval(() => this.#prune(true), PRUNE_MS);
    this.#pruneTimer.unref();
  }

  /** Stops following; writes what is still waiting. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    clearInterval(this.#pruneTimer);
    for (const timer of this.#publishTimers.values()) clearTimeout(timer);
    this.#publishTimers.clear();
    await this.idle();
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      await this.#save();
    }
    await this.#saving;
  }

  /** Resolves once the changes in flight are done (tests). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()].map((run) => run.catch(() => undefined)));
  }

  async #self(): Promise<string> {
    this.#selfId ??= (await this.#o.peers.self()).id;
    return this.#selfId;
  }

  /**
   * `GET /api/moves`: this machine's moves (running first, then the newest), and, unless a
   * paired machine asks (it lists its own only: no chains), the paired machines' as last known.
   */
  async list(forPeer: boolean): Promise<MoveRecord[]> {
    const self = await this.#self();
    const own = prunedMoves([...this.#records.values()], this.#now()).map((record) => viewMove(record, self));
    if (forPeer) return own;
    return byRecency([...own, ...prunedMoves(this.#o.peers.remoteMoves(self), this.#now())]);
  }

  /** `GET /api/moves/{id}`: one move with the git commands (a paired machine's: asked there). */
  async get(id: string): Promise<MoveDetail> {
    const remote = parseRemoteId(id);
    if (remote) {
      const answer = await this.#o.peers.forward(remote.machineId, 'GET', `/api/moves/${encodeURIComponent(remote.id)}`, undefined);
      if (answer.status !== 200) throw refusal(answer);
      const machine = (await this.#o.peers.machines()).find((entry) => entry.id === remote.machineId);
      const mapped = moveFromPeer({ id: remote.machineId, name: machine?.name ?? remote.machineId, state: machine?.state ?? 'online' }, await this.#self(), answer.body);
      if (!mapped) throw new MovesError(502, 'peer-error', 'the other computer answered something that is not a move');
      const log = (answer.body as { log?: unknown }).log;
      return { ...mapped, log: Array.isArray(log) ? log.filter((line): line is string => typeof line === 'string') : [] };
    }
    const record = this.#records.get(id);
    if (!record) throw new MovesError(404, 'not-found', `no move ${id}`);
    return { ...viewMove(record, await this.#self()), log: this.#o.runner.get(id)?.log ?? [] };
  }

  /** `POST /api/moves/{id}/dismiss`: a finished move leaves the list (a running one is refused: 409). */
  async dismiss(id: string): Promise<void> {
    const remote = parseRemoteId(id);
    if (remote) {
      const answer = await this.#o.peers.forward(remote.machineId, 'POST', `/api/moves/${encodeURIComponent(remote.id)}/dismiss`, {});
      if (answer.status < 200 || answer.status >= 300) throw refusal(answer);
      return;
    }
    const record = this.#records.get(id);
    if (!record) throw new MovesError(404, 'not-found', `no move ${id}`);
    if (record.state === 'running') throw new MovesError(409, 'running', 'the move is still running: it can be dismissed once it ends');
    this.#records.delete(id);
    this.#publish(record, true);
    this.#saveSoon(true);
  }

  #onRun(run: TakeoverRun, meta: TakeoverRunMeta): void {
    if (this.#closed) return;
    this.#queue(run.id, () => this.#apply(run, meta));
  }

  async #apply(run: TakeoverRun, meta: TakeoverRunMeta): Promise<void> {
    const previous = this.#records.get(run.id) ?? null;
    const names = await this.#machineNames();
    const fields = runFields(run);
    const result = run.result ? (parseRemoteId(run.result.sessionId)?.id ?? run.result.sessionId) : null;
    const member = previous?.member ?? this.#members?.(meta.sourceMachineId, meta.rawSessionId) ?? null;
    const title = meta.title ?? (previous && previous.title !== '' ? previous.title : await this.#titleOf(meta));
    const now = new Date(this.#now()).toISOString();
    const record: MoveRecord = {
      id: run.id,
      kind: member ? 'teammate' : 'agent',
      title,
      member,
      source: { id: meta.sourceMachineId, name: names.get(meta.sourceMachineId) ?? 'the other computer', sessionId: meta.rawSessionId },
      target: { id: meta.targetMachineId, name: names.get(meta.targetMachineId) ?? 'the other computer', sessionId: result },
      agentSessionId: meta.rawSessionId,
      ...fields,
      startedAt: meta.startedAt,
      updatedAt: now,
      endedAt: run.state === 'running' ? null : (meta.endedAt ?? now),
      interrupted: false,
      choices: choicesOf(meta.request),
    };
    this.#records.set(record.id, record);
    const moved = previous === null || previous.state !== record.state || previous.step?.id !== record.step?.id || stepStatus(previous) !== stepStatus(record);
    this.#publish(record, false, !moved);
    this.#saveSoon(record.state !== 'running' && previous?.state !== record.state);
    if (record.state === 'failed' && previous?.state !== 'failed') await this.#raiseFailed(record);
    if (record.state === 'done' && previous?.state !== 'done') await this.#o.systemItems.closeMoveFailedNotices(moveAgentKeys(record), record.endedAt ?? now, 'moved');
  }

  /** The machines' names (this one's and the paired ones'). */
  async #machineNames(): Promise<Map<string, string>> {
    const self = await this.#o.peers.self();
    const names = new Map<string, string>([[self.id, self.name]]);
    for (const machine of await this.#o.peers.machines().catch(() => [])) names.set(machine.id, machine.name);
    return names;
  }

  /** The agent's title before the source described it: its session here, or its paired machine's as last known. */
  async #titleOf(meta: TakeoverRunMeta): Promise<string> {
    if (meta.sourceMachineId === (await this.#self())) {
      const session = await this.#o.store.sessions.get(meta.rawSessionId).catch(() => null);
      return session ? (session.title ?? '').trim() || session.name : 'the agent';
    }
    const remote = this.#o.peers.remoteSessions().find((session) => session.id === meta.request.sessionId);
    return remote ? (remote.title ?? '').trim() || remote.name : 'the agent';
  }

  async #raiseFailed(record: MoveRecord): Promise<void> {
    const self = await this.#self();
    const view = viewMove(record, self);
    await this.#o.systemItems.moveFailedNotice({
      moveId: record.id,
      title: moveFailedTitle(view),
      source: moveAgentName(view),
      detail: moveFailedDetail(view),
      // The item is on the agent when its session is this machine's (a peer's session has no local item link).
      sessionId: record.source.id === self ? record.source.sessionId : null,
      keys: moveAgentKeys(record),
      at: record.endedAt ?? record.updatedAt,
      move: { id: record.id, kind: record.kind, title: record.title, member: record.member, source: record.source, target: record.target, choices: record.choices },
    });
  }

  /** Publishes `movesChanged` now, or (a detail-only change) at most every {@link DETAIL_PUBLISH_MS}. */
  #publish(record: MoveRecord, removed: boolean, throttled = false): void {
    const send = (): void => {
      this.#publishTimers.delete(record.id);
      if (this.#closed) return;
      const now = removed ? record : this.#records.get(record.id);
      if (!now) return;
      void this.#self().then((self) => this.#o.bus.publish('movesChanged', { move: viewMove(now, self), ...(removed ? { removed: true } : {}) }));
    };
    if (throttled) {
      if (!this.#publishTimers.has(record.id)) {
        const timer = setTimeout(send, DETAIL_PUBLISH_MS);
        timer.unref();
        this.#publishTimers.set(record.id, timer);
      }
      return;
    }
    clearTimeout(this.#publishTimers.get(record.id));
    send();
  }

  /** Drops the finished moves past the retention (published as removed). */
  #prune(publish: boolean): void {
    const kept = new Set(prunedMoves([...this.#records.values()], this.#now()).map((record) => record.id));
    let changed = false;
    for (const record of [...this.#records.values()]) {
      if (kept.has(record.id)) continue;
      this.#records.delete(record.id);
      changed = true;
      if (publish) this.#publish(record, true);
    }
    if (changed && publish) this.#saveSoon(false);
  }

  #saveSoon(now: boolean): void {
    if (this.#closed && !now) return;
    if (now) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      void this.#save();
      return;
    }
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.#save();
    }, 1_000);
    this.#saveTimer.unref();
  }

  /** Writes the moves (one write at a time, the newest state). */
  #save(): Promise<void> {
    this.#saving = this.#saving
      .catch(() => undefined)
      .then(() => this.#o.store.settings.set(MOVES_SETTING, prunedMoves([...this.#records.values()], this.#now())))
      .catch((error: unknown) => this.#onError(error));
    return this.#saving;
  }

  #queue(id: string, work: () => Promise<void>): void {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(work)
      .catch((error: unknown) => this.#onError(error));
    this.#queues.set(id, run);
    void run.finally(() => {
      if (this.#queues.get(id) === run) this.#queues.delete(id);
    });
  }
}

/** The status of a record's current step (a change publishes at once). */
function stepStatus(record: MoveRecord): string | null {
  return record.step ? (record.steps.find((step) => step.id === record.step?.id)?.status ?? null) : null;
}

/** Running moves first (oldest started first), then the finished ones (newest ended first). */
function byRecency(records: readonly MoveRecord[]): MoveRecord[] {
  const running = records.filter((record) => record.state === 'running').sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const finished = records.filter((record) => record.state !== 'running').sort((a, b) => ((a.endedAt ?? a.updatedAt) < (b.endedAt ?? b.updatedAt) ? 1 : (a.endedAt ?? a.updatedAt) > (b.endedAt ?? b.updatedAt) ? -1 : 0));
  return [...running, ...finished];
}

/** A paired machine's refusal as a {@link MovesError}. */
function refusal(answer: { readonly status: number; readonly body: unknown }): MovesError {
  const body = (typeof answer.body === 'object' && answer.body !== null ? answer.body : {}) as { error?: unknown; message?: unknown };
  return new MovesError(answer.status >= 400 ? answer.status : 502, typeof body.error === 'string' ? body.error : 'peer-error', typeof body.message === 'string' ? body.message : `the other computer answered ${answer.status}`);
}

/** A kept record read back (anything malformed is dropped). */
function readRecord(value: unknown): MoveRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as MoveRecord;
  if (typeof record.id !== 'string' || typeof record.startedAt !== 'string' || !['running', 'done', 'failed'].includes(record.state)) return null;
  if (typeof record.source !== 'object' || record.source === null || typeof record.target !== 'object' || record.target === null) return null;
  return {
    ...record,
    steps: Array.isArray(record.steps) ? record.steps : [],
    rollbackNotes: Array.isArray(record.rollbackNotes) ? record.rollbackNotes : [],
    leftovers: Array.isArray(record.leftovers) ? record.leftovers : [],
    stashes: Array.isArray(record.stashes) ? record.stashes : [],
    interrupted: record.interrupted === true,
    choices: record.choices ?? { placement: null, clonePaths: {}, workspaceFiles: null, excludeRepos: [], stashTargets: [] },
  };
}

