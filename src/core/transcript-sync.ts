/**
 * "Attach here" sync back (M4.1; `docs/handoff/ARCHITECTURE.md` → *Terminal
 * handoff*, `docs/spike-m0.md` → M0.4): stdout never replays history, so the turns
 * a terminal added while the session was detached are read from the CLI's
 * transcript (`<configDir>/projects/<slug>/<sessionId>.jsonl`). This module is the
 * pure part: which transcript entries are new, and what each one shows in the
 * chat. Reading the file and storing the events is `src/server/supervisor/attach.ts`.
 *
 * Rules (`docs/supervisor.md` → *Attach here*):
 * - The conversation is the chain of `user` / `assistant` / `attachment` / `system`
 *   entries linked by `parentUuid` (sidechain entries excluded). A file can hold
 *   more than one leaf when two processes wrote to one id (M0.4 `handoff-conc`); the
 *   CLI continues from the newest leaf, so that leaf's chain is the conversation.
 *   "Newest" = the leaf written last (the file is append-only).
 * - New = the chain entries after the sync point (`sessions.last_transcript_uuid`,
 *   the newest main-chain uuid Switchboard saw on stdout). When the sync point is on
 *   another branch, the entries after the fork point are new (without a common
 *   ancestor: the chain's entries written after the sync point's line). When there
 *   is no sync point yet, the whole chain is new. When the sync point is not in the
 *   file at all, nothing is imported (never guessed).
 * - Skipped: `model:"<synthetic>"` assistant lines (`No response requested.` after
 *   an interrupted turn), `isMeta` user lines, interrupt markers, thinking blocks,
 *   `attachment` / `system` entries.
 */
import { type JsonRecord, parseStreamObject } from './stream-json.ts';

/** One parsed transcript line. */
export type TranscriptEntry = Readonly<JsonRecord>;

/** Entry types that form the `parentUuid` chain (M0.3). */
const CHAIN_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'attachment', 'system']);

/** The model name of the CLI's own filler lines (`No response requested.`, M0.4). */
export const SYNTHETIC_MODEL = '<synthetic>';

function uuidOf(entry: TranscriptEntry): string | null {
  return typeof entry['uuid'] === 'string' ? entry['uuid'] : null;
}

/**
 * The entry's parent in the conversation: `parentUuid`, or `logicalParentUuid` for
 * an entry that restarts the physical chain (the CLI's compaction boundary).
 */
function parentOf(entry: TranscriptEntry): string | null {
  if (typeof entry['parentUuid'] === 'string') return entry['parentUuid'];
  return typeof entry['logicalParentUuid'] === 'string' ? entry['logicalParentUuid'] : null;
}

/** `true` for a main-chain conversation entry (has a uuid, not a sidechain line). */
export function isChainEntry(entry: TranscriptEntry): boolean {
  return CHAIN_TYPES.has(String(entry['type'])) && uuidOf(entry) !== null && entry['isSidechain'] !== true;
}

/** Parses the text of a transcript file (one JSON object per line); lines that are not objects are skipped. */
export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed as TranscriptEntry);
    } catch {
      // A line cut by a concurrent writer: not part of the conversation yet.
    }
  }
  return entries;
}

/** The chain of the leaf written last, root first. Empty when the file has no chain entries. */
export function newestChain(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const chain = entries.filter(isChainEntry);
  const byUuid = new Map<string, TranscriptEntry>();
  const parents = new Set<string>();
  for (const entry of chain) {
    byUuid.set(uuidOf(entry) as string, entry);
    const parent = parentOf(entry);
    if (parent) parents.add(parent);
  }
  let leaf: TranscriptEntry | undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i] as TranscriptEntry;
    if (!parents.has(uuidOf(entry) as string)) {
      leaf = entry;
      break;
    }
  }
  const out: TranscriptEntry[] = [];
  const seen = new Set<string>();
  for (let entry = leaf; entry; ) {
    const uuid = uuidOf(entry) as string;
    if (seen.has(uuid)) break; // a malformed cycle
    seen.add(uuid);
    out.push(entry);
    const parent = parentOf(entry);
    entry = parent ? byUuid.get(parent) : undefined;
  }
  return out.reverse();
}

/** What {@link entriesSince} found. */
export interface SyncSlice {
  /** The newest chain's entries after the sync point, oldest first. */
  readonly entries: TranscriptEntry[];
  /** The newest chain's tip (the new sync point), `null` for a file without chain entries. */
  readonly tip: string | null;
  /** `false` when the sync point is not in the file at all (nothing is imported then). */
  readonly found: boolean;
  /** `true` when the sync point sits on an older branch (the file forked after it). */
  readonly forked: boolean;
}

