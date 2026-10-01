import { randomUUID } from 'node:crypto';
import type { SessionModelOption } from '../../../core/api.ts';
import type { SessionBranching } from '../../../core/branching.ts';
import type { CliProviderId } from '../../../core/cli-providers.ts';
import type { ContextState } from '../../../core/context-meter.ts';
import type { Coordination, FolderKind, Phase, QaStack, SessionMode, SessionOrigin, SessionStatus, WorkType } from '../../../core/model.ts';
import { type CreateInput, type Patch, type RepoContext, placeholders } from '../context.ts';
import { Table, type TableSpec, defined } from '../table.ts';

/** A stored session (ARCHITECTURE data model + the M0 stored fields). */
export interface SessionRecord {
  /** Switchboard's id (the `{id}` of `/api/sessions/{id}`). */
  readonly id: string;
  /** Unique, kebab-case (the API validates the format); the worktree and branch are built from it, so it never changes. */
  readonly name: string;
  /** D22 (0006): the free-text title the UI shows (trimmed, 1–80 characters); `null` = show {@link name}. */
  readonly title: string | null;
  /** The task text the developer typed in the New-session modal. */
  readonly task: string;
  /** The CLI's session id (`--session-id` / `--resume`); never changes. */
  readonly claudeSessionId: string;
  readonly status: SessionStatus;
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly coordination: Coordination | null;
  readonly qaStack: QaStack | null;
  readonly qaConfluenceUrl: string | null;
  readonly qaFigmaUrls: string[];
  /** Solutions in scope, in the chosen order. */
  readonly solutions: string[];
  /** NewSession `worktrees` toggle. */
  readonly worktrees: boolean;
  readonly ultracode: boolean;
  /** `false` after "Continue in terminal" until "Attach here". */
  readonly attached: boolean;
  /**
   * Working folder of the claude process (D14): the workspace root for a
   * workspace folder; the repo, or its worktree when the session has one, for a
   * repo folder. Canonical (realpath).
   */
  readonly cwd: string | null;
  /** The saved folder the session started in (D14); `null` once that folder is removed from the list (or before D14 without a saved root). */
  readonly folderId: string | null;
  /** The session's folder, canonical: the workspace root or the repo (D14). Kept when the folder leaves the saved list. */
  readonly root: string | null;
  /**
   * What {@link root} is (D14). D59: `plain` is stored as `root_kind` NULL next to
   * a `root` (0003's CHECK allows only workspace / repo, and `sessions` is not
   * rebuilt; `docs/database.md` → 0022): {@link SessionRepository} maps it both ways.
   */
  readonly rootKind: FolderKind | null;
  /** Where the session came from (0004, D16): started in Switchboard, or moved in from a terminal. */
  readonly origin: SessionOrigin;
  /** D25 (0008): the remote session (`session_<X>`) this one is a local copy of (`--teleport`); `null` otherwise. */
  readonly remoteSource: string | null;
  /** Pid of the live claude process, `null` when none. */
  readonly pid: number | null;
  readonly requestedPermissionMode: string | null;
  /** `system/init.permissionMode` last seen. */
  readonly observedPermissionMode: string | null;
  /** `claude_code_version` from `system/init`. */
  readonly cliVersion: string | null;
  /** Last transcript entry Switchboard has (the Attach sync point). */
  readonly lastTranscriptUuid: string | null;
  /** Set while a Switchboard-initiated stop runs (e.g. `pause`, `detach`, `restart`). */
  readonly stopReason: string | null;
  /** The schedule that started it, if any. */
  readonly scheduleId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly detachedAt: string | null;
  readonly endedAt: string | null;
  /**
   * D24 (0007): what the live process's `initialize` reported as
   * `remote_control_available` (`false` from each spawn until the reply); `null`
   * for a session Switchboard never ran a process for (the demo seed).
   */
  readonly remoteAvailable: boolean | null;
  /** D24: Remote Control is on (a new process reattaches it). */
  readonly remoteEnabled: boolean;
  /** D24: the claude.ai link of the last bridge; kept when Remote is turned off. */
  readonly remoteSessionUrl: string | null;
  /** D24: the last bridge's `cse_…` id (the next `reattach_session_id`); kept when Remote is turned off. */
  readonly remoteBridgeId: string | null;
  /** D31 (0009): the chosen model, `--model` on every spawn; `null` = the CLI's default. */
  readonly model: string | null;
  /** D31: the chosen effort level, `--effort` on every spawn; `null` = the CLI's default. */
  readonly effort: string | null;
  /** D31: the models the session's last claude process reported in its `initialize` reply; `null` until one did. */
  readonly modelOptions: SessionModelOption[] | null;
  /**
   * D33 (0010): when the developer closed the session (ISO); `null` = open. A
   * closed session leaves the sidebar's list and is never resumed by restart
   * recovery; History lists it and Reopen clears this.
   */
  readonly closedAt: string | null;
  /**
   * D38 (0011): the branch the session's worktrees are on (the D32 ticket branch,
   * or `session/{name}` for a scheduled run), stored when it starts with Worktrees
   * on; `null` without worktrees (and before 0011). Worktrees its agent creates on
   * this branch are adopted as the session's (`docs/worktrees.md` → *Adopted worktrees*).
   */
  readonly branch: string | null;
  /**
   * D40 (0012): how the session's task worktrees are branched (the epic, its base,
   * per-repo base overrides, dropped repos), stored when it starts with Worktrees
   * on under the ticket rule; `null` otherwise (and before 0012). Adoption (D38)
   * reads it for the base an agent-created worktree was cut from.
   */
  readonly branching: SessionBranching | null;
  /**
   * D49 (0015): the context window meter's state (`src/core/context-meter.ts`),
   * written by the stream recorder and by terminal-turn imports; `null` until the
   * first reading (and for every session before 0015). Read with `readContextState`.
   */
  readonly context: ContextState | null;
  /**
   * D48 P4 (migration 0017): a hand-started terminal session Switchboard hooked
   * into (`docs/peers.md` → *Hooked terminal sessions*); Switchboard never runs a
   * process for it. `false` for every other session.
   */
  readonly hooked: boolean;
  /** D48 P4: the transcript its hooks reported; `null` when unknown. */
  readonly transcriptPath: string | null;
  /**
   * D62 (0023): the CLI the session's process runs (`claude` for every session
   * from before D62); a mid-session switch changes it (`docs/providers.md`).
   */
  readonly provider: CliProviderId;
  /**
   * D63 (0024): the account profile the session's process runs on (`cli_profiles.id`);
   * `null` = the Default of its CLI. A switch changes it.
   */
  readonly profileId: string | null;
  /** D63: automatic account switching leaves the session on its profile. */
  readonly profilePinned: boolean;
}

