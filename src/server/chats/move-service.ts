import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type FileHandle, chmod, copyFile, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactExtension, isArtifactKind } from '../../core/artifacts.ts';
import { kindOf, pdfPageCount, safeFileName, servedType, sniffType } from '../../core/attachments.ts';
import {
  type ChatArtifactInfo,
  type ChatAttachmentInfo,
  type ChatDataFile,
  type ChatDataPart,
  type ChatLookAtChoice,
  type ChatLookAtPlan,
  type ChatLookAtSource,
  type ChatMoveInspect,
  type ChatMovePlan,
  type ChatScratchFileInfo,
  CHAT_MOVE_ARTIFACT_MAX_BYTES,
  CHAT_MOVE_ARTIFACT_VERSIONS_MAX,
  CHAT_MOVE_ATTACHMENTS_MAX,
  CHAT_MOVE_ATTACHMENT_MAX_BYTES,
  CHAT_MOVE_DATA_MAX_BYTES,
  chatMovedFromLabel,
  chatMovedMessage,
  chatSourceBlockers,
  isSafeArtifactVersionName,
  isSafeAttachmentId,
  lastSegment,
  lookAtBlockers,
  mappedLookAt,
} from '../../core/chat-move.ts';
import { CLI_LABELS } from '../../core/cli-providers.ts';
import { type ConversationFile, TAKEOVER_CHUNK_BYTES, normalizeRemoteUrl, sessionShortId } from '../../core/takeover.ts';
import { slugForCwd } from '../../core/transcript.ts';
import type { AccountService } from '../accounts/service.ts';
import type { CliStatusService } from '../cli/status.ts';
import type { ServerConfig } from '../config.ts';
import type { SessionMove, SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { FolderService } from '../folders/service.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { TodoService } from '../todos/service.ts';
import { TakeoverGit } from '../takeover/git.ts';
import { allowedPlaces, findCheckouts, resolveAllowed } from '../takeover/locate.ts';
import { type ChunkAnswer, type OpAnswer, TakeoverError, type TakeoverService, safeConversationName } from '../takeover/service.ts';
import { type StagedWorkspaceFile, checkWorkspaceChunk, inspectStaged, listWorkspaceFiles, placeWorkspaceFiles, sourceWorkspaceFile, writeStagedChunk } from '../takeover/workspace.ts';
import { CHATS_DIR, chatScratchDir, deleteChat, removeChatScratch } from './start.ts';

/** Options of {@link ChatMoveService}. */
export interface ChatMoveServiceOptions {
  readonly store: Store;
  readonly config: Pick<ServerConfig, 'dataDir'>;
  readonly supervisor: SessionSupervisor;
  readonly accounts: AccountService;
  readonly clis: CliStatusService;
  readonly folders: FolderService;
  readonly takeover: TakeoverService;
  readonly todos?: TodoService;
  readonly self: () => Promise<{ readonly id: string; readonly name: string }>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
}

/** What the source keeps of a chat move in progress (the data files it serves). */
interface SourceChatOp {
  readonly chatId: string;
  readonly startedAt: number;
  readonly files: Map<string, { readonly abs: string } | { readonly bytes: Buffer }>;
}

/** What the target keeps of a chat move in progress. */
interface TargetChatOp {
  readonly dir: string;
  readonly staged: Map<string, { readonly part: ChatDataPart; readonly name: string; readonly size: number; readonly sha256: string }>;
  readonly scratch: Map<string, StagedWorkspaceFile>;
  scratchBytes: number;
  bytes: number;
  /** What the resume made here (the undo removes it). */
  chatId: string | null;
  scratchDir: string | null;
  installed: string[];
  attachmentIds: string[];
  artifactIds: string[];
  handover: string | null;
  sessionCreated: boolean;
}

const OP_TTL_MS = 30 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function keyOf(part: ChatDataPart, name: string): string {
  return `${part}:${name}`;
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * D155 (`docs/chats.md` → *Moving a chat to another computer*, `docs/peers.md` →
 * *Moving a chat (D155)*): this machine's side of moving a **chat** to / from a
 * paired machine. The conversation's files, the stop, the "moved to" finish and
 * the source's undo are the take-over's own operations (`TakeoverService`); this
 * service adds what is the chat's: its description (record, look-at folders,
 * attachments, scratch files, artifacts), the target's plan of the look-at
 * folders, the chat's data files in checked chunks, the new chat on the target
 * and its undo. Read-only except where it says so.
 */
export class ChatMoveService {
  readonly #store: Store;
  readonly #dataDir: string;
  readonly #supervisor: SessionSupervisor;
  readonly #accounts: AccountService;
  readonly #clis: CliStatusService;
  readonly #folders: FolderService;
  readonly #takeover: TakeoverService;
  readonly #todos: TodoService | null;
  readonly #self: () => Promise<{ readonly id: string; readonly name: string }>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onError: (error: unknown) => void;
  readonly #sources = new Map<string, SourceChatOp>();
  readonly #targets = new Map<string, TargetChatOp>();

  constructor(options: ChatMoveServiceOptions) {
    this.#store = options.store;
    this.#dataDir = options.config.dataDir;
    this.#supervisor = options.supervisor;
    this.#accounts = options.accounts;
    this.#clis = options.clis;
    this.#folders = options.folders;
    this.#takeover = options.takeover;
    this.#todos = options.todos ?? null;
    this.#self = options.self;
    this.#env = options.env ?? process.env;
    this.#onError = options.onError ?? ((error) => console.error('switchboard chat move:', error));
  }

  #git(log: string[]): TakeoverGit {
    return new TakeoverGit({ log: (line) => log.push(line), env: this.#env });
  }

  // ═══ source ═══════════════════════════════════════════════════════════

  /** What this machine would hand over for chat `chatId` (read-only). */
  async inspect(chatId: string): Promise<OpAnswer<ChatMoveInspect>> {
    const log: string[] = [];
    const record = await this.#store.sessions.get(chatId);
    if (!record) throw new TakeoverError(404, 'not-found', `no chat ${chatId}`);
    const self = await this.#self();
    const display = record.title ?? record.name;
    this.#expireStale();
    const blockers = chatSourceBlockers({
      display,
      kind: record.kind,
      closed: record.closedAt !== null,
      movedTo: record.movedTo?.machineName ?? null,
      busy: record.status === 'run' || record.status === 'need',
      switching: this.#supervisor.currentSwitch(chatId) !== null || this.#supervisor.accountSwitching(chatId),
      moving: this.#takeover.isTakingOver(chatId),
    });
    if (record.kind !== 'chat') throw new TakeoverError(409, 'not-a-chat', blockers[0] ?? `${display} is not a chat`);
    const conversation = await this.#takeover.conversationOfRecord(record, blockers);
    const git = this.#git(log);
    const lookAt: ChatLookAtSource[] = [];
    for (const folder of record.lookAt) lookAt.push(await this.#describeLookAt(folder, git));
    const attachments = await this.#attachments(record);
    const scratchFiles = await this.#scratchFiles(record);
    const artifacts = await this.#artifacts(chatId);
    const dataBytes =
      attachments.reduce((sum, entry) => sum + (entry.refused === null ? entry.size : 0), 0) +
      scratchFiles.files.reduce((sum, entry) => sum + (entry.refused === null ? entry.size : 0), 0) +
      artifacts.reduce((sum, artifact) => sum + artifact.versions.reduce((total, version) => total + version.size, 0), 0);
    if (dataBytes > CHAT_MOVE_DATA_MAX_BYTES) blockers.push(`${display} has ${sizeText(dataBytes)} of attachments, scratch files and artifacts: a move copies at most ${sizeText(CHAT_MOVE_DATA_MAX_BYTES)}`);
    const tooLarge = artifacts.flatMap((artifact) => artifact.versions.filter((version) => version.size > CHAT_MOVE_ARTIFACT_MAX_BYTES).map(() => artifact.title));
    if (tooLarge.length > 0) blockers.push(`the artifact “${tooLarge[0] as string}” has a version over ${sizeText(CHAT_MOVE_ARTIFACT_MAX_BYTES)}: too large to move`);
    return {
      result: {
        machine: self,
        platform: process.platform,
        chatId,
        name: record.name,
        title: record.title,
        task: record.task,
        provider: record.provider,
        claudeSessionId: record.claudeSessionId,
        nativeId: record.provider === 'claude' ? record.claudeSessionId : await this.#store.providers.nativeId(chatId, record.provider),
        model: record.model,
        effort: record.effort,
        live: this.#supervisor.isLive(chatId),
        busy: record.status === 'run' || record.status === 'need',
        scratch: record.cwd,
        attachmentsDir: attachments.length > 0 ? path.join(this.#dataDir, 'attachments', chatId) : null,
        lookAt,
        conversation,
        attachments,
        scratchFiles,
        artifacts,
        todos: (await this.#store.todos.list(chatId)).map((todo) => ({
          text: todo.title,
          title: todo.title,
          description: todo.description,
          plan: todo.plan,
          priority: todo.priority,
          estimateMinutes: todo.estimateMinutes,
          state: todo.state,
          addedBy: todo.addedBy,
          createdAt: todo.createdAt,
          doneAt: todo.doneAt,
          startedAt: todo.startedAt,
          startedBy: todo.startedBy,
        })),
        blockers,
      },
      log,
    };
  }

  /** A looked-at folder: its name and, inside a git checkout, the checkout's remote keys and the path below its top. */
  async #describeLookAt(folder: string, git: TakeoverGit): Promise<ChatLookAtSource> {
    const real = await realpath(folder).catch(() => null);
    if (real === null) return { path: folder, name: lastSegment(folder), repo: null, missing: true };
    const top = await git.try(real, ['rev-parse', '--show-toplevel']);
    let repo: ChatLookAtSource['repo'] = null;
    if (top.ok && top.out !== '') {
      const topReal = await realpath(top.out).catch(() => top.out);
      const names = (await git.try(topReal, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const keys: string[] = [];
      for (const name of names) {
        const url = await git.try(topReal, ['remote', 'get-url', name]);
        if (url.ok && url.out !== '') keys.push(normalizeRemoteUrl(url.out));
      }
      const relative = path.relative(topReal, real).split(path.sep).join('/');
      if (keys.length > 0 && !relative.startsWith('..')) repo = { keys: [...new Set(keys)], relative };
    }
    return { path: real, name: lastSegment(real), repo, missing: false };
  }

  async #attachments(record: SessionRecord): Promise<ChatAttachmentInfo[]> {
    const rows = (await this.#store.attachments.list()).filter((row) => row.sessionId === record.id);
    const out: ChatAttachmentInfo[] = [];
    for (const [index, row] of rows.entries()) {
      const abs = path.join(this.#dataDir, 'attachments', record.id, row.file);
      const info = await stat(abs).catch(() => null);
      const refused = index >= CHAT_MOVE_ATTACHMENTS_MAX ? `more than ${CHAT_MOVE_ATTACHMENTS_MAX} attachments` : info === null || !info.isFile() ? 'its file is gone' : info.size > CHAT_MOVE_ATTACHMENT_MAX_BYTES ? `over ${sizeText(CHAT_MOVE_ATTACHMENT_MAX_BYTES)}` : null;
      out.push({ id: row.id, name: row.name, mediaType: row.mediaType, kind: row.kind, size: info?.size ?? row.size, pages: row.pages, createdAt: row.createdAt, refused });
    }
    return out;
  }

  /** The chat's scratch folder's files, by D152's workspace-file rules (no links, caps; a file that looks like a secret stays). */
  async #scratchFiles(record: SessionRecord): Promise<{ readonly files: ChatScratchFileInfo[]; readonly truncated: boolean }> {
    const root = await this.#scratchRoot(record);
    if (root === null) return { files: [], truncated: false };
    const listing = await listWorkspaceFiles(root).catch(() => null);
    if (listing === null) return { files: [], truncated: false };
    return {
      files: listing.files.map((file) => ({
        name: file.name,
        size: file.size,
        refused: file.refused ?? (file.sha256 === null ? 'unreadable' : file.secret !== null ? `looks like it holds secrets (${file.secret}): it stays on this computer` : null),
      })),
      truncated: listing.truncated,
    };
  }

  /** The chat's scratch folder, only when it is the one under `<dataDir>/chats/` (never another folder). */
  async #scratchRoot(record: SessionRecord): Promise<string | null> {
    const expected = await realpath(chatScratchDir(this.#dataDir, record.id)).catch(() => null);
    if (expected === null || record.cwd === null) return null;
    const cwd = await realpath(record.cwd).catch(() => null);
    return cwd === expected ? expected : null;
  }

  async #artifacts(chatId: string): Promise<ChatArtifactInfo[]> {
    const out: ChatArtifactInfo[] = [];
    let versions = 0;
    for (const artifact of await this.#store.artifacts.list({ sessionId: chatId })) {
      const list = await this.#store.artifacts.versions(artifact.id);
      if (versions + list.length > CHAT_MOVE_ARTIFACT_VERSIONS_MAX) break;
      versions += list.length;
      out.push({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        language: artifact.language,
        createdBy: artifact.createdBy,
        versions: list.map((version) => ({ n: version.n, text: version.file === null, mediaType: version.mediaType, size: version.size, createdBy: version.createdBy })),
      });
    }
    return out;
  }

  /**
   * The chat's data files this move sends (attachments, scratch files, artifact
   * versions), read again now and checksummed; their paths are kept for the chunks.
   */
  async data(opId: string, chatId: string): Promise<OpAnswer<{ readonly files: readonly ChatDataFile[] }>> {
    const record = await this.#store.sessions.get(chatId);
    if (!record || record.kind !== 'chat') throw new TakeoverError(404, 'not-found', `no chat ${chatId}`);
    const op: SourceChatOp = { chatId, startedAt: Date.now(), files: new Map() };
    const out: ChatDataFile[] = [];
    const addFile = async (part: ChatDataPart, name: string, abs: string): Promise<void> => {
      const info = await stat(abs);
      op.files.set(keyOf(part, name), { abs });
      out.push({ part, name, size: info.size, sha256: await sha256File(abs) });
    };
    for (const attachment of await this.#attachments(record)) {
      if (attachment.refused !== null) continue;
      const row = await this.#store.attachments.get(attachment.id);
      if (row) await addFile('attachment', attachment.id, path.join(this.#dataDir, 'attachments', chatId, row.file));
    }
    const root = await this.#scratchRoot(record);
    if (root !== null) {
      for (const file of (await this.#scratchFiles(record)).files) {
        if (file.refused !== null) continue;
        await addFile('scratch', file.name, await sourceWorkspaceFile(root, file.name));
      }
    }
    for (const artifact of await this.#artifacts(chatId)) {
      for (const version of artifact.versions) {
        const full = await this.#store.artifacts.version(artifact.id, version.n);
        if (!full) continue;
        const name = `${artifact.id}/${version.n}`;
        if (full.content !== null) {
          const bytes = Buffer.from(full.content, 'utf8');
          op.files.set(keyOf('artifact', name), { bytes });
          out.push({ part: 'artifact', name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        } else if (full.file !== null) {
          const abs = path.resolve(this.#dataDir, full.file);
          if (!abs.startsWith(`${path.join(this.#dataDir, 'artifacts')}${path.sep}`)) continue;
          await addFile('artifact', name, abs);
        }
      }
    }
    this.#sources.set(opId, op);
    return { result: { files: out }, log: [] };
  }

  /** One chunk of a data file {@link data} listed. */
  async readData(opId: string, part: ChatDataPart, name: string, offset: number): Promise<ChunkAnswer> {
    const op = this.#sources.get(opId);
    if (!op) throw new TakeoverError(404, 'unknown-operation', `no chat move ${opId} is running here`);
    const entry = op.files.get(keyOf(part, name));
    if (!entry) throw new TakeoverError(404, 'unknown-file', `${part} ${name} is not part of this move`);
    if (!Number.isInteger(offset) || offset < 0) throw new TakeoverError(422, 'invalid', 'offset must be a whole number of bytes');
    if ('bytes' in entry) {
      const slice = entry.bytes.subarray(offset, offset + TAKEOVER_CHUNK_BYTES);
      return { name, size: entry.bytes.length, offset, length: slice.length, data: slice.toString('base64'), eof: offset + slice.length >= entry.bytes.length };
    }
    const handle: FileHandle = await open(entry.abs, 'r');
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(TAKEOVER_CHUNK_BYTES, Math.max(0, size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { name, size, offset, length: bytesRead, data: buffer.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= size };
    } finally {
      await handle.close();
    }
  }

  /** Forgets a source operation (after the finish or the undo). */
  release(opId: string): { readonly released: boolean } {
    return { released: this.#sources.delete(opId) };
  }

  #expireStale(): void {
    for (const [opId, op] of [...this.#sources.entries()]) if (Date.now() - op.startedAt > OP_TTL_MS) this.#sources.delete(opId);
  }

  // ═══ target ═══════════════════════════════════════════════════════════

  async #places(): Promise<string[]> {
    return allowedPlaces(this.#folders.expand('~'), (await this.#store.folders.list()).map((record) => record.canonicalPath));
  }

  /**
   * The target's judgement (read-only): the CLI and account here, a clash with a
   * conversation this machine has already, and each looked-at folder: a suggestion
   * (a checkout with the same remote, the same path, a saved folder or checkout with
   * the same name) and the chosen folder checked (an existing folder inside the
   * home folder or a saved folder, links resolved; D110's allowed places).
   * `lookAt`: the developer's choice per source path (absent = the suggestion).
   */
  async plan(body: { readonly source: ChatMoveInspect; readonly lookAt?: ChatLookAtChoice | null }): Promise<OpAnswer<ChatMovePlan>> {
    const log: string[] = [];
    const source = body.source;
    if (!isRecord(source) || typeof source.provider !== 'string' || !Array.isArray(source.lookAt)) throw new TakeoverError(422, 'invalid', 'source must be a chat description');
    const self = await this.#self();
    const blockers: string[] = [];
    const refusal = await this.#clis.refusal(source.provider).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (refusal) blockers.push(`${CLI_LABELS[source.provider] ?? source.provider} cannot run on ${self.name}: ${refusal}`);
    const profileId = await this.#accounts.pick(source.provider).catch(() => null);
    const profile = profileId ? await this.#store.profiles.get(profileId) : null;
    if (source.provider === 'claude') {
      const existing = await this.#store.sessions.getByClaudeSessionId(source.claudeSessionId);
      if (existing && !(existing.movedTo && existing.closedAt !== null)) blockers.push(`${self.name} has this conversation already (${existing.title ?? existing.name})`);
    }
    const places = await this.#places();
    const saved = (await this.#store.folders.list()).map((record) => record.canonicalPath);
    const choice = body.lookAt ?? {};
    const git = this.#git(log);
    let checkouts: Array<{ readonly path: string; readonly keys: readonly string[] }> | null = null;
    const loadCheckouts = async (): Promise<Array<{ readonly path: string; readonly keys: readonly string[] }>> => {
      if (checkouts !== null) return checkouts;
      const found = new Set<string>();
      for (const folder of saved) for (const checkout of await findCheckouts(folder).catch(() => [] as string[])) found.add(checkout);
      checkouts = [];
      for (const checkout of found) {
        const names = (await git.try(checkout, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        const keys: string[] = [];
        for (const name of names) {
          const url = await git.try(checkout, ['remote', 'get-url', name]);
          if (url.ok && url.out !== '') keys.push(normalizeRemoteUrl(url.out));
        }
        checkouts.push({ path: checkout, keys });
      }
      return checkouts;
    };
    const allowed = async (candidate: string): Promise<string | null> => resolveAllowed(candidate, places).catch(() => null);
    const rows: ChatLookAtPlan[] = [];
    for (const folder of source.lookAt.slice(0, 50)) {
      if (!isRecord(folder) || typeof folder.path !== 'string') continue;
      const name = typeof folder.name === 'string' ? folder.name : lastSegment(folder.path);
      let suggestion: string | null = null;
      let match: ChatLookAtPlan['match'] = null;
      const repo: { keys?: unknown; relative?: unknown } | null = isRecord(folder.repo) ? folder.repo : null;
      if (repo && Array.isArray(repo.keys) && repo.keys.length > 0) {
        const keys = new Set((repo.keys as unknown[]).map((key) => (typeof key === 'string' ? key : '')));
        for (const checkout of await loadCheckouts()) {
          if (!checkout.keys.some((key) => keys.has(key))) continue;
          const relative = typeof repo.relative === 'string' ? repo.relative : '';
          const safe = relative === '' || relative.split('/').every((segment) => segment !== '' && segment !== '..' && segment !== '.');
          const at = safe ? await allowed(relative === '' ? checkout.path : path.join(checkout.path, ...relative.split('/'))) : null;
          if (at !== null) {
            suggestion = at;
            match = 'remote';
            break;
          }
        }
      }
      if (suggestion === null && path.isAbsolute(folder.path)) {
        const same = await allowed(folder.path);
        if (same !== null) {
          suggestion = same;
          match = 'path';
        }
      }
      if (suggestion === null) {
        const lower = name.toLowerCase();
        const byName = [...saved, ...(await loadCheckouts()).map((checkout) => checkout.path)].find((candidate) => lastSegment(candidate).toLowerCase() === lower) ?? null;
        const at = byName ? await allowed(byName) : null;
        if (at !== null) {
          suggestion = at;
          match = 'name';
        }
      }
      const chosen = Object.hasOwn(choice, folder.path) ? (choice[folder.path] ?? null) : suggestion;
      let target: string | null = null;
      let problem: string | null = null;
      if (chosen !== null) {
        try {
          target = await resolveAllowed(this.#folders.expand(chosen), places);
        } catch (error) {
          target = chosen;
          problem = error instanceof Error ? error.message : String(error);
        }
      }
      rows.push({ source: folder.path, name, suggestion, match, target, problem });
    }
    blockers.push(...lookAtBlockers(rows));
    return {
      result: {
        machine: self,
        platform: process.platform,
        cli: { provider: source.provider, label: CLI_LABELS[source.provider] ?? source.provider, available: refusal === null, reason: refusal },
        account: { profileId: profileId ?? null, name: profile?.name ?? 'Default' },
        lookAt: rows,
        blockers,
      },
      log,
    };
  }

  #target(opId: string): TargetChatOp {
    let op = this.#targets.get(opId);
    if (!op) {
      op = {
        dir: path.join(this.#dataDir, 'takeover', `${opId.replace(/[^A-Za-z0-9-]/g, '')}-chat`),
        staged: new Map(),
        scratch: new Map(),
        scratchBytes: 0,
        bytes: 0,
        chatId: null,
        scratchDir: null,
        installed: [],
        attachmentIds: [],
        artifactIds: [],
        handover: null,
        sessionCreated: false,
      };
      this.#targets.set(opId, op);
    }
    return op;
  }

  /**
   * One chunk of a chat data file into the operation's staging folder, checked
   * before a byte is written: a known part, a safe name (an attachment's UUID, a
   * scratch file's relative name by D152's rules, `<artifact>/<n>`), the size caps
   * and the move's total. The last chunk checks the size and sha256; a scratch file
   * that looks like a secret here is refused too (a chat move never copies one).
   */
  async receiveData(input: { readonly opId: string; readonly part: unknown; readonly name: unknown; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<{ readonly received: number; readonly done: boolean }> {
    const op = this.#target(input.opId);
    const part = input.part;
    if (part !== 'attachment' && part !== 'scratch' && part !== 'artifact') throw new TakeoverError(422, 'invalid', 'part must be attachment, scratch or artifact');
    const bytes = Buffer.from(typeof input.data === 'string' ? input.data : '', 'base64');
    if (bytes.length > TAKEOVER_CHUNK_BYTES) throw new TakeoverError(413, 'too-large', 'a chunk is over the chunk size');
    if (!Number.isInteger(input.offset) || input.offset < 0) throw new TakeoverError(422, 'invalid', 'offset must be a whole number of bytes');
    if (!Number.isInteger(input.size) || input.size < 0) throw new TakeoverError(422, 'invalid', 'size must be a whole number of bytes');
    if (input.offset + bytes.length > input.size) throw new TakeoverError(422, 'invalid', 'more bytes than the announced size');
    let name: string;
    if (part === 'scratch') {
      const refused = checkWorkspaceChunk({ name: input.name, size: input.size, offset: input.offset, bytes: bytes.length }, { staged: op.scratch, bytes: op.scratchBytes });
      if (refused) throw new TakeoverError(refused.status, refused.status === 413 ? 'too-large' : 'invalid', refused.message);
      name = input.name as string;
    } else if (part === 'attachment') {
      if (!isSafeAttachmentId(input.name)) throw new TakeoverError(422, 'invalid', `${String(input.name)} is not an attachment id`);
      if (input.size > CHAT_MOVE_ATTACHMENT_MAX_BYTES) throw new TakeoverError(413, 'too-large', `an attachment is at most ${sizeText(CHAT_MOVE_ATTACHMENT_MAX_BYTES)}`);
      name = input.name;
    } else {
      if (!isSafeArtifactVersionName(input.name)) throw new TakeoverError(422, 'invalid', `${String(input.name)} is not an artifact version`);
      if (input.size > CHAT_MOVE_ARTIFACT_MAX_BYTES) throw new TakeoverError(413, 'too-large', `an artifact version is at most ${sizeText(CHAT_MOVE_ARTIFACT_MAX_BYTES)}`);
      name = input.name;
    }
    const key = keyOf(part, name);
    if (input.offset === 0 && !op.staged.has(key) && op.bytes + input.size > CHAT_MOVE_DATA_MAX_BYTES) throw new TakeoverError(413, 'too-large', `a chat move copies at most ${sizeText(CHAT_MOVE_DATA_MAX_BYTES)} besides its conversation`);
    const file = path.join(op.dir, part, ...name.split('/'));
    let received: number;
    try {
      received = await writeStagedChunk(file, input.offset, bytes);
    } catch (error) {
      throw new TakeoverError(409, 'out-of-order', `${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (received < input.size) return { received, done: false };
    const drop = async (status: number, code: string, message: string): Promise<never> => {
      await rm(file, { force: true });
      throw new TakeoverError(status, code, message);
    };
    const actual = await stat(file);
    if (actual.size !== input.size || (await sha256File(file)) !== input.sha256) return drop(422, 'checksum', `${name} arrived damaged (checksum mismatch): nothing was kept`);
    if (part === 'scratch') {
      const staged = await inspectStaged(file, name);
      if (staged.secret !== null) return drop(422, 'secret-not-copied', `${name} looks like it holds secrets: a chat move does not copy it`);
      const previous = op.scratch.get(name);
      if (previous) op.scratchBytes -= previous.size;
      op.scratch.set(name, { name, size: staged.size, sha256: staged.sha256, secret: false });
      op.scratchBytes += staged.size;
    }
    const previous = op.staged.get(key);
    if (previous) op.bytes -= previous.size;
    op.staged.set(key, { part, name, size: input.size, sha256: input.sha256 });
    op.bytes += input.size;
    return { received, done: true };
  }

  /**
   * Makes the chat here and starts it: a new scratch folder (its files placed, never
   * over anything), the conversation installed where the CLI looks for it (from
   * the take-over's staging), its attachments (the same ids) and artifacts (copies)
   * stored for it, the look-at folders as the plan (re-checked now) maps them, its
   * todos, then the chat resumed in plan mode with a first service message.
   */
  async resume(body: { readonly opId: string; readonly source: ChatMoveInspect; readonly files: readonly ConversationFile[]; readonly lookAt?: ChatLookAtChoice | null; readonly from: { readonly id: string; readonly name: string } }): Promise<OpAnswer<{ readonly sessionId: string; readonly name: string; readonly lookAt: readonly string[]; readonly note: string | null }>> {
    const op = this.#target(body.opId);
    const source = body.source;
    const planned = (await this.plan({ source, lookAt: body.lookAt ?? null })).result;
    if (planned.blockers.length > 0) throw new TakeoverError(409, 'blocked', planned.blockers.join('; '));
    const self = await this.#self();
    const chatId = randomUUID();
    op.chatId = chatId;
    const scratchDir = chatScratchDir(this.#dataDir, chatId);
    await mkdir(path.join(this.#dataDir, CHATS_DIR), { recursive: true, mode: 0o700 });
    await mkdir(scratchDir, { mode: 0o700 });
    op.scratchDir = scratchDir;
    const scratch = await realpath(scratchDir);
    const profileId = (await this.#accounts.pick(source.provider).catch(() => null)) ?? null;
    let note: string | null = null;
    const stagedConversation = (name: string): string => path.join(this.#takeover.stagingRoot(), body.opId.replace(/[^A-Za-z0-9-]/g, ''), 'files', ...name.split('/'));
    const listed = new Set(body.files.map((file) => file.name));
    let transcript: string | null = null;
    let nativeId: string | null = null;
    let messages: Array<{ role: 'user' | 'assistant'; text: string; ts: string | null }> = [];
    let handoverPath: string | null = null;
    const claudeSessionId = source.provider === 'claude' ? source.claudeSessionId : randomUUID();
    if (source.provider === 'claude') {
      const dir = await this.#accounts.dirOf(profileId, 'claude');
      if (!dir) throw new TakeoverError(500, 'no-config-dir', "Claude Code's config folder is not known on this machine");
      const project = path.join(dir, 'projects', slugForCwd(scratch));
      await mkdir(project, { recursive: true, mode: 0o700 });
      for (const file of body.files) {
        if (!listed.has(file.name) || safeConversationName(file.name) === null || file.name.startsWith('@')) continue;
        const to = path.join(project, ...file.name.split('/'));
        await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await copyFile(stagedConversation(file.name), to);
        await chmod(to, 0o600).catch(() => undefined);
        op.installed.push(to);
      }
      transcript = path.join(project, `${source.claudeSessionId}.jsonl`);
    } else {
      let carried = false;
      const rollout = body.files.find((file) => file.name.startsWith('rollout/') && safeConversationName(file.name) !== null);
      if (source.provider === 'codex' && rollout && source.nativeId) {
        try {
          const home = await this.#accounts.dirOf(profileId, 'codex');
          if (!home) throw new Error('the Codex folder is not known on this machine');
          const to = path.join(home, 'sessions', ...rollout.name.slice('rollout/'.length).split('/'));
          await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
          await copyFile(stagedConversation(rollout.name), to);
          await chmod(to, 0o600).catch(() => undefined);
          op.installed.push(to);
          nativeId = source.nativeId;
          carried = true;
        } catch (error) {
          note = `Codex's rollout could not be copied (${error instanceof Error ? error.message : String(error)}): the chat is handed over as a summary`;
        }
      }
      if (listed.has('@messages.json')) {
        try {
          const parsed: unknown = JSON.parse(await readFile(stagedConversation('@messages.json'), 'utf8'));
          if (Array.isArray(parsed)) {
            messages = parsed
              .filter((item): item is { role: 'user' | 'assistant'; text: string; ts?: string } => isRecord(item) && (item['role'] === 'user' || item['role'] === 'assistant') && typeof item['text'] === 'string')
              .map((item) => ({ role: item.role, text: item.text, ts: typeof item.ts === 'string' ? item.ts : null }));
          }
        } catch {
          messages = [];
        }
      }
      if (!carried && listed.has('@chat.md')) {
        const folder = path.join(this.#dataDir, 'handovers', `chat-move-${sessionShortId(body.opId)}`);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        handoverPath = path.join(folder, 'chat.md');
        await copyFile(stagedConversation('@chat.md'), handoverPath);
        await chmod(handoverPath, 0o600).catch(() => undefined);
        op.handover = folder;
      }
    }
    // The scratch folder's files (never over anything; links never followed).
    const placed = await placeWorkspaceFiles(scratch, [...op.scratch.values()], (name) => path.join(op.dir, 'scratch', ...name.split('/')));
    // A tombstone of an earlier move of this conversation here is replaced.
    const existing = source.provider === 'claude' ? await this.#store.sessions.getByClaudeSessionId(claudeSessionId) : null;
    if (existing) {
      if (existing.movedTo && existing.closedAt !== null) {
        if (existing.kind === 'chat') await deleteChat(this.#store, this.#dataDir, existing.id);
        else await this.#store.sessions.delete(existing.id);
      } else throw new TakeoverError(409, 'exists', `${self.name} has this conversation as a chat or session already`);
    }
    let name = source.name;
    for (let n = 2; await this.#store.sessions.getByName(name); n++) name = `${source.name}-${n}`;
    const lookAt = mappedLookAt(planned.lookAt);
    const attachmentsDir = path.join(this.#dataDir, 'attachments', chatId);
    const carriedAttachments = source.attachments.filter((entry) => op.staged.has(keyOf('attachment', entry.id)));
    const parts = [
      chatMovedMessage({
        fromMachine: source.machine.name,
        toMachine: self.name,
        lookAt: planned.lookAt.map((row) => ({ from: row.source, to: row.problem === null ? row.target : null })),
        scratch: { from: source.scratch, to: scratch },
        attachments: { from: typeof source.attachmentsDir === 'string' ? source.attachmentsDir : null, to: attachmentsDir, count: carriedAttachments.length },
      }),
    ];
    if (handoverPath) parts.push(`${CLI_LABELS[source.provider]}'s own record of the conversation could not be carried over, so Switchboard exported the chat: read ${handoverPath} first, summarize where things stand, then continue.`);
    if (placed.conflicts.length > 0 || placed.refused.length > 0) note = [note, `${placed.conflicts.length + placed.refused.length} scratch file(s) were not placed`].filter(Boolean).join('; ');
    const movedFrom: SessionMove = { machineId: source.machine.id, machineName: source.machine.name, sessionId: source.chatId, at: new Date().toISOString() };
    const created = await this.#supervisor.takeOverChat(
      {
        id: chatId,
        name,
        title: source.title,
        task: source.task,
        provider: source.provider,
        claudeSessionId,
        nativeId,
        profileId,
        model: source.model,
        effort: source.effort,
        transcript,
        messages: source.provider === 'claude' ? [] : messages,
        movedFrom,
        dividerLabel: chatMovedFromLabel(source.machine.name),
        firstMessage: parts.join('\n\n'),
        cwd: scratch,
        lookAt,
      },
      {
        beforeSpawn: async (session) => {
          op.sessionCreated = true;
          await this.#storeAttachments(op, session.id, attachmentsDir, carriedAttachments);
          await this.#storeArtifacts(op, session.id, source.artifacts);
          if (this.#todos && Array.isArray(source.todos) && source.todos.length > 0) await this.#todos.import(session.id, source.todos);
          // Tests only (`SWITCHBOARD_PEER_TEST_HOOKS=1`): a failure once everything is in place, so the undo is exercised.
          if (this.#env['SWITCHBOARD_PEER_TEST_HOOKS'] === '1' && this.#env['SWITCHBOARD_TEST_CHAT_MOVE_FAIL'] === 'resume') throw new TakeoverError(500, 'test-failure', 'the chat move failed on purpose (test hook)');
        },
      },
    );
    await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
    return { result: { sessionId: created.id, name: created.name, lookAt, note }, log: [] };
  }

  async #storeAttachments(op: TargetChatOp, chatId: string, folder: string, attachments: readonly ChatAttachmentInfo[]): Promise<void> {
    if (attachments.length === 0) return;
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const attachment of attachments) {
      const bytes = await readFile(path.join(op.dir, 'attachment', attachment.id));
      // The kind and type are this machine's own reading of the bytes (never taken on trust).
      const sniffed = sniffType(bytes);
      const kind = kindOf(sniffed);
      const id = (await this.#store.attachments.get(attachment.id)) ? randomUUID() : attachment.id;
      const file = `${id}-${safeFileName(attachment.name)}`;
      await this.#store.attachments.create({ id, sessionId: chatId, name: safeFileName(attachment.name), mediaType: servedType(sniffed), kind, size: bytes.length, file, pages: kind === 'pdf' ? pdfPageCount(bytes) : null, ...(typeof attachment.createdAt === 'string' ? { createdAt: attachment.createdAt } : {}) });
      op.attachmentIds.push(id);
      await writeFile(path.join(folder, file), bytes, { flag: 'wx', mode: 0o600 });
    }
  }

  async #storeArtifacts(op: TargetChatOp, chatId: string, artifacts: readonly ChatArtifactInfo[]): Promise<void> {
    for (const artifact of artifacts) {
      if (!isArtifactKind(artifact.kind) || !Array.isArray(artifact.versions)) continue;
      const versions = [...artifact.versions].sort((a, b) => a.n - b.n).filter((version) => op.staged.has(keyOf('artifact', `${artifact.id}/${version.n}`)));
      if (versions.length === 0) continue;
      let id = randomBytes(5).toString('hex');
      while (await this.#store.artifacts.get(id)) id = randomBytes(5).toString('hex');
      let made = false;
      for (const [index, version] of versions.entries()) {
        const bytes = await readFile(path.join(op.dir, 'artifact', artifact.id, String(version.n)));
        const n = index + 1;
        let input;
        if (version.text) input = { content: bytes.toString('utf8'), file: null, mediaType: null, size: bytes.length, createdBy: version.createdBy === 'developer' ? 'developer' : 'agent' } as const;
        else {
          const relative = path.join('artifacts', id, `${n}.${artifactExtension(artifact.kind, artifact.language, version.mediaType)}`);
          await mkdir(path.join(this.#dataDir, 'artifacts', id), { recursive: true, mode: 0o700 });
          await writeFile(path.join(this.#dataDir, relative), bytes, { flag: 'wx', mode: 0o600 });
          input = { content: null, file: relative.split(path.sep).join('/'), mediaType: version.mediaType, size: bytes.length, createdBy: version.createdBy === 'developer' ? 'developer' : 'agent' } as const;
        }
        if (!made) {
          await this.#store.artifacts.create({ id, sessionId: chatId, title: artifact.title, kind: artifact.kind, language: artifact.language, version: input });
          op.artifactIds.push(id);
          made = true;
        } else await this.#store.artifacts.addVersion(id, { title: artifact.title, language: artifact.language, version: input });
      }
    }
  }

  /**
   * Undo on the target after a failure: the chat (if it was made), its attachments,
   * artifacts and scratch folder, the conversation files installed for the CLI, the
   * handover export, and both staging folders (this one and the take-over's).
   */
  async abort(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>> {
    const notes: string[] = [];
    const op = this.#targets.get(opId);
    const attempt = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        notes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (op) {
      if (op.chatId && (await this.#store.sessions.get(op.chatId))) {
        await attempt('could not stop the moved chat', () => this.#supervisor.close(op.chatId as string, { confirm: true }));
        await attempt('could not remove the moved chat', () => deleteChat(this.#store, this.#dataDir, op.chatId as string));
      }
      for (const id of op.attachmentIds) await attempt('could not remove an attachment', () => this.#store.attachments.delete(id));
      if (op.chatId) await attempt('could not remove the attachments', () => rm(path.join(this.#dataDir, 'attachments', op.chatId as string), { recursive: true, force: true }));
      for (const id of op.artifactIds) {
        await attempt('could not remove an artifact', () => this.#store.artifacts.delete(id));
        await attempt('could not remove an artifact', () => rm(path.join(this.#dataDir, 'artifacts', id), { recursive: true, force: true }));
      }
      if (op.chatId) await attempt('could not remove the scratch folder', () => removeChatScratch(this.#dataDir, op.chatId as string));
      for (const file of [...op.installed].reverse()) await attempt(`could not remove ${file}`, () => rm(file, { force: true, recursive: true }));
      if (op.handover) await attempt('could not remove the handover export', () => rm(op.handover as string, { recursive: true, force: true }));
      await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
      this.#targets.delete(opId);
    }
    // The conversation's chunks were staged by the take-over's own receiver.
    const staged = await this.#takeover.abort(opId).catch((error: unknown) => {
      notes.push(`could not remove the copied conversation: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (staged) notes.push(...staged.result.notes);
    return { result: { notes }, log: [] };
  }

  /** Forgets a finished operation's target state (the chat stays). */
  async close(opId: string): Promise<void> {
    const op = this.#targets.get(opId);
    this.#targets.delete(opId);
    if (op) await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
    await this.#takeover.closeTarget(opId).catch((error: unknown) => this.#onError(error));
  }

  /** `true` while a target operation is open (tests). */
  hasTarget(opId: string): boolean {
    return this.#targets.has(opId);
  }
}