/** The entries written after `syncUuid` on the newest leaf's chain (rules in the module comment). */
export function entriesSince(entries: readonly TranscriptEntry[], syncUuid: string | null): SyncSlice {
  const chain = newestChain(entries);
  const tip = chain.length > 0 ? uuidOf(chain[chain.length - 1] as TranscriptEntry) : null;
  if (syncUuid === null) return { entries: chain, tip, found: true, forked: false };
  const position = new Map<string, number>(chain.map((entry, index) => [uuidOf(entry) as string, index]));
  const direct = position.get(syncUuid);
  if (direct !== undefined) return { entries: chain.slice(direct + 1), tip, found: true, forked: false };
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    const uuid = uuidOf(entry);
    if (uuid && isChainEntry(entry)) byUuid.set(uuid, entry);
  }
  if (!byUuid.has(syncUuid)) return { entries: [], tip, found: false, forked: false };
  // Walk up from the sync point to the first ancestor on the newest chain: the fork point.
  const seen = new Set<string>();
  for (let uuid: string | null = syncUuid; uuid && !seen.has(uuid); ) {
    seen.add(uuid);
    const at = position.get(uuid);
    if (at !== undefined) return { entries: chain.slice(at + 1), tip, found: true, forked: true };
    const entry = byUuid.get(uuid);
    uuid = entry ? parentOf(entry) : null;
  }
  // No common ancestor (a broken link): the newest chain's entries written after the sync point's line.
  const syncLine = entries.findIndex((entry) => uuidOf(entry) === syncUuid);
  const later = new Set(entries.slice(syncLine + 1));
  return { entries: chain.filter((entry) => later.has(entry)), tip, found: true, forked: true };
}

/** One thing a transcript entry adds to the session's events. */
export type TranscriptItem =
  /** A prompt typed in the terminal (or a slash command, as `/name args`). */
  | { readonly kind: 'prompt'; readonly uuid: string; readonly ts: string | null; readonly text: string }
  /** Assistant text; blocks of one `messageId` belong to one message. */
  | { readonly kind: 'text'; readonly uuid: string; readonly ts: string | null; readonly messageId: string | null; readonly text: string }
  | {
      readonly kind: 'tool-use';
      readonly uuid: string;
      readonly ts: string | null;
      readonly messageId: string | null;
      readonly toolUseId: string;
      readonly name: string;
      readonly input: JsonRecord;
    }
  | { readonly kind: 'tool-result'; readonly uuid: string; readonly ts: string | null; readonly toolUseId: string; readonly text: string; readonly isError: boolean };

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** A typed prompt's text: slash commands (`<command-name>/loop</command-name><command-args>1h</command-args>`) read `/loop 1h`. */
export function promptText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('<local-command-')) return null;
  const name = COMMAND_NAME.exec(trimmed);
  if (name) {
    const args = COMMAND_ARGS.exec(trimmed)?.[1]?.trim() ?? '';
    const command = (name[1] ?? '').trim();
    return args ? `${command} ${args}` : command;
  }
  return trimmed;
}

/** What the given (new) transcript entries show, in order (skips listed in the module comment). */
export function transcriptItems(entries: readonly TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    const uuid = uuidOf(entry);
    if (!uuid || !isChainEntry(entry)) continue;
    const ts = typeof entry['timestamp'] === 'string' && !Number.isNaN(Date.parse(entry['timestamp'])) ? new Date(entry['timestamp']).toISOString() : null;
    const type = entry['type'];
    if (type === 'user') {
      if (entry['isMeta'] === true) continue;
      const message = parseStreamObject({ ...entry });
      if (message.kind === 'tool-result') {
        for (const result of message.results) {
          if (result.toolUseId) items.push({ kind: 'tool-result', uuid, ts, toolUseId: result.toolUseId, text: result.text, isError: result.isError });
        }
      } else if (message.kind === 'user-text' && !message.interrupt) {
        const text = promptText(message.text);
        if (text !== null) items.push({ kind: 'prompt', uuid, ts, text });
      }
    } else if (type === 'assistant') {
      const message = parseStreamObject({ ...entry });
      if (message.kind !== 'assistant' || message.model === SYNTHETIC_MODEL) continue;
      for (const block of message.blocks) {
        if (block.type === 'text' && block.text.trim() !== '') {
          items.push({ kind: 'text', uuid, ts, messageId: message.messageId, text: block.text });
        } else if (block.type === 'tool_use' && block.id) {
          items.push({ kind: 'tool-use', uuid, ts, messageId: message.messageId, toolUseId: block.id, name: block.name, input: block.input });
        }
      }
    }
  }
  return items;
}
