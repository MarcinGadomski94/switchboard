import { randomUUID } from 'node:crypto';
import { parseRemoteId, remoteId } from '../../core/peers.ts';
import {
  type CapturedRepo,
  type ConversationFile,
  type Leftover,
  type SourceInspect,
  type TakeoverPreview,
  type TargetDirListing,
  type TargetPlacement,
  type TakeoverRun,
  type TakeoverStepId,
  type TakeoverStepState,
  type TargetPlan,
  TAKEOVER_STEPS,
  TAKEOVER_STEP_LABELS,
  placementKey,
  placementToRemember,
  rollbackActions,
  runInProblem,
} from '../../core/takeover.ts';
import { type WorkspaceFileChoice, type WorkspaceFilesResult, fileChoiceProblem, filesToSend } from '../../core/workspace-move.ts';
import type { MoveStash } from '../../core/move-worktrees.ts';
import { type MoveOverwrite, overwriteNote } from '../../core/move-overwrite.ts';
import { effectiveExclusions } from '../../core/outside-repos.ts';
import type { SessionMove } from '../db/repos/sessions.ts';
import type { PeerService } from '../peers/service.ts';
import { MOVE_LOG_PREFIX, moveLogReason, moveOutcomeMessage } from '../../core/move-log.ts';
import { type MoveLogSink, SILENT_MOVE_LOG } from './move-log.ts';
import { type SourceCleanupReport, cleanupSummary, readCleanupReport } from '../../core/source-cleanup.ts';
import { type ChunkAnswer, type OpAnswer, type ResumeBody, TakeoverError, type TakeoverService } from './service.ts';

/**
 * D65 (`docs/peers.md` → *Taking a session over*): the **initiating** machine's
 * orchestration. The machine whose UI started the take-over drives both ends
 * through {@link TakeoverEndpoint}s: its own (direct calls) and the other's (the
 * peer API). Which end is the source follows from the session: a peer's session
 * (a remote id) is taken over **to this machine**; this machine's own session is
 * moved **to** the chosen peer. Order: checks → stop → capture (WIP push) →
 * conversation copy → restore the working tree → resume → close the old session
 * and clean up. A failure before the resume undoes everything (`rollbackActions`).
 */

