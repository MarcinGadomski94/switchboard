import path from 'node:path';
import { COMMAND_TOOLS, type EvidenceCounts, READ_TOOLS, type WorksInEvidenceKind, evidencePaths } from '../../core/works-in-evidence.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { isWorkingTreeTop } from '../solutions/checkout.ts';
import { EDIT_TOOLS, canonicalPath, insideRelative } from './touched.ts';

/**
 * D152 follow-up 2026-11-05 (`docs/worktrees.md` → *Which repositories* → *Works
 * in*): the evidence of which repos a session works in beyond what it edited: the
 * paths its Read / Grep / Glob / LS calls named (and the absolute paths a Glob /
 * Grep result listed) and the folders its shell commands ran in, each mapped to
 * the git working tree that holds it (the nearest folder with a `.git` entry, never
 * above the session's folder or worktree it lies in). Edits in the same window are
 * counted too, for the ranking.
 *
 * Never on a hot path (D144): only `GET /api/sessions/{id}/works-in` and a move's
 * `source/inspect` ask, never the session list, the Diff or checkpoints. Bounded:
 * the newest {@link WORKS_IN_EVENT_WINDOW} events only, results cut to
 * {@link WORKS_IN_RESULT_CHARS} characters in SQL, at most
 * {@link WORKS_IN_MAX_PATHS} distinct paths resolved (newest first). The answer is
 * remembered per session until a new event arrives (or {@link WORKS_IN_TTL_MS}).
 */

/** Only the session's newest events this many are read. */
export const WORKS_IN_EVENT_WINDOW = 20_000;
/** A tool result is read up to this many characters. */
export const WORKS_IN_RESULT_CHARS = 4_000;
/** At most this many distinct paths are mapped to a working tree per computation. */
export const WORKS_IN_MAX_PATHS = 2_000;
/** An answer is reused this long when no new event arrived (a repo cloned meanwhile shows up after it). */
export const WORKS_IN_TTL_MS = 30_000;
/** Sessions whose answers are remembered (oldest dropped first). */
const MAX_SESSIONS = 200;

/** The evidence for one working tree. */
export interface RepoEvidence {
  /** The working tree's top folder (real path). */
  readonly top: string;
  readonly counts: EvidenceCounts;
}

/** Where a session's paths may count: its folder and its worktrees (real paths). */
export interface EvidenceBounds {
  /** The session's folder (a workspace root, a repo folder, a plain folder); `null` without one. */
  readonly root: string | null;
  /** The session's registered worktrees. */
  readonly worktrees: readonly string[];
}

interface Cached {
  readonly key: string;
  readonly newestId: number;
  readonly at: number;
  readonly answer: readonly RepoEvidence[];
}

/** Options of {@link WorksInEvidence}. */
export interface WorksInEvidenceOptions {
  readonly store: Store;
  /** Epoch ms (tests). */
  readonly now?: () => number;
}

/** Reads and remembers a session's read / command evidence (see the module comment). */
export class WorksInEvidence {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #cache = new Map<string, Cached>();
  readonly #running = new Map<string, Promise<readonly RepoEvidence[]>>();

