import { CHAT_TAKEOVER_REFUSAL } from '../../core/chats.ts';
import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, chmod, copyFile, mkdir, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLI_LABELS, type CliProviderId } from '../../core/cli-providers.ts';
import { slugForCwd } from '../../core/transcript.ts';
import { worktreePath as worktreePathOf, solutionCandidates } from '../../core/worktrees.ts';
import {
  type AppliedRepo,
  type CapturedRepo,
  type ConversationFile,
  type ConversationFileInfo,
  type ConversationKind,
  type Leftover,
  type PathChange,
  type RepoResolution,
  type SourceInspect,
  type SourceRepo,
  type RepoCheck,
  type TargetCandidate,
  type TargetDirListing,
  type TargetPlacement,
  type TargetPlan,
  type TargetVerification,
  TARGET_FOLDERS_SETTING,
  TAKEOVER_CHUNK_BYTES,
  TAKEOVER_FILE_MAX_BYTES,
  isCloneableUrl,
  isCommitId,
  isSafeBranchName,
  isSafeRepoKey,
  isTempBranch,
  layoutInside,
  checkStateOf,
  matchingCandidates,
  normalizeRemoteUrl,
  movedToLabel,
  planBlockers,
  planRepos,
  redactUrl,
  remoteKeyOf,
  sessionShortId,
  takenOverLabel,
  takeoverMessage,
  unreachableRemoteText,
  worktreeSlotBlocker,
} from '../../core/takeover.ts';
import type { AccountService } from '../accounts/service.ts';
import { chatMarkdown, findCodexRollout } from '../cli/handover.ts';
import type { CliStatusService } from '../cli/status.ts';
import type { ServerConfig } from '../config.ts';
import type { SessionMove, SessionRecord } from '../db/repos/sessions.ts';
import type { WorktreeRecord } from '../db/repos/worktrees.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, folderRefOf } from '../folders/ref.ts';
import type { FolderService } from '../folders/service.ts';
import type { HookService } from '../hooks/service.ts';
import type { QuestionPipeline } from '../inbox/pipeline.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import { TakeoverGit, TakeoverGitError, pathExists } from './git.ts';
import { isMainCheckout } from '../solutions/checkout.ts';
import { type CheckoutFacts, LocateRefusal, allowedPlaces, checkoutFacts, findCheckouts, listFolders, resolveAllowed } from './locate.ts';
import type { TodoService } from '../todos/service.ts';
import type { LoopService } from '../loops/owned.ts';
import type { WorktreeManager } from '../worktrees/manager.ts';
import { type WorksInEvidence, type WorksInSource, type WorkspaceFileInfo, type WorkspaceFileTarget, type WorkspaceFilesListing, type WorkspaceFilesResult, type WorkspaceRootCheck, WORKSPACE_BINARY_MAX_BYTES, WORKSPACE_FILE_MAX_BYTES, workspaceCopyAudit } from '../../core/workspace-move.ts';
import { isWorkingTreeTop } from '../solutions/checkout.ts';
import { type MoveStash, type SkippedWorktree, type TargetChanges, isSafeWorktreeLayout, skippedWarning, stashAudit, stashMessage, worktreeAtTarget, worktreeCarry, worktreeLayout } from '../../core/move-worktrees.ts';
import { type StagedWorkspaceFile, checkWorkspaceChunk, checkWorkspaceRoot, inspectStaged, listWorkspaceFiles, mkdirTracked, placeWorkspaceFiles, sourceWorkspaceFile, undoPlaced, workspaceFileStates, writeStagedChunk } from './workspace.ts';

/**
 * D153: the worktree that is the session's own working copy (a worktree session's
 * `../<repo>-wt-<name>`, or the worktree its cwd is in): carried as before. Every
 * other worktree of a workspace session is one of the agent's own (adopted D145
 * rows, `.claude/worktrees/<name>`): carried only when pushed and not merged.
 */
async function sessionsOwnCopy(record: SessionRecord, worktree: WorktreeRecord): Promise<boolean> {
  const real = async (value: string): Promise<string> => realpath(value).catch(() => path.resolve(value));
  const at = await real(worktree.path);
  if (at === (await real(worktreePathOf(worktree.repoPath, record.name)))) return true;
  if (record.cwd) {
    const cwd = await real(record.cwd);
    if (cwd === at || cwd.startsWith(`${at}${path.sep}`)) return true;
  }
  return false;
}

/** A refusal of a take-over route, sent as `{ error, message }`. */
export class TakeoverError extends Error {
  override name = 'TakeoverError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** How long a take-over's source side is kept when nothing finishes it (the initiating machine went away). */
export const SOURCE_OP_TTL_MS = 30 * 60_000;

/** Settings key of the temporary remote branches that are still out there (one-click delete). */
export const LEFTOVERS_SETTING = 'takeover.leftovers';

/** The answer of every take-over route that does work: its result and the git commands it ran. */
export interface OpAnswer<T> {
  readonly result: T;
  readonly log: readonly string[];
}

/** Options of {@link TakeoverService}. */
export interface TakeoverServiceOptions {
  readonly store: Store;
  readonly config: ServerConfig;
  readonly supervisor: SessionSupervisor;
  readonly hooks: HookService;
  readonly worktrees: WorktreeManager;
  readonly folders: FolderService;
  readonly accounts: AccountService;
  readonly clis: CliStatusService;
  readonly questions: QuestionPipeline;
  /** D68: the todo lists (the session's travel with it); none = its todos stay behind. */
  readonly todos?: TodoService;
  /** D94: the Switchboard loops (the session's travel with it and end here); none = they stay behind. */
  readonly loops?: LoopService;
  /** This machine's id and name. */
  readonly self: () => Promise<{ readonly id: string; readonly name: string }>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onError?: (error: unknown) => void;
  /** D152: the audit line of a workspace-file copy (no names, no contents); default: the service log. */
  readonly onAudit?: (line: string) => void;
}

/** What the source keeps of a take-over in progress. */
interface SourceOp {
  readonly sessionId: string;
  readonly claudeSessionId: string;
  readonly hooked: boolean;
  wasLive: boolean;
  wasBusy: boolean;
  captured: Array<CapturedRepo & { readonly repoPath: string; leftoverId: string | null }>;
  terminalStopped: boolean;
  readonly startedAt: number;
  /** name → absolute path (real files) or bytes (generated). */
  files: Map<string, { readonly abs: string } | { readonly bytes: Buffer }>;
  /** D152: the workspace files this take-over sends (name → absolute path on this machine). */
  workspace: Map<string, string>;
  finished: boolean;
}

/** What the target keeps of a take-over in progress. */
interface TargetOp {
  readonly dir: string;
  applied: AppliedRepo[];
  worktreeRecords: WorktreeRecord[];
  installed: string[];
  /** Hunks of `plan` the resume needs. */
  place: { readonly folder: FolderRef; readonly cwd: string; readonly changes: readonly PathChange[] } | null;
  /** The session was created by this op (the id). */
  sessionId: string | null;
  /** D110: the chosen folder this op saved (a workspace root or a checkout that was not saved yet); removed by the undo. */
  addedFolderId: string | null;
  /** D152: the workspace files staged here (checked, verified), and their bytes. */
  staged: Map<string, StagedWorkspaceFile>;
  stagedBytes: number;
  /** D152: files this op wrote under the workspace root, and folders it created (the new root, a clone's parents); the undo removes them. */
  placedFiles: string[];
  createdDirs: string[];
  /** D153: the stashes this op made in target checkouts (kept: the undo never touches them, it only reports them). */
  stashes: MoveStash[];
}

/** One transferred chunk. */
export interface ChunkAnswer {
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly length: number;
  /** Base64. */
  readonly data: string;
  readonly eof: boolean;
}

/** A target-side request that carries the source's description. */
export interface TargetBody {
  readonly opId: string;
  readonly source: SourceInspect;
  readonly clonePaths?: Readonly<Record<string, string>>;
  /** D110: the target folders the developer chose (absent: the saved folders, as before D110). */
  readonly placement?: TargetPlacement;
  /** D153: the target checkouts whose uncommitted changes the developer confirmed stashing ("Stash them on <PC>"). */
  readonly stashTargets?: readonly string[];
}

/** The target's resume request. */
export interface ResumeBody extends TargetBody {
  readonly files: readonly ConversationFile[];
  readonly from: { readonly id: string; readonly name: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A file name from the other machine: relative, no `..`, no drive, at most 500 characters. */
export function safeConversationName(name: unknown): string | null {
  if (typeof name !== 'string' || name === '' || name.length > 500) return null;
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) return null;
  return name;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function walk(root: string, prefix: string, out: Array<{ name: string; abs: string; size: number }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(abs, `${prefix}${entry.name}/`, out);
    else if (entry.isFile()) out.push({ name: `${prefix}${entry.name}`, abs, size: (await stat(abs)).size });
  }
}

/**
 * D65 (`docs/peers.md` → *Taking a session over*): this machine's side of a
 * take-over. The **source** routes inspect a session, stop it, push its work in
 * progress to a temporary branch, serve its conversation in chunks and, at the
 * end, mark it moved. The **target** routes judge and prepare the repos (match
 * by remote, clone), receive the conversation, restore the working tree and
 * start the session. Both are plain methods; the peer API and the initiating
 * machine's runner (`runner.ts`) call them the same way, local or over the
 * tailnet. Every method that does work answers with the git commands it ran.
 */
export class TakeoverService {
  readonly #store: Store;
  readonly #config: ServerConfig;
  readonly #supervisor: SessionSupervisor;
  readonly #hooks: HookService;
  readonly #worktrees: WorktreeManager;
  readonly #folders: FolderService;
  readonly #accounts: AccountService;
  readonly #clis: CliStatusService;
  readonly #questions: QuestionPipeline;
  readonly #self: () => Promise<{ readonly id: string; readonly name: string }>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #onError: (error: unknown) => void;
  readonly #onAudit: (line: string) => void;
  readonly #sources = new Map<string, SourceOp>();
  readonly #activeSessions = new Set<string>();
  readonly #targets = new Map<string, TargetOp>();

  readonly #todos: TodoService | null;
  readonly #loops: LoopService | null;

  constructor(options: TakeoverServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#supervisor = options.supervisor;
    this.#hooks = options.hooks;
    this.#worktrees = options.worktrees;
    this.#folders = options.folders;
    this.#accounts = options.accounts;
    this.#clis = options.clis;
    this.#questions = options.questions;
    this.#todos = options.todos ?? null;
    this.#loops = options.loops ?? null;
    this.#self = options.self;
    this.#env = options.env ?? process.env;
    this.#onError = options.onError ?? ((error) => console.error('switchboard take-over:', error));
    this.#onAudit = options.onAudit ?? ((line) => console.info(`switchboard take-over [audit]: ${line}`));
  }

