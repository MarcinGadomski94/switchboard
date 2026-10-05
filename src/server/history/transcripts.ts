import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { HistoryItem } from '../../core/api.ts';
import { type HistoryRoot, type HistorySession, type HistoryTranscript, buildHistoryRows, filterHistory } from '../../core/history.ts';
import { type TranscriptFacts, TranscriptParser, isCurrentFacts, projectFolderPrefix } from '../../core/transcript.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import { type FolderRef, folderOfSession, folderRefOf, repoSolutionName } from '../folders/ref.ts';
import type { HistoryProvider } from '../providers.ts';

/** Each path resolved, then its real path when that differs; no duplicates. */
async function pathForms(paths: readonly string[]): Promise<string[]> {
  const forms: string[] = [];
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    const real = await realpath(resolved).catch(() => resolved);
    for (const form of [real, resolved]) if (!forms.includes(form)) forms.push(form);
  }
  return forms;
}

/**
 * The Claude Code config folder transcripts live under (`docs/spike-m0.md` →
 * *Transcript location*): `$CLAUDE_CONFIG_DIR`, else `~/.claude`, NFC-normalized
 * like the CLI does. Resolved once at startup.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  const dir = configured && configured.trim() !== '' ? path.resolve(configured) : path.join(home, '.claude');
  return dir.normalize('NFC');
}

/**
 * The facts of one transcript file (`<id>.jsonl`, the id from its name), streamed
 * line by line (files reach tens of MB). Read only.
 */
export async function readTranscriptFacts(file: string): Promise<TranscriptFacts> {
  const parser = new TranscriptParser(path.basename(file, '.jsonl'));
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) parser.pushLine(line);
  } finally {
    lines.close();
    stream.destroy();
  }
  return parser.finish();
}

/** Options of {@link TranscriptHistory}. */
export interface TranscriptHistoryOptions {
  /** Sessions and saved folders (D14: History reads under every saved folder and every session's folder). */
  readonly store: Store;
  /** From {@link claudeConfigDir}. Only ever read. */
  readonly configDir: string;
  /** Default: the current platform (macOS and Windows compare paths case-insensitively). */
  readonly platform?: NodeJS.Platform;
  /** Clock for "active" (tests). */
  readonly now?: () => number;
}

interface Parsed {
  readonly size: number;
  readonly mtimeMs: number;
  readonly facts: TranscriptFacts;
}

