import { lstat, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { protectedBranchReason } from '../../core/auto-clean.ts';
import { type CarriedRepo, type MoveCarried, type SourceCleanupItem, type SourceCleanupReport, decideBranchCleanup, decideWorktreeCleanup, regenerableIgnored } from '../../core/source-cleanup.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { folderOfSession } from '../folders/ref.ts';
import type { SessionSupervisor } from '../supervisor/supervisor.ts';
import type { WorktreeManager } from '../worktrees/manager.ts';
import { TakeoverGit } from './git.ts';
import type { MoveLog } from './move-log.ts';

/** What {@link SourceCleanup} needs of the server. */
export interface SourceCleanupOptions {
  readonly store: Store;
  readonly supervisor: SessionSupervisor;
  readonly worktrees: WorktreeManager;
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly self: () => Promise<{ readonly id: string; readonly name: string }>;
  readonly moveLog: MoveLog;
  /** The conversation's files on this machine (absolute paths) and the ids they are named after (an older move: nothing recorded). */
  readonly conversationFiles: (record: SessionRecord) => Promise<{ readonly files: readonly string[]; readonly ids: readonly string[] }>;
}

/** A refusal of a clean-up (the routes send it as `{ error, message }`). */
export class SourceCleanupError extends Error {
  override name = 'SourceCleanupError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One repo or worktree the clean-up looks at. */
interface Candidate {
  readonly name: string;
  readonly kind: 'main' | 'worktree';
  readonly path: string;
  readonly mainPath: string;
  readonly carried: CarriedRepo | null;
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

async function real(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file));
}

function inside(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * D156 (`docs/peers.md` → *Cleaning up the source after a move (D156)*): the clean-up
 * of a moved agent on this, its source, computer. {@link preview} says what it would
 * remove and lists the rest; {@link run} removes it: the agent archived (D137), the
 * worktrees that travelled and are unchanged since (their local branch only when the
 * remote has it at the same commit), the conversation file the move copied. Never a
 * main checkout, a repo, a workspace file, `git worktree prune`, `git branch -D`, or
 * a `--force` that could lose work that did not travel.
 */
export class SourceCleanup {
  readonly #o: SourceCleanupOptions;

  constructor(options: SourceCleanupOptions) {
    this.#o = options;
  }

  /** What a clean-up would do now (nothing changes). */
  async preview(sessionId: string): Promise<{ readonly report: SourceCleanupReport; readonly log: readonly string[] }> {
    const log: string[] = [];
    return { report: await this.#work(sessionId, false, log), log };
  }

  /**
   * Runs the clean-up. `run`: the move's run id (its move log) or a fresh one for
   * **Clean up on this computer…**; every removal and every item left is in the
   * `move: cleanup` line, and the agent's chat gets a note.
   */
  async run(sessionId: string, run: string, trigger: 'move' | 'manual'): Promise<{ readonly report: SourceCleanupReport; readonly log: readonly string[] }> {
    const log: string[] = [];
    const report = await this.#o.moveLog.step(run, 'cleanup', 'source', () => this.#work(sessionId, true, log), { session: sessionId, trigger }, (value) => ({
      removed: value.removed.map((item) => `${item.kind}: ${item.path}`),
      left: value.manual.map((item) => `${item.kind}: ${item.path} (${item.text})`),
      derived: value.derived,
    }));
    return { report, log };
  }

  async #work(sessionId: string, apply: boolean, log: string[]): Promise<SourceCleanupReport> {
    const record = await this.#o.store.sessions.get(sessionId);
    if (!record) throw new SourceCleanupError(404, 'not-found', `no session ${sessionId}`);
    const move = record.movedTo;
    if (!move) throw new SourceCleanupError(409, 'not-moved', `${record.title ?? record.name} was not moved to another computer: there is nothing to clean up after a move`);
    if (this.#o.supervisor.isLive(sessionId)) throw new SourceCleanupError(409, 'running', `${record.title ?? record.name} is running here: it was moved, so stop it first`);
    const self = await this.#o.self();
    const to = move.machineName;
    const git = new TakeoverGit({ log: (line) => log.push(line), env: this.#o.env });
    const carried: MoveCarried | null = move.carried ?? null;
    const removed: SourceCleanupItem[] = [];
    const manual: SourceCleanupItem[] = [];
    const title = record.title ?? record.name;

    // 1 · the agent: archived (D137) — it stays in Archived with its history until the archive's period ends.
    if (record.closedAt === null) {
      if (apply) await this.#o.supervisor.close(sessionId, { confirm: true });
      removed.push({ kind: 'session', path: title, text: 'archived: it stays in Archived with its history until the archive deletes it' });
    } else {
      removed.push({ kind: 'session', path: title, text: 'archived (already): it stays in Archived with its history until the archive deletes it' });
    }

    // 2 · the repos and worktrees.
    const all = await this.#o.store.sessions.list();
    const candidates = carried ? this.#carriedCandidates(carried) : await this.#derivedCandidates(record, git);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const at = await real(candidate.path);
      if (seen.has(at)) continue;
      seen.add(at);
      if (!(await exists(candidate.path))) continue;
      const main = await real((await git.mainCheckout(candidate.path)) ?? candidate.mainPath);
      if (candidate.kind === 'main' || main === at) {
        manual.push({ kind: 'main-checkout', path: candidate.path, text: carried ? `carried: the code now also lives on ${to}. Switchboard never removes a main checkout` : `the agent worked here (an older move: it likely travelled to ${to}). Switchboard never removes a main checkout` });
        continue;
      }
      await this.#worktree(candidate, main, record, all, git, apply, to, removed, manual);
    }
    for (const entry of carried?.notCarried ?? []) {
      const at = await real(entry.path);
      if (seen.has(at) || !(await exists(entry.path))) continue;
      seen.add(at);
      manual.push({ kind: entry.kind === 'worktree' ? 'worktree' : 'repo', path: entry.path, text: `${entry.reason}: its work stays here` });
    }

    // 3 · the conversation file the move copied (only this session's own files).
    await this.#conversation(record, carried, all, apply, to, removed, manual);

    // 4 · what travelled as a copy and stays here: the workspace files.
    if (carried && carried.workspaceRoot) {
      for (const name of carried.workspaceFiles) {
        const file = path.join(carried.workspaceRoot, ...name.split('/'));
        if (await exists(file)) manual.push({ kind: 'workspace-file', path: file, text: `copied to ${to}; the original stays here (other agents of the workspace may use it)` });
      }
    }
    // 5 · Switchboard's own folders for this agent (removed with it when the archive deletes it).
    for (const dir of ['attachments', 'handovers', 'chats']) {
      const folder = path.join(this.#o.dataDir, dir, record.id);
      if (await exists(folder)) manual.push({ kind: 'folder', path: folder, text: "Switchboard's files of this agent: removed with it when the archive deletes it" });
    }

    const at = new Date().toISOString();
    const report: SourceCleanupReport = { sessionId, title, machine: self.name, movedTo: to, at, ran: apply, derived: carried === null, removed, manual, error: null };
    if (apply) {
      const fresh = await this.#o.store.sessions.get(sessionId);
      if (fresh?.movedTo) await this.#o.store.sessions.update(sessionId, { movedTo: { ...fresh.movedTo, cleanup: { at, removed: removed.length, manual: manual.length } } });
      const text = `Cleaned up on ${self.name} after the move: ${removed.map((item) => `${item.kind === 'session' ? 'the agent' : item.path} ${item.kind === 'session' ? 'archived' : 'removed'}`).join('; ')}${manual.length > 0 ? `. Left for you: ${manual.map((item) => item.path).join(', ')}` : ''}`;
      await this.#o.supervisor.recordServiceEvent(sessionId, 'text', text, { type: 'lifecycle', action: 'moved-cleaned', message: text }).catch(() => undefined);
    }
    return report;
  }

  /** The repos a move recorded: its worktrees first (a worktree's branch is checked before its main checkout is listed). */
  #carriedCandidates(carried: MoveCarried): Candidate[] {
    return carried.repos.map((repo) => ({ name: repo.name, kind: repo.kind, path: repo.path, mainPath: repo.mainPath, carried: repo }));
  }

  /** An older move (nothing recorded): the session's worktrees, its folder's repos, its cwd's, its extra folders and what its history shows it worked in. */
  async #derivedCandidates(record: SessionRecord, git: TakeoverGit): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const add = async (dir: string): Promise<void> => {
      if (!(await exists(dir))) return;
      const top = (await git.try(dir, ['rev-parse', '--show-toplevel'])).out;
      if (top === '') return;
      const here = await real(top);
      const main = await real((await git.mainCheckout(here)) ?? here);
      out.push({ name: path.basename(main), kind: main === here ? 'main' : 'worktree', path: here, mainPath: main, carried: null });
    };
    for (const row of await this.#o.store.worktrees.list({ sessionId: record.id })) if (!row.removedAt) await add(row.path);
    if (record.cwd) await add(record.cwd);
    const folder = folderOfSession(record);
    if (folder && record.rootKind === 'workspace') {
      for (const solution of record.solutions) {
        const location = await this.#o.worktrees.resolveRepo(solution, folder).catch(() => null);
        if (location) await add(location.repoPath);
      }
    }
    for (const dir of record.extraDirs ?? []) await add(dir);
    for (const entry of await this.#o.worktrees.worksInFound(record).catch(() => [])) await add(entry.top);
    // Worktrees first, so their decisions are made before a main checkout of the same repo is listed.
    return [...out.filter((entry) => entry.kind === 'worktree'), ...out.filter((entry) => entry.kind === 'main')];
  }

  async #worktree(candidate: Candidate, main: string, record: SessionRecord, all: readonly SessionRecord[], git: TakeoverGit, apply: boolean, to: string, removed: SourceCleanupItem[], manual: SourceCleanupItem[]): Promise<void> {
    const dir = candidate.path;
    const at = await real(dir);
    const head = await git.sha(dir, 'HEAD');
    const branch = await git.currentBranch(dir);
    const uncommitted = (await git.dirtyCounts(dir)).total;
    const currentTree = uncommitted > 0 && candidate.carried?.wipTree ? await git.workingTree(dir) : null;
    const status = (await git.raw(dir, ['status', '--porcelain=v1', '-z', '--ignored'])) ?? '';
    const keptIgnored = status
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .map((entry) => entry.slice(3))
      .filter((entry) => !regenerableIgnored(entry));
    const usedBy: string[] = [];
    for (const other of all) {
      if (other.id === record.id || other.cwd === null) continue;
      if (inside(await real(other.cwd), at)) usedBy.push(other.title ?? other.name);
    }
    const count = await git.try(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    const localOnly = count.ok && /^\d+$/.test(count.out) ? Number(count.out) : null;
    const decision = decideWorktreeCleanup({ exists: true, linked: true, head, uncommitted, currentTree, keptIgnored, usedBy, localOnly, carried: candidate.carried });
    if (!decision.remove) {
      manual.push({ kind: 'worktree', path: dir, text: `not removed: ${decision.why}` });
      return;
    }
    // Its branch: deleted after the worktree only when the remote has it at the same commit.
    const remote = candidate.carried?.remoteName ?? (branch ? (await git.remoteOf(dir, branch))?.name : null) ?? 'origin';
    let remoteTip: string | null = null;
    if (branch) {
      const listed = await git.tryRemote(dir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], 30_000);
      remoteTip = listed.ok ? (listed.out.split('\n').map((line) => line.split(/\s+/)).find((parts) => parts[1] === `refs/heads/${branch}`)?.[0] ?? null) : null;
    }
    const branchDecision = decideBranchCleanup({ branch, protectedReason: branch ? protectedBranchReason(branch) : null, localTip: head, remoteTip, remote });
    const how = decision.force ? `its uncommitted changes travelled to ${to} (git worktree remove --force)` : 'git worktree remove';
    if (!apply) {
      removed.push({ kind: 'worktree', path: dir, text: `would be removed: it travelled to ${to} and is unchanged since (${how})` });
      if (branch && branchDecision.delete) removed.push({ kind: 'branch', path: `${main} ${branch}`, text: `would be deleted (git branch -d): ${remote} has it at the same commit` });
      else if (branch) manual.push({ kind: 'branch', path: `${main} ${branch}`, text: `kept: ${branchDecision.delete ? '' : branchDecision.why}` });
      return;
    }
    // Re-read right before removing: a change since the facts were read keeps it.
    const again = await git.dirtyCounts(dir);
    const headNow = await git.sha(dir, 'HEAD');
    if (headNow !== head || again.total !== uncommitted || (decision.force && (await git.workingTree(dir)) !== currentTree)) {
      manual.push({ kind: 'worktree', path: dir, text: 'not removed: it changed while it was being cleaned up' });
      return;
    }
    const removal = await git.try(main, ['worktree', 'remove', ...(decision.force ? ['--force'] : []), dir]);
    if (!removal.ok) {
      manual.push({ kind: 'worktree', path: dir, text: `not removed: git refused (${removal.error})` });
      return;
    }
    const row = await this.#o.store.worktrees.getLiveByPath(dir);
    if (row) await this.#o.store.worktrees.markRemoved(row.id);
    removed.push({ kind: 'worktree', path: dir, text: `removed: it travelled to ${to} and was unchanged since (${how})` });
    if (!branch) return;
    if (!branchDecision.delete) {
      manual.push({ kind: 'branch', path: `${main} ${branch}`, text: `kept: ${branchDecision.why}` });
      return;
    }
    const deleted = await git.try(main, ['branch', '-d', branch]);
    if (deleted.ok) removed.push({ kind: 'branch', path: `${main} ${branch}`, text: `deleted (git branch -d): ${remote} has it at the same commit` });
    else manual.push({ kind: 'branch', path: `${main} ${branch}`, text: `kept: git branch -d refused (${deleted.error})` });
  }

  /** Claude Code's (or Codex's) own record of the conversation: only this session's files, only when no other session here uses them. */
  async #conversation(record: SessionRecord, carried: MoveCarried | null, all: readonly SessionRecord[], apply: boolean, to: string, removed: SourceCleanupItem[], manual: SourceCleanupItem[]): Promise<void> {
    const found = await this.#o.conversationFiles(record).catch(() => ({ files: [] as string[], ids: [] as string[] }));
    const ids = [...new Set([record.claudeSessionId, ...found.ids].filter((id) => typeof id === 'string' && id.length >= 8))];
    const files = carried ? carried.conversation : found.files;
    if (files.length === 0) return;
    const sharedWith = all.filter((other) => other.id !== record.id && ids.includes(other.claudeSessionId) && !(other.movedTo && other.closedAt !== null));
    // The files named after the session's id, and the folder `<id>/` beside its transcript (its subagents' files).
    const roots = new Set<string>();
    for (const file of files) {
      const id = ids.find((value) => path.basename(file).includes(value));
      if (id) {
        roots.add(file);
        continue;
      }
      const segments = file.split(path.sep);
      const at = segments.findIndex((segment) => ids.includes(segment));
      if (at > 0) roots.add(segments.slice(0, at + 1).join(path.sep));
    }
    for (const target of roots) {
      if (!(await exists(target))) continue;
      if (sharedWith.length > 0) {
        manual.push({ kind: 'conversation', path: target, text: `kept: ${sharedWith.map((other) => other.title ?? other.name).join(', ')} here uses the same conversation` });
        continue;
      }
      const info = await stat(target).catch(() => null);
      if (!info) continue;
      // A folder only when it is named exactly after the session's id (`<id>/` beside the transcript).
      if (info.isDirectory() && !ids.includes(path.basename(target))) continue;
      if (!apply) {
        removed.push({ kind: 'conversation', path: target, text: `would be removed: the move copied it to ${to}` });
        continue;
      }
      try {
        await rm(target, { recursive: info.isDirectory(), force: false });
        removed.push({ kind: 'conversation', path: target, text: `removed: the move copied it to ${to}` });
      } catch (error) {
        manual.push({ kind: 'conversation', path: target, text: `not removed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
}