  constructor(options: WorksInEvidenceOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  /** The working trees the session's tool calls point into, with how often each was edited, read or worked in by a command, first seen first. */
  async of(session: Pick<SessionRecord, 'id' | 'cwd'>, bounds: EvidenceBounds): Promise<readonly RepoEvidence[]> {
    const key = JSON.stringify([session.cwd, bounds.root, bounds.worktrees]);
    const newestId = await this.#store.events.newestId(session.id);
    const cached = this.#cache.get(session.id);
    if (cached && cached.key === key && cached.newestId === newestId && this.#now() - cached.at < WORKS_IN_TTL_MS) return cached.answer;
    // Concurrent callers share one computation.
    const runKey = `${session.id}\u0000${key}\u0000${newestId}`;
    const running = this.#running.get(runKey);
    if (running) return running;
    const work = this.#compute(session, bounds).then((answer) => {
      this.#cache.delete(session.id);
      this.#cache.set(session.id, { key, newestId, at: this.#now(), answer });
      if (this.#cache.size > MAX_SESSIONS) this.#cache.delete(this.#cache.keys().next().value as string);
      return answer;
    });
    this.#running.set(runKey, work);
    try {
      return await work;
    } finally {
      this.#running.delete(runKey);
    }
  }

  /** Forgets a session's remembered answer (tests; a session that is gone). */
  forget(sessionId: string): void {
    this.#cache.delete(sessionId);
  }

  async #compute(session: Pick<SessionRecord, 'id' | 'cwd'>, bounds: EvidenceBounds): Promise<readonly RepoEvidence[]> {
    const calls = await this.#store.events.toolCallsInNewest(session.id, [...EDIT_TOOLS, ...READ_TOOLS, ...COMMAND_TOOLS], WORKS_IN_EVENT_WINDOW, WORKS_IN_RESULT_CHARS);
    const cwd = session.cwd;
    // Newest first, so the path cap keeps the recent ones; counted per call and kind.
    const perPath = new Map<string, { edited: number; read: number; commands: number; first: number }>();
    for (let at = calls.length - 1; at >= 0; at--) {
      const call = calls[at] as (typeof calls)[number];
      let input: unknown = null;
      try {
        input = call.input === null ? null : JSON.parse(call.input);
      } catch {
        continue;
      }
      const found: Array<{ path: string; kind: WorksInEvidenceKind }> = [];
      if (EDIT_TOOLS.includes(call.name)) {
        const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
        const written = typeof record['file_path'] === 'string' ? record['file_path'] : typeof record['notebook_path'] === 'string' ? record['notebook_path'] : null;
        if (written !== null && written !== '') {
          const absolute = path.isAbsolute(written) ? written : cwd ? path.resolve(cwd, written) : null;
          if (absolute !== null) found.push({ path: absolute, kind: 'edited' });
        }
      } else {
        found.push(...evidencePaths({ type: 'tool', name: call.name, input, ...(call.result !== null ? { result: call.result } : {}), ...(call.isError ? { isError: true } : {}) }, cwd));
      }
      for (const entry of found) {
        let counts = perPath.get(entry.path);
        if (!counts) {
          if (perPath.size >= WORKS_IN_MAX_PATHS) continue;
          counts = { edited: 0, read: 0, commands: 0, first: call.id };
          perPath.set(entry.path, counts);
        }
        counts[entry.kind]++;
        counts.first = Math.min(counts.first, call.id);
      }
    }
    if (perPath.size === 0) return [];
    const roots = [bounds.root, ...bounds.worktrees].filter((entry): entry is string => entry !== null);
    const realRoots: string[] = [];
    for (const root of roots) realRoots.push(await canonicalPath(root));
    const tops = new Map<string, string | null>();
    const byTop = new Map<string, { edited: number; read: number; commands: number; first: number }>();
    for (const [written, counts] of perPath) {
      // A Windows path read on a Mac (or the reverse) is no path here.
      if (!path.isAbsolute(written)) continue;
      const file = await canonicalPath(written);
      const bound = boundOf(realRoots, file);
      // Edits count wherever they are (SessionRepos lists their working trees); reads and commands only inside the session's folder or worktrees.
      if (bound === null && counts.read + counts.commands > 0 && counts.edited === 0) continue;
      const top = await topWithin(file, bound, tops);
      if (top === null) continue;
      const sum = byTop.get(top) ?? { edited: 0, read: 0, commands: 0, first: counts.first };
      sum.edited += counts.edited;
      if (bound !== null) {
        sum.read += counts.read;
        sum.commands += counts.commands;
      }
      sum.first = Math.min(sum.first, counts.first);
      byTop.set(top, sum);
    }
    return [...byTop.entries()]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([top, sum]) => ({ top, counts: { edited: sum.edited, read: sum.read, commands: sum.commands } }));
  }
}

/** The root (of `roots`) `file` lies in or is, the deepest one; `null` when none. */
function boundOf(roots: readonly string[], file: string): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (file !== root && insideRelative(root, file) === null) continue;
    if (best === null || root.length > best.length) best = root;
  }
  return best;
}

/**
 * The git working tree holding `file`: the nearest folder (from `file` itself up)
 * with a `.git` entry, never above `bound` (`null` bound: up to the file system's
 * top, an edit's rule). Folders already resolved are reused through `seen`.
 */
async function topWithin(file: string, bound: string | null, seen: Map<string, string | null>): Promise<string | null> {
  const walked: string[] = [];
  let current = file;
  let answer: string | null = null;
  for (;;) {
    const known = seen.get(`${bound ?? ''}\u0000${current}`);
    if (known !== undefined) {
      answer = known;
      break;
    }
    walked.push(current);
    if (await isWorkingTreeTop(current)) {
      answer = current;
      break;
    }
    const parent = path.dirname(current);
    if (current === bound || parent === current) break;
    if (bound !== null && insideRelative(bound, parent) === null && parent !== bound) break;
    current = parent;
  }
  for (const dir of walked) seen.set(`${bound ?? ''}\u0000${dir}`, answer);
  return answer;
}