/** The take-over operations of one machine, local or over the peer API. */
export interface TakeoverEndpoint {
  /** `null` for this machine. */
  readonly machineId: string | null;
  /** `opId`: the run the check belongs to (the move log); absent for the preview. */
  inspect(sessionId: string, opId?: string): Promise<OpAnswer<SourceInspect>>;
  stop(opId: string, sessionId: string): Promise<OpAnswer<{ readonly wasLive: boolean; readonly wasBusy: boolean }>>;
  /** `exclude`: D152 follow-up 2026-11-05, the source paths of repos the developer left out (not captured). */
  capture(opId: string, exclude?: readonly string[]): Promise<OpAnswer<{ readonly repos: readonly CapturedRepo[] }>>;
  stopTerminal(opId: string): Promise<OpAnswer<{ readonly pid: number | null; readonly how: string }>>;
  files(opId: string): Promise<OpAnswer<{ readonly kind: string; readonly files: readonly ConversationFile[] }>>;
  readChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer>;
  /** D152: the workspace files this take-over sends (re-read and checked on the source). */
  workspaceFiles(opId: string, names: readonly string[]): Promise<OpAnswer<{ readonly files: ReadonlyArray<{ readonly name: string; readonly size: number; readonly sha256: string | null; readonly secret: boolean }> }>>;
  readWorkspaceChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer>;
  receiveWorkspaceChunk(input: { readonly opId: string; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string; readonly secret: boolean; readonly confirmed: boolean }): Promise<unknown>;
  finish(opId: string, move: SessionMove, stillThere: readonly string[]): Promise<OpAnswer<{ readonly leftovers: readonly Leftover[]; readonly closeError: string | null }>>;
  rollbackSource(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>>;
  /** D156: the source's clean-up after a successful move (an older source answers 403 / 404). */
  cleanupSource(opId: string, sessionId: string): Promise<OpAnswer<SourceCleanupReport>>;
  plan(body: { readonly source: SourceInspect; readonly clonePaths?: Readonly<Record<string, string>>; readonly placement?: TargetPlacement; readonly stashTargets?: readonly string[]; readonly overwriteTargets?: readonly string[]; readonly opId?: string }): Promise<OpAnswer<TargetPlan>>;
  /** D110: the target's folder picker listing (`null` = the starting places). */
  listFolders(path: string | null): Promise<TargetDirListing>;
  receiveChunk(input: { readonly opId: string; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<unknown>;
  apply(body: { readonly opId: string; readonly source: SourceInspect; readonly clonePaths?: Readonly<Record<string, string>>; readonly placement?: TargetPlacement; readonly stashTargets?: readonly string[]; readonly overwriteTargets?: readonly string[]; readonly captured: readonly CapturedRepo[] }): Promise<OpAnswer<{ readonly place: { readonly cwd: string }; readonly changes: readonly unknown[]; readonly applied: ReadonlyArray<{ readonly key: string; readonly tempDeleted: boolean; readonly tempDeleteError: string | null }>; readonly workspaceFiles?: WorkspaceFilesResult | null; readonly stashes?: readonly MoveStash[]; readonly overwrites?: readonly MoveOverwrite[] }>>;
  abort(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[]; readonly stashes?: readonly MoveStash[]; readonly overwrites?: readonly MoveOverwrite[] }>>;
  resume(body: ResumeBody): Promise<OpAnswer<{ readonly sessionId: string; readonly name: string; readonly note: string | null }>>;
  closeTarget(opId: string): Promise<void>;
}

/** This machine's endpoint: direct calls. */
export function localEndpoint(service: TakeoverService): TakeoverEndpoint {
  return {
    machineId: null,
    inspect: (sessionId, opId) => service.inspect(sessionId, opId),
    stop: (opId, sessionId) => service.stop(opId, sessionId),
    capture: (opId, exclude) => service.capture(opId, exclude ?? []),
    stopTerminal: (opId) => service.stopTerminal(opId),
    files: (opId) => service.files(opId),
    readChunk: (opId, name, offset) => service.readChunk(opId, name, offset),
    workspaceFiles: (opId, names) => service.workspaceFiles(opId, names),
    readWorkspaceChunk: (opId, name, offset) => service.readWorkspaceChunk(opId, name, offset),
    receiveWorkspaceChunk: (input) => service.receiveWorkspaceChunk(input),
    finish: (opId, move, stillThere) => service.finish(opId, move, stillThere),
    rollbackSource: (opId) => service.rollbackSource(opId),
    cleanupSource: (opId, sessionId) => service.cleanupAfterMove(opId, sessionId),
    plan: (body) => service.plan(body),
    listFolders: (path) => service.listTargetFolders(path),
    receiveChunk: (input) => service.receiveChunk(input),
    apply: (body) => service.apply(body),
    abort: (opId) => service.abort(opId),
    resume: (body) => service.resume(body),
    closeTarget: (opId) => service.closeTarget(opId),
  };
}

/** A paired machine's endpoint: the same operations through its peer API (`/api/takeover/*`). */
export function peerEndpoint(peers: PeerService, machineId: string): TakeoverEndpoint {
  const call = async <T>(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<T> => {
    const answer = await peers.forward(machineId, method, `/api/takeover${route}`, body);
    if (answer.status < 200 || answer.status >= 300) {
      const failure = (typeof answer.body === 'object' && answer.body !== null ? answer.body : {}) as { error?: unknown; message?: unknown };
      throw new TakeoverError(answer.status, typeof failure.error === 'string' ? failure.error : 'peer-error', typeof failure.message === 'string' ? failure.message : `the other machine answered ${answer.status}`);
    }
    return answer.body as T;
  };
  return {
    machineId,
    inspect: (sessionId, opId) => call('POST', '/source/inspect', opId ? { sessionId, opId } : { sessionId }),
    stop: (opId, sessionId) => call('POST', '/source/stop', { opId, sessionId }),
    capture: (opId, exclude) => call('POST', '/source/capture', { opId, ...(exclude && exclude.length > 0 ? { excludeRepos: exclude } : {}) }),
    stopTerminal: (opId) => call('POST', '/source/stop-terminal', { opId }),
    files: (opId) => call('POST', '/source/files', { opId }),
    readChunk: (opId, name, offset) => call('POST', '/source/chunk', { opId, name, offset }),
    workspaceFiles: (opId, names) => call('POST', '/source/workspace-files', { opId, names }),
    readWorkspaceChunk: (opId, name, offset) => call('POST', '/source/workspace-chunk', { opId, name, offset }),
    receiveWorkspaceChunk: (input) => call('POST', '/target/workspace-chunk', input),
    finish: (opId, move, stillThere) => call('POST', '/source/finish', { opId, move, stillThere }),
    rollbackSource: (opId) => call('POST', '/source/rollback', { opId }),
    cleanupSource: (opId, sessionId) => call('POST', '/source/cleanup', { opId, sessionId }),
    plan: (body) => call('POST', '/target/plan', body),
    listFolders: (path) => call('POST', '/target/folders', path === null ? {} : { path }),
    receiveChunk: (input) => call('POST', '/target/chunk', input),
    apply: (body) => call('POST', '/target/apply', body),
    abort: (opId) => call('POST', '/target/abort', { opId }),
    resume: (body) => call('POST', '/target/resume', body),
    closeTarget: async (opId) => {
      await call('POST', '/target/close', { opId });
    },
  };
}

/** What starts a take-over. */
export interface TakeoverRequest {
  /** A local id (moved to `targetMachine`) or a peer's remote id (taken over to this machine). */
  readonly sessionId: string;
  /** The paired machine a local session goes to; absent for a peer's session (it comes here). */
  readonly targetMachine?: string | null;
  readonly clonePaths?: Readonly<Record<string, string>>;
  /** D110: the target folders the developer chose; absent = the remembered ones, else the target's saved folders. */
  readonly placement?: TargetPlacement;
  /** D110: the developer cleared the chosen folders: the target's saved folders, not the remembered ones. */
  readonly savedFolders?: boolean;
  /** The developer confirmed that a hooked terminal's `claude` is stopped. */
  readonly confirmStopTerminal?: boolean;
  /** D152: the workspace's own files to copy (absent: none, except the root AGENTS.md of a workspace root the move creates). */
  readonly workspaceFiles?: WorkspaceFileChoice;
  /**
   * D152 follow-up 2026-11-05: the source paths of repos the developer left out of
   * the move (absent: every listed repo is carried, the default, read-only ones too).
   */
  readonly excludeRepos?: readonly string[];
  /**
   * D153: the target checkouts whose uncommitted changes the developer confirmed
   * stashing ("Stash them on <PC>"); absent = none (a dirty checkout blocks).
   */
  readonly stashTargets?: readonly string[];
  /**
   * D157: the target checkouts whose diverged branch the developer confirmed
   * overwriting ("Overwrite them on <PC> (keep a backup branch)"); absent = none
   * (a diverged branch blocks).
   */
  readonly overwriteTargets?: readonly string[];
  /** D156: clean up on the source after a successful move (archive, carried worktrees, the conversation file); absent = no. */
  readonly cleanupSource?: boolean;
  /**
   * The move log's start line (`docs/peers.md` → *The move log*): the Team member a
   * Team move moves, and the crew move it is part of. Set by Team, never by the HTTP route.
   */
  readonly context?: MoveContext;
}

/** What a take-over moves on behalf of, for the move log. */
export interface MoveContext {
  readonly member?: { readonly id: string; readonly name: string };
  readonly crew?: { readonly id: string; readonly name: string; readonly run: string };
}

/** Both ends of a take-over. */
interface Ends {
  readonly source: TakeoverEndpoint;
  readonly target: TakeoverEndpoint;
  /** The session's id on the source (raw). */
  readonly rawSessionId: string;
  /** The peer's machine id, `null` when ... never both ends local. */
  readonly peerId: string;
}

/** Options of {@link TakeoverRunner}. */
export interface TakeoverRunnerOptions {
  readonly service: TakeoverService;
  readonly peers: PeerService;
  readonly onError?: (error: unknown) => void;
  /** The move log's run lines (start, outcome) on this, the initiating, machine; the steps are the services'. Absent: none. */
  readonly log?: MoveLogSink;
}

/** Marks every run's state for the dialog's poll. */
interface RunState {
  id: string;
  state: TakeoverRun['state'];
  steps: TakeoverStepState[];
  error: TakeoverRun['error'];
  rolledBack: boolean | null;
  rollbackNotes: string[];
  result: TakeoverRun['result'];
  leftovers: Array<Leftover & { machineId: string | null }>;
  log: string[];
  sessionKey: string;
  workspaceFiles: WorkspaceFilesResult | null;
  /** D153: stashes the move made on the target (kept, also after an undo). */
  stashes: MoveStash[];
  /** D157: branches the move overwrote on the target (their backup branches are kept, also after an undo). */
  overwrites: MoveOverwrite[];
  /** D156: the source's clean-up after the move (`null`: not asked for, or not yet). */
  sourceCleanup: SourceCleanupReport | null;
  /** D154: who started it and between which machines (the moves list). */
  meta: TakeoverRunMeta;
}

/**
 * D154 (`docs/peers.md` → *Following a move (D154)*): what the moves list needs of a run
 * besides its state: the request (Try again's choices), both machines and the agent.
 */
export interface TakeoverRunMeta {
  readonly request: TakeoverRequest;
  readonly sourceMachineId: string;
  readonly targetMachineId: string;
  /** The session on the source (raw). */
  readonly rawSessionId: string;
  /** The agent's title once the source described it (`null` before the checks read it). */
  title: string | null;
  readonly startedAt: string;
  endedAt: string | null;
}

/** D154: a run changed (a step, its detail, its end). */
export type TakeoverRunListener = (run: TakeoverRun, meta: TakeoverRunMeta) => void;

/** The initiating machine's take-over runner (`docs/peers.md` → *Taking a session over*). */
export class TakeoverRunner {
  readonly #service: TakeoverService;
  readonly #peers: PeerService;
  readonly #onError: (error: unknown) => void;
  readonly #log: MoveLogSink;
  readonly #runs = new Map<string, RunState>();
  readonly #listeners = new Set<TakeoverRunListener>();

  constructor(options: TakeoverRunnerOptions) {
    this.#service = options.service;
    this.#peers = options.peers;
    this.#onError = options.onError ?? ((error) => console.error('switchboard take-over:', error));
    this.#log = options.log ?? SILENT_MOVE_LOG;
  }

  async #ends(request: TakeoverRequest): Promise<Ends> {
    const self = await this.#peers.self();
    const remote = parseRemoteId(request.sessionId);
    if (remote) {
      if (request.targetMachine && request.targetMachine !== self.id) throw new TakeoverError(422, 'invalid', "a peer's session can only be taken over to this machine");
      if (!this.#peers.hasMachine(remote.machineId)) throw new TakeoverError(404, 'not-found', `no paired machine ${remote.machineId}`);
      return { source: peerEndpoint(this.#peers, remote.machineId), target: localEndpoint(this.#service), rawSessionId: remote.id, peerId: remote.machineId };
    }
    const to = request.targetMachine;
    if (typeof to !== 'string' || to === '') throw new TakeoverError(422, 'invalid', 'a session of this machine needs a targetMachine to move to');
    if (to === self.id) throw new TakeoverError(422, 'invalid', 'the session runs on this machine already');
    if (!this.#peers.hasMachine(to)) throw new TakeoverError(404, 'not-found', `no paired machine ${to}`);
    return { source: localEndpoint(this.#service), target: peerEndpoint(this.#peers, to), rawSessionId: request.sessionId, peerId: to };
  }

  /** D110: the key the target folders of a move are remembered under (on this, the initiating, machine). */
  async #placementKey(ends: Ends, source: SourceInspect): Promise<string> {
    const self = await this.#peers.self();
    const targetId = ends.target.machineId ?? self.id;
    return placementKey(source.machine.id, source.folder?.path ?? source.cwd ?? '', targetId);
  }

  /**
   * What the dialog shows before anything changes: both machines' view of the
   * take-over. D110: with no `placement` in the request, the one remembered from
   * the last move of this folder to that machine is used (and said so).
   */
  async preview(request: TakeoverRequest): Promise<TakeoverPreview> {
    const ends = await this.#ends(request);
    const source = (await ends.source.inspect(ends.rawSessionId)).result;
    let placement = request.placement ?? null;
    let remembered = false;
    if (placement === null && request.savedFolders !== true) {
      placement = await this.#service.rememberedPlacement(await this.#placementKey(ends, source));
      remembered = placement !== null;
    }
    // D152 follow-up: a repo outside the workspace is left out by its default or the developer's choice (`placement.outsideCarry`).
    const carried = withoutExcluded(source, effectiveExclusions(source.repos, request.excludeRepos, placement?.outsideCarry));
    const target = (await ends.target.plan({ source: carried, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}), ...(placement ? { placement } : {}), ...stashOf(request) })).result;
    const blockers = [...source.blockers, ...target.blockers, ...excludedProblem(source, carried)];
    // D152 follow-up (*Where it runs*): a target that did not honour the repo to run in (an older Switchboard) is refused up front.
    const runIn = runInProblem(placement, target);
    if (runIn !== null) blockers.push(runIn);
    // D152: the ticked workspace files (a secret needs the confirmation, the caps hold); none when the agent runs in a repo there.
    const files = fileChoiceProblem(source.workspaceFiles, filesToSend(source.workspaceFiles, placement?.runIn ? undefined : request.workspaceFiles, target.workspaceFiles, createsRoot(target)));
    if (files !== null) blockers.push(files);
    const excluded = source.repos.filter((repo) => !carried.repos.includes(repo)).map((repo) => repo.path);
    return { source, target, stopsTerminal: source.hooked, ok: blockers.length === 0, blockers, placement, remembered, excluded };
  }

  /** D110: the target machine's folder listing for the dialog's picker (`docs/peers.md` → *Target folders and verification*). */
  async listTargetFolders(machine: string | null, path: string | null): Promise<TargetDirListing> {
    const self = await this.#peers.self();
    if (machine === null || machine === self.id) return localEndpoint(this.#service).listFolders(path);
    if (!this.#peers.hasMachine(machine)) throw new TakeoverError(404, 'not-found', `no paired machine ${machine}`);
    return peerEndpoint(this.#peers, machine).listFolders(path);
  }

  /** Starts a take-over and returns its run at once; the dialog polls {@link get}. */
  async start(request: TakeoverRequest): Promise<TakeoverRun> {
    const ends = await this.#ends(request);
    const selfId = (await this.#peers.self()).id;
    for (const run of this.#runs.values()) {
      if (run.state === 'running' && run.sessionKey === request.sessionId) throw new TakeoverError(409, 'in-progress', 'this session is being taken over already');
    }
    const run: RunState = {
      id: randomUUID(),
      state: 'running',
      steps: TAKEOVER_STEPS.map((id) => ({ id, label: TAKEOVER_STEP_LABELS[id], status: 'pending', detail: null })),
      error: null,
      rolledBack: null,
      rollbackNotes: [],
      result: null,
      leftovers: [],
      log: [],
      sessionKey: request.sessionId,
      workspaceFiles: null,
      stashes: [],
      overwrites: [],
      sourceCleanup: null,
      meta: { request, sourceMachineId: ends.source.machineId ?? selfId, targetMachineId: ends.target.machineId ?? selfId, rawSessionId: ends.rawSessionId, title: null, startedAt: new Date().toISOString(), endedAt: null },
    };
    this.#runs.set(run.id, run);
    this.#notify(run);
    while (this.#runs.size > 20) {
      const oldest = [...this.#runs.values()].find((entry) => entry.state !== 'running');
      if (!oldest) break;
      this.#runs.delete(oldest.id);
    }
    void this.#execute(run, ends, request).catch((error: unknown) => this.#onError(error));
    return this.#view(run);
  }

  /** D154: follows every run's changes (the moves list); returns the unsubscribe. */
  subscribe(listener: TakeoverRunListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(run: RunState): void {
    if (this.#listeners.size === 0) return;
    const view = this.#view(run);
    for (const listener of [...this.#listeners]) {
      try {
        listener(view, run.meta);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** A run as the dialog polls it. */
  get(id: string): TakeoverRun | null {
    const run = this.#runs.get(id);
    return run ? this.#view(run) : null;
  }

  #view(run: RunState): TakeoverRun {
    return {
      id: run.id,
      state: run.state,
      steps: run.steps.map((step) => ({ ...step })),
      error: run.error,
      rolledBack: run.rolledBack,
      rollbackNotes: [...run.rollbackNotes],
      result: run.result,
      leftovers: run.leftovers.map((entry) => ({ ...entry })),
      log: [...run.log],
      workspaceFiles: run.workspaceFiles,
      stashes: run.stashes.map((stash) => ({ ...stash })),
      overwrites: run.overwrites.map((entry) => ({ ...entry })),
      ...(run.sourceCleanup ? { sourceCleanup: run.sourceCleanup } : {}),
    };
  }

  async #execute(run: RunState, ends: Ends, request: TakeoverRequest): Promise<void> {
    const opId = run.id;
    const { source, target } = ends;
    const self = await this.#peers.self();
    const sourceName = (): string => sourceInfo?.machine.name ?? 'the source';
    let sourceInfo: SourceInspect | null = null;
    let plan: TargetPlan | null = null;
    let captured: readonly CapturedRepo[] = [];
    let files: readonly ConversationFile[] = [];
    let stoppedLive = false;
    let terminalStopped = false;
    const done: TakeoverStepId[] = [];
    const logOf = (who: string, lines: readonly string[]): void => {
      for (const line of lines) run.log.push(`[${who}] ${line}`);
    };
    const step = (id: TakeoverStepId): TakeoverStepState => run.steps.find((entry) => entry.id === id) as TakeoverStepState;
    const set = (id: TakeoverStepId, status: TakeoverStepState['status'], detail: string | null = null): void => {
      const current = step(id);
      run.steps[run.steps.indexOf(current)] = { ...current, status, detail: detail ?? current.detail };
      this.#notify(run);
    };
    let failedAt: TakeoverStepId = 'checks';
    const started = Date.now();
    await this.#logStart(run, ends, request, self).catch((error: unknown) => this.#onError(error));
    try {
      // 1 · checks on both sides.
      failedAt = 'checks';
      set('checks', 'running');
      const inspected = (await source.inspect(ends.rawSessionId, opId)).result;
      // D152 follow-up 2026-11-05: the repos the developer left out are neither planned nor captured.
      const leavingOut = effectiveExclusions(inspected.repos, request.excludeRepos, request.placement?.outsideCarry);
      sourceInfo = withoutExcluded(inspected, leavingOut);
      run.meta.title = inspected.title ?? inspected.name;
      const leftOutProblem = excludedProblem(inspected, sourceInfo);
      if (leftOutProblem.length > 0) throw new TakeoverError(409, 'blocked', leftOutProblem.join('; '));
      plan = (await target.plan({ source: sourceInfo, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}), ...(request.placement ? { placement: request.placement } : {}), ...stashOf(request), opId })).result;
      const blockers = [...sourceInfo.blockers, ...plan.blockers];
      const runInRefused = runInProblem(request.placement, plan);
      if (runInRefused !== null) blockers.push(runInRefused);
      if (blockers.length > 0) throw new TakeoverError(409, 'blocked', blockers.join('; '));
      if (sourceInfo.hooked && request.confirmStopTerminal !== true) throw new TakeoverError(409, 'confirm-needed', "confirm that the terminal's claude on the other machine will be stopped");
      // D152: the workspace files to send (new on the target; the root AGENTS.md of a workspace the move creates).
      const sending = filesToSend(sourceInfo.workspaceFiles, request.placement?.runIn ? undefined : request.workspaceFiles, plan.workspaceFiles, createsRoot(plan));
      const filesProblem = fileChoiceProblem(sourceInfo.workspaceFiles, sending);
      if (filesProblem !== null) throw new TakeoverError(409, 'blocked', filesProblem);
      set('checks', 'done', `${sourceInfo.repos.length} repo${sourceInfo.repos.length === 1 ? '' : 's'}, ${plan.cli.label} on ${plan.account.name}`);
      done.push('checks');
      // 2 · stop the session where it runs (a hooked terminal: after the capture).
      failedAt = 'stop';
      set('stop', 'running');
      const stopped = await source.stop(opId, ends.rawSessionId);
      stoppedLive = stopped.result.wasLive;
      logOf(sourceName(), stopped.log);
      set('stop', 'done', sourceInfo.hooked ? "the terminal's claude is stopped after the capture" : stopped.result.wasLive ? 'paused' : 'was not running');
      done.push('stop');
      // 3 · the WIP push (and, for a hooked session, the terminal's stop).
      failedAt = 'capture';
      set('capture', 'running');
      const capture = await source.capture(opId, leavingOut);
      logOf(sourceName(), capture.log);
      captured = capture.result.repos;
      const changed = captured.reduce((total, repo) => total + repo.uncommitted, 0);
      set('capture', 'running', `${captured.length} repo${captured.length === 1 ? '' : 's'}, ${changed} uncommitted file${changed === 1 ? '' : 's'} pushed`);
      if (sourceInfo.hooked) {
        const killed = await source.stopTerminal(opId);
        terminalStopped = true;
        logOf(sourceName(), killed.log);
      }
      set('capture', 'done');
      done.push('capture');
      // 4 · the conversation.
      failedAt = 'transfer';
      set('transfer', 'running');
      const listed = await source.files(opId);
      files = listed.result.files;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      let sent = 0;
      for (const file of files) {
        let offset = 0;
        for (;;) {
          const chunk = await source.readChunk(opId, file.name, offset);
          await target.receiveChunk({ opId, name: file.name, size: file.size, sha256: file.sha256, offset, data: chunk.data });
          offset += chunk.length;
          sent += chunk.length;
          if (chunk.eof || chunk.length === 0) break;
        }
        set('transfer', 'running', `${Math.round(sent / 1024)} of ${Math.round(total / 1024)} KB`);
      }
      // D152: the workspace's own files, over the same paired link (staged and checked on the target).
      let workspaceCount = 0;
      if (sending.copy.length > 0) {
        const listed = (await source.workspaceFiles(opId, sending.copy)).result.files;
        for (const file of listed) {
          if (file.secret && sending.confirmSecrets !== true) throw new TakeoverError(409, 'blocked', `${file.name} looks like it holds secrets: confirm copying it first`);
          let offset = 0;
          for (;;) {
            const chunk = await source.readWorkspaceChunk(opId, file.name, offset);
            await target.receiveWorkspaceChunk({ opId, name: file.name, size: file.size, sha256: file.sha256 ?? '', offset, data: chunk.data, secret: file.secret, confirmed: sending.confirmSecrets === true });
            offset += chunk.length;
            if (chunk.eof || chunk.length === 0) break;
          }
          workspaceCount++;
        }
      }
      set('transfer', 'done', `${files.length} file${files.length === 1 ? '' : 's'}, ${Math.round(total / 1024)} KB${workspaceCount > 0 ? `; ${workspaceCount} workspace file${workspaceCount === 1 ? '' : 's'}` : ''}`);
      done.push('transfer');
      // 5 · the working tree on the target.
      failedAt = 'apply';
      set('apply', 'running');
      const applied = await target.apply({ opId, source: sourceInfo, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}), ...(request.placement ? { placement: request.placement } : {}), ...stashOf(request), captured });
      logOf(plan.machine.name, applied.log);
      run.stashes = [...(applied.result.stashes ?? [])];
      run.overwrites = [...(applied.result.overwrites ?? [])];
      const placed = applied.result.workspaceFiles ?? null;
      if (placed || (request.workspaceFiles && request.workspaceFiles.copy.length > 0)) {
        // What was skipped up front (the same file, a conflict on the target) is reported with what the apply did.
        const skippedSame = (plan.workspaceFiles ?? []).filter((entry) => entry.state === 'same' && request.workspaceFiles?.copy.includes(entry.name)).map((entry) => entry.name);
        const skippedConflicts = (plan.workspaceFiles ?? []).filter((entry) => entry.state === 'conflict' && request.workspaceFiles?.copy.includes(entry.name)).map((entry) => entry.name);
        const refusedUpFront = (plan.workspaceFiles ?? []).filter((entry) => entry.state === 'refused' && request.workspaceFiles?.copy.includes(entry.name)).map((entry) => ({ name: entry.name, reason: entry.reason ?? 'refused' }));
        run.workspaceFiles = {
          copied: placed?.copied ?? [],
          same: [...skippedSame, ...(placed?.same ?? [])],
          conflicts: [...skippedConflicts, ...(placed?.conflicts ?? [])],
          refused: [...refusedUpFront, ...(placed?.refused ?? [])],
          secret: placed?.secret ?? 0,
        };
      }
      const filesNote = run.workspaceFiles ? `; ${run.workspaceFiles.copied.length} workspace file${run.workspaceFiles.copied.length === 1 ? '' : 's'} copied${run.workspaceFiles.conflicts.length > 0 ? `, ${run.workspaceFiles.conflicts.length} skipped (a different file is there)` : ''}` : '';
      set('apply', 'done', `${applied.result.applied.length} repo${applied.result.applied.length === 1 ? '' : 's'} restored${filesNote}`);
      done.push('apply');
      const stillThere = applied.result.applied.filter((repo) => !repo.tempDeleted).map((repo) => repo.key);
      // 6 · resume on the target.
      failedAt = 'resume';
      set('resume', 'running');
      const resumed = await target.resume({ opId, source: sourceInfo, files, from: sourceInfo.machine });
      logOf(plan.machine.name, resumed.log);
      done.push('resume');
      const targetMachine = ends.target.machineId === null ? { id: self.id, name: self.name } : { id: plan.machine.id, name: plan.machine.name };
      const key = ends.target.machineId === null ? resumed.result.sessionId : remoteId(plan.machine.id, resumed.result.sessionId);
      run.result = { sessionId: key, machineName: targetMachine.name, machineId: targetMachine.id, local: ends.target.machineId === null };
      set('resume', 'done', resumed.result.note);
      // D110: the folders this move used are offered the next time this folder moves to that machine.
      // D152: a workspace root it created is remembered as an existing folder, a cloned repo is found there next time.
      // D152 follow-up: a repo outside the workspace it cloned is used from there next time, and the outside carry choices are kept.
      const clonedOutside = Object.fromEntries(plan.repos.filter((resolution) => resolution.action === 'clone' && resolution.cloneTo !== null && sourceInfo?.repos.find((repo) => repo.key === resolution.key)?.outside === true).map((resolution) => [resolution.key, resolution.cloneTo as string]));
      if (request.placement) await this.#service.rememberPlacement(await this.#placementKey(ends, sourceInfo), placementToRemember(request.placement, plan.workspaceRoot?.path ?? null, clonedOutside)).catch((error: unknown) => this.#onError(error));
      // 7 · the old session is marked moved; the temp branches are cleaned up. Failures from here keep the take-over.
      set('finish', 'running');
      try {
        const finished = await source.finish(opId, { machineId: targetMachine.id, machineName: targetMachine.name, sessionId: resumed.result.sessionId, at: new Date().toISOString() }, stillThere);
        logOf(sourceName(), finished.log);
        for (const leftover of finished.result.leftovers) run.leftovers.push({ ...leftover, machineId: ends.source.machineId });
        const notes: string[] = [];
        if (finished.result.closeError) notes.push(`the old session could not be closed: ${finished.result.closeError}`);
        if (finished.result.leftovers.length > 0) notes.push(`${finished.result.leftovers.length} temporary branch${finished.result.leftovers.length === 1 ? '' : 'es'} could not be deleted`);
        // D156: the clean-up on the source, only after a successful move whose old session was closed.
        if (request.cleanupSource === true) {
          if (finished.result.closeError) run.sourceCleanup = skippedCleanup(ends.rawSessionId, sourceName(), targetMachine.name, 'the old session could not be closed, so nothing was cleaned up');
          else {
            set('finish', 'running', 'cleaning up');
            run.sourceCleanup = await this.#cleanupSource(source, opId, ends.rawSessionId, sourceName(), targetMachine.name, (lines) => logOf(sourceName(), lines));
          }
        }
        set('finish', notes.length > 0 ? 'failed' : 'done', notes.join('; ') || (run.sourceCleanup ? cleanupSummary(run.sourceCleanup) : null));
      } catch (error) {
        if (request.cleanupSource === true) run.sourceCleanup = skippedCleanup(ends.rawSessionId, sourceName(), targetMachine.name, `${sourceName()} could not finish the move, so nothing was cleaned up`);
        set('finish', 'failed', error instanceof Error ? error.message : String(error));
        // The other machine could not be reached to clean up: whatever the target could not delete is reported from what it said.
        for (const key of stillThere) {
          const repo = sourceInfo.repos.find((entry) => entry.key === key);
          const capturedRepo = captured.find((entry) => entry.key === key);
          if (repo && capturedRepo) {
            run.leftovers.push({ id: '', repoPath: repo.path, remoteName: capturedRepo.remoteName, remoteUrl: capturedRepo.remoteUrl, branch: capturedRepo.tempBranch, at: new Date().toISOString(), reason: 'the machine that pushed it could not be reached', machineId: ends.source.machineId });
          }
        }
      }
      await target.closeTarget(opId).catch((error: unknown) => this.#onError(error));
      run.state = 'done';
      this.#logOutcome(run, started);
      run.meta.endedAt = new Date().toISOString();
      this.#notify(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.error = { step: failedAt, message };
      set(failedAt, 'failed', message);
      // The run stays `running` (with its error set: the dialog says "Undoing…") until the undo is over.
      // Nothing is registered yet when the checks fail.
      try {
        if (done.length > 0 || failedAt !== 'checks') {
          await this.#rollback(run, ends, { done, stoppedLive, hooked: sourceInfo?.hooked ?? false, terminalStopped }, plan?.machine.name ?? 'the target', sourceName());
        } else {
          run.rolledBack = null;
        }
      } finally {
        run.state = 'failed';
        this.#logOutcome(run, started);
        run.meta.endedAt = new Date().toISOString();
        this.#notify(run);
      }
    }
  }

  /** D156: the source's clean-up; a failure (an older source, the source unreachable) is reported, never fails the move. */
  async #cleanupSource(source: TakeoverEndpoint, opId: string, sessionId: string, sourceName: string, targetName: string, log: (lines: readonly string[]) => void): Promise<SourceCleanupReport> {
    try {
      const answer = await source.cleanupSource(opId, sessionId);
      log(answer.log);
      return readCleanupReport(answer.result) ?? skippedCleanup(sessionId, sourceName, targetName, 'its answer could not be read');
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      const code = (error as { code?: unknown }).code;
      const older = code === 'peer-forbidden' || status === 404 || status === 403;
      return skippedCleanup(sessionId, sourceName, targetName, older ? `Switchboard on ${sourceName} is older and cannot clean up after a move: update it, then use Clean up on this computer… on the moved agent there` : error instanceof Error ? error.message : String(error));
    }
  }

  /** The move log's first line of a run, on this (the initiating) machine. */
  async #logStart(run: RunState, ends: Ends, request: TakeoverRequest, self: { readonly id: string; readonly name: string }): Promise<void> {
    const peerName = (await this.#peers.machines()).find((machine) => machine.id === ends.peerId)?.name ?? ends.peerId;
    const sourceLocal = ends.source.machineId === null;
    const title = sourceLocal ? await this.#service.sessionTitle(ends.rawSessionId) : (this.#peers.remoteSessions().find((session) => session.id === request.sessionId)?.name ?? null);
    const context = request.context ?? {};
    this.#log.info(
      {
        run: run.id,
        step: 'start',
        state: 'started',
        session: ends.rawSessionId,
        title,
        source: sourceLocal ? self.name : peerName,
        target: sourceLocal ? peerName : self.name,
        initiator: sourceLocal ? 'source' : 'target',
        ...(context.member ? { member: context.member.name, memberId: context.member.id } : {}),
        ...(context.crew ? { crew: context.crew.name, crewId: context.crew.id, crewRun: context.crew.run } : {}),
        ...(request.excludeRepos && request.excludeRepos.length > 0 ? { excluded: request.excludeRepos.length } : {}),
      },
      `${MOVE_LOG_PREFIX} start`,
    );
  }

  /** The move log's last line of a run: done, or failed at a step (rolled back or not) with what was left behind. */
  #logOutcome(run: RunState, started: number): void {
    const failedAt = run.error?.step ?? null;
    const fields = {
      run: run.id,
      step: 'outcome',
      state: failedAt === null ? 'done' : 'failed',
      ms: Date.now() - started,
      ...(failedAt !== null ? { failedAt, reason: moveLogReason(run.error?.message ?? 'failed'), rolledBack: run.rolledBack } : {}),
      ...(run.rollbackNotes.length > 0 ? { rollbackNotes: run.rollbackNotes.map(moveLogReason) } : {}),
      leftovers: run.leftovers.map((entry) => `${entry.repoPath} ${entry.branch}`),
      ...(run.stashes.length > 0 ? { stashes: run.stashes.map((stash) => stash.path) } : {}),
      ...(run.overwrites.length > 0 ? { overwrites: run.overwrites.map((entry) => moveLogReason(overwriteNote(entry))) } : {}),
      ...(run.result ? { session: run.result.sessionId } : {}),
      ...(run.steps.some((entry) => entry.id === 'finish' && entry.status === 'failed') ? { finish: 'failed' } : {}),
      ...(run.sourceCleanup ? { cleanup: cleanupSummary(run.sourceCleanup) } : {}),
    };
    const message = moveOutcomeMessage({ failedAt, rolledBack: run.rolledBack });
    if (failedAt === null) this.#log.info(fields, message);
    else this.#log.warn(fields, message);
  }

  async #rollback(run: RunState, ends: Ends, state: { done: readonly TakeoverStepId[]; stoppedLive: boolean; hooked: boolean; terminalStopped: boolean }, targetName: string, sourceName: string): Promise<void> {
    const opId = run.id;
    let clean = true;
    const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        clean = false;
        run.rollbackNotes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const actions = rollbackActions(state);
    // The target is undone whenever it holds something; the source always forgets the operation (a stop that failed too).
    const targetUndo = actions.includes('target-undo-apply') || actions.includes('target-remove-files') || actions.includes('target-remove-session');
    if (targetUndo || state.done.length > 0 || run.steps.some((entry) => entry.status === 'failed' && entry.id !== 'checks')) {
      await attempt(`could not undo the changes on ${targetName}`, async () => {
        const undone = await ends.target.abort(opId);
        appendLog(run, targetName, undone.log);
        run.rollbackNotes.push(...undone.result.notes);
        // D153: a stash the move made is kept by the undo: the run says where and how to restore it.
        if (undone.result.stashes && undone.result.stashes.length > 0) run.stashes = [...undone.result.stashes];
        // D157: the undo moved an overwritten branch back; its backup branch stays and the run says so.
        if (undone.result.overwrites && undone.result.overwrites.length > 0) run.overwrites = [...undone.result.overwrites];
        if (undone.result.notes.length > 0) clean = false;
      });
    }
    await attempt(`could not undo the changes on ${sourceName}`, async () => {
      const undone = await ends.source.rollbackSource(opId);
      appendLog(run, sourceName, undone.log);
      run.rollbackNotes.push(...undone.result.notes);
      if (undone.result.notes.some((note) => note.startsWith('could not'))) clean = false;
    });
    run.rolledBack = clean;
  }
}

/** D156: a clean-up that did not run, with why (the move itself succeeded). */
function skippedCleanup(sessionId: string, machine: string, movedTo: string, error: string): SourceCleanupReport {
  return { sessionId, title: '', machine, movedTo, at: new Date().toISOString(), ran: false, derived: false, removed: [], manual: [], error };
}

/** D152: the move creates the workspace root (a new folder, or one that is not a workspace yet). */
function createsRoot(plan: Pick<TargetPlan, 'workspaceRoot'>): boolean {
  const root = plan.workspaceRoot ?? null;
  return root !== null && root.ok && !root.workspace;
}

/** D153: the request's confirmed stash checkouts, for the target's plan and apply. */
function stashOf(request: TakeoverRequest): { stashTargets?: readonly string[]; overwriteTargets?: readonly string[] } {
  // D157: the confirmed overwrites travel with them.
  return {
    ...(request.stashTargets && request.stashTargets.length > 0 ? { stashTargets: request.stashTargets } : {}),
    ...(request.overwriteTargets && request.overwriteTargets.length > 0 ? { overwriteTargets: request.overwriteTargets } : {}),
  };
}

function appendLog(run: RunState, who: string, lines: readonly string[]): void {
  for (const line of lines) run.log.push(`[${who}] ${line}`);
}

/** D152 follow-up 2026-11-05: `source` without the repos the developer left out (by their source path). */
export function withoutExcluded(source: SourceInspect, exclude: readonly string[] | undefined): SourceInspect {
  if (!exclude || exclude.length === 0) return source;
  const out = new Set(exclude);
  return { ...source, repos: source.repos.filter((repo) => !out.has(repo.path)) };
}

/** D152 follow-up 2026-11-05: the blocker when every repo was left out (there is nothing to carry the work through). */
function excludedProblem(source: SourceInspect, carried: SourceInspect): string[] {
  return source.repos.length > 0 && carried.repos.length === 0 ? ['every repo is left out: tick at least one to carry'] : [];
}