  #git(lines: string[]): TakeoverGit {
    return new TakeoverGit({ log: (line) => lines.push(line), env: this.#env });
  }

  // ═══ source ═══════════════════════════════════════════════════════════

  /** What this machine would hand over for `sessionId` (read-only; nothing is touched). */
  /** D94: `true` while this machine's session is being taken over (its loops skip their due times meanwhile). */
  isTakingOver(sessionId: string): boolean {
    return this.#activeSessions.has(sessionId);
  }

  async inspect(sessionId: string): Promise<OpAnswer<SourceInspect>> {
    const log: string[] = [];
    const git = this.#git(log);
    const record = await this.#store.sessions.get(sessionId);
    if (!record) throw new TakeoverError(404, 'not-found', `no session ${sessionId}`);
    const self = await this.#self();
    const blockers: string[] = [];
    const display = record.title ?? record.name;
    if (record.closedAt !== null) blockers.push(`${display} is closed: reopen it first`);
    // D106: a chat lives in this machine's scratch folder.
    if (record.kind === 'chat') blockers.push(`${display}: ${CHAT_TAKEOVER_REFUSAL}`);
    if (record.movedTo) blockers.push(`${display} was already taken over to ${record.movedTo.machineName}`);
    if (!record.hooked && !record.attached) blockers.push(`${display} continues in a terminal: attach it here first`);
    if (this.#supervisor.currentSwitch(sessionId) || this.#supervisor.accountSwitching(sessionId)) blockers.push(`${display} is switching CLI or account: wait for it to finish`);
    await this.#expireStale(sessionId);
    if (this.#activeSessions.has(sessionId)) blockers.push(`${display} is being taken over already`);
    const repos: SourceRepo[] = [];
    const folderRef = folderOfSession(record);
    const used = new Set<string>();
    const keyOf = (name: string): string => {
      let key = name.replace(/[^A-Za-z0-9._-]/g, '-') || 'repo';
      for (let n = 2; used.has(key); n++) key = `${name.replace(/[^A-Za-z0-9._-]/g, '-')}-${n}`;
      used.add(key);
      return key;
    };
    const leftOut: Array<{ readonly name: string; readonly path: string; readonly reason: string }> = [];
    // D153: the agent's own worktrees of a workspace session that are not carried (no remote branch, merged).
    const skippedWorktrees: SkippedWorktree[] = [];
    const skippedPaths = new Set<string>();
    const workspaceSession = record.rootKind === 'workspace' && folderRef !== null;
    const describe = async (input: { name: string; kind: 'main' | 'worktree'; dir: string; baseRef: string | null; parentBranch: string | null }, found?: { source: WorksInSource; evidence: readonly WorksInEvidence[] }, own?: { readonly prState: string | null }): Promise<void> => {
      // D153: one of the agent's own worktrees travels only when its branch has a remote-tracking branch and is not merged.
      let worktreeAt: string | null = null;
      if (own && input.kind === 'worktree') {
        const facts = await git.worktreeCarryFacts(input.dir, { baseRef: input.baseRef, prState: own.prState });
        const decision = worktreeCarry(facts);
        const main = (await git.mainCheckout(input.dir)) ?? input.dir;
        if (!decision.carry) {
          skippedPaths.add(await realpath(input.dir).catch(() => input.dir));
          skippedWorktrees.push({ name: path.basename(main), path: input.dir, mainPath: main, branch: facts.branch, reason: decision.reason, text: decision.text, uncommitted: facts.uncommitted, warning: skippedWarning(facts.uncommitted, self.name) });
          return;
        }
        worktreeAt = worktreeLayout(main, input.dir);
      }
      const answer = await git.describe({ key: keyOf(input.name), ...input });
      // A repo it only read in or ran commands in that cannot travel (no remote, a detached HEAD…) is left out with the reason, never a blocker.
      if ('blocker' in answer) {
        if (found && (found.source === 'read' || found.source === 'commands')) leftOut.push({ name: input.name, path: input.dir, reason: answer.blocker });
        else blockers.push(answer.blocker);
      } else {
        const repo: SourceRepo = { ...answer.repo, ...(worktreeAt !== null && isSafeWorktreeLayout(worktreeAt) ? { worktreeAt } : {}) };
        repos.push(found ? { ...repo, found: found.source, evidence: found.evidence } : repo);
      }
    };
    const live = await this.#store.worktrees.list({ sessionId });
    if (live.length > 0) {
      // D153: in a workspace session every worktree but the session's own copy (`../<repo>-wt-<name>`, or the one its cwd is in) is one of the agent's own.
      for (const worktree of live) await describe({ name: worktree.repo, kind: 'worktree', dir: worktree.path, baseRef: worktree.baseRef, parentBranch: worktree.parentBranch }, undefined, workspaceSession && !(await sessionsOwnCopy(record, worktree)) ? { prState: worktree.prState } : undefined);
    } else if (record.rootKind === 'workspace' && folderRef) {
      for (const solution of record.solutions) {
        try {
          const location = await this.#worktrees.resolveRepo(solution, folderRef);
          await describe({ name: solution, kind: 'main', dir: location.repoPath, baseRef: null, parentBranch: null });
        } catch (error) {
          blockers.push(`${solution}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (record.cwd) {
      const top = (await git.try(record.cwd, ['rev-parse', '--show-toplevel'])).out;
      if (top === '') blockers.push(`${record.cwd} is not in a git repository: there is nothing to carry the files through`);
      else {
        const dir = await realpath(top).catch(() => top);
        const main = await git.mainCheckout(dir);
        await describe({ name: path.basename(main ?? dir), kind: main !== null && main !== dir ? 'worktree' : 'main', dir, baseRef: null, parentBranch: null });
      }
    } else {
      blockers.push(`${display} has no working folder`);
    }
    // D152: a workspace session also carries the repos its history shows it works in (the files it edited, its cwd's repo), not only the solutions it named;
    // D152 follow-up 2026-11-05: and the repos it only read in or ran commands in (ranked; the developer may leave any out in the dialog: `excludeRepos`).
    if (record.rootKind === 'workspace' && folderRef) {
      const found = await this.#worktrees.worksInFound(record).catch(() => []);
      const covered = new Map<string, number>();
      for (const [at, repo] of repos.entries()) {
        covered.set(await realpath(repo.path).catch(() => repo.path), at);
        if (repo.kind === 'main') covered.set(await realpath(repo.mainPath).catch(() => repo.mainPath), at);
      }
      for (const entry of found) {
        if (skippedPaths.has(await realpath(entry.top).catch(() => entry.top))) continue;
        if (entry.source === 'worktree') {
          const at = covered.get(await realpath(entry.top).catch(() => entry.top));
          if (at !== undefined) repos[at] = { ...(repos[at] as SourceRepo), found: 'worktree', evidence: entry.evidence };
          continue;
        }
        const top = await realpath(entry.top).catch(() => entry.top);
        const at = covered.get(top);
        if (at !== undefined) {
          repos[at] = { ...(repos[at] as SourceRepo), found: (repos[at] as SourceRepo).found ?? entry.source, evidence: entry.evidence };
          continue;
        }
        covered.set(top, repos.length);
        const main = await git.mainCheckout(top);
        const mainReal = main === null ? null : await realpath(main).catch(() => main);
        const linked = mainReal !== null && mainReal !== top;
        // D153: a worktree it found in its history (Claude Code's `.claude/worktrees/<name>`, one it made beside the checkout) is one of the agent's own.
        await describe({ name: linked ? path.basename(mainReal) : entry.name, kind: linked ? 'worktree' : 'main', dir: top, baseRef: null, parentBranch: null }, { source: entry.source, evidence: entry.evidence }, linked ? { prState: null } : undefined);
      }
    }
    if (repos.length === 0 && blockers.length === 0) {
      blockers.push(
        skippedWorktrees.length > 0
          ? `${display} works only in worktrees the move does not carry (${skippedWorktrees.map((entry) => `${path.basename(entry.path)}: ${entry.text}`).join('; ')}): there is nothing to carry the files through`
          : `${display} works in no git repository: there is nothing to carry the files through`,
      );
    }
    // D152: the workspace's own files (a workspace root that is no git checkout).
    let workspaceFiles: WorkspaceFilesListing | null = null;
    if (record.rootKind === 'workspace' && record.root && !(await isWorkingTreeTop(record.root))) workspaceFiles = await listWorkspaceFiles(record.root).catch(() => null);
    // The conversation.
    const conversation = await this.#conversationOf(record, blockers);
    const queued = (await this.#store.pendingMessages.pending(sessionId)).map((message) => message.text);
    let terminalPid: number | null = null;
    if (record.hooked) terminalPid = await this.#hooks.terminalPid(sessionId).catch(() => null);
    const busy = record.status === 'run' || record.status === 'need';
    return {
      result: {
        machine: self,
        platform: process.platform,
        sessionId,
        name: record.name,
        title: record.title,
        task: record.task,
        provider: record.provider,
        claudeSessionId: record.claudeSessionId,
        nativeId: record.provider === 'claude' ? record.claudeSessionId : await this.#store.providers.nativeId(sessionId, record.provider),
        origin: record.hooked ? 'terminal' : record.origin,
        cwd: record.cwd,
        folder: record.root && record.rootKind ? { path: record.root, kind: record.rootKind } : null,
        solutions: record.solutions,
        worktrees: record.worktrees,
        branch: record.branch,
        model: record.model,
        effort: record.effort,
        ultracode: record.ultracode,
        hooked: record.hooked,
        terminalPid,
        live: this.#supervisor.isLive(sessionId),
        busy,
        status: record.status,
        repos,
        conversation,
        queued,
        // D68: the session's todo list travels with it (open and done items; a done one keeps its hour).
        // D69: with its title, description and plan; `text` (= title) for a 1.7.0 target.
        todos: (await this.#store.todos.list(sessionId)).map((todo) => ({
          text: todo.title,
          title: todo.title,
          description: todo.description,
          plan: todo.plan,
          // D70: an older target ignores them.
          priority: todo.priority,
          estimateMinutes: todo.estimateMinutes,
          state: todo.state,
          addedBy: todo.addedBy,
          createdAt: todo.createdAt,
          doneAt: todo.doneAt,
          // D75: an item in progress stays in progress there (an older target reads it as open).
          startedAt: todo.startedAt,
          startedBy: todo.startedBy,
        })),
        // D94: its Switchboard loops travel with it (they fire on the target from then on).
        ...(this.#loops ? { loops: await this.#loops.portable(sessionId) } : {}),
        workspaceFiles,
        leftOut,
        skippedWorktrees,
        blockers,
      },
      log,
    };
  }

  /** How the session's conversation travels, and its real files (names + sizes). */
  async #conversationOf(record: SessionRecord, blockers: string[]): Promise<SourceInspect['conversation']> {
    if (record.provider === 'claude') {
      const found = await this.#claudeTranscript(record);
      if (found === null) {
        blockers.push(`no transcript of ${record.claudeSessionId} was found on this machine`);
        return { kind: 'claude-transcript', files: [], note: null };
      }
      const files = await this.#claudeFiles(found, record.claudeSessionId);
      if (files.some((file) => file.size > TAKEOVER_FILE_MAX_BYTES)) blockers.push(`the conversation has a file over ${TAKEOVER_FILE_MAX_BYTES / 1024 / 1024} MB: too large to move`);
      return { kind: 'claude-transcript', files: files.map(({ name, size }) => ({ name, size })), note: null };
    }
    if (record.provider === 'codex') {
      const rollout = await this.#codexRollout(record);
      if (rollout) {
        return { kind: 'codex-rollout', files: [{ name: `rollout/${rollout.relative}`, size: rollout.size }], note: 'Codex continues the same thread from its rollout file; if that fails the chat is handed over as a summary.' };
      }
    }
    return {
      kind: 'handover',
      files: [],
      note: `${CLI_LABELS[record.provider]}'s own record cannot be copied: the new agent reads the exported chat and continues from it (the D62 handover).`,
    };
  }

  async #claudeTranscript(record: SessionRecord): Promise<string | null> {
    if (record.transcriptPath && (await pathExists(record.transcriptPath))) return record.transcriptPath;
    return this.#supervisor.findTranscript(record.claudeSessionId);
  }

  async #claudeFiles(transcript: string, claudeSessionId: string): Promise<Array<{ name: string; abs: string; size: number }>> {
    const out: Array<{ name: string; abs: string; size: number }> = [{ name: `${claudeSessionId}.jsonl`, abs: transcript, size: (await stat(transcript)).size }];
    await walk(path.join(path.dirname(transcript), claudeSessionId), `${claudeSessionId}/`, out);
    return out;
  }

  async #codexRollout(record: SessionRecord): Promise<{ readonly abs: string; readonly relative: string; readonly size: number } | null> {
    const native = await this.#store.providers.nativeId(record.id, 'codex');
    if (!native) return null;
    const home = await this.#accounts.dirOf(record.profileId, 'codex');
    if (!home) return null;
    const abs = await findCodexRollout({ CODEX_HOME: home }, native);
    if (!abs) return null;
    const relative = path.relative(path.join(home, 'sessions'), abs).split(path.sep).join('/');
    return { abs, relative, size: (await stat(abs)).size };
  }

  /**
   * Step 2: stops the session where it runs. A Switchboard-run session is paused
   * (D7); a hooked terminal session is left alone here (its process is stopped
   * after the capture, {@link stopTerminal}). Registers the take-over: a second one
   * for the same session is refused until this one ends.
   */
  async stop(opId: string, sessionId: string): Promise<OpAnswer<{ readonly wasLive: boolean; readonly wasBusy: boolean }>> {
    const record = await this.#store.sessions.get(sessionId);
    if (!record) throw new TakeoverError(404, 'not-found', `no session ${sessionId}`);
    await this.#expireStale(sessionId);
    if (this.#activeSessions.has(sessionId)) throw new TakeoverError(409, 'in-progress', 'this session is being taken over already');
    const op: SourceOp = {
      sessionId,
      claudeSessionId: record.claudeSessionId,
      hooked: record.hooked,
      wasLive: false,
      wasBusy: record.status === 'run' || record.status === 'need',
      captured: [],
      terminalStopped: false,
      startedAt: Date.now(),
      files: new Map(),
      workspace: new Map(),
      finished: false,
    };
    this.#activeSessions.add(sessionId);
    this.#sources.set(opId, op);
    try {
      if (!record.hooked && this.#supervisor.isLive(sessionId)) {
        op.wasLive = true;
        await this.#supervisor.pause(sessionId);
      }
    } catch (error) {
      this.#forgetSource(opId);
      throw error;
    }
    return { result: { wasLive: op.wasLive, wasBusy: op.wasBusy }, log: [] };
  }

  #source(opId: string): SourceOp {
    const op = this.#sources.get(opId);
    if (!op) throw new TakeoverError(404, 'unknown-operation', `no take-over ${opId} is running here`);
    return op;
  }

  /**
   * A take-over whose initiating machine went away (it never finished or rolled
   * back) would hold its session "being taken over" for ever: after 30 minutes the
   * next call rolls it back (its temp branches are deleted, a paused session runs again).
   */
  async #expireStale(sessionId: string): Promise<void> {
    for (const [opId, op] of [...this.#sources.entries()]) {
      if (op.sessionId === sessionId && Date.now() - op.startedAt > SOURCE_OP_TTL_MS) await this.rollbackSource(opId).catch((error: unknown) => this.#onError(error));
    }
  }

  #forgetSource(opId: string): void {
    const op = this.#sources.get(opId);
    if (op) this.#activeSessions.delete(op.sessionId);
    this.#sources.delete(opId);
  }

  /**
   * Step 3: for every repo, the WIP commit (everything uncommitted, untracked files
   * included, ignored ones not; made without touching the branch, the index or the
   * working tree) and its push to the temporary branch. The temp branches are
   * written to the leftovers list at once, so a crash never loses track of them.
   */
  async capture(opId: string, exclude: readonly string[] = []): Promise<OpAnswer<{ readonly repos: readonly CapturedRepo[] }>> {
    const op = this.#source(opId);
    const log: string[] = [];
    const git = this.#git(log);
    const inspected = (await this.inspectRepos(op.sessionId, log)).repos;
    // D152 follow-up 2026-11-05: a repo the developer left out is not captured (no temp branch).
    const left = new Set(exclude);
    for (const repo of inspected) {
      if (left.has(repo.path)) continue;
      const captured = await git.capture(repo, op.sessionId);
      const leftover = await this.#addLeftover({ repoPath: repo.path, remoteName: repo.remoteName, remoteUrl: repo.remoteUrl, branch: captured.tempBranch, reason: null });
      op.captured.push({ ...captured, repoPath: repo.path, leftoverId: leftover.id });
    }
    return { result: { repos: op.captured.map(({ repoPath: _repoPath, leftoverId: _leftoverId, ...rest }) => rest) }, log };
  }

  /** The repos as they are now (the capture re-reads them: the preview may be old). */
  async inspectRepos(sessionId: string, log: string[] = []): Promise<{ readonly repos: readonly SourceRepo[] }> {
    const answer = await this.inspect(sessionId);
    log.push(...answer.log);
    const real = answer.result.blockers.filter((blocker) => !blocker.includes('is being taken over already'));
    if (real.length > 0) throw new TakeoverError(409, 'blocked', real.join('; '));
    return { repos: answer.result.repos };
  }

  /** Stops a hooked session's terminal `claude` (after the capture). */
  async stopTerminal(opId: string): Promise<OpAnswer<{ readonly pid: number | null; readonly how: string }>> {
    const op = this.#source(opId);
    if (!op.hooked) throw new TakeoverError(409, 'not-hooked', 'this session is not a hooked terminal session');
    const stopped = await this.#hooks.stopTerminal(op.sessionId);
    op.terminalStopped = true;
    return { result: stopped, log: [stopped.pid === null ? 'the terminal process was already gone' : `stopped the terminal's claude (pid ${stopped.pid}): ${stopped.how}`] };
  }

  /**
   * Step 4 (source): lists the conversation's files with their checksums and keeps
   * what each name stands for. Generated files (`@chat.md`, `@messages.json`) are
   * built here: the D62 handover export and the chat as messages.
   */
  async files(opId: string): Promise<OpAnswer<{ readonly kind: ConversationKind; readonly files: readonly ConversationFile[] }>> {
    const op = this.#source(opId);
    const record = await this.#store.sessions.get(op.sessionId);
    if (!record) throw new TakeoverError(404, 'not-found', `no session ${op.sessionId}`);
    op.files.clear();
    const list: ConversationFile[] = [];
    const add = async (name: string, abs: string): Promise<void> => {
      const info = await stat(abs);
      if (info.size > TAKEOVER_FILE_MAX_BYTES) throw new TakeoverError(413, 'too-large', `${name} is ${info.size} bytes: the limit is ${TAKEOVER_FILE_MAX_BYTES}`);
      op.files.set(name, { abs });
      list.push({ name, size: info.size, sha256: await sha256Of(abs) });
    };
    const addBytes = (name: string, bytes: Buffer): void => {
      op.files.set(name, { bytes });
      list.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    };
    let kind: ConversationKind = 'handover';
    if (record.provider === 'claude') {
      const found = await this.#claudeTranscript(record);
      if (found === null) throw new TakeoverError(409, 'no-transcript', `no transcript of ${record.claudeSessionId} was found`);
      kind = 'claude-transcript';
      for (const file of await this.#claudeFiles(found, record.claudeSessionId)) await add(file.name, file.abs);
    } else {
      const rollout = record.provider === 'codex' ? await this.#codexRollout(record) : null;
      if (rollout) {
        kind = 'codex-rollout';
        await add(`rollout/${rollout.relative}`, rollout.abs);
      }
      const events = await this.#store.events.list(op.sessionId);
      const agents = await this.#store.agents.listBySession(op.sessionId);
      const mainAgentId = agents.find((agent) => agent.kind === 'main')?.id ?? null;
      addBytes(
        '@chat.md',
        Buffer.from(chatMarkdown({ title: record.title ?? record.name, cwd: record.cwd ?? '', from: record.provider, to: record.provider, at: new Date(), events, mainAgentId })),
      );
      const messages: Array<{ role: 'user' | 'assistant'; text: string; ts: string }> = [];
      for (const event of events) {
        const payload = isRecord(event.payload) ? event.payload : {};
        if (event.agentId && mainAgentId && event.agentId !== mainAgentId) continue;
        if (payload['type'] === 'user' && typeof payload['text'] === 'string') messages.push({ role: 'user', text: payload['text'], ts: event.ts });
        else if (payload['type'] === 'assistant' && typeof payload['text'] === 'string') messages.push({ role: 'assistant', text: payload['text'], ts: event.ts });
      }
      addBytes('@messages.json', Buffer.from(JSON.stringify(messages.slice(-2000))));
    }
    return { result: { kind, files: list }, log: [] };
  }

  /** One chunk of a listed file (at most {@link TAKEOVER_CHUNK_BYTES} raw bytes). */
  async readChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer> {
    const op = this.#source(opId);
    const entry = op.files.get(name);
    if (!entry) throw new TakeoverError(404, 'unknown-file', `${name} is not part of this take-over`);
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

  /**
   * D152 (source): the workspace files this take-over sends, read again now (the
   * preview may be old): each must still be listed and copyable; its path is kept
   * for the chunks. Answers each one's size, checksum and secret mark.
   */
  async workspaceFiles(opId: string, names: readonly string[]): Promise<OpAnswer<{ readonly files: ReadonlyArray<Pick<WorkspaceFileInfo, 'name' | 'size' | 'sha256'> & { readonly secret: boolean }> }>> {
    const op = this.#source(opId);
    const record = await this.#store.sessions.get(op.sessionId);
    if (!record || record.rootKind !== 'workspace' || !record.root) throw new TakeoverError(409, 'not-workspace', 'this session has no workspace folder');
    const listing = await listWorkspaceFiles(record.root);
    const out: Array<Pick<WorkspaceFileInfo, 'name' | 'size' | 'sha256'> & { readonly secret: boolean }> = [];
    op.workspace.clear();
    for (const name of new Set(names)) {
      const file = listing.files.find((entry) => entry.name === name);
      if (!file) throw new TakeoverError(404, 'unknown-file', `${name} is not one of the workspace's files here`);
      if (file.refused !== null || file.sha256 === null) throw new TakeoverError(413, 'too-large', `${name} cannot be copied: ${file.refused ?? 'unreadable'}`);
      op.workspace.set(name, await sourceWorkspaceFile(listing.root, name));
      out.push({ name, size: file.size, sha256: file.sha256, secret: file.secret !== null });
    }
    return { result: { files: out }, log: [] };
  }

  /** D152 (source): one chunk of a workspace file {@link workspaceFiles} listed. */
  async readWorkspaceChunk(opId: string, name: string, offset: number): Promise<ChunkAnswer> {
    const op = this.#source(opId);
    const abs = op.workspace.get(name);
    if (!abs) throw new TakeoverError(404, 'unknown-file', `${name} is not part of this take-over`);
    if (!Number.isInteger(offset) || offset < 0) throw new TakeoverError(422, 'invalid', 'offset must be a whole number of bytes');
    const handle: FileHandle = await open(abs, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > WORKSPACE_FILE_MAX_BYTES) throw new TakeoverError(413, 'too-large', `${name} grew over the limit`);
      const buffer = Buffer.alloc(Math.min(TAKEOVER_CHUNK_BYTES, Math.max(0, size - offset)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { name, size, offset, length: bytesRead, data: buffer.subarray(0, bytesRead).toString('base64'), eof: offset + bytesRead >= size };
    } finally {
      await handle.close();
    }
  }

  /**
   * Step 7 (source): the session is **moved**: `moved_to` is stored, a note is
   * recorded in its chat, queued messages are marked handed over, and the session
   * is closed (read-only, `reopen` refuses it). The temporary branches the target
   * could not delete are deleted here; what still fails is reported.
   */
  async finish(opId: string, move: SessionMove, stillThere: readonly string[]): Promise<OpAnswer<{ readonly leftovers: readonly Leftover[]; readonly closeError: string | null }>> {
    const op = this.#source(opId);
    const log: string[] = [];
    const git = this.#git(log);
    const record = await this.#store.sessions.get(op.sessionId);
    let closeError: string | null = null;
    if (record) {
      try {
        for (const message of await this.#store.pendingMessages.pending(op.sessionId)) await this.#store.pendingMessages.markDelivered(message.id);
        await this.#store.sessions.update(op.sessionId, { movedTo: move });
        await this.#supervisor.recordServiceEvent(op.sessionId, 'text', movedToLabel(move.machineName), {
          type: 'lifecycle',
          action: 'moved-away',
          machine: move.machineName,
          machineId: move.machineId,
          remoteSessionId: move.sessionId,
        });
        // D94: its Switchboard loops fire on the target now.
        await this.#loops?.endAll(op.sessionId, `the session moved to ${move.machineName}`);
        await this.#supervisor.close(op.sessionId, { confirm: true, beforePublish: (id) => this.#questions.closeSession(id) });
        if (record.hooked) await this.#hooks.unhooked(op.sessionId);
      } catch (error) {
        closeError = error instanceof Error ? error.message : String(error);
        this.#onError(error);
      }
    }
    const leftovers: Leftover[] = [];
    for (const captured of op.captured) {
      if (captured.leftoverId === null) continue;
      // The target deleted it already (not in `stillThere`): just forget it here (and the tracking ref the push made).
      if (!stillThere.includes(captured.key)) {
        await git.forgetTrackingRef(captured.repoPath, captured.remoteName, captured.tempBranch);
        await this.#removeLeftover(captured.leftoverId);
        continue;
      }
      try {
        await git.deleteTempBranch(captured.repoPath, captured.remoteName, captured.tempBranch);
        await this.#removeLeftover(captured.leftoverId);
      } catch (error) {
        const found = (await this.#leftovers()).find((entry) => entry.id === captured.leftoverId);
        if (found) leftovers.push({ ...found, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    op.finished = true;
    this.#forgetSource(opId);
    return { result: { leftovers, closeError }, log };
  }

  /**
   * Undo on the source after a failure before the session resumed on the target:
   * the temporary branches are deleted (the source's branch, index and working tree
   * were never touched, so there is no WIP commit to undo) and a Switchboard-run
   * session that was running is started again (idle stays idle; an interrupted turn
   * gets "Continue."). A hooked terminal's stopped process cannot be started again
   * from here: the note says how.
   */
  async rollbackSource(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[] }>> {
    const op = this.#sources.get(opId);
    if (!op) return { result: { notes: [] }, log: [] };
    const log: string[] = [];
    const git = this.#git(log);
    const notes: string[] = [];
    for (const captured of op.captured) {
      try {
        await git.deleteTempBranch(captured.repoPath, captured.remoteName, captured.tempBranch);
        if (captured.leftoverId) await this.#removeLeftover(captured.leftoverId);
      } catch (error) {
        notes.push(`could not delete the temporary branch ${captured.tempBranch}: ${error instanceof Error ? error.message : String(error)} (it is listed for a one-click delete)`);
      }
    }
    if (op.hooked && op.terminalStopped) {
      notes.push(`the terminal's claude was stopped before the failure: start it again with \`claude --resume ${op.claudeSessionId}\` in its folder`);
    } else if (!op.hooked && op.wasLive) {
      try {
        if (op.wasBusy) await this.#supervisor.resume(op.sessionId);
        else await this.#supervisor.respawn(op.sessionId);
        notes.push('the session runs here again');
      } catch (error) {
        notes.push(`could not resume the session here: ${error instanceof Error ? error.message : String(error)} (Resume it by hand)`);
      }
    }
    this.#forgetSource(opId);
    return { result: { notes }, log };
  }

  // ═══ target ═══════════════════════════════════════════════════════════

  /** The saved repos on this machine (every remote of each), the matching candidates for `names`. */
  async #candidates(names: readonly string[], git: TakeoverGit): Promise<TargetCandidate[]> {
    const out: TargetCandidate[] = [];
    const seen = new Set<string>();
    const add = async (repoPath: string, folder: { readonly id: string; readonly canonicalPath: string; readonly kind: 'workspace' | 'repo' }, name: string): Promise<void> => {
      if (seen.has(`${folder.id}\n${repoPath}`)) return;
      seen.add(`${folder.id}\n${repoPath}`);
      const remotes = (await git.try(repoPath, ['remote'])).out.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      if (remotes.length === 0) {
        out.push({ path: repoPath, folderId: folder.id, folderKind: folder.kind, folderPath: folder.canonicalPath, name, remoteKey: null, remoteName: null });
        return;
      }
      for (const remote of remotes) {
        const url = await git.try(repoPath, ['remote', 'get-url', remote]);
        out.push({ path: repoPath, folderId: folder.id, folderKind: folder.kind, folderPath: folder.canonicalPath, name, remoteKey: url.ok ? normalizeRemoteUrl(url.out) : null, remoteName: remote });
      }
    };
    for (const record of await this.#store.folders.list()) {
      if (record.kind === 'plain') continue;
      const folder = { id: record.id, canonicalPath: record.canonicalPath, kind: record.kind };
      if (record.kind === 'repo') {
        if (await git.isRepo(record.canonicalPath)) await add(record.canonicalPath, folder, path.basename(record.canonicalPath));
        continue;
      }
      for (const name of new Set(names)) {
        try {
          const location = await this.#worktrees.resolveRepo(name, folderRefOf(record));
          await add(location.repoPath, folder, name);
        } catch {
          // Not in this workspace.
        }
      }
    }
    return out;
  }

  /** D110: the places a listing or a search may look into on this machine (home, saved folders and their parents). */
  async #places(): Promise<string[]> {
    return allowedPlaces(this.#folders.expand('~'), (await this.#store.folders.list()).map((record) => record.canonicalPath));
  }

  /**
   * D110 `POST /api/takeover/target/folders` `{ path? }` (peer-callable, read-only):
   * the folder picker's listing of this machine: the folders inside `path` (never
   * a file), or with no path the starting places (the saved folders and the home
   * folder). A path outside the home folder and the saved folders (and their
   * parents) is refused (403); links are resolved first.
   */
  async listTargetFolders(input: string | null): Promise<TargetDirListing> {
    const self = await this.#self();
    const places = await this.#places();
    const records = await this.#store.folders.list();
    const home = this.#folders.expand('~');
    const starting: TargetDirListing['places'] = [
      ...records.map((record) => ({ label: record.label ?? path.basename(record.canonicalPath), path: record.canonicalPath, kind: record.kind })),
      { label: 'Home', path: home, kind: 'home' as const },
    ];
    if (input === null || input.trim() === '') return { machine: self, platform: process.platform, path: null, parent: null, entries: [], places: starting };
    let dir: string;
    try {
      dir = await resolveAllowed(this.#folders.expand(input.trim()), places);
    } catch (error) {
      if (error instanceof LocateRefusal) throw new TakeoverError(error.status, error.status === 403 ? 'outside' : 'invalid', error.message);
      throw error;
    }
    const up = path.dirname(dir);
    const parent = up !== dir && (await resolveAllowed(up, places).then(() => true, () => false)) ? up : null;
    return { machine: self, platform: process.platform, path: dir, parent, entries: await listFolders(dir), places: starting };
  }

  /**
   * D110: finds the session's repos under the chosen folders. Every checkout under
   * a root (bounded depth, `findCheckouts`) and every per-repo override is read
   * (remotes, branch, uncommitted count); a repo matches a checkout that has a
   * remote with the same normalised key, never by its folder's name (a checkout
   * named like it without that remote is only a hint). One match (or the
   * developer's pick among several) is the candidate the plan uses.
   */
  async #locate(repos: readonly SourceRepo[], placement: TargetPlacement, sourceFolder: string | null, git: TakeoverGit, newRoot: WorkspaceRootCheck | null = null): Promise<{
    readonly roots: string[];
    readonly problems: string[];
    readonly perRepo: Array<{ readonly matches: CheckoutFacts[]; readonly hints: Array<{ path: string; remote: string | null }>; readonly state: RepoCheck['state']; readonly path: string | null }>;
    readonly candidates: TargetCandidate[];
    readonly matches: Array<TargetCandidate | null>;
    readonly workspace: { readonly path: string; readonly folderId: string | null } | null;
    readonly defaults: Record<string, string>;
  }> {
    const places = await this.#places();
    const records = await this.#store.folders.list();
    const problems: string[] = [];
    const roots: string[] = [];
    for (const root of placement.roots) {
      try {
        const real = await resolveAllowed(this.#folders.expand(root), places);
        if (!roots.includes(real)) roots.push(real);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    // D152: a workspace root the developer creates is searched too once it exists (an earlier move made it, or it was empty).
    if (newRoot?.ok && newRoot.exists && !roots.includes(newRoot.path)) roots.unshift(newRoot.path);
    if (placement.roots.length === 0 && Object.keys(placement.repoPaths ?? {}).length === 0 && !placement.newWorkspace) problems.push('choose at least one folder on this machine');
    // Every checkout under the roots, then the overrides.
    const facts = new Map<string, CheckoutFacts>();
    for (const root of roots) for (const dir of await findCheckouts(root)) if (!facts.has(dir)) facts.set(dir, await checkoutFacts(dir, git));
    const overrides: Record<string, string> = {};
    for (const [key, typed] of Object.entries(placement.repoPaths ?? {})) {
      try {
        const real = await resolveAllowed(this.#folders.expand(typed), places);
        if (!(await isMainCheckout(real))) {
          problems.push(`${typed} is not a git checkout (a repo's own folder, not a worktree)`);
          continue;
        }
        overrides[key] = real;
        if (!facts.has(real)) facts.set(real, await checkoutFacts(real, git));
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    const folderOf = (dir: string): { id: string | null; kind: 'workspace' | 'repo'; path: string } => {
      const repoFolder = records.find((record) => record.kind === 'repo' && record.canonicalPath === dir);
      if (repoFolder) return { id: repoFolder.id, kind: 'repo', path: repoFolder.canonicalPath };
      const holder = records.find((record) => record.kind === 'workspace' && dir.startsWith(`${record.canonicalPath}${path.sep}`));
      return holder ? { id: holder.id, kind: 'workspace', path: holder.canonicalPath } : { id: null, kind: 'repo', path: dir };
    };
    const all = [...facts.values()];
    const perRepo = [];
    const candidates: TargetCandidate[] = [];
    const matches: Array<TargetCandidate | null> = [];
    for (const repo of repos) {
      const key = repo.remoteKey;
      const found = key === '' ? [] : all.filter((entry) => entry.remotes.some((remote) => remote.key === key));
      const chosen = overrides[repo.key] ?? null;
      const overrideFacts = chosen !== null ? facts.get(chosen) : undefined;
      if (chosen !== null && overrideFacts && !found.includes(overrideFacts)) {
        problems.push(`${chosen} is not a checkout of ${repo.name}: its remote is ${overrideFacts.remotes[0]?.url ?? 'missing'}, the session's is ${repo.remoteUrl}`);
      }
      const hints = all
        .filter((entry) => !found.includes(entry) && path.basename(entry.path).toLowerCase() === repo.name.toLowerCase())
        .map((entry) => ({ path: entry.path, remote: entry.remotes[0]?.url ?? null }));
      // D152: the developer chose to clone this repo: a checkout found here is not used.
      const judged = placement.repoModes?.[repo.key] === 'clone' ? { state: 'missing' as const, path: null } : checkStateOf(found, chosen !== null && found.includes(overrideFacts as CheckoutFacts) ? chosen : null, repo.branch);
      perRepo.push({ matches: found, hints, state: judged.state, path: judged.path });
      if (judged.path !== null) {
        const folder = folderOf(judged.path);
        const remote = (found.find((entry) => entry.path === judged.path) as CheckoutFacts).remotes.find((entry) => entry.key === key);
        const candidate: TargetCandidate = { path: judged.path, folderId: folder.id, folderKind: folder.kind, folderPath: folder.path, name: path.basename(judged.path), remoteKey: key, remoteName: remote?.name ?? null };
        candidates.push(candidate);
        matches.push(candidate);
      } else {
        matches.push(null);
      }
    }
    // Where a workspace session lives: the first root that is a workspace (saved or not).
    let workspace: { path: string; folderId: string | null } | null = newRoot?.ok ? { path: newRoot.path, folderId: records.find((record) => record.canonicalPath === newRoot.path)?.id ?? null } : null;
    for (const root of workspace ? [] : roots) {
      if ((await this.#folders.check(root)).kind !== 'workspace') continue;
      workspace = { path: root, folderId: records.find((record) => record.canonicalPath === root)?.id ?? null };
      break;
    }
    // Where a missing repo is cloned: the workspace's layout (as on the source), else the first root.
    const defaults: Record<string, string> = {};
    const first = roots[0];
    for (const repo of repos) {
      const layout = workspace && sourceFolder ? layoutInside(sourceFolder, repo.mainPath) : null;
      if (workspace && layout) defaults[repo.key] = path.join(workspace.path, ...layout);
      else if (first) defaults[repo.key] = path.join(workspace?.path ?? first, repo.name);
    }
    return { roots, problems, perRepo, candidates, matches, workspace, defaults };
  }

  /**
   * The target's view: which repos are used, cloned or blocked, whether the CLI
   * runs here and on which account. Read-only (it may fetch nothing and change
   * nothing). D110: with a `placement` the repos are looked for under the chosen
   * folders (`#locate`) instead of among the saved folders, and the plan carries
   * the verification table the dialog shows; the apply then uses exactly these
   * paths.
   */
  async plan(body: Pick<TargetBody, 'source' | 'clonePaths' | 'placement' | 'stashTargets'> & { readonly opId?: string }): Promise<OpAnswer<TargetPlan>> {
    const log: string[] = [];
    const git = this.#git(log);
    const source = body.source;
    // D110: matched by this machine's normalisation of the URL (an older source's key may differ in case).
    const sourceRepos: SourceRepo[] = source.repos.map((repo) => ({ ...repo, remoteKey: remoteKeyOf(repo) }));
    const placement = body.placement ?? null;
    const self = await this.#self();
    const blockers: string[] = [];
    const records = await this.#store.folders.list();
    // D152: the workspace root the developer asked to create here: checked (read-only) before anything else.
    const workspaceRoot: WorkspaceRootCheck | null = placement?.newWorkspace ? await checkWorkspaceRoot(this.#folders.expand(placement.newWorkspace.path), placement.newWorkspace.useExisting === true, await this.#places()) : null;
    if (workspaceRoot && !workspaceRoot.ok && workspaceRoot.reason) blockers.push(workspaceRoot.reason);
    const located = placement ? await this.#locate(sourceRepos, placement, source.folder?.path ?? null, git, workspaceRoot) : null;
    const names = [...new Set([...sourceRepos.map((repo) => repo.name), ...source.solutions])];
    const candidates = located ? located.candidates : await this.#candidates(names, git);
    // The default clone folder: next to the default saved folder (D110: the first chosen folder).
    const defaultFolder = records.find((record) => record.isDefault) ?? records[0] ?? null;
    const defaultCloneParent = located ? (located.workspace?.path ?? located.roots[0] ?? null) : defaultFolder ? path.dirname(defaultFolder.canonicalPath) : null;
    if (located) blockers.push(...located.problems);
    // Facts the pure planner needs.
    const exists = new Set<string>();
    const checkedOut = new Set<string>();
    const dirtyTargets = new Set<string>();
    // D153: what changed in each dirty checkout (shown with the blocker / the stash choice).
    const targetChanges = new Map<string, TargetChanges>();
    // D153: one of the agent's own worktrees keeps its place next to the checkout; two worktrees never share a path.
    const worktreeOf = (repoPath: string, sessionName: string, repo?: SourceRepo): string => (repo?.worktreeAt && isSafeWorktreeLayout(repo.worktreeAt) ? path.resolve(worktreeAtTarget(repoPath, repo.worktreeAt)) : worktreePathOf(repoPath, sessionName));
    const worktreeUsers = new Map<string, string>();
    // The worktree paths in the way (a live worktree, a non-empty folder…): blockers before anything is paused.
    const worktreeBlockers = new Map<string, string>();
    const checkWorktreePath = async (repoPath: string | null, worktree: string, repoName: string): Promise<void> => {
      const reason = worktreeSlotBlocker(await git.worktreeSlot(repoPath, worktree), { machine: self.name, path: worktree, repo: repoName });
      if (reason !== null) worktreeBlockers.set(worktree, reason);
    };
    // D153: a second worktree planned at the same path is refused (never a quiet `…-2`).
    const claimWorktree = (worktree: string, repo: SourceRepo): void => {
      const first = worktreeUsers.get(worktree);
      if (first === undefined) worktreeUsers.set(worktree, repo.path);
      else if (first !== repo.path && !worktreeBlockers.has(worktree)) worktreeBlockers.set(worktree, `two worktrees would go to ${worktree} on ${self.name} (${first} and ${repo.path}): leave one of them out`);
    };
    const typed = body.clonePaths ?? {};
    const workspaceDefaults: Record<string, string> = located ? { ...located.defaults } : {};
    const matches = located ? located.matches : sourceRepos.map((repo) => matchingCandidates(repo, candidates)[0] ?? null);
    // A workspace session clones into the workspace's own layout.
    let workspace: TargetCandidate | null = null;
    if (source.folder?.kind === 'workspace' && !source.hooked) {
      if (located) {
        if (located.workspace) workspace = { path: located.workspace.path, folderId: located.workspace.folderId, folderKind: 'workspace', folderPath: located.workspace.path, name: path.basename(located.workspace.path), remoteKey: null, remoteName: null };
        else blockers.push('none of the chosen folders is a workspace (a folder with the router AGENTS.md): choose the workspace root on this machine');
      } else {
        const counts = new Map<string, number>();
        for (const match of matches) if (match && match.folderKind === 'workspace' && match.folderId) counts.set(match.folderId, (counts.get(match.folderId) ?? 0) + 1);
        const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        workspace = matches.find((match) => match?.folderId === best?.[0]) ?? null;
        if (workspace === null) {
          // No repo matched at all: picking some saved workspace would be a guess, so the take-over stops here.
          blockers.push('no saved workspace folder on this machine holds any of this session\'s repos: add the workspace folder here first (Settings → Folders), or choose the target folders');
        } else {
          for (const repo of sourceRepos) {
            const candidate = solutionCandidates(workspace.folderPath, repo.name)?.[0];
            if (candidate) workspaceDefaults[repo.key] = candidate;
          }
        }
      }
    }
    for (let index = 0; index < sourceRepos.length; index++) {
      const repo = sourceRepos[index] as SourceRepo;
      const match = matches[index];
      if (match) {
        const worktree = repo.kind === 'worktree' ? worktreeOf(match.path, source.name, repo) : null;
        if (worktree) await checkWorktreePath(match.path, worktree, repo.name);
        if (worktree) claimWorktree(worktree, repo);
        const branches = await git.checkedOutBranches(match.path);
        const holder = branches.get(repo.branch);
        if (holder !== undefined && (repo.kind === 'worktree' || path.resolve(holder) !== path.resolve(match.path))) checkedOut.add(`${match.path}\n${repo.branch}`);
        if (repo.kind === 'main' && !dirtyTargets.has(match.path) && (await git.dirtyCounts(match.path)).total > 0) {
          dirtyTargets.add(match.path);
          targetChanges.set(match.path, await git.targetChanges(match.path));
        }
      } else {
        const to = typed[repo.key]?.trim() || workspaceDefaults[repo.key] || (defaultCloneParent ? path.join(defaultCloneParent, repo.name) : '');
        if (to !== '') {
          if (await pathExists(to)) exists.add(to);
          if (repo.kind === 'worktree') {
            const worktree = worktreeOf(to, source.name, repo);
            await checkWorktreePath(null, worktree, repo.name);
            claimWorktree(worktree, repo);
          }
        }
      }
    }
    let repos: RepoResolution[] = planRepos(sourceRepos, candidates, {
      clonePaths: { ...workspaceDefaults, ...typed },
      sessionName: source.name,
      defaultCloneParent,
      exists,
      checkedOut,
      dirtyTargets,
      targetChanges,
      ...(body.stashTargets ? { stashTargets: body.stashTargets } : {}),
      machineName: self.name,
      worktreeBlockers,
      worktreePathOf: worktreeOf,
    });
    // D110: several checkouts of one repo under the chosen folders and no pick: the developer chooses (never a guess).
    if (located) {
      repos = repos.map((resolution, index) => {
        const found = located.perRepo[index];
        if (found?.state !== 'ambiguous') return resolution;
        const reason = `${resolution.name} has ${found.matches.length} checkouts under the chosen folders: choose which one to use`;
        return { ...resolution, action: 'blocked', matchedPath: null, folderId: null, worktreePath: null, cloneTo: null, cloneUrl: null, reason, summary: reason };
      });
    }
    // The remotes: this service must be able to read each one it will fetch from or clone (a key the terminal can use may not be usable here).
    repos = await this.#checkRemotes(repos, sourceRepos, self.name, git);
    blockers.push(...planBlockers(repos));
    // The CLI and the account.
    const refusal = await this.#clis.refusal(source.provider).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    const profileId = await this.#accounts.pick(source.provider).catch(() => null);
    const profile = profileId ? await this.#store.profiles.get(profileId) : null;
    if (refusal) blockers.push(`${CLI_LABELS[source.provider]} cannot run on ${self.name}: ${refusal}`);
    // A conversation that is already a session here.
    const existing = await this.#store.sessions.getByClaudeSessionId(source.claudeSessionId);
    if (existing && !(existing.movedTo && existing.closedAt !== null)) blockers.push(`${self.name} has this conversation as a session already (${existing.title ?? existing.name})`);
    // Where the session lives.
    let folder: TargetPlan['folder'] = null;
    let cwd: string | null = null;
    const usable = repos.filter((repo) => repo.action !== 'blocked');
    if (blockers.length === 0 || usable.length === repos.length) {
      if (workspace) {
        folder = { id: workspace.folderId, path: workspace.folderPath, kind: 'workspace' };
        cwd = workspace.folderPath;
      } else if (source.folder?.kind === 'workspace' && !source.hooked) {
        folder = null;
      } else if (repos.length > 1) {
        blockers.push('this session works in several repos outside a workspace folder: it cannot be placed on this machine');
      } else if (repos[0] && repos[0].action !== 'blocked') {
        const first = repos[0];
        const match = matches[0];
        folder = match ? { id: match.folderId, path: match.folderPath, kind: match.folderKind } : { id: null, path: first.cloneTo as string, kind: 'repo' };
        cwd = first.worktreePath ?? first.matchedPath ?? first.cloneTo;
      }
    }
    const verification: TargetVerification | null = located
      ? {
          roots: located.roots,
          problems: located.problems,
          repos: repos.map((resolution, index): RepoCheck => {
            const found = located.perRepo[index] as (typeof located.perRepo)[number];
            const pick = found.matches.find((entry) => entry.path === found.path) ?? null;
            const differences: string[] = [];
            if (pick && pick.branch !== resolution.branch) differences.push(`on ${pick.branch ?? 'a detached HEAD'}, not ${resolution.branch}`);
            if (pick && pick.dirty > 0) differences.push(`${pick.dirty} uncommitted file${pick.dirty === 1 ? '' : 's'} there`);
            const hint = found.state === 'missing' && found.hints.length > 0 ? ` (${found.hints.map((entry) => `${entry.path} is named like it but its remote is ${entry.remote ?? 'missing'}`).join('; ')})` : '';
            return {
              key: resolution.key,
              name: resolution.name,
              branch: resolution.branch,
              state: found.state,
              matches: found.matches.map((entry) => ({ path: entry.path, branch: entry.branch, dirty: entry.dirty })),
              path: found.path,
              hints: found.hints,
              cloneTo: resolution.action === 'clone' ? resolution.cloneTo : null,
              ok: resolution.action !== 'blocked',
              note: `${differences.length > 0 ? `${differences.join(', ')}. ` : ''}${resolution.summary}${hint}`,
            };
          }),
        }
      : null;
    // D152: what is at each of the workspace's own files' paths under the workspace root here.
    let workspaceFiles: WorkspaceFileTarget[] | null = null;
    if (source.workspaceFiles && source.workspaceFiles.files.length > 0 && workspace) {
      const root = workspaceRoot && !workspaceRoot.exists ? null : workspace.folderPath;
      workspaceFiles = await workspaceFileStates(root, source.workspaceFiles.files);
    }
    return {
      result: {
        machine: self,
        platform: process.platform,
        cli: { provider: source.provider, label: CLI_LABELS[source.provider], available: refusal === null, reason: refusal },
        account: { profileId: profileId ?? null, name: profile?.name ?? 'Default' },
        repos,
        folder,
        cwd,
        blockers,
        defaultCloneParent,
        placement,
        verification,
        workspaceRoot,
        workspaceFiles,
      },
      log,
    };
  }

  /**
   * The remote check of the plan (`docs/peers.md` → *Reaching the remote*): for every
   * repo the take-over will fetch into, `git ls-remote` of the checkout's matching
   * remote, and for every repo it will clone, of the clone URL, all at once, from
   * this process (the background service, its own keys and credential helpers),
   * non-interactive and bounded ({@link TakeoverGit.reachable}). A remote it cannot
   * read blocks that repo with git's reason and a hint, before anything is paused.
   * Nothing is cached: every preview, check and apply asks again.
   */
  async #checkRemotes(repos: RepoResolution[], sourceRepos: readonly SourceRepo[], machine: string, git: TakeoverGit): Promise<RepoResolution[]> {
    return Promise.all(
      repos.map(async (resolution): Promise<RepoResolution> => {
        if (resolution.action === 'blocked') return resolution;
        const repo = sourceRepos.find((entry) => entry.key === resolution.key);
        if (!repo) return resolution;
        let cwd: string;
        let remote: string;
        let url: string;
        let remoteName: string | null = null;
        if (resolution.action === 'use' && resolution.matchedPath) {
          const found = await git.remoteByKey(resolution.matchedPath, remoteKeyOf(repo));
          // No such remote: the apply says so ("has no remote for …"); nothing to ask here.
          if (found === null) return resolution;
          cwd = resolution.matchedPath;
          remote = found.name;
          url = found.url;
          remoteName = found.name;
        } else if (resolution.action === 'clone' && resolution.cloneUrl && isCloneableUrl(resolution.cloneUrl)) {
          cwd = os.tmpdir();
          remote = resolution.cloneUrl;
          url = resolution.cloneUrl;
        } else {
          return resolution;
        }
        const reach = await git.reachable(cwd, remote);
        if (reach.ok) return resolution;
        const reason = unreachableRemoteText({ machine, repo: resolution.name, url, remoteName, reason: reach.reason, timedOut: reach.timedOut });
        return { ...resolution, action: 'blocked', reason, summary: reason };
      }),
    );
  }

  /** D110: the remembered target folders of a (source machine, source folder, target machine), on the initiating machine. */
  async rememberedPlacement(key: string): Promise<TargetPlacement | null> {
    const stored = await this.#store.settings.get(TARGET_FOLDERS_SETTING);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
    const entry = (stored as Record<string, unknown>)[key];
    if (typeof entry !== 'object' || entry === null) return null;
    const roots = (entry as { roots?: unknown }).roots;
    const repoPaths = (entry as { repoPaths?: unknown }).repoPaths;
    if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string')) return null;
    return { roots: roots as string[], ...(typeof repoPaths === 'object' && repoPaths !== null && !Array.isArray(repoPaths) ? { repoPaths: repoPaths as Record<string, string> } : {}) };
  }

  /** D110: remembers `placement` for the next move of that folder to that machine (the last 50 kept). */
  async rememberPlacement(key: string, placement: TargetPlacement): Promise<void> {
    const stored = await this.#store.settings.get(TARGET_FOLDERS_SETTING);
    const current = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
    delete current[key];
    current[key] = { roots: [...placement.roots], ...(placement.repoPaths ? { repoPaths: { ...placement.repoPaths } } : {}), at: new Date().toISOString() };
    const keys = Object.keys(current);
    for (const old of keys.slice(0, Math.max(0, keys.length - 50))) delete current[old];
    await this.#store.settings.set(TARGET_FOLDERS_SETTING, current);
  }

  /** The staging folder of an operation. */
  #stage(opId: string): string {
    return path.join(this.#config.dataDir, 'takeover', opId.replace(/[^A-Za-z0-9-]/g, ''));
  }

  #target(opId: string): TargetOp {
    let op = this.#targets.get(opId);
    if (!op) {
      op = { dir: this.#stage(opId), applied: [], worktreeRecords: [], installed: [], place: null, sessionId: null, addedFolderId: null, staged: new Map(), stagedBytes: 0, placedFiles: [], createdDirs: [], stashes: [] };
      this.#targets.set(opId, op);
    }
    return op;
  }

  /**
   * Step 4 (target): one chunk of a conversation file into the operation's staging
   * folder. Chunks arrive in order; the last one checks the size and the sha256
   * (a mismatch deletes the file and refuses).
   */
  async receiveChunk(input: { readonly opId: string; readonly name: string; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string }): Promise<{ readonly received: number; readonly done: boolean }> {
    const name = safeConversationName(input.name);
    if (name === null) throw new TakeoverError(422, 'invalid', `${String(input.name)} is not a valid file name`);
    if (!Number.isInteger(input.size) || input.size < 0 || input.size > TAKEOVER_FILE_MAX_BYTES) throw new TakeoverError(413, 'too-large', `${name} is over the ${TAKEOVER_FILE_MAX_BYTES / 1024 / 1024} MB limit`);
    if (!Number.isInteger(input.offset) || input.offset < 0) throw new TakeoverError(422, 'invalid', 'offset must be a whole number of bytes');
    const op = this.#target(input.opId);
    const file = path.join(op.dir, 'files', ...name.split('/'));
    const bytes = Buffer.from(typeof input.data === 'string' ? input.data : '', 'base64');
    if (bytes.length > TAKEOVER_CHUNK_BYTES) throw new TakeoverError(413, 'too-large', 'a chunk is over the chunk size');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const have = (await stat(file).catch(() => null))?.size ?? 0;
    if (input.offset === 0 && have > 0) await rm(file, { force: true });
    else if (input.offset !== have && !(input.offset === 0 && have === 0)) throw new TakeoverError(409, 'out-of-order', `${name}: expected offset ${have}, got ${input.offset}`);
    if (input.offset + bytes.length > input.size) throw new TakeoverError(422, 'invalid', `${name}: more bytes than the announced size`);
    const handle = await open(file, input.offset === 0 ? 'w' : 'a', 0o600);
    try {
      await handle.write(bytes, 0, bytes.length);
    } finally {
      await handle.close();
    }
    const received = input.offset + bytes.length;
    if (received < input.size) return { received, done: false };
    const actual = await sha256Of(file);
    if (actual !== input.sha256) {
      await rm(file, { force: true });
      throw new TakeoverError(422, 'checksum', `${name} arrived damaged (checksum mismatch): nothing was kept`);
    }
    return { received, done: true };
  }

  /**
   * D152 (target): one chunk of a workspace file into the operation's staging
   * folder (`<op>/workspace/`), checked before a byte is written (a safe relative
   * name, ≤ 1 MB a file, ≤ 20 MB and 300 files a move). The last chunk checks the
   * size and sha256, and this machine's own secret check: a file that looks like
   * it holds a secret (here or on the source) is kept only when the developer
   * confirmed it; otherwise it is deleted and refused. Contents are never logged.
   */
  async receiveWorkspaceChunk(input: { readonly opId: string; readonly name: unknown; readonly size: number; readonly sha256: string; readonly offset: number; readonly data: string; readonly secret: boolean; readonly confirmed: boolean }): Promise<{ readonly received: number; readonly done: boolean }> {
    const op = this.#target(input.opId);
    const bytes = Buffer.from(typeof input.data === 'string' ? input.data : '', 'base64');
    if (bytes.length > TAKEOVER_CHUNK_BYTES) throw new TakeoverError(413, 'too-large', 'a chunk is over the chunk size');
    const refused = checkWorkspaceChunk({ name: input.name, size: input.size, offset: input.offset, bytes: bytes.length }, { staged: op.staged, bytes: op.stagedBytes });
    if (refused) throw new TakeoverError(refused.status, refused.status === 413 ? 'too-large' : 'invalid', refused.message);
    const name = input.name as string;
    const file = path.join(op.dir, 'workspace', ...name.split('/'));
    let received: number;
    try {
      received = await writeStagedChunk(file, input.offset, bytes);
    } catch (error) {
      throw new TakeoverError(409, 'out-of-order', `${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (received < input.size) return { received, done: false };
    const staged = await inspectStaged(file, name);
    const drop = async (status: number, code: string, message: string): Promise<never> => {
      await rm(file, { force: true });
      throw new TakeoverError(status, code, message);
    };
    if (staged.size !== input.size || staged.sha256 !== input.sha256) return drop(422, 'checksum', `${name} arrived damaged (checksum mismatch): nothing was kept`);
    const secret = staged.secret !== null || input.secret === true;
    if (staged.binary && staged.size > WORKSPACE_BINARY_MAX_BYTES) return drop(413, 'too-large', `${name} is a binary file over the limit: nothing was kept`);
    if (secret && input.confirmed !== true) return drop(422, 'secret-not-confirmed', `${name} looks like it holds secrets and copying it was not confirmed: nothing was kept`);
    const previous = op.staged.get(name);
    if (previous) op.stagedBytes -= previous.size;
    op.staged.set(name, { name, size: staged.size, sha256: staged.sha256, secret });
    op.stagedBytes += staged.size;
    return { received, done: true };
  }

  /**
   * Step 5: restores the repos on this machine, one by one: clone what is missing
   * (and save it as a folder, D14), fetch the temporary branch, check the real
   * branch out (or create the worktree on it, same branch name), bring it to the
   * pushed tip, undo the WIP commit with `git reset --mixed` (the changes are
   * uncommitted again; untracked files are untracked again), and delete the
   * temporary remote branch. A failure throws; {@link abort} undoes what was done.
   */
  async apply(body: TargetBody & { readonly captured: readonly CapturedRepo[] }): Promise<OpAnswer<{ readonly place: { readonly cwd: string; readonly folder: { readonly id: string | null; readonly path: string; readonly kind: string } }; readonly changes: readonly PathChange[]; readonly applied: readonly AppliedRepo[]; readonly workspaceFiles?: WorkspaceFilesResult | null; readonly stashes?: readonly MoveStash[] }>> {
    const log: string[] = [];
    const git = this.#git(log);
    const planned = (await this.plan({ source: body.source, ...(body.clonePaths ? { clonePaths: body.clonePaths } : {}), ...(body.placement ? { placement: body.placement } : {}), ...(body.stashTargets ? { stashTargets: body.stashTargets } : {}) })).result;
    if (planned.blockers.length > 0 || planned.folder === null || planned.cwd === null) throw new TakeoverError(409, 'blocked', planned.blockers.join('; ') || 'the session cannot be placed on this machine');
    const op = this.#target(body.opId);
    const changes: PathChange[] = [];
    let folderRef: FolderRef | null = null;
    // D152: the workspace root the developer picked is created first (its folders are undone if the move fails).
    if (planned.workspaceRoot && !planned.workspaceRoot.exists) {
      op.createdDirs.push(...(await mkdirTracked(planned.workspaceRoot.path)));
      log.push(`created the workspace folder ${planned.workspaceRoot.path}`);
    }
    for (const resolution of planned.repos) {
      const repo = body.source.repos.find((entry) => entry.key === resolution.key) as SourceRepo;
      const captured = body.captured.find((entry) => entry.key === resolution.key);
      if (!captured) throw new TakeoverError(422, 'invalid', `no captured state for ${resolution.name}`);
      // Everything below goes to git as an argument: nothing the other machine sent is passed on unchecked.
      if (!isSafeRepoKey(repo.key) || !isSafeBranchName(repo.branch) || !isTempBranch(captured.tempBranch) || !isSafeBranchName(captured.tempBranch)) {
        throw new TakeoverError(422, 'invalid', `${resolution.name}: the branch or the temporary branch name is not valid`);
      }
      if (!isCommitId(captured.baseSha) || !isCommitId(captured.tipSha) || (captured.wipSha !== null && !isCommitId(captured.wipSha))) throw new TakeoverError(422, 'invalid', `${resolution.name}: a commit id is not valid`);
      if (resolution.action === 'clone' && !isCloneableUrl(resolution.cloneUrl ?? '')) throw new TakeoverError(422, 'invalid', `${resolution.name}: the clone URL is not valid`);
      const applied: { -readonly [K in keyof AppliedRepo]: AppliedRepo[K] } = {
        key: resolution.key,
        path: resolution.matchedPath ?? (resolution.cloneTo as string),
        worktreePath: resolution.worktreePath,
        worktreeMade: false,
        branch: repo.branch,
        cloned: false,
        addedFolderId: null,
        createdBranch: false,
        previousTip: null,
        previousHead: null,
        tempDeleted: false,
        tempDeleteError: null,
        privateRef: null,
        remoteName: null,
        tempBranch: captured.tempBranch,
      };
      op.applied.push(applied);
      let main = applied.path;
      if (resolution.action === 'clone') {
        // D152: the clone's missing parent folders are this move's (the undo removes them when empty).
        op.createdDirs.push(...(await mkdirTracked(path.dirname(resolution.cloneTo as string))));
        await git.clone(resolution.cloneUrl as string, resolution.cloneTo as string);
        applied.cloned = true;
        main = resolution.cloneTo as string;
        applied.path = main;
        if (planned.folder.kind !== 'workspace') {
          const added = await this.#folders.add(main);
          if (added.created) applied.addedFolderId = added.folder.id;
        }
      }
      const remote = (await git.remoteByKey(main, remoteKeyOf(repo))) ?? null;
      if (remote === null) throw new TakeoverError(409, 'no-remote', `${main} has no remote for ${repo.remoteUrl}`);
      const privateRef = `refs/switchboard/takeover/${sessionShortId(body.source.sessionId)}/${repo.key}`;
      applied.privateRef = privateRef;
      applied.remoteName = remote.name;
      const tip = await git.fetchTemp(main, remote.name, captured.tempBranch, privateRef);
      if (tip !== captured.tipSha) throw new TakeoverError(409, 'tip-mismatch', `${repo.name}: the temporary branch arrived at ${tip}, expected ${captured.tipSha}`);
      // The branch itself, for its upstream (it may not exist on the remote).
      await git.tryRemote(main, ['fetch', '--quiet', remote.name, `+refs/heads/${repo.branch}:refs/remotes/${remote.name}/${repo.branch}`]);
      const localTip = await git.sha(main, `refs/heads/${repo.branch}`);
      applied.previousTip = localTip;
      if (localTip !== null && !(await git.isAncestor(main, localTip, tip))) {
        throw new TakeoverError(409, 'diverged', `${repo.name}: the branch ${repo.branch} on this machine has commits the original does not have; nothing was changed`);
      }
      // What the plan let through at the worktree path / on the branch: an empty folder is removed, a stale entry an earlier attempt left (its folder gone) is removed (that entry only).
      await git.clearWorktreeSlot(main, resolution.worktreePath, repo.branch);
      if (resolution.worktreePath) {
        if (localTip === null) {
          applied.createdBranch = true;
          await git.run(main, ['worktree', 'add', '--quiet', '-b', repo.branch, resolution.worktreePath, tip]);
        } else {
          await git.run(main, ['branch', '-f', repo.branch, tip]);
          await git.run(main, ['worktree', 'add', '--quiet', resolution.worktreePath, repo.branch]);
        }
        applied.worktreeMade = true;
        if (captured.wipSha) await git.run(resolution.worktreePath, ['reset', '--quiet', '--mixed', captured.baseSha]);
        const record = await this.#store.worktrees.create({
          repo: resolution.name,
          repoPath: main,
          branch: repo.branch,
          baseRef: repo.baseRef,
          path: await realpath(resolution.worktreePath),
          sessionId: null,
          parentBranch: repo.parentBranch,
        });
        op.worktreeRecords.push(record);
        changes.push({ name: repo.name, from: repo.path, to: resolution.worktreePath });
      } else {
        // D153: the developer confirmed stashing this checkout's changes ("Stash them on <PC>"): stashed right before the checkout, never dropped or popped.
        if (resolution.stash === true) {
          const counts = await git.dirtyCounts(main);
          if (counts.total > 0) {
            const message = stashMessage(body.source.title ?? body.source.name, body.source.machine.name, new Date());
            const commit = await git.stashPush(main, message);
            const stash: MoveStash = { path: main, machine: planned.machine.name, message, files: counts.total, commit };
            applied.stashed = stash;
            op.stashes.push(stash);
            const audit = stashAudit(stash);
            log.push(audit);
            this.#onAudit(audit);
          }
        }
        applied.previousHead = await git.headRef(main);
        if (localTip === null) {
          applied.createdBranch = true;
          await git.run(main, ['checkout', '--quiet', '-b', repo.branch, tip]);
        } else {
          await git.run(main, ['checkout', '--quiet', repo.branch]);
          await git.run(main, ['merge', '--quiet', '--ff-only', tip]);
        }
        if (captured.wipSha) await git.run(main, ['reset', '--quiet', '--mixed', captured.baseSha]);
        changes.push({ name: repo.name, from: repo.path, to: main });
      }
      if (applied.createdBranch && (await git.sha(main, `refs/remotes/${remote.name}/${repo.branch}`)) !== null) {
        await git.try(main, ['branch', '--set-upstream-to', `${remote.name}/${repo.branch}`, repo.branch]);
      }
      // The pushed tip is in the repo now: the temporary branch has done its job.
      await git.try(main, ['update-ref', '-d', privateRef]);
      try {
        await git.deleteTempBranch(main, remote.name, captured.tempBranch);
        applied.tempDeleted = true;
      } catch (error) {
        applied.tempDeleteError = error instanceof Error ? error.message : String(error);
      }
    }
    // D152: the workspace's own files, staged by the transfer, are placed under the workspace root (never over a different file).
    let workspaceFiles: WorkspaceFilesResult | null = null;
    if (op.staged.size > 0) {
      if (planned.folder.kind !== 'workspace') throw new TakeoverError(409, 'not-workspace', 'workspace files arrived for a session that has no workspace folder here');
      const placed = await placeWorkspaceFiles(planned.folder.path, [...op.staged.values()], (name) => path.join(op.dir, 'workspace', ...name.split('/')));
      op.placedFiles.push(...placed.placed);
      op.createdDirs.push(...placed.createdDirs);
      workspaceFiles = { copied: placed.copied, same: placed.same, conflicts: placed.conflicts, refused: placed.refused, secret: placed.secret };
      const audit = workspaceCopyAudit(placed.copied.length, placed.secret, planned.machine.name);
      log.push(audit);
      this.#onAudit(audit);
    }
    if (planned.workspaceRoot && !planned.workspaceRoot.exists && (await this.#folders.check(planned.folder.path)).kind !== 'workspace') {
      throw new TakeoverError(409, 'no-router', `the new workspace folder ${planned.folder.path} has no AGENTS.md: copy the workspace's AGENTS.md with it`);
    }
    // D110: a chosen folder that is not saved here yet (a workspace root, a checkout found under a chosen folder) is saved now; the undo removes it.
    if (planned.folder.id === null && planned.folder.kind === 'workspace') {
      const added = await this.#folders.add(planned.folder.path);
      if (added.created) op.addedFolderId = added.folder.id;
      folderRef = { id: added.folder.id, path: planned.folder.path, root: planned.folder.path, kind: 'workspace' };
    } else if (planned.folder.kind === 'workspace') {
      folderRef = { id: planned.folder.id, path: planned.folder.path, root: planned.folder.path, kind: 'workspace' };
    } else {
      const first = op.applied[0] as AppliedRepo;
      if (planned.folder.id === null && !first.cloned && !(await this.#store.folders.getByCanonicalPath(first.path))) {
        const added = await this.#folders.add(first.path);
        if (added.created) op.addedFolderId = added.folder.id;
      }
      const record = (await this.#store.folders.list()).find((entry) => entry.canonicalPath === first.path || entry.id === (first.addedFolderId ?? planned.folder?.id));
      folderRef = record ? folderRefOf(record) : { id: planned.folder.id, path: planned.folder.path, root: planned.folder.path, kind: 'repo' };
    }
    op.place = { folder: folderRef, cwd: planned.cwd, changes };
    return { result: { place: { cwd: planned.cwd, folder: { id: folderRef.id, path: folderRef.path, kind: folderRef.kind } }, changes, applied: [...op.applied], workspaceFiles, stashes: [...op.stashes] }, log };
  }

  /**
   * Undo of {@link apply} (and of an installed conversation) on the target after a
   * failure, newest first: worktrees made are removed (they hold only the restored
   * work), a main checkout is put back on what it had checked out before (its tree
   * was clean before the take-over: `reset --hard` + `clean -fd` only undo the
   * restore), a branch the take-over created is deleted and one it moved is put
   * back, a clone is removed with its saved folder.
   */
  async abort(opId: string): Promise<OpAnswer<{ readonly notes: readonly string[]; readonly stashes?: readonly MoveStash[] }>> {
    const op = this.#targets.get(opId);
    if (!op) return { result: { notes: [] }, log: [] };
    const log: string[] = [];
    const git = this.#git(log);
    const notes: string[] = [];
    const attempt = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        notes.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    for (const file of op.installed.reverse()) await attempt(`could not remove ${file}`, () => rm(file, { force: true, recursive: true }));
    for (const record of op.worktreeRecords) await this.#store.worktrees.markRemoved(record.id).catch(() => undefined);
    for (const applied of [...op.applied].reverse()) {
      // The fetch's private ref and the remote-tracking ref it may have made.
      if (applied.privateRef) await git.try(applied.path, ['update-ref', '-d', applied.privateRef]);
      if (applied.remoteName && applied.tempBranch) await git.forgetTrackingRef(applied.path, applied.remoteName, applied.tempBranch);
      if (applied.worktreePath) {
        // A worktree the restore never made (it failed before `worktree add`) is not a leftover; only one it made is ever forced.
        const removed = await git.removePlannedWorktree(applied.path, applied.worktreePath, applied.worktreeMade === true);
        if (removed.outcome === 'left') notes.push(removed.note);
      } else if (applied.previousHead !== null) {
        await attempt(`could not restore ${applied.path}`, async () => {
          await git.run(applied.path, ['reset', '--quiet', '--hard']);
          await git.run(applied.path, ['clean', '-fdq']);
          const detached = !/^[A-Za-z0-9._/-]+$/.test(applied.previousHead as string) || /^[0-9a-f]{40}$/.test(applied.previousHead as string);
          await git.run(applied.path, detached ? ['checkout', '--quiet', '--detach', applied.previousHead as string] : ['checkout', '--quiet', applied.previousHead as string]);
        });
      }
      if (!applied.cloned) {
        if (applied.createdBranch) await attempt(`could not delete the branch ${applied.branch}`, () => git.run(applied.path, ['branch', '-D', applied.branch]));
        else if (applied.previousTip) {
          await attempt(`could not move ${applied.branch} back`, async () => {
            // Nothing to do when it never moved (the restore failed before, e.g. diverged).
            if ((await git.sha(applied.path, `refs/heads/${applied.branch}`)) === applied.previousTip) return;
            // Checked out in that very checkout (a main checkout on its own branch: `branch -f` refuses): its tree was clean before the restore, so a hard reset only undoes it.
            if (applied.worktreePath === null && (await git.currentBranch(applied.path)) === applied.branch) await git.run(applied.path, ['reset', '--quiet', '--hard', applied.previousTip as string]);
            else await git.run(applied.path, ['branch', '-f', applied.branch, applied.previousTip as string]);
          });
        }
      }
      if (applied.addedFolderId) await attempt('could not remove the saved folder', () => this.#folders.remove(applied.addedFolderId as string));
      if (applied.cloned) await attempt(`could not remove the clone ${applied.path}`, () => rm(applied.path, { recursive: true, force: true }));
    }
    if (op.addedFolderId) await attempt('could not remove the saved folder', () => this.#folders.remove(op.addedFolderId as string));
    // D152: the workspace files this move wrote, then the folders it created (only when empty).
    notes.push(...(await undoPlaced(op.placedFiles, op.createdDirs)));
    await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
    this.#targets.delete(opId);
    // D153: a stash this move made stays (the developer's changes); the undo only reports it.
    for (const stash of op.stashes) log.push(`kept the stash in ${stash.path}: "${stash.message}"`);
    return { result: { notes, stashes: [...op.stashes] }, log };
  }

  /**
   * Step 6 (target): installs the conversation where the CLI looks for it, creates
   * the session and starts it: Claude Code: `<config dir>/projects/<cwd slug>/<id>.jsonl`
   * (+ its folder) with `--resume <id>`; Codex: its rollout in `CODEX_HOME` and
   * `thread/resume`, else the D62 handover; OpenCode: the handover. The agent's
   * first message says where the session came from and which paths changed.
   */
  async resume(body: ResumeBody): Promise<OpAnswer<{ readonly sessionId: string; readonly name: string; readonly note: string | null }>> {
    const op = this.#targets.get(body.opId);
    if (!op || !op.place) throw new TakeoverError(409, 'not-applied', 'the working tree was not restored here yet');
    const source = body.source;
    const place = op.place;
    const self = await this.#self();
    const profileId = (await this.#accounts.pick(source.provider).catch(() => null)) ?? null;
    let note: string | null = null;
    // The conversation: where it goes, what is imported.
    const claudeSessionId = source.provider === 'claude' ? source.claudeSessionId : randomUUID();
    let nativeId: string | null = null;
    let transcript: string | null = null;
    let handoverPath: string | null = null;
    let messages: Array<{ role: 'user' | 'assistant'; text: string; ts: string | null }> = [];
    const staged = (name: string): string => path.join(op.dir, 'files', ...name.split('/'));
    const listed = new Set(body.files.map((file) => file.name));
    if (source.provider === 'claude') {
      const dir = await this.#accounts.dirOf(profileId, 'claude');
      if (!dir) throw new TakeoverError(500, 'no-config-dir', "Claude Code's config folder is not known on this machine");
      const project = path.join(dir, 'projects', slugForCwd(place.cwd));
      await mkdir(project, { recursive: true, mode: 0o700 });
      for (const file of body.files) {
        if (!listed.has(file.name) || safeConversationName(file.name) === null) continue;
        const to = path.join(project, ...file.name.split('/'));
        await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await copyFile(staged(file.name), to);
        await chmod(to, 0o600).catch(() => undefined);
        op.installed.push(to);
      }
      transcript = path.join(project, `${source.claudeSessionId}.jsonl`);
    } else {
      let carried = false;
      const rollout = body.files.find((file) => file.name.startsWith('rollout/'));
      if (source.provider === 'codex' && rollout && source.nativeId) {
        try {
          const home = await this.#accounts.dirOf(profileId, 'codex');
          if (!home) throw new Error('the Codex folder is not known on this machine');
          const to = path.join(home, 'sessions', ...rollout.name.slice('rollout/'.length).split('/'));
          await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
          await copyFile(staged(rollout.name), to);
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
          const parsed: unknown = JSON.parse(await readFile(staged('@messages.json'), 'utf8'));
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
        const folder = path.join(this.#config.dataDir, 'handovers', `takeover-${sessionShortId(body.opId)}`);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        handoverPath = path.join(folder, 'chat.md');
        await copyFile(staged('@chat.md'), handoverPath);
        await chmod(handoverPath, 0o600).catch(() => undefined);
      }
    }
    // The first message.
    const parts = [takeoverMessage({ fromMachine: source.machine.name, toMachine: self.name, changes: place.changes, restored: true })];
    if (handoverPath) {
      parts.push(
        `${CLI_LABELS[source.provider]}'s own record of the conversation could not be carried over, so Switchboard exported the chat: read ${handoverPath} first, summarize where things stand (the goal, decisions made, files changed, open tasks, the next step), then continue.`,
      );
    }
    if (source.busy) parts.push('The turn that was running when the session was taken over was interrupted: finish it.');
    if (source.queued.length > 0) parts.push(`Messages that were waiting to be sent to you:\n${source.queued.map((text) => `- ${text}`).join('\n')}`);
    // A tombstone of an earlier move of this conversation is replaced.
    const existing = await this.#store.sessions.getByClaudeSessionId(claudeSessionId);
    if (existing) {
      if (existing.movedTo && existing.closedAt !== null) await this.#store.sessions.delete(existing.id);
      else throw new TakeoverError(409, 'exists', `${self.name} has this conversation as a session already`);
    }
    let name = source.name;
    for (let n = 2; await this.#store.sessions.getByName(name); n++) name = `${source.name}-${n}`;
    const movedFrom: SessionMove = { machineId: source.machine.id, machineName: source.machine.name, sessionId: source.sessionId, at: new Date().toISOString() };
    const created = await this.#supervisor.takeOver(
      {
        name,
        title: source.title,
        task: source.task,
        provider: source.provider,
        claudeSessionId,
        nativeId,
        solutions: source.solutions,
        worktrees: source.worktrees,
        branch: source.branch,
        branching: null,
        origin: source.origin,
        model: source.model,
        effort: source.effort,
        ultracode: source.ultracode,
        profileId,
        transcript,
        messages: source.provider === 'claude' ? [] : messages,
        movedFrom,
        dividerLabel: takenOverLabel(source.machine.name),
        firstMessage: parts.join('\n\n'),
      },
      { folder: place.folder, cwd: place.cwd },
      {
        beforeSpawn: async (session) => {
          await this.#worktrees.assign(op.worktreeRecords, session.id);
          // D68: the todo list, before the agent's first turn (an older source sends none).
          if (this.#todos && Array.isArray(source.todos) && source.todos.length > 0) await this.#todos.import(session.id, source.todos);
          // D94: its Switchboard loops (an older source sends none).
          if (this.#loops && Array.isArray(source.loops) && source.loops.length > 0) await this.#loops.importLoops(session.id, source.loops);
        },
      },
    );
    op.sessionId = created.id;
    await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
    const stillTrack = this.#targets.get(body.opId);
    if (stillTrack) stillTrack.installed = [];
    return { result: { sessionId: created.id, name: created.name, note }, log: [] };
  }

  /** Forgets a finished operation's target state (the working tree is kept). */
  async closeTarget(opId: string): Promise<void> {
    const op = this.#targets.get(opId);
    this.#targets.delete(opId);
    if (op) await rm(op.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** `true` when a target operation is open (tests). */
  hasTarget(opId: string): boolean {
    return this.#targets.has(opId);
  }

  // ═══ leftovers ════════════════════════════════════════════════════════

  async #leftovers(): Promise<Leftover[]> {
    const stored = await this.#store.settings.get(LEFTOVERS_SETTING);
    return Array.isArray(stored) ? (stored as Leftover[]) : [];
  }

  async #addLeftover(input: Omit<Leftover, 'id' | 'at'>): Promise<Leftover> {
    const entry: Leftover = { id: randomUUID(), at: new Date().toISOString(), ...input, remoteUrl: redactUrl(input.remoteUrl) };
    await this.#store.settings.set(LEFTOVERS_SETTING, [...(await this.#leftovers()), entry]);
    return entry;
  }

  async #removeLeftover(id: string): Promise<void> {
    await this.#store.settings.set(
      LEFTOVERS_SETTING,
      (await this.#leftovers()).filter((entry) => entry.id !== id),
    );
  }

  /** The temporary branches this machine pushed and could not delete (the one-click delete lists them). */
  async listLeftovers(): Promise<Leftover[]> {
    // The ones of a take-over still running are not leftovers yet.
    const active = new Set([...this.#sources.values()].flatMap((op) => op.captured.map((captured) => captured.leftoverId)));
    return (await this.#leftovers()).filter((entry) => !active.has(entry.id));
  }

  /** Deletes one leftover branch from its remote (`git push --delete`); only a take-over branch is ever touched. */
  async deleteLeftover(id: string): Promise<OpAnswer<{ readonly deleted: boolean }>> {
    const log: string[] = [];
    const entry = (await this.#leftovers()).find((candidate) => candidate.id === id);
    if (!entry) throw new TakeoverError(404, 'not-found', `no leftover ${id}`);
    if (!isTempBranch(entry.branch)) throw new TakeoverError(422, 'invalid', `${entry.branch} is not a take-over branch`);
    try {
      await this.#git(log).deleteTempBranch(entry.repoPath, entry.remoteName, entry.branch);
    } catch (error) {
      throw new TakeoverError(502, 'delete-failed', error instanceof TakeoverGitError ? error.message : String(error));
    }
    await this.#removeLeftover(id);
    return { result: { deleted: true }, log };
  }

  /** The take-over staging folder, for tests. */
  stagingRoot(): string {
    return path.join(this.#config.dataDir, 'takeover');
  }
}
