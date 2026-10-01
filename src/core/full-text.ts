/**
 * Fix · long messages: finding the whole text of a cut event in the CLI's
 * transcript (`GET /api/sessions/{id}/events/{eventId}/full`, `docs/chat.md` →
 * *Cut messages*). The pure part; reading the files and writing the event back is
 * `src/server/sessions/full-event.ts`.
 *
 * Keys, most reliable first (every match is checked: the stored text must be the
 * start of the whole text, else it is no match):
 * - assistant text: the event's `messageId` (the CLI writes each text block of
 *   one message as its own line with the same `message.id`; Switchboard merged
 *   them with a blank line between, so they are merged the same way here), then
 *   the line's `uuid`;
 * - a subagent's prompt: the line's `uuid`;
 * - else the clipped prefix: a message of the same kind whose text starts with
 *   the stored text, the one written closest to the event's time.
 * Sidechain lines count (an older CLI wrote subagents' lines into the main file).
 */
import { type TranscriptEntry, transcriptItems } from './transcript-sync.ts';
import type { JsonRecord } from './stream-json.ts';

/** What is known of a cut message event. */
export interface CutMessage {
  readonly type: 'assistant' | 'agent-prompt';
  /** The stored (cut) text. */
  readonly text: string;
  readonly uuid: string | null;
  readonly messageId: string | null;
  /** The event's time (ISO); picks among several prefix matches. */
  readonly ts: string | null;
}

interface Candidate {
  readonly text: string;
  readonly uuids: ReadonlySet<string>;
  readonly messageId: string | null;
  readonly ts: string | null;
}

/** Every entry as a main-chain one (sidechain lines are read too). */
function asChain(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => (entry['isSidechain'] === true ? { ...entry, isSidechain: false } : entry));
}

/** The assistant messages of `entries`: text blocks merged per `message.id` (else per line), in file order. */
function assistantMessages(entries: readonly TranscriptEntry[]): Candidate[] {
  const groups = new Map<string, { texts: string[]; seen: Set<string>; uuids: Set<string>; messageId: string | null; ts: string | null }>();
  for (const item of transcriptItems(asChain(entries))) {
    if (item.kind !== 'text') continue;
    const key = item.messageId ?? item.uuid;
    let group = groups.get(key);
    if (!group) {
      group = { texts: [], seen: new Set(), uuids: new Set(), messageId: item.messageId, ts: item.ts };
      groups.set(key, group);
    }
    // The same line twice (a copied branch) adds nothing.
    const mark = `${item.uuid}\u0000${item.text}`;
    if (group.seen.has(mark)) continue;
    group.seen.add(mark);
    group.uuids.add(item.uuid);
    group.texts.push(item.text);
  }
  return [...groups.values()].map((group) => ({ text: group.texts.join('\n\n'), uuids: group.uuids, messageId: group.messageId, ts: group.ts }));
}

/** The prompts of `entries` (a subagent's file: its brief and later prompts), in file order. */
function prompts(entries: readonly TranscriptEntry[]): Candidate[] {
  const out: Candidate[] = [];
  for (const item of transcriptItems(asChain(entries))) {
    if (item.kind === 'prompt') out.push({ text: item.text, uuids: new Set([item.uuid]), messageId: null, ts: item.ts });
  }
  return out;
}

/** `true` when `whole` can be the text `cut` was cut from (a prompt's text is read trimmed). */
function startsWithCut(whole: string, cut: string): boolean {
  if (cut === '') return false;
  return whole.startsWith(cut) || whole.startsWith(cut.trimStart());
}

function distance(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number.MAX_SAFE_INTEGER;
  const diff = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isNaN(diff) ? Number.MAX_SAFE_INTEGER : diff;
}

/**
 * The whole text of a cut message in one transcript's entries; `null` when the
 * transcript does not have it (see the module comment for the keys).
 */
export function findFullText(entries: readonly TranscriptEntry[], cut: CutMessage): string | null {
  const candidates = cut.type === 'assistant' ? assistantMessages(entries) : prompts(entries);
  const fits = candidates.filter((candidate) => startsWithCut(candidate.text, cut.text));
  if (fits.length === 0) return null;
  if (cut.messageId !== null) {
    const byId = fits.find((candidate) => candidate.messageId === cut.messageId);
    if (byId) return byId.text;
  }
  if (cut.uuid !== null) {
    const byUuid = fits.find((candidate) => candidate.uuids.has(cut.uuid as string));
    if (byUuid) return byUuid.text;
  }
  // The clipped prefix: the closest in time (the same turn when the transcript has it).
  const sorted = [...fits].sort((a, b) => distance(a.ts, cut.ts) - distance(b.ts, cut.ts));
  return sorted[0]?.text ?? null;
}

/** A tool call's whole input and result as the transcript has them (either may be missing). */
export interface FullTool {
  readonly input: JsonRecord | null;
  readonly result: { readonly text: string; readonly isError: boolean } | null;
}

/** The whole input and result of the tool call `toolUseId` in one transcript's entries; `null` when it has neither. */
export function findFullTool(entries: readonly TranscriptEntry[], toolUseId: string): FullTool | null {
  let input: JsonRecord | null = null;
  let result: FullTool['result'] = null;
  for (const item of transcriptItems(asChain(entries))) {
    if (item.kind === 'tool-use' && item.toolUseId === toolUseId && input === null) input = item.input;
    if (item.kind === 'tool-result' && item.toolUseId === toolUseId && result === null) result = { text: item.text, isError: item.isError };
  }
  return input === null && result === null ? null : { input, result };
}
