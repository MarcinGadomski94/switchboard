import path from 'node:path';
import { type MemoryReach, type MemoryRepoRef, NO_REACH } from '../../core/memory.ts';
import { normalizeRemoteUrl } from '../../core/takeover.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { runCommand, succeeded } from '../exec.ts';
import type { SessionRepoSet } from '../worktrees/session-repos.ts';
import { memberOfSession } from './team-link.ts';

/**
 * D107 follow-up 2026-10-15 · what a session sees besides its folder's workspace entries
 * (`docs/memory.md` → *Scopes*): its Team member (D100) and the repositories it works in. The
 * repositories come from the shared repo set (`worktrees/session-repos.ts`: its worktrees and the
 * working trees it uses in place); each is named by its **normalized remote key**
 * (`normalizeRemoteUrl` of `origin`, else of its only remote), else by its **main checkout's path**
 * (`git rev-parse --git-common-dir`), so a linked worktree is its repository.
 */

/** What reach needs of the repo set (`SessionRepos.of`). */
export interface MemoryRepoSource {
  of(session: SessionRecord): Promise<SessionRepoSet>;
}

/** How long a working tree's repository identity is reused. */
const IDENTITY_TTL_MS = 60_000;

/** The repo identity of working trees, cached a minute (git is asked at most once per tree per minute). */
export class MemoryRepoIdentity {
  readonly #cache = new Map<string, { at: number; ref: Promise<MemoryRepoRef | null> }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The repository `top` (a main checkout or a linked worktree) belongs to; `null` outside git. */
  of(top: string): Promise<MemoryRepoRef | null> {
    const cached = this.#cache.get(top);
    if (cached && this.#now() - cached.at < IDENTITY_TTL_MS) return cached.ref;
    const ref = repoRefOf(top);
    this.#cache.set(top, { at: this.#now(), ref });
    if (this.#cache.size > 500) this.#cache.delete(this.#cache.keys().next().value as string);
    return ref;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 10_000 });
  return succeeded(result) ? result.stdout.trim() : null;
}

/** A working tree's repository: its remote key (else main checkout path) and its main checkout's name. */
export async function repoRefOf(top: string): Promise<MemoryRepoRef | null> {
  const common = await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common === null || common === '') return null;
  const main = path.basename(common) === '.git' ? path.dirname(common) : top;
  const remotes = ((await git(top, ['remote'])) ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
  const url = remote ? await git(top, ['remote', 'get-url', remote]) : null;
  const key = url ? normalizeRemoteUrl(url) : '';
  return { key: key !== '' ? key : main, label: path.basename(main) };
}

/** The repositories of a repo set, de-duplicated by key (worktrees first, then in place). */
export async function reposOf(set: SessionRepoSet, identity: MemoryRepoIdentity): Promise<MemoryRepoRef[]> {
  const out: MemoryRepoRef[] = [];
  const add = (ref: MemoryRepoRef | null): void => {
    if (ref && !out.some((known) => known.key === ref.key)) out.push(ref);
  };
  // A worktree whose folder is gone still names its repository through its main checkout.
  for (const worktree of set.worktrees) add((await identity.of(worktree.path).catch(() => null)) ?? (await identity.of(worktree.repoPath).catch(() => null)));
  for (const repo of set.inPlace) add(await identity.of(repo.top).catch(() => null));
  return out;
}

/** A session's reach: its member (Team on) and its repositories. Never throws (nothing found = workspace only). */
export async function reachOf(store: Store, session: SessionRecord, source: MemoryRepoSource | null, identity: MemoryRepoIdentity): Promise<MemoryReach> {
  const member = memberOfSession(store, session.id);
  let repos: MemoryRepoRef[] = [];
  if (source) {
    try {
      repos = await reposOf(await source.of(session), identity);
    } catch {
      repos = [];
    }
  }
  if (!member && repos.length === 0) return NO_REACH;
  return { memberId: member?.id ?? null, memberLabel: member?.name ?? null, repos };
}
