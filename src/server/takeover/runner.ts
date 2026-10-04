import { randomUUID } from 'node:crypto';
import { parseRemoteId, remoteId } from '../../core/peers.ts';
import {
  type CapturedRepo,
  type ConversationFile,
  type Leftover,
  type SourceInspect,
  type TakeoverPreview,
  type TakeoverRun,
  type TakeoverStepId,
  type TakeoverStepState,
  type TargetPlan,
  TAKEOVER_STEPS,
  TAKEOVER_STEP_LABELS,
  rollbackActions,
} from '../../core/takeover.ts';
import type { SessionMove } from '../db/repos/sessions.ts';
import type { PeerService } from '../peers/service.ts';
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
  inspect(sessionId: string): Promise<OpAnswer<SourceInspect>>;
  stop(opId: string, sessionId: string): Promise<OpAnswer<{ readonly wasLive: boolean; readonly wasBusy: boolean }>>;
  capture(opId: string): Promise<OpAnswer<{ readonly repos: readonly CapturedRepo[] }>>;
  stopTerminal(opId: string): Promise<OpAnswer<{ readonly pid: number | null; readonly how: string }>>;
  files(opId: string): Promise<OpAnswer<{ readonly kind: string; readonly files: readonly ConversationFile[] }>>;
  readChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer>;
  finish(opId: string, move: SessionMove, stillThere: readonly string[]): Promise<OpAnswer<{ readonly leftovers: readonly Leftover[]; readonly closeError: string | null }>>;
  rollbackSource(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>>;
  plan(body: { readonly source: SourceInspect; readonly clonePaths?: Readonly<Record<string, string>> }): Promise<OpAnswer<TargetPlan>>;
  receiveChunk(input: { readonly opId: string; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<unknown>;
  apply(body: { readonly opId: string; readonly source: SourceInspect; readonly clonePaths?: Readonly<Record<string, string>>; readonly captured: readonly CapturedRepo[] }): Promise<OpAnswer<{ readonly place: { readonly cwd: string }; readonly changes: readonly unknown[]; readonly applied: ReadonlyArray<{ readonly key: string; readonly tempDeleted: boolean; readonly tempDeleteError: string | null }> }>>;
  abort(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>>;
  resume(body: ResumeBody): Promise<OpAnswer<{ readonly sessionId: string; readonly name: string; readonly note: string | null }>>;
  closeTarget(opId: string): Promise<void>;
}

/** This machine's endpoint: direct calls. */
export function localEndpoint(service: TakeoverService): TakeoverEndpoint {
  return {
    machineId: null,
    inspect: (sessionId) => service.inspect(sessionId),
    stop: (opId, sessionId) => service.stop(opId, sessionId),
    capture: (opId) => service.capture(opId),
    stopTerminal: (opId) => service.stopTerminal(opId),
    files: (opId) => service.files(opId),
    readChunk: (opId, name, offset) => service.readChunk(opId, name, offset),
    finish: (opId, move, stillThere) => service.finish(opId, move, stillThere),
    rollbackSource: (opId) => service.rollbackSource(opId),
    plan: (body) => service.plan(body),
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
    inspect: (sessionId) => call('POST', '/source/inspect', { sessionId }),
    stop: (opId, sessionId) => call('POST', '/source/stop', { opId, sessionId }),
    capture: (opId) => call('POST', '/source/capture', { opId }),
    stopTerminal: (opId) => call('POST', '/source/stop-terminal', { opId }),
    files: (opId) => call('POST', '/source/files', { opId }),
    readChunk: (opId, name, offset) => call('POST', '/source/chunk', { opId, name, offset }),
    finish: (opId, move, stillThere) => call('POST', '/source/finish', { opId, move, stillThere }),
    rollbackSource: (opId) => call('POST', '/source/rollback', { opId }),
    plan: (body) => call('POST', '/target/plan', body),
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
  /** The developer confirmed that a hooked terminal's `claude` is stopped. */
  readonly confirmStopTerminal?: boolean;
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
}

/** The initiating machine's take-over runner (`docs/peers.md` → *Taking a session over*). */
export class TakeoverRunner {
  readonly #service: TakeoverService;
  readonly #peers: PeerService;
  readonly #onError: (error: unknown) => void;
  readonly #runs = new Map<string, RunState>();

  constructor(options: TakeoverRunnerOptions) {
    this.#service = options.service;
    this.#peers = options.peers;
    this.#onError = options.onError ?? ((error) => console.error('switchboard take-over:', error));
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

  /** What the dialog shows before anything changes: both machines' view of the take-over. */
  async preview(request: TakeoverRequest): Promise<TakeoverPreview> {
    const ends = await this.#ends(request);
    const source = (await ends.source.inspect(ends.rawSessionId)).result;
    const target = (await ends.target.plan({ source, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}) })).result;
    const blockers = [...source.blockers, ...target.blockers];
    return { source, target, stopsTerminal: source.hooked, ok: blockers.length === 0, blockers };
  }

  /** Starts a take-over and returns its run at once; the dialog polls {@link get}. */
  async start(request: TakeoverRequest): Promise<TakeoverRun> {
    const ends = await this.#ends(request);
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
    };
    this.#runs.set(run.id, run);
    while (this.#runs.size > 20) {
      const oldest = [...this.#runs.values()].find((entry) => entry.state !== 'running');
      if (!oldest) break;
      this.#runs.delete(oldest.id);
    }
    void this.#execute(run, ends, request).catch((error: unknown) => this.#onError(error));
    return this.#view(run);
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
    };
    let failedAt: TakeoverStepId = 'checks';
    try {
      // 1 · checks on both sides.
      failedAt = 'checks';
      set('checks', 'running');
      sourceInfo = (await source.inspect(ends.rawSessionId)).result;
      plan = (await target.plan({ source: sourceInfo, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}) })).result;
      const blockers = [...sourceInfo.blockers, ...plan.blockers];
      if (blockers.length > 0) throw new TakeoverError(409, 'blocked', blockers.join('; '));
      if (sourceInfo.hooked && request.confirmStopTerminal !== true) throw new TakeoverError(409, 'confirm-needed', "confirm that the terminal's claude on the other machine will be stopped");
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
      const capture = await source.capture(opId);
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
      set('transfer', 'done', `${files.length} file${files.length === 1 ? '' : 's'}, ${Math.round(total / 1024)} KB`);
      done.push('transfer');
      // 5 · the working tree on the target.
      failedAt = 'apply';
      set('apply', 'running');
      const applied = await target.apply({ opId, source: sourceInfo, ...(request.clonePaths ? { clonePaths: request.clonePaths } : {}), captured });
      logOf(plan.machine.name, applied.log);
      set('apply', 'done', `${applied.result.applied.length} repo${applied.result.applied.length === 1 ? '' : 's'} restored`);
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
      // 7 · the old session is marked moved; the temp branches are cleaned up. Failures from here keep the take-over.
      set('finish', 'running');
      try {
        const finished = await source.finish(opId, { machineId: targetMachine.id, machineName: targetMachine.name, sessionId: resumed.result.sessionId, at: new Date().toISOString() }, stillThere);
        logOf(sourceName(), finished.log);
        for (const leftover of finished.result.leftovers) run.leftovers.push({ ...leftover, machineId: ends.source.machineId });
        const notes: string[] = [];
        if (finished.result.closeError) notes.push(`the old session could not be closed: ${finished.result.closeError}`);
        if (finished.result.leftovers.length > 0) notes.push(`${finished.result.leftovers.length} temporary branch${finished.result.leftovers.length === 1 ? '' : 'es'} could not be deleted`);
        set('finish', notes.length > 0 ? 'failed' : 'done', notes.join('; ') || null);
      } catch (error) {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.error = { step: failedAt, message };
      set(failedAt, 'failed', message);
      run.state = 'failed';
      // Nothing is registered yet when the checks fail.
      if (done.length > 0 || failedAt !== 'checks') {
        await this.#rollback(run, ends, { done, stoppedLive, hooked: sourceInfo?.hooked ?? false, terminalStopped }, plan?.machine.name ?? 'the target', sourceName());
      } else {
        run.rolledBack = null;
      }
    }
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

function appendLog(run: RunState, who: string, lines: readonly string[]): void {
  for (const line of lines) run.log.push(`[${who}] ${line}`);
}
