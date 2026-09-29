import { open, stat } from 'node:fs/promises';
import type { Loop, TerminalLoop, TerminalSession } from '../../core/api.ts';
import { deriveLoops, type LoopEventInput } from '../../core/derive/loops.ts';
import { transcriptLoopEvents } from '../../core/derive/terminal-loops.ts';
import { terminalStatus } from '../../core/terminal-status.ts';
import { parseTranscript } from '../../core/transcript-sync.ts';
import { findTranscriptFile } from '../supervisor/attach.ts';
import { findLoopProgress } from './progress.ts';

/**
 * D52 "A peer's schedules and loops" (`docs/derivations.md` → *Loop cards* →
 * *Terminal sessions (D52)*): the loops of the terminal `claude` sessions running
 * on this machine that Switchboard does not follow (neither its own nor hooked),
 * derived read-only from their transcripts. No hooks are needed: the list is
 * `claude agents --json` (through the hook service's terminal list), each
 * transcript is found in this machine's CLI projects dir and read as it is.
 *
 * Bounded and cheap: at most {@link MAX_TERMINALS} sessions; a transcript is read
 * again only when its size or mtime changed, and at most its last
 * {@link MAX_TRANSCRIPT_BYTES} (a longer file's older turns are not seen: a loop
 * started before them is missed). Nothing is stored.
 */

/** At most this many terminal sessions are read per list. */
export const MAX_TERMINALS = 32;

/** At most this much of a transcript's end is read. */
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** The row id prefix of a terminal loop: `term:<claude session id>:<key>`. */
export const TERMINAL_LOOP_PREFIX = 'term:';

/** Options of {@link TerminalLoopReader}. */
export interface TerminalLoopReaderOptions {
  /** The terminal sessions running on this machine (`HookService.listTerminals`); `null` when `claude agents --json` could not be read. */
  readonly listTerminals: () => Promise<readonly TerminalSession[] | null>;
  /** The CLI's config dir (its `projects/`). */
  readonly configDir: () => string;
  readonly now?: () => Date;
}

interface Cached {
  readonly key: string;
  readonly events: LoopEventInput[];
}

/** The D52 terminal-loop reader of this machine. */
export class TerminalLoopReader {
  readonly #options: TerminalLoopReaderOptions;
  readonly #now: () => Date;
  /** Per transcript file: its loop events (cached by size + mtime). */
  readonly #files = new TranscriptLoopEvents();

  constructor(options: TerminalLoopReaderOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** `GET /api/terminal-loops` (this machine's part): every loop of every un-followed terminal session. */
  async list(): Promise<TerminalLoop[]> {
    const terminals = await this.#options.listTerminals();
    if (!terminals) return [];
    const out: TerminalLoop[] = [];
    const seen = new Set<string>();
    for (const terminal of terminals.filter((row) => !row.hooked).slice(0, MAX_TERMINALS)) {
      const file = await findTranscriptFile(this.#options.configDir(), terminal.id);
      if (!file) continue;
      seen.add(file);
      const events = await this.#events(file);
      if (events.length === 0) continue;
      const now = this.#now();
      const observed = deriveLoops(events, { now, status: terminalStatus(terminal.status), mainAgentId: null });
      if (observed.length === 0) continue;
      const progress = terminal.cwd ? await findLoopProgress([terminal.cwd], terminal.cwd) : null;
      const counted = progress && (progress.progress.cap !== null || progress.progress.breakerCount !== null) ? progress : null;
      const info = { id: terminal.id, name: terminal.name, cwd: terminal.cwd, status: terminal.status, pid: terminal.pid, startedAt: terminal.startedAt };
      for (const loop of observed) {
        const note = [loop.note, counted ? `Cap and breaker from ${counted.shown}.` : null].filter((n): n is string => Boolean(n)).join(' ');
        const wire: Loop = {
          id: `${TERMINAL_LOOP_PREFIX}${terminal.id}:${loop.key}`,
          sessionId: terminal.id,
          kind: loop.kind,
          label: loop.label,
          iteration: loop.iteration,
          cap: counted?.progress.cap ?? null,
          breakerCount: counted?.progress.breakerCount ?? null,
          breakerState: null,
          nextFireAt: loop.nextFireAt,
          expiresAt: loop.expiresAt,
          iterations: loop.iterations,
          progressPath: counted?.shown ?? null,
          note: note === '' ? null : note,
          createdAt: loop.startedAt,
          updatedAt: now.toISOString(),
        };
        out.push({ loop: wire, terminal: info });
      }
    }
    // Sessions that are gone leave the cache.
    this.#files.retain(seen);
    return out;
  }

  async #events(file: string): Promise<LoopEventInput[]> {
    return this.#files.events(file);
  }
}

/**
 * D52: the loop events of transcript files (`transcriptLoopEvents`), each read again
 * only when its size or mtime changed, at most its last {@link MAX_TRANSCRIPT_BYTES}.
 * Shared by the terminal-loop reader and the hooked sessions' loops.
 */
export class TranscriptLoopEvents {
  readonly #cache = new Map<string, Cached>();

  /** The file's loop events (`[]` when it cannot be read). */
  async events(file: string): Promise<LoopEventInput[]> {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(file);
    } catch {
      return [];
    }
    const key = `${info.size}:${info.mtimeMs}`;
    const cached = this.#cache.get(file);
    if (cached?.key === key) return cached.events;
    const text = await readTail(file, info.size);
    const events = text === null ? [] : transcriptLoopEvents(parseTranscript(text));
    this.#cache.set(file, { key, events });
    return events;
  }

  /** Forgets every file but `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const file of [...this.#cache.keys()]) if (!keep.has(file)) this.#cache.delete(file);
  }
}

/** The file's text, at most its last {@link MAX_TRANSCRIPT_BYTES} (from the first whole line); `null` when it cannot be read. */
async function readTail(file: string, size: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, 'r');
    const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