/** Input of {@link SessionRepository.create}; `id` defaults to a random UUID, `status` to `idle`. */
export type SessionCreate = CreateInput<SessionRecord, 'name' | 'claudeSessionId', 'createdAt' | 'updatedAt'>;

/** Input of {@link SessionRepository.update}. */
export type SessionPatch = Patch<SessionRecord, 'id' | 'createdAt' | 'updatedAt'>;

/** Filter of {@link SessionRepository.list}. */
export interface SessionFilter {
  readonly statuses?: readonly SessionStatus[];
  /** D33: `false` = only open sessions (`closed_at` NULL), `true` = only closed ones; omitted = both. */
  readonly closed?: boolean;
}

const SPEC: TableSpec<SessionRecord> = {
  table: 'sessions',
  key: 'id',
  fields: {
    id: ['id', 'text'],
    name: ['name', 'text'],
    title: ['title', 'text'],
    task: ['task', 'text'],
    claudeSessionId: ['claude_session_id', 'text'],
    status: ['status', 'text'],
    workType: ['work_type', 'text'],
    mode: ['mode', 'text'],
    phase: ['phase', 'text'],
    coordination: ['coordination', 'text'],
    qaStack: ['qa_stack', 'text'],
    qaConfluenceUrl: ['qa_confluence_url', 'text'],
    qaFigmaUrls: ['qa_figma_urls', 'json'],
    solutions: ['solutions', 'json'],
    worktrees: ['worktrees', 'bool'],
    ultracode: ['ultracode', 'bool'],
    attached: ['attached', 'bool'],
    cwd: ['cwd', 'text'],
    folderId: ['folder_id', 'text'],
    root: ['root', 'text'],
    rootKind: ['root_kind', 'text'],
    origin: ['origin', 'text'],
    remoteSource: ['remote_source', 'text'],
    pid: ['pid', 'int'],
    requestedPermissionMode: ['requested_permission_mode', 'text'],
    observedPermissionMode: ['observed_permission_mode', 'text'],
    cliVersion: ['cli_version', 'text'],
    lastTranscriptUuid: ['last_transcript_uuid', 'text'],
    stopReason: ['stop_reason', 'text'],
    scheduleId: ['schedule_id', 'text'],
    createdAt: ['created_at', 'text'],
    updatedAt: ['updated_at', 'text'],
    lastActivityAt: ['last_activity_at', 'text'],
    detachedAt: ['detached_at', 'text'],
    endedAt: ['ended_at', 'text'],
    remoteAvailable: ['remote_available', 'bool'],
    remoteEnabled: ['remote_enabled', 'bool'],
    remoteSessionUrl: ['remote_session_url', 'text'],
    remoteBridgeId: ['remote_bridge_id', 'text'],
    model: ['model', 'text'],
    effort: ['effort', 'text'],
    modelOptions: ['model_options', 'json'],
    closedAt: ['closed_at', 'text'],
    branch: ['branch', 'text'],
    branching: ['branching', 'json'],
    context: ['context', 'json'],
    hooked: ['hooked', 'bool'],
    transcriptPath: ['transcript_path', 'text'],
    provider: ['provider', 'text'],
    profileId: ['profile_id', 'text'],
    profilePinned: ['profile_pinned', 'bool'],
  },
};

