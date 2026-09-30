import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ContinueRefusal, FolderCheck } from '../../core/api.ts';
import { isTerminalConversation, relativeToRoot, solutionOfPath } from '../../core/history.ts';
import { TITLE_MAX, checkTitle, shortNameFromTitle } from '../../core/session-title.ts';
import { movedSessionName } from '../../core/terminal-move.ts';
import type { TranscriptFacts } from '../../core/transcript.ts';
import type { FolderRecord } from '../db/repos/folders.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, repoSolutionName } from '../folders/ref.ts';
import { FolderError, type FolderService } from '../folders/service.ts';
import { SESSION_NAME } from '../sessions/validate.ts';
import { attachWarningMessage } from '../supervisor/attach.ts';
import { type SessionSupervisor, SupervisorError } from '../supervisor/supervisor.ts';
import { readTranscriptFacts } from './transcripts.ts';

/** A CLI session id as it can appear in a transcript's file name (no separators). */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** What a refused move answers: its HTTP status and body. */
export type ContinueRefusalBody =
  | ContinueRefusal
  | { readonly error: string; readonly message: string }
  | { readonly error: 'invalid'; readonly errors: ReadonlyArray<{ readonly field: string; readonly message: string }> };

/** Result of {@link ConversationMover.continue}: the moved session, or the refusal to send as it is. */
export type ContinueOutcome =
  | { readonly ok: true; readonly record: SessionRecord }
  | { readonly ok: false; readonly status: number; readonly body: ContinueRefusalBody };

/** Options of {@link ConversationMover}. */
export interface ConversationMoverOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly folders: FolderService;
  /** Default: the current platform (macOS and Windows compare paths case-insensitively, as History does). */
  readonly platform?: NodeJS.Platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refused(status: number, body: ContinueRefusalBody): ContinueOutcome {
  return { ok: false, status, body };
}

/**
 * D22: a moved session's title: the conversation's title (the last custom title,
 * else the AI title), whitespace collapsed and cut to {@link TITLE_MAX}
 * characters; `null` when it has none (the session then shows its name, which
 * came from the first prompt).
 */
export function conversationTitle(facts: Pick<TranscriptFacts, 'customTitle' | 'aiTitle'>): string | null {
  for (const text of [facts.customTitle, facts.aiTitle]) {
    const title = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
    if (title !== '') return title;
  }
  return null;
}

/** HTTP status of a supervisor refusal during the move (as the session routes map them). */
function supervisorStatus(error: SupervisorError): number {
  if (error.code === 'closing') return 503;
  if (error.code === 'not-found') return 404;
  return 409;
}

/**
 * "Continue in Switchboard" (D16, `docs/supervisor.md` → *Continue in Switchboard*):
 * moves a conversation started in a terminal into Switchboard as the **same**
 * conversation, `POST /api/history/{claudeSessionId}/continue`:
 *
 * 1. refused when a session already has the id (409 `already-in-switchboard`, with
 *    its session id), when there is no transcript (404) or it is not a terminal
 *    conversation (422 `not-a-terminal-conversation`: History lists only those);
 * 2. **folder**: the saved folder that holds the conversation's start folder (the
 *    most specific one, as History places its row). None: the workspace or repo it
 *    sits in (walking up from the start folder, D14 kinds) is offered as 409
 *    `folder-not-saved` with that folder's check, and added with `addFolder: true`;
 *    neither a workspace nor a repo above it: 422 `not-in-a-folder`;
 * 3. **name**: `name` when given (kebab-case, unique: else 422), else the title,
 *    else the first prompt, in kebab-case, made unique (`src/core/terminal-move.ts`);
 *    D22: the session's **title** is the conversation's title ({@link conversationTitle}).
 *    D22 (developer ruling 2026-09-28): a given `title` (trimmed, 1–80 characters,
 *    else 422 on `title`) replaces it, and without a given `name` the short name is
 *    derived from that title as for a new session (`shortNameFromTitle`: `-2`, `-3`, …);
 * 4. **terminal check** (the Attach-here warning): 409 `terminal-open` with the
 *    reasons unless `confirm: true`. Nothing has changed until here (the folder is
 *    added only after this check);
 * 5. {@link SessionSupervisor.adopt}: the session (bound to the id, cwd = where the
 *    conversation started, no work type / mode / phase, task = its first prompt),
 *    the transcript's turns as events, `--resume <id>` with no message (idle).
 *
 * Moves run one at a time, so two calls never bind one id twice or pick one name twice.
 */
