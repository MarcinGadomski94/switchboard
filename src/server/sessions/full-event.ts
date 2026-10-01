/**
 * Fix · long messages: `GET /api/sessions/{id}/events/{eventId}/full`
 * (`docs/chat.md` → *Cut messages*). A message event stored cut (before the fix
 * every message over 4,000 characters was; now only past the safety cap) gets its
 * whole text back from the session's CLI transcript and is written back into the
 * stored event, so it stays whole (published as a `/hub` `event`). A tool call's
 * cut input / result is read the same way but only answered, never stored (tool
 * output stays cut in the database: `docs/derivations.md` → *What is clipped*).
 *
 * Files read (read-only, never written): the session's transcript
 * (`<configDir>/projects/*\/<claudeSessionId>.jsonl`), then its subagents' files
 * (`<session>/subagents/agent-*.jsonl`, D48 P4: where the CLI keeps a subagent's
 * lines).
 */
import { readFile } from 'node:fs/promises';
import type { FullEventAnswer } from '../../core/api.ts';
import { MESSAGE_TEXT_LIMIT, type ToolPayload, clipInput, clipMessage, textCutAt } from '../../core/event-payload.ts';
import { type CutMessage, type FullTool, findFullText, findFullTool } from '../../core/full-text.ts';
import { parseTranscript } from '../../core/transcript-sync.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { Store } from '../db/store.ts';
import { subagentFiles } from '../hooks/service.ts';
import { toEvent } from './wire.ts';

/** What {@link restoreFullEvent} needs. */
export interface FullEventDeps {
  readonly store: Store;
  /** The transcript of a CLI session id (`SessionSupervisor.findTranscript`); `null` when there is none. */
  readonly findTranscript: (claudeSessionId: string) => Promise<string | null>;
  /** Publishes an event written back (`/hub` `event`). */
  readonly publish: (event: EventRecord) => void;
}

/** A refusal: HTTP status, `error` code and the words the chat shows. */
export interface FullEventRefusal {
  readonly status: number;
  readonly error: 'not-found' | 'not-restorable' | 'transcript-gone' | 'not-in-transcript';
  readonly message: string;
}

/** The chat's words when the transcript is gone. */
export const TRANSCRIPT_GONE = "The session's CLI transcript is gone: the full text cannot be restored.";
/** The chat's words when the transcript no longer has the message. */
export const NOT_IN_TRANSCRIPT = "The session's CLI transcript does not have this message any more: the full text cannot be restored.";

function refusal(status: number, error: FullEventRefusal['error'], message: string): FullEventRefusal {
  return { status, error, message };
}

/** `true` when a tool call's input or result was cut. */
function toolCut(payload: ToolPayload): boolean {
  return payload.inputTruncated === true || payload.resultTruncated === true;
}

/** The session's transcript files: the main one first, then its subagents' (none when it has no transcript). */
async function transcriptFiles(deps: FullEventDeps, claudeSessionId: string): Promise<string[]> {
  const main = await deps.findTranscript(claudeSessionId);
  return main === null ? [] : [main, ...(await subagentFiles(main))];
}

/** Reads each file in turn until `find` answers. */
async function searchFiles<T>(files: readonly string[], find: (entries: ReturnType<typeof parseTranscript>) => T | null): Promise<T | null> {
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const found = find(parseTranscript(text));
    if (found !== null) return found;
  }
  return null;
}

/**
 * The event with its whole text (see the module comment), or why not: 404
 * `not-found` (no such session, or no such event in it), 422 `not-restorable` (an
 * event with no text to restore), 410 `transcript-gone`, 410 `not-in-transcript`.
 * An event that is not cut is answered as it is.
 */
export async function restoreFullEvent(deps: FullEventDeps, sessionId: string, eventId: number): Promise<FullEventAnswer | FullEventRefusal> {
  const session = await deps.store.sessions.get(sessionId);
  if (!session) return refusal(404, 'not-found', `no session ${sessionId}`);
  const event = Number.isSafeInteger(eventId) && eventId > 0 ? await deps.store.events.get(eventId) : null;
  if (!event || event.sessionId !== session.id) return refusal(404, 'not-found', `no event ${eventId} in session ${sessionId}`);
  const payload = event.payload as { type?: unknown } | null;
  const type = payload && typeof payload === 'object' ? payload.type : undefined;

  if (type === 'assistant' || type === 'agent-prompt') {
    if (textCutAt(payload) === null) return { event: toEvent(event), saved: false };
    const files = await transcriptFiles(deps, session.claudeSessionId);
    if (files.length === 0) return refusal(410, 'transcript-gone', TRANSCRIPT_GONE);
    const stored = payload as { text: string };
    const cut: CutMessage = { type, text: stored.text, uuid: event.uuid, messageId: event.messageId, ts: event.ts };
    const whole = await searchFiles(files, (entries) => findFullText(entries, cut));
    if (whole === null) return refusal(410, 'not-in-transcript', NOT_IN_TRANSCRIPT);
    const clipped = clipMessage(whole);
    // ASSUMED long-messages-write-back: written back, so the message stays whole (and the next load needs no transcript).
    const updated = await deps.store.events.update(event.id, { payload: { ...payload, text: clipped.text, truncated: clipped.truncated } });
    if (!updated) return refusal(404, 'not-found', `no event ${eventId} in session ${sessionId}`);
    deps.publish(updated);
    return { event: toEvent(updated), saved: true };
  }

  if (type === 'tool') {
    const tool = payload as ToolPayload;
    if (!toolCut(tool)) return { event: toEvent(event), saved: false };
    const files = await transcriptFiles(deps, session.claudeSessionId);
    if (files.length === 0) return refusal(410, 'transcript-gone', TRANSCRIPT_GONE);
    const found: FullTool | null = await searchFiles(files, (entries) => findFullTool(entries, tool.toolUseId));
    if (found === null) return refusal(410, 'not-in-transcript', NOT_IN_TRANSCRIPT);
    const { inputTruncated: _input, resultTruncated: _result, ...rest } = tool;
    let next: ToolPayload = rest;
    if (found.input !== null) {
      const input = clipInput(found.input, MESSAGE_TEXT_LIMIT);
      next = { ...next, input: input.input, ...(input.truncated ? { inputTruncated: true } : {}) };
    } else if (tool.inputTruncated) {
      next = { ...next, inputTruncated: true };
    }
    if (found.result !== null) {
      const result = clipMessage(found.result.text);
      next = { ...next, result: result.text, ...(result.truncated ? { resultTruncated: true } : {}) };
    } else if (tool.resultTruncated) {
      next = { ...next, resultTruncated: true };
    }
    // ASSUMED long-messages-tool-output: a tool's whole output is answered, not stored (the database keeps tool output cut).
    return { event: toEvent({ ...event, payload: next }), saved: false };
  }

  return refusal(422, 'not-restorable', `event ${eventId} has no text to restore`);
}