/**
 * D59: a plain-folder session is stored with `root_kind` NULL (0003's CHECK is
 * workspace / repo only): a record read with a `root` and no kind is `plain`.
 * No earlier version writes a root without its kind (0003 and every start set
 * both), so the state is unambiguous.
 */
function fromStored(record: SessionRecord): SessionRecord {
  return record.root !== null && record.rootKind === null ? { ...record, rootKind: 'plain' } : record;
}

/** D59: `rootKind: 'plain'` is written as `root_kind` NULL ({@link fromStored}). */
function toStored<T extends { readonly rootKind?: FolderKind | null }>(values: T): T {
  return values.rootKind === 'plain' ? { ...values, rootKind: null } : values;
}

function mapped(record: SessionRecord | null): SessionRecord | null {
  return record === null ? null : fromStored(record);
}

/** Sessions. */
export class SessionRepository {
  readonly #ctx: RepoContext;
  readonly #table: Table<SessionRecord>;

  constructor(ctx: RepoContext) {
    this.#ctx = ctx;
    this.#table = new Table(ctx.db, SPEC);
  }

  /** Stores a new session. The name and the claude session id must be unique. */
  async create(input: SessionCreate): Promise<SessionRecord> {
    const ts = this.#ctx.now();
    return fromStored(this.#table.insert(toStored({ ...defined(input), id: input.id ?? randomUUID(), createdAt: ts, updatedAt: ts })));
  }

  async get(id: string): Promise<SessionRecord | null> {
    return mapped(this.#table.get(id));
  }

  async getByName(name: string): Promise<SessionRecord | null> {
    return mapped(this.#table.first('name = ?', [name]));
  }

  async getByClaudeSessionId(claudeSessionId: string): Promise<SessionRecord | null> {
    return mapped(this.#table.first('claude_session_id = ?', [claudeSessionId]));
  }

  /** Sessions, newest first. */
  async list(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${placeholders(filter.statuses.length)})`);
      params.push(...filter.statuses);
    }
    if (filter.closed !== undefined) where.push(filter.closed ? 'closed_at IS NOT NULL' : 'closed_at IS NULL');
    return this.#table.select(where.join(' AND '), params, 'created_at DESC, id').map(fromStored);
  }

  /** Updates the given fields (and `updatedAt`); `null` if there is no such session. */
  async update(id: string, patch: SessionPatch): Promise<SessionRecord | null> {
    return mapped(this.#table.update(id, toStored({ ...patch, updatedAt: this.#ctx.now() })));
  }

  /** Deletes a session with its agents, events, questions, requests, loops and pending messages. */
  async delete(id: string): Promise<boolean> {
    return this.#table.delete(id);
  }
}