/** A transcript file found by a scan. */
interface Found {
  readonly file: string;
  readonly folder: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * The real History provider (M7.4; D14): stored sessions from the database
 * joined with the transcripts under `<configDir>/projects/`, plus the
 * terminal-started sessions (gap #5) of every saved folder and every session's
 * folder. Each row carries its folder. Rules for which rows exist and what they
 * show are in `src/core/history.ts`; this class finds and parses the files.
 *
 * - Only project folders whose name starts with the slug of a folder (saved or a
 *   session's) or of a session's cwd (a repo worktree) are read (the slug is
 *   lossy, so `src/core/history.ts` also checks each file's start `cwd`), and only
 *   their top-level `*.jsonl` (never `<id>/subagents/`).
 * - Each file is streamed line by line (they reach tens of MB) and parsed once per
 *   `(size, mtime)`: the facts are cached in memory and in `history_cache`, so a
 *   restart does not re-read unchanged files. Cache rows of files that are gone
 *   from a scanned folder are dropped.
 * - Nothing is ever written under the config folder.
 */
export class TranscriptHistory implements HistoryProvider {
  readonly #store: Store;
  readonly #projectsDir: string;
  readonly #caseInsensitive: boolean;
  readonly #now: () => number;
  readonly #memory = new Map<string, Parsed>();
  readonly #parsing = new Map<string, Promise<Parsed>>();
  #parseCount = 0;

  constructor(options: TranscriptHistoryOptions) {
    this.#store = options.store;
    this.#projectsDir = path.join(options.configDir, 'projects');
    const platform = options.platform ?? process.platform;
    this.#caseInsensitive = platform === 'darwin' || platform === 'win32';
    this.#now = options.now ?? Date.now;
  }

  /** How many files were parsed (not served from a cache) so far. For tests. */
  get parseCount(): number {
    return this.#parseCount;
  }

  async history(q?: string): Promise<HistoryItem[]> {
    const records = await this.#store.sessions.list();
    const sessions = await this.#storedSessions(records);
    const roots = await this.#roots(records);
    // The transcript folders: every folder, plus each session's cwd (a repo session's worktree sits next to the repo).
    const scanned = [...new Set([...roots.map((root) => root.path), ...records.flatMap((record) => (record.cwd ? [record.cwd] : []))])];
    const transcripts = scanned.length > 0 ? await this.#transcripts(scanned) : [];
    const rows = buildHistoryRows({ sessions, transcripts, roots, caseInsensitive: this.#caseInsensitive, now: this.#now() });
    return filterHistory(rows, q);
  }

  async #storedSessions(records: readonly SessionRecord[]): Promise<HistorySession[]> {
    const worktrees = await this.#store.worktrees.list({ includeRemoved: true });
    return records.map((record) => ({
      id: record.id,
      name: record.name,
      title: record.title,
      claudeSessionId: record.claudeSessionId,
      status: record.status,
      task: record.task,
      workType: record.workType,
      mode: record.mode,
      phase: record.phase,
      solutions: record.solutions,
      createdAt: record.createdAt,
      worktrees: worktrees
        .filter((wt) => wt.sessionId === record.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((wt) => ({ repo: wt.repo, branch: wt.branch, prNumber: wt.prNumber, prState: wt.prState })),
      folder: record.folderId,
      folderPath: record.root,
      origin: record.origin,
      remoteSource: record.remoteSource,
      closedAt: record.closedAt,
      hooked: record.hooked,
    }));
  }

  /**
   * Every saved folder and every session's folder (D14), each as saved and in its
   * canonical form (the CLI records the on-disk case, M0.3). A saved folder wins
   * over a session's copy of the same path.
   */
  async #roots(records: readonly SessionRecord[]): Promise<HistoryRoot[]> {
    const roots: HistoryRoot[] = [];
    const seen = new Set<string>();
    const add = async (folder: FolderRef): Promise<void> => {
      const repoName = folder.kind === 'repo' ? repoSolutionName(folder) : null;
      for (const form of await pathForms([folder.path, folder.root])) {
        if (seen.has(form)) continue;
        seen.add(form);
        roots.push({ path: form, kind: folder.kind, folder: folder.id, folderPath: folder.path, repoName });
      }
    };
    for (const record of await this.#store.folders.list()) await add(folderRefOf(record));
    for (const record of records) {
      const folder = folderOfSession(record);
      if (folder) await add(folder);
    }
    return roots;
  }

  async #transcripts(scanned: readonly string[]): Promise<HistoryTranscript[]> {
    const prefixes = (await pathForms(scanned)).map((folder) => this.#fold(projectFolderPrefix(folder)));
    let folders: string[];
    try {
      folders = (await readdir(this.#projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && prefixes.some((prefix) => this.#fold(entry.name).startsWith(prefix)))
        .map((entry) => path.join(this.#projectsDir, entry.name));
    } catch {
      return [];
    }
    const found: Found[] = [];
    for (const folder of folders) found.push(...(await this.#filesIn(folder)));
    const transcripts: HistoryTranscript[] = [];
    for (const file of found) {
      const parsed = await this.#parsed(file).catch(() => null);
      if (parsed) transcripts.push({ facts: parsed.facts, mtimeMs: parsed.mtimeMs });
    }
    await this.#prune(new Set(folders), new Set(found.map((f) => f.file)));
    return transcripts;
  }

  #fold(text: string): string {
    return this.#caseInsensitive ? text.toLowerCase() : text;
  }

  /** Top-level `*.jsonl` files of a project folder with their size and mtime. */
  async #filesIn(folder: string): Promise<Found[]> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: Found[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, entry.name);
      try {
        const info = await stat(file);
        found.push({ file, folder, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // gone since the readdir
      }
    }
    return found;
  }

  /** The facts of `found`: memory, then `history_cache`, else a streaming parse (one at a time per file). */
  async #parsed(found: Found): Promise<Parsed> {
    const known = this.#memory.get(found.file);
    if (known && known.size === found.size && known.mtimeMs === found.mtimeMs) return known;
    const cached = await this.#store.historyCache.getFresh(found.file, found.size, found.mtimeMs);
    if (cached && isCurrentFacts(cached.item)) {
      const parsed = { size: found.size, mtimeMs: found.mtimeMs, facts: cached.item };
      this.#memory.set(found.file, parsed);
      return parsed;
    }
    const key = `${found.file}\n${found.size}\n${found.mtimeMs}`;
    let running = this.#parsing.get(key);
    if (!running) {
      running = this.#parse(found).finally(() => this.#parsing.delete(key));
      this.#parsing.set(key, running);
    }
    return running;
  }

  async #parse(found: Found): Promise<Parsed> {
    const sessionId = path.basename(found.file, '.jsonl');
    const facts = await readTranscriptFacts(found.file);
    this.#parseCount += 1;
    // The cache is keyed by the (size, mtime) the scan saw; a file that grew while it was
    // read is simply parsed again on the next request.
    const parsed = { size: found.size, mtimeMs: found.mtimeMs, facts };
    this.#memory.set(found.file, parsed);
    await this.#store.historyCache.upsert({ transcriptPath: found.file, claudeSessionId: sessionId, size: found.size, mtimeMs: found.mtimeMs, item: facts });
    return parsed;
  }

  /** Drops cache rows of files that are no longer in a folder that was just scanned. */
  async #prune(folders: ReadonlySet<string>, files: ReadonlySet<string>): Promise<void> {
    for (const entry of await this.#store.historyCache.list()) {
      if (files.has(entry.transcriptPath) || !folders.has(path.dirname(entry.transcriptPath))) continue;
      await this.#store.historyCache.delete(entry.transcriptPath);
      this.#memory.delete(entry.transcriptPath);
    }
  }
}
