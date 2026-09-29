/**
 * D52 (`docs/derivations.md` → *Loop cards* → *Terminal sessions (D52)*): the
 * loop-relevant events of a terminal `claude` session that Switchboard does not
 * follow, read from its transcript, in the shape `deriveLoops` reads. Pure.
 *
 * The transcript has no stream-json `result` lines, so a turn's end is the main
 * chain's assistant message that ended it (`stop_reason: end_turn`): it becomes a
 * `result` event (`isError: false`, labelled with that message's first text line).
 * Prompts (slash commands as `/name args`, so a typed `/loop 5m …` reads as the
 * `/loop` command) become `user` events; tool calls become `tool` events with
 * their results paired in (`isError` from the result); assistant text becomes
 * `assistant` events. Everything else in the file is skipped, as for the chat
 * (`transcriptItems`).
 */
import { type TranscriptEntry, newestChain, transcriptItems } from '../transcript-sync.ts';
import type { LoopEventInput } from './loops.ts';

function firstLine(text: string, limit = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function stopReason(entry: TranscriptEntry): string | null {
  const message = entry['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const reason = (message as Record<string, unknown>)['stop_reason'];
  return typeof reason === 'string' ? reason : null;
}

/** A mutable event while the list is built (tool results are paired in later). */
interface Draft {
  ts: string;
  agentId: null;
  label: string;
  payload: Record<string, unknown>;
}

/**
 * The events `deriveLoops` needs from a terminal session's transcript entries
 * (already parsed, any order the file had): the newest chain only, oldest first.
 * Entries without a timestamp take the previous one's (or the epoch).
 */
export function transcriptLoopEvents(entries: readonly TranscriptEntry[]): LoopEventInput[] {
  const out: Draft[] = [];
  const tools = new Map<string, Draft>();
  let lastTs = new Date(0).toISOString();
  for (const entry of newestChain(entries)) {
    const items = transcriptItems([entry]);
    let lastText: string | null = null;
    for (const item of items) {
      const ts = item.ts ?? lastTs;
      lastTs = ts;
      switch (item.kind) {
        case 'prompt':
          out.push({ ts, agentId: null, label: firstLine(item.text), payload: { type: 'user', text: item.text } });
          break;
        case 'text':
          lastText = item.text;
          out.push({ ts, agentId: null, label: firstLine(item.text), payload: { type: 'assistant', text: item.text } });
          break;
        case 'tool-use': {
          const draft: Draft = { ts, agentId: null, label: item.name, payload: { type: 'tool', name: item.name, toolUseId: item.toolUseId, input: item.input } };
          tools.set(item.toolUseId, draft);
          out.push(draft);
          break;
        }
        case 'tool-result': {
          const draft = tools.get(item.toolUseId);
          if (draft && draft.payload['result'] === undefined) draft.payload = { ...draft.payload, result: item.text, isError: item.isError };
          break;
        }
      }
    }
    if (entry['type'] === 'assistant' && stopReason(entry) === 'end_turn') {
      const ts = typeof entry['timestamp'] === 'string' && !Number.isNaN(Date.parse(entry['timestamp'])) ? new Date(entry['timestamp']).toISOString() : lastTs;
      lastTs = ts;
      out.push({ ts, agentId: null, label: lastText ? firstLine(lastText) : '', payload: { type: 'result', isError: false } });
    }
  }
  return out;
}