export class ConversationMover {
  readonly #store: Store;
  readonly #supervisor: SessionSupervisor;
  readonly #folders: FolderService;
  readonly #caseInsensitive: boolean;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ConversationMoverOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#folders = options.folders;
    const platform = options.platform ?? process.platform;
    this.#caseInsensitive = platform === 'darwin' || platform === 'win32';
  }

  /** Moves the conversation `claudeSessionId` (see the class comment); `body` is the request body ({@link ContinueConversation}). */
  continue(claudeSessionId: string, body: unknown): Promise<ContinueOutcome> {
    const run = this.#queue.catch(() => undefined).then(() => this.#continueNow(claudeSessionId, body));
    this.#queue = run;
    return run;
  }

  async #continueNow(claudeSessionId: string, body: unknown): Promise<ContinueOutcome> {
    if (body !== undefined && body !== null && !isRecord(body)) {
      return refused(422, { error: 'invalid', errors: [{ field: '', message: 'the body must be an object: { name?, title?, addFolder?, confirm? }' }] });
    }
    const input = isRecord(body) ? body : {};
    const rawName = input['name'];
    if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
      return refused(422, { error: 'invalid', errors: [{ field: 'name', message: 'the name must be text' }] });
    }
    // D22: a typed title (omitted or null: the conversation's own title, D16).
    const rawTitle = input['title'];
    let typedTitle: string | null = null;
    if (rawTitle !== undefined && rawTitle !== null) {
      const check = checkTitle(rawTitle);
      if (!check.ok) return refused(422, { error: 'invalid', errors: [{ field: 'title', message: check.message }] });
      typedTitle = check.title;
    }
    const addFolder = input['addFolder'] === true;
    const confirm = input['confirm'] === true;

    if (!CLAUDE_SESSION_ID.test(claudeSessionId)) return refused(404, { error: 'not-found', message: `no conversation ${claudeSessionId}` });
    const existing = await this.#store.sessions.getByClaudeSessionId(claudeSessionId);
    if (existing) {
      return refused(409, { error: 'already-in-switchboard', message: `this conversation is already in Switchboard as ${existing.name}`, sessionId: existing.id });
    }
    const transcript = await this.#supervisor.findTranscript(claudeSessionId);
    if (!transcript) return refused(404, { error: 'not-found', message: `no transcript of the conversation ${claudeSessionId}` });
    const facts = await readTranscriptFacts(transcript);
    if (!isTerminalConversation(facts) || facts.startCwd === null) {
      return refused(422, { error: 'not-a-terminal-conversation', message: 'this conversation was not typed in an interactive terminal (or has no prompt yet)' });
    }
    const startCwd = facts.startCwd;
    let cwd: string;
    try {
      cwd = await realpath(startCwd);
    } catch {
      return refused(409, { error: 'folder-missing', message: `the folder the conversation started in does not exist any more: ${startCwd}` });
    }

    // 2. The folder, without changing anything yet.
    let saved = this.#savedFolderFor([startCwd, cwd], await this.#store.folders.list());
    let toAdd: FolderCheck | null = null;
    if (!saved) {
      const check = await this.#enclosingFolder(cwd);
      if (!check) {
        return refused(422, { error: 'not-in-a-folder', message: `${startCwd} is not inside a workspace (a folder with a router AGENTS.md) or a git repository`, cwd: startCwd });
      }
      saved = check.canonicalPath ? await this.#store.folders.getByCanonicalPath(check.canonicalPath) : null;
      if (!saved) {
        if (!addFolder) {
          const kind = check.kind === 'repo' ? 'git repository' : check.kind === 'plain' ? 'folder' : 'workspace';
          return refused(409, { error: 'folder-not-saved', message: `no saved folder holds ${startCwd}; add the ${kind} ${check.path} to continue it here`, check });
        }
        toAdd = check;
      }
    }

    // 3. The name.
    const taken = new Set((await this.#store.sessions.list()).map((session) => session.name));
    const typed = typeof rawName === 'string' ? rawName.trim() : '';
    if (typed !== '') {
      if (!SESSION_NAME.test(typed) || typed.length > 64) {
        return refused(422, { error: 'invalid', errors: [{ field: 'name', message: 'the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters' }] });
      }
      if (taken.has(typed)) return refused(422, { error: 'invalid', errors: [{ field: 'name', message: `a session named "${typed}" already exists` }] });
    }
    const name = typed !== '' ? typed : typedTitle !== null ? shortNameFromTitle(typedTitle, taken) : movedSessionName(facts, taken);

    // 4. A terminal may still have it open: two live processes on one id split the transcript (M0.4).
    if (!confirm) {
      const reasons = await this.#supervisor.conversationWarnings(claudeSessionId, transcript, cwd);
      if (reasons.length > 0) {
        return refused(409, { error: 'terminal-open', message: attachWarningMessage(reasons).replace('Attaching now forks', 'Moving it now forks'), reasons });
      }
    }

    // 5. The changes: the folder (when asked), the session, its events, the process.
    let folder: FolderRef;
    try {
      const id = toAdd ? (await this.#folders.add(toAdd.path)).folder.id : (saved as FolderRecord).id;
      folder = await this.#folders.resolveForSession(id);
    } catch (error) {
      if (!(error instanceof FolderError)) throw error;
      return refused(error.status, { error: error.code, message: error.message, ...(error.check ? { check: error.check } : {}) });
    }
    try {
      const record = await this.#supervisor.adopt(
        {
          name,
          title: typedTitle ?? conversationTitle(facts),
          task: facts.firstPrompt ?? facts.firstCommand ?? '',
          claudeSessionId,
          solutions: this.#solutions(folder, facts),
          transcript,
        },
        { folder, cwd },
      );
      await this.#folders.markUsed(folder.id);
      return { ok: true, record };
    } catch (error) {
      if (!(error instanceof SupervisorError)) throw error;
      return refused(supervisorStatus(error), { error: error.code, message: error.message });
    }
  }

  /** The most specific saved folder that holds one of `cwds` (as saved or canonical), else `null`. */
  #savedFolderFor(cwds: readonly string[], folders: readonly FolderRecord[]): FolderRecord | null {
    let best: { readonly record: FolderRecord; readonly length: number } | null = null;
    for (const record of folders) {
      for (const root of new Set([record.path, record.canonicalPath])) {
        if (!cwds.some((cwd) => relativeToRoot(cwd, root, this.#caseInsensitive) !== null)) continue;
        const length = root.replace(/[\\/]+$/, '').length;
        if (!best || length > best.length) best = { record, length };
      }
    }
    return best?.record ?? null;
  }

  /**
   * The workspace or git repo `cwd` sits in (D14 kinds): `cwd` itself or the
   * nearest folder above it that is one. A linked worktree is skipped (its main
   * checkout is the repo to add, and the walk goes on above it). `null` at the top.
   */
  async #enclosingFolder(cwd: string): Promise<FolderCheck | null> {
    // D59: every folder is at least a plain folder, so the nearest workspace or repo up the tree wins;
    // only when there is none is the start folder itself offered, as a plain folder.
    let start: FolderCheck | null = null;
    for (let dir = cwd; ; ) {
      const check = await this.#folders.check(dir);
      if (check.kind === 'workspace' || check.kind === 'repo') return check;
      if (dir === cwd && check.kind === 'plain') start = check;
      const parent = path.dirname(dir);
      if (parent === dir) return start;
      dir = parent;
    }
  }

  /**
   * The moved session's solutions: a repo folder's one solution; in a workspace,
   * the solutions (router layout, `solutionOfPath`) of every folder the
   * conversation worked in, in order (none at the workspace root).
   */
  #solutions(folder: FolderRef, facts: TranscriptFacts): string[] {
    if (folder.kind === 'repo') return [repoSolutionName(folder)];
    // D59: a plain folder has no solutions.
    if (folder.kind === 'plain') return [];
    const out: string[] = [];
    for (const cwd of facts.cwds) {
      const relative = relativeToRoot(cwd, folder.root, this.#caseInsensitive) ?? relativeToRoot(cwd, folder.path, this.#caseInsensitive);
      const solution = relative === null ? null : solutionOfPath(relative);
      if (solution && !out.includes(solution)) out.push(solution);
    }
    return out;
  }
}
