import { randomUUID } from 'node:crypto';
import {
  type ChatDataFile,
  type ChatDataPart,
  type ChatLookAtChoice,
  type ChatMoveInspect,
  type ChatMovePlan,
  type ChatMovePreview,
  type ChatMoveRun,
  type ChatMoveStepId,
  CHAT_LOOK_AT_REMEMBER_MAX,
  CHAT_LOOK_AT_SETTING,
  CHAT_MOVE_STEPS,
  CHAT_MOVE_STEP_LABELS,
  chatLookAtKey,
  chatMoveUnsupportedText,
  effectiveLookAt,
} from '../../core/chat-move.ts';
import { parseRemoteId, remoteId } from '../../core/peers.ts';
import type { ConversationFile, TakeoverStepState } from '../../core/takeover.ts';
import type { SessionMove } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { PeerService } from '../peers/service.ts';
import { type ChunkAnswer, type OpAnswer, TakeoverError, type TakeoverService } from '../takeover/service.ts';
import type { ChatMoveService } from './move-service.ts';

/**
 * D155 (`docs/peers.md` → *Moving a chat (D155)*): the **initiating** machine's
 * orchestration of a chat move, the chat's counterpart of the take-over runner
 * (`src/server/takeover/runner.ts`). It drives both ends through the same
 * operations, local calls for this machine and the peer API for the other:
 * checks → stop → transfer (the conversation through the take-over's own chunks,
 * then the chat's data) → resume (the new chat on the target) → finish (the old
 * chat marked moved and closed). A failure before the resume undoes everything on
 * both ends; an older Switchboard on the other end is refused up front.
 */

