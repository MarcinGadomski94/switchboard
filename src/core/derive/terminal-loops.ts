/**
 * D52 (`docs/derivations.md` → *Loop cards* → *Terminal sessions (D52)*): the
 * loop-relevant events of a terminal `claude` session that Switchboard does not
 * follow, read from its transcript, in the shape `deriveLoops` reads. Pure.
 *
 * The transcript has no stream-json `result` lines, so a turn's end is the main
 * chain's assistant message that ended it (`stop_reason: end_turn`): it becomes one
 * `result` event after that message's last line (`isError: false`, labelled with
 * its first text line). A turn the CLI runs on its own (a `/loop` / cron firing)
 * starts with an `isMeta` user line (`turnOrigin: "scheduled"`), which is skipped
 * like every meta line, so its turn reads as self-started: a firing (VERIFIED
 * D52-probe-fire).
 * Prompts (slash commands as `/name args`, so a typed `/loop 5m …` reads as the
 * `/loop` command) become `user` events; tool calls become `tool` events with
 * their results paired in (`isError` from the result); assistant text becomes
 * `assistant` events. Everything else in the file is skipped, as for the chat
 * (`transcriptItems`).
 * D93: where the CLI process changed (a line's `entrypoint` differs from the
 * previous line's: a terminal `cli` session continued as `sdk-cli`, or back) a
 * `lifecycle` event with the action {@link PROCESS_CHANGED} goes in, so the earlier
 * process's session-only schedules end there. A restart with the same entrypoint is
 * not visible here (the `version` field is not used: conservative, a false process
 * change would drop a live loop).
 * Unlisted schedules: a prompt the CLI wrote itself with no visible job
 * ({@link cliPromptText}) also becomes a `cli-prompt` event (`unlisted-loops.ts`).
 */
import { type TranscriptEntry, newestChain, transcriptItems } from '../transcript-sync.ts';
import { type LoopEventInput, PROCESS_CHANGED } from './loops.ts';
import { CLI_PROMPT } from './unlisted-loops.ts';

/**
 * The text of a prompt the CLI wrote itself with no visible job (`promptSource:
 * "system"`, no `scheduledTaskId`, not a task notification, main chain), else `null`.
 */
export function cliPromptText(entry: TranscriptEntry): string | null {
  if (entry['type'] !== 'user' || entry['promptSource'] !== 'system' || entry['isSidechain'] === true) return null;
  if (entry['turnOrigin'] === 'task_notification') return null;
  if (entry['scheduledTaskId'] !== undefined && entry['scheduledTaskId'] !== null) return null;
  const message = entry['message'];
  const content = message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>)['content'] : undefined;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((block) => block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result')) return null;
    text = content
      .map((block) => (block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'text' ? String((block as Record<string, unknown>)['text'] ?? '') : ''))
      .join('\n');
  }
  text = text.trim();
  if (text === '' || text.startsWith('<task-notification>')) return null;
  return text;
}

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
  /** D93: the entrypoint of the previous line that had one. */
  let seenEntrypoint: string | null = null;
  /**
   * The turn-ending message seen last, not written yet: the CLI writes one line per
   * content block (thinking, text, tool use), each with the message's `stop_reason`
   * (VERIFIED D52-probe-blocks), so the `result` goes out once, after the last line
   * of that message.
   */
  let ending: { id: string | null; ts: string; label: string } | null = null;
  const flush = (): void => {
    if (!ending) return;
    out.push({ ts: ending.ts, agentId: null, label: ending.label, payload: { type: 'result', isError: false } });
    ending = null;
  };
  for (const entry of newestChain(entries)) {
    const id = messageId(entry);
    if (ending && !(entry['type'] === 'assistant' && id !== null && id === ending.id)) flush();
    const entrypoint = typeof entry['entrypoint'] === 'string' && entry['entrypoint'] !== '' ? entry['entrypoint'] : null;
    if (entrypoint !== null) {
      if (seenEntrypoint !== null && entrypoint !== seenEntrypoint) {
        const ts = typeof entry['timestamp'] === 'string' && !Number.isNaN(Date.parse(entry['timestamp'])) ? new Date(entry['timestamp']).toISOString() : lastTs;
        out.push({ ts, agentId: null, label: PROCESS_CHANGED, payload: { type: 'lifecycle', action: PROCESS_CHANGED } });
      }
      seenEntrypoint = entrypoint;
    }
    // A prompt the CLI wrote itself with no visible job: a possible unlisted schedule (`unlisted-loops.ts`).
    const cliPrompt = cliPromptText(entry);
    if (cliPrompt !== null) {
      const ts = typeof entry['timestamp'] === 'string' && !Number.isNaN(Date.parse(entry['timestamp'])) ? new Date(entry['timestamp']).toISOString() : lastTs;
      out.push({ ts, agentId: null, label: firstLine(cliPrompt), payload: { type: CLI_PROMPT, text: cliPrompt } });
    }
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
      const previous: { id: string | null; label: string } | null = ending;
      const label: string = lastText ? firstLine(lastText) : previous && previous.id === id && id !== null ? previous.label : '';
      ending = { id, ts, label };
    }
  }
  flush();
  return out;
}

/** The assistant message id of a transcript line (`message.id`), `null` without one. */
function messageId(entry: TranscriptEntry): string | null {
  const message = entry['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const id = (message as Record<string, unknown>)['id'];
  return typeof id === 'string' && id !== '' ? id : null;
}