/** One end's operations. */
interface ChatEndpoint {
  readonly machineId: string | null;
  inspect(chatId: string): Promise<OpAnswer<ChatMoveInspect>>;
  stop(opId: string, chatId: string): Promise<OpAnswer<{ readonly wasLive: boolean; readonly wasBusy: boolean }>>;
  files(opId: string): Promise<OpAnswer<{ readonly kind: string; readonly files: readonly ConversationFile[] }>>;
  readChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer>;
  data(opId: string, chatId: string): Promise<OpAnswer<{ readonly files: readonly ChatDataFile[] }>>;
  readData(opId: string, part: ChatDataPart, name: string, offset: number): Promise<ChunkAnswer>;
  release(opId: string): Promise<unknown>;
  finish(opId: string, move: SessionMove): Promise<OpAnswer<{ readonly closeError: string | null }>>;
  rollbackSource(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>>;
  plan(body: { readonly source: ChatMoveInspect; readonly lookAt?: ChatLookAtChoice | null }): Promise<OpAnswer<ChatMovePlan>>;
  receiveChunk(input: { readonly opId: string; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<unknown>;
  receiveData(input: { readonly opId: string; readonly part: ChatDataPart; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<unknown>;
  resume(body: { readonly opId: string; readonly source: ChatMoveInspect; readonly files: readonly ConversationFile[]; readonly lookAt?: ChatLookAtChoice | null; readonly from: { readonly id: string; readonly name: string } }): Promise<OpAnswer<{ readonly sessionId: string; readonly name: string; readonly lookAt: readonly string[]; readonly note: string | null }>>;
  abort(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>>;
  close(opId: string): Promise<void>;
}

function localEndpoint(chats: ChatMoveService, takeover: TakeoverService): ChatEndpoint {
  return {
    machineId: null,
    inspect: (chatId) => chats.inspect(chatId),
    stop: (opId, chatId) => takeover.stop(opId, chatId),
    files: (opId) => takeover.files(opId),
    readChunk: (opId, name, offset) => takeover.readChunk(opId, name, offset),
    data: (opId, chatId) => chats.data(opId, chatId),
    readData: (opId, part, name, offset) => chats.readData(opId, part, name, offset),
    release: async (opId) => chats.release(opId),
    finish: (opId, move) => takeover.finish(opId, move, []),
    rollbackSource: (opId) => takeover.rollbackSource(opId),
    plan: (body) => chats.plan(body),
    receiveChunk: (input) => takeover.receiveChunk(input),
    receiveData: (input) => chats.receiveData(input),
    resume: (body) => chats.resume(body),
    abort: (opId) => chats.abort(opId),
    close: (opId) => chats.close(opId),
  };
}

function peerEndpoint(peers: PeerService, machineId: string, machineName: () => Promise<string>): ChatEndpoint {
  const call = async <T>(route: string, body: unknown): Promise<T> => {
    const answer = await peers.forward(machineId, 'POST', `/api/takeover${route}`, body);
    if (answer.status < 200 || answer.status >= 300) {
      const failure = (typeof answer.body === 'object' && answer.body !== null ? answer.body : {}) as { error?: unknown; message?: unknown };
      // An older Switchboard has no chat routes: its peer API refuses them (403 peer-forbidden) or does not know them (404).
      if (route.startsWith('/chat/') && ((answer.status === 403 && failure.error === 'peer-forbidden') || (answer.status === 404 && failure.error !== 'not-found' && failure.error !== 'unknown-operation' && failure.error !== 'unknown-file'))) {
        throw new TakeoverError(409, 'unsupported', chatMoveUnsupportedText(await machineName()));
      }
      throw new TakeoverError(answer.status, typeof failure.error === 'string' ? failure.error : 'peer-error', typeof failure.message === 'string' ? failure.message : `the other machine answered ${answer.status}`);
    }
    return answer.body as T;
  };
  return {
    machineId,
    inspect: (chatId) => call('/chat/source/inspect', { chatId }),
    stop: (opId, chatId) => call('/source/stop', { opId, sessionId: chatId }),
    files: (opId) => call('/source/files', { opId }),
    readChunk: (opId, name, offset) => call('/source/chunk', { opId, name, offset }),
    data: (opId, chatId) => call('/chat/source/data', { opId, chatId }),
    readData: (opId, part, name, offset) => call('/chat/source/data-chunk', { opId, part, name, offset }),
    release: (opId) => call('/chat/source/release', { opId }),
    finish: (opId, move) => call('/source/finish', { opId, move, stillThere: [] }),
    rollbackSource: (opId) => call('/source/rollback', { opId }),
    plan: (body) => call('/chat/target/plan', body),
    receiveChunk: (input) => call('/target/chunk', input),
    receiveData: (input) => call('/chat/target/data-chunk', input),
    resume: (body) => call('/chat/target/resume', body),
    abort: (opId) => call('/chat/target/abort', { opId }),
    close: async (opId) => {
      await call('/chat/target/close', { opId });
    },
  };
}

/** What starts a chat move (`POST /api/takeover/chat`). */
export interface ChatMoveRequest {
  /** A local chat id (moved to `targetMachine`) or a peer's chat's remote id (moved here). */
  readonly chatId: string;
  readonly targetMachine?: string | null;
  /** Per looked-at folder (its source path): the folder on the target, or `null` = leave it out; absent = remembered, else the target's suggestion. */
  readonly lookAt?: ChatLookAtChoice;
}

interface Ends {
  readonly source: ChatEndpoint;
  readonly target: ChatEndpoint;
  readonly rawChatId: string;
}

interface RunState {
  id: string;
  state: ChatMoveRun['state'];
  steps: TakeoverStepState[];
  error: ChatMoveRun['error'];
  rolledBack: boolean | null;
  rollbackNotes: string[];
  result: ChatMoveRun['result'];
  log: string[];
  chatKey: string;
}

/** Options of {@link ChatMoveRunner}. */
export interface ChatMoveRunnerOptions {
  readonly chats: ChatMoveService;
  readonly takeover: TakeoverService;
  readonly peers: PeerService;
  readonly store: Store;
  readonly onError?: (error: unknown) => void;
  /**
   * D154 hook: told when a chat move starts and every time its run changes, so a
   * server-side list of move runs can show chat moves next to the others. Unset
   * until that list exists on this branch (TODO D154: register the chat runs there).
   */
  readonly onRun?: (run: ChatMoveRun) => void;
}

/** The initiating machine's chat-move runner (`docs/peers.md` → *Moving a chat (D155)*). */
export class ChatMoveRunner {
  readonly #chats: ChatMoveService;
  readonly #takeover: TakeoverService;
  readonly #peers: PeerService;
  readonly #store: Store;
  readonly #onError: (error: unknown) => void;
  readonly #onRun: ((run: ChatMoveRun) => void) | null;
  readonly #runs = new Map<string, RunState>();

  constructor(options: ChatMoveRunnerOptions) {
    this.#chats = options.chats;
    this.#takeover = options.takeover;
    this.#peers = options.peers;
    this.#store = options.store;
    this.#onError = options.onError ?? ((error) => console.error('switchboard chat move:', error));
    this.#onRun = options.onRun ?? null;
  }

  async #machineName(id: string): Promise<string> {
    return (await this.#peers.machines()).find((machine) => machine.id === id)?.name ?? 'the other computer';
  }

  async #ends(request: ChatMoveRequest): Promise<Ends> {
    const self = await this.#peers.self();
    const local = localEndpoint(this.#chats, this.#takeover);
    const remote = parseRemoteId(request.chatId);
    if (remote) {
      if (request.targetMachine && request.targetMachine !== self.id) throw new TakeoverError(422, 'invalid', "a paired computer's chat can only be moved to this computer");
      if (!this.#peers.hasMachine(remote.machineId)) throw new TakeoverError(404, 'not-found', `no paired machine ${remote.machineId}`);
      return { source: peerEndpoint(this.#peers, remote.machineId, () => this.#machineName(remote.machineId)), target: local, rawChatId: remote.id };
    }
    const to = request.targetMachine;
    if (typeof to !== 'string' || to === '') throw new TakeoverError(422, 'invalid', 'a chat of this computer needs a targetMachine to move to');
    if (to === self.id) throw new TakeoverError(422, 'invalid', 'the chat is on this computer already');
    if (!this.#peers.hasMachine(to)) throw new TakeoverError(404, 'not-found', `no paired machine ${to}`);
    return { source: local, target: peerEndpoint(this.#peers, to, () => this.#machineName(to)), rawChatId: request.chatId };
  }

  async #targetId(ends: Ends): Promise<string> {
    return ends.target.machineId ?? (await this.#peers.self()).id;
  }

  async #remembered(source: ChatMoveInspect, targetId: string): Promise<Record<string, string | null>> {
    const stored = await this.#store.settings.get(CHAT_LOOK_AT_SETTING);
    const entries = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, { readonly target?: unknown }>) : {};
    const out: Record<string, string | null> = {};
    for (const folder of source.lookAt) {
      const entry = entries[chatLookAtKey(source.machine.id, folder.path, targetId)];
      if (entry && (typeof entry.target === 'string' || entry.target === null)) out[folder.path] = entry.target;
    }
    return out;
  }

  async #remember(source: ChatMoveInspect, targetId: string, plan: ChatMovePlan): Promise<void> {
    const stored = await this.#store.settings.get(CHAT_LOOK_AT_SETTING);
    const entries: Record<string, { target: string | null; at: string }> = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...(stored as Record<string, { target: string | null; at: string }>) } : {};
    const at = new Date().toISOString();
    for (const row of plan.lookAt) entries[chatLookAtKey(source.machine.id, row.source, targetId)] = { target: row.problem === null ? row.target : null, at };
    const newest = Object.entries(entries)
      .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
      .slice(0, CHAT_LOOK_AT_REMEMBER_MAX);
    await this.#store.settings.set(CHAT_LOOK_AT_SETTING, Object.fromEntries(newest));
  }

  async #choice(ends: Ends, source: ChatMoveInspect, requested: ChatLookAtChoice | null): Promise<{ readonly choice: Record<string, string | null>; readonly remembered: boolean }> {
    return effectiveLookAt(
      source.lookAt.map((folder) => folder.path),
      requested,
      await this.#remembered(source, await this.#targetId(ends)),
    );
  }

  /** Both computers' view of the move (nothing changes). */
  async preview(request: ChatMoveRequest): Promise<ChatMovePreview> {
    const ends = await this.#ends(request);
    const source = (await ends.source.inspect(ends.rawChatId)).result;
    const { choice, remembered } = await this.#choice(ends, source, request.lookAt ?? null);
    const target = (await ends.target.plan({ source, lookAt: choice })).result;
    const lookAt: Record<string, string | null> = {};
    for (const row of target.lookAt) lookAt[row.source] = row.target;
    const blockers = [...source.blockers, ...target.blockers];
    return { source, target, lookAt, remembered, ok: blockers.length === 0, blockers };
  }

  /** Starts a chat move and returns its run at once; the dialog polls {@link get}. */
  async start(request: ChatMoveRequest): Promise<ChatMoveRun> {
    const ends = await this.#ends(request);
    for (const run of this.#runs.values()) {
      if (run.state === 'running' && run.chatKey === request.chatId) throw new TakeoverError(409, 'in-progress', 'this chat is being moved already');
    }
    const run: RunState = {
      id: randomUUID(),
      state: 'running',
      steps: CHAT_MOVE_STEPS.map((id) => ({ id, label: CHAT_MOVE_STEP_LABELS[id], status: 'pending', detail: null })),
      error: null,
      rolledBack: null,
      rollbackNotes: [],
      result: null,
      log: [],
      chatKey: request.chatId,
    };
    this.#runs.set(run.id, run);
    while (this.#runs.size > 20) {
      const oldest = [...this.#runs.values()].find((entry) => entry.state !== 'running');
      if (!oldest) break;
      this.#runs.delete(oldest.id);
    }
    this.#publish(run);
    void this.#execute(run, ends, request).catch((error: unknown) => this.#onError(error));
    return this.#view(run);
  }

  /** A run as the dialog polls it. */
  get(id: string): ChatMoveRun | null {
    const run = this.#runs.get(id);
    return run ? this.#view(run) : null;
  }

  #view(run: RunState): ChatMoveRun {
    return {
      kind: 'chat',
      id: run.id,
      state: run.state,
      steps: run.steps.map((step) => ({ ...step })),
      error: run.error,
      rolledBack: run.rolledBack,
      rollbackNotes: [...run.rollbackNotes],
      result: run.result,
      leftovers: [],
      log: [...run.log],
      workspaceFiles: null,
      stashes: [],
    };
  }

  #publish(run: RunState): void {
    if (!this.#onRun) return;
    try {
      this.#onRun(this.#view(run));
    } catch (error) {
      this.#onError(error);
    }
  }

  async #execute(run: RunState, ends: Ends, request: ChatMoveRequest): Promise<void> {
    const opId = run.id;
    const { source, target } = ends;
    const self = await this.#peers.self();
    const set = (id: ChatMoveStepId, status: TakeoverStepState['status'], detail: string | null = null): void => {
      const index = run.steps.findIndex((entry) => entry.id === id);
      const current = run.steps[index] as TakeoverStepState;
      run.steps[index] = { ...current, status, detail: detail ?? current.detail };
      this.#publish(run);
    };
    const log = (who: string, lines: readonly string[]): void => {
      for (const line of lines) run.log.push(`[${who}] ${line}`);
    };
    let failedAt: ChatMoveStepId = 'checks';
    let sourceName = 'the source';
    let targetName = 'the target';
    let started = false;
    try {
      set('checks', 'running');
      const inspected = (await source.inspect(ends.rawChatId)).result;
      sourceName = inspected.machine.name;
      if (inspected.blockers.length > 0) throw new TakeoverError(409, 'blocked', inspected.blockers.join('; '));
      const { choice } = await this.#choice(ends, inspected, request.lookAt ?? null);
      const plan = (await target.plan({ source: inspected, lookAt: choice })).result;
      targetName = plan.machine.name;
      if (plan.blockers.length > 0) throw new TakeoverError(409, 'blocked', plan.blockers.join('; '));
      const kept = plan.lookAt.filter((row) => row.target !== null).length;
      set('checks', 'done', `${plan.cli.label} on ${plan.account.name}; ${kept} of ${plan.lookAt.length} folder${plan.lookAt.length === 1 ? '' : 's'} to look at`);

      failedAt = 'stop';
      set('stop', 'running');
      started = true;
      const stopped = await source.stop(opId, ends.rawChatId);
      set('stop', 'done', stopped.result.wasLive ? 'its process is stopped' : 'was not running');

      failedAt = 'transfer';
      set('transfer', 'running');
      const files = (await source.files(opId)).result.files;
      for (const file of files) {
        let offset = 0;
        for (;;) {
          const chunk = await source.readChunk(opId, file.name, offset);
          await target.receiveChunk({ opId, name: file.name, size: file.size, sha256: file.sha256, offset, data: chunk.data });
          offset += chunk.length;
          if (chunk.eof || chunk.length === 0) break;
        }
      }
      const data = (await source.data(opId, ends.rawChatId)).result.files;
      for (const file of data) {
        let offset = 0;
        for (;;) {
          const chunk = await source.readData(opId, file.part, file.name, offset);
          await target.receiveData({ opId, part: file.part, name: file.name, size: file.size, sha256: file.sha256, offset, data: chunk.data });
          offset += chunk.length;
          if (chunk.eof || chunk.length === 0) break;
        }
      }
      const count = (part: ChatDataPart): number => data.filter((file) => file.part === part).length;
      set('transfer', 'done', `the conversation (${files.length} file${files.length === 1 ? '' : 's'}), ${count('attachment')} attachment${count('attachment') === 1 ? '' : 's'}, ${count('scratch')} scratch file${count('scratch') === 1 ? '' : 's'}, ${data.filter((file) => file.part === 'artifact').map((file) => file.name.split('/')[0]).filter((id, index, all) => all.indexOf(id) === index).length} artifact(s)`);

      failedAt = 'resume';
      set('resume', 'running');
      const resumed = await target.resume({ opId, source: inspected, files, lookAt: choice, from: inspected.machine });
      log(targetName, resumed.log);
      const targetMachine = ends.target.machineId === null ? { id: self.id, name: self.name } : { id: plan.machine.id, name: plan.machine.name };
      const key = ends.target.machineId === null ? resumed.result.sessionId : remoteId(plan.machine.id, resumed.result.sessionId);
      run.result = { sessionId: key, machineName: targetMachine.name, machineId: targetMachine.id, local: ends.target.machineId === null };
      set('resume', 'done', resumed.result.note ?? `looks at ${resumed.result.lookAt.length} folder${resumed.result.lookAt.length === 1 ? '' : 's'} there`);
      await this.#remember(inspected, targetMachine.id, plan).catch((error: unknown) => this.#onError(error));

      // From here a failure keeps the move (the chat continues on the target).
      set('finish', 'running');
      try {
        const finished = await source.finish(opId, { machineId: targetMachine.id, machineName: targetMachine.name, sessionId: resumed.result.sessionId, at: new Date().toISOString() });
        log(sourceName, finished.log);
        set('finish', finished.result.closeError ? 'failed' : 'done', finished.result.closeError ? `the old chat could not be closed: ${finished.result.closeError}` : null);
      } catch (error) {
        set('finish', 'failed', error instanceof Error ? error.message : String(error));
      }
      await source.release(opId).catch((error: unknown) => this.#onError(error));
      await target.close(opId).catch((error: unknown) => this.#onError(error));
      run.state = 'done';
      this.#publish(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.error = { step: failedAt, message };
      set(failedAt, 'failed', message);
      try {
        if (started) await this.#rollback(run, ends, sourceName, targetName);
        else run.rolledBack = null;
      } finally {
        run.state = 'failed';
        this.#publish(run);
      }
    }
  }

  /** Undoes a failed move: the target forgets everything it made, the source runs the chat again as it was. */
  async #rollback(run: RunState, ends: Ends, sourceName: string, targetName: string): Promise<void> {
    let clean = true;
    const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        clean = false;
        run.rollbackNotes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await attempt(`could not undo the changes on ${targetName}`, async () => {
      const undone = await ends.target.abort(run.id);
      run.rollbackNotes.push(...undone.result.notes);
      if (undone.result.notes.length > 0) clean = false;
    });
    await attempt(`could not undo the changes on ${sourceName}`, async () => {
      const undone = await ends.source.rollbackSource(run.id);
      run.rollbackNotes.push(...undone.result.notes);
      if (undone.result.notes.some((note) => note.startsWith('could not'))) clean = false;
    });
    await ends.source.release(run.id).catch(() => undefined);
    run.rolledBack = clean;
  }
}
