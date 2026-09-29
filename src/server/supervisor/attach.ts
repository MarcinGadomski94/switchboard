/**
 * "Attach here" (M4.1; `docs/handoff/ARCHITECTURE.md` → *Terminal handoff*,
 * `docs/spike-m0.md` → M0.3 / M0.4, gap #5; `docs/supervisor.md` → *Attach here*):
 *
 * - **The warning.** Two live processes on one session id silently fork the
 *   conversation (M0.4 `handoff-conc`), so before spawning, Switchboard checks
 *   whether a terminal may still hold the session: the transcript changed less than
 *   2 minutes ago, or `claude agents --json` lists the id as live (an idle
 *   interactive terminal does not touch the file, M0.3). When the list cannot be
 *   read, liveness is unknown and that is a reason to ask too.
 * - **Sync back.** stdout never replays history, so the turns the terminal added are
 *   read from the transcript and stored as events (`src/core/transcript-sync.ts`
 *   decides which entries are new and what they show).
 *
 * Switchboard never writes the transcript or anything under the CLI's config folder.
 */
import { homedir } from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AttachWarningReason } from '../../core/api.ts';
import { textLabel, toolEventKind, toolLabel, userMessageKind } from '../../core/derive/event-kind.ts';
import { type ToolPayload, type UserPayload, clip, clipInput } from '../../core/event-payload.ts';
import { type ContextState, contextFromTranscript, readContextState } from '../../core/context-meter.ts';
import { entriesSince, newestChain, parseTranscript, transcriptItems } from '../../core/transcript-sync.ts';
import type { EventRecord } from '../db/repos/events.ts';
import type { SessionRecord } from '../db/repos/sessions.ts';
import type { Store } from '../db/store.ts';
import type { LiveProcessLister } from './recovery.ts';

/** A transcript written to less than this long ago may belong to an open terminal (gap #5). */
export const ATTACH_RECENT_MS = 2 * 60_000;

/** `$CLAUDE_CONFIG_DIR` when set, else `~/.claude` (M0.3: where the CLI keeps `projects/`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return (configured && configured.trim() !== '' ? configured : path.join(home, '.claude')).normalize('NFC');
}

/**
 * The session's transcript, `<configDir>/projects/*\/<claudeSessionId>.jsonl`
 * (M0.3: the most robust lookup; the project folder's slug is lossy). `null` when
 * there is none yet (the file appears with the first user message). If the id
 * exists in more than one project folder, the most recently written file wins.
 */
export async function findTranscriptFile(configDir: string, claudeSessionId: string): Promise<string | null> {
  const projects = path.join(configDir, 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const folder of folders) {
    const file = path.join(projects, folder, `${claudeSessionId}.jsonl`);
    try {
      const info = await stat(file);
      if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) best = { file, mtimeMs: info.mtimeMs };
    } catch {
      // Not in this project folder.
    }
  }
  return best?.file ?? null;
}

/** Input of {@link attachWarnings}. */
export interface AttachCheck {
  /** The session's transcript file, `null` when it has none. */
  readonly transcript: string | null;
  readonly claudeSessionId: string;
  /** `claude agents --json`; `null` = no way to list live processes (liveness unknown). */
  readonly listLive: LiveProcessLister | null;
  /** Epoch ms (tests pass a fixed clock). */
  readonly now: number;
}

/** Why attaching now might fork the conversation; empty = safe to attach without asking. */
export async function attachWarnings(check: AttachCheck): Promise<AttachWarningReason[]> {
  const reasons: AttachWarningReason[] = [];
  if (check.transcript) {
    try {
      const info = await stat(check.transcript);
      if (check.now - info.mtimeMs < ATTACH_RECENT_MS) reasons.push({ kind: 'transcript-recent', modifiedAt: new Date(info.mtimeMs).toISOString() });
    } catch {
      // Gone since it was found: nothing wrote to it recently.
    }
  }
  const rows = check.listLive ? await check.listLive() : null;
  if (rows === null) {
    reasons.push({ kind: 'liveness-unknown' });
  } else {
    const pids = new Set(rows.filter((row) => row.sessionId === check.claudeSessionId).map((row) => row.pid));
    for (const pid of pids) reasons.push({ kind: 'terminal-live', pid });
  }
  return reasons;
}

/** The server's one-line message for a warning (the UI words its own, `session-header.ts`). */
export function attachWarningMessage(reasons: readonly AttachWarningReason[]): string {
  const why = reasons.map((reason) => {
    switch (reason.kind) {
      case 'transcript-recent':
        return `the transcript changed at ${reason.modifiedAt}`;
      case 'terminal-live':
        return `claude process ${reason.pid} has the session open`;
      case 'liveness-unknown':
        return 'claude agents --json could not be read';
    }
  });
  return `A terminal may still have this session open (${why.join('; ')}). Attaching now forks the conversation; send { "confirm": true } to attach anyway.`;
}

/** Options of {@link importTerminalTurns}. */
export interface ImportOptions {
  readonly store: Store;
  readonly session: SessionRecord;
  /** The session's main agent: the terminal's turns are its main chain. */
  readonly mainAgentId: string;
  readonly transcript: string;
  /** Called after every event insert or update (the `/hub` `event`). */
  readonly onEvent: (event: EventRecord) => void;
  /** Origin of the imported prompts (default `terminal`; D25 imports a local copy's remote history as `remote`). */
  readonly origin?: Extract<UserPayload['origin'], 'terminal' | 'remote'>;
  /**
   * D25: import the whole newest chain, ignoring the stored sync point (entries
   * already stored, same uuid, are still skipped). For a teleported local copy,
   * whose remote history sits in front of the turns Switchboard already saw.
   */
  readonly fromStart?: boolean;
}

/** What {@link importTerminalTurns} did. */
export interface ImportResult {
  /** Events added (prompts, assistant messages, tool calls). */
  readonly imported: number;
  /** `false` when the stored sync point is not in the transcript (nothing imported). */
  readonly found: boolean;
  /** The sync point was on an older branch: the file forked after it (M0.4). */
  readonly forked: boolean;
  /** The new sync point (`sessions.last_transcript_uuid`). */
  readonly tip: string | null;
}

/**
 * Stores the terminal's turns: the transcript entries after the session's sync
 * point on the newest leaf's chain (`src/core/transcript-sync.ts`), as the same
 * event shapes the stream produces (`docs/derivations.md` → *Events*), with the
 * transcript's timestamps. Prompts are `user` events with origin `terminal`;
 * assistant text blocks of one message merge into one event; tool calls are paired
 * with their results. Entries already stored (same uuid) are skipped. Afterwards
 * the sync point moves to the chain's tip.
 */
export async function importTerminalTurns(options: ImportOptions): Promise<ImportResult> {
  const { store, session, mainAgentId, onEvent } = options;
  const origin = options.origin ?? 'terminal';
  const entries = parseTranscript(await readFile(options.transcript, 'utf8'));
  const slice = entriesSince(entries, options.fromStart === true ? null : session.lastTranscriptUuid);
  if (!slice.found) return { imported: 0, found: false, forked: false, tip: session.lastTranscriptUuid };
  const texts = new Map<string, { eventId: number; text: string }>();
  const tools = new Map<string, number>();
  const counts = { imported: 0, lastTs: null as string | null };

  const append = async (input: Parameters<Store['events']['append']>[0]): Promise<EventRecord> => {
    const event = await store.events.append(input);
    onEvent(event);
    counts.imported++;
    if (counts.lastTs === null || event.ts > counts.lastTs) counts.lastTs = event.ts;
    return event;
  };

  for (const item of transcriptItems(slice.entries)) {
    const ts = item.ts ?? undefined;
    if (item.kind !== 'tool-result' && (await store.events.hasUuid(session.id, item.uuid))) continue;
    switch (item.kind) {
      case 'prompt': {
        const payload: UserPayload = { type: 'user', text: item.text, origin, delivered: true };
        await append({
          sessionId: session.id,
          agentId: mainAgentId,
          ts,
          kind: userMessageKind(item.text),
          label: textLabel(item.text),
          payload,
          uuid: item.uuid,
        });
        break;
      }
      case 'text': {
        const key = item.messageId ?? item.uuid;
        const merged = texts.get(key);
        if (merged) {
          merged.text = `${merged.text}\n\n${item.text}`;
          const cut = clip(merged.text);
          const updated = await store.events.update(merged.eventId, {
            label: textLabel(merged.text),
            payload: { type: 'assistant', text: cut.text, messageId: item.messageId },
          });
          if (updated) onEvent(updated);
        } else {
          const cut = clip(item.text);
          const event = await append({
            sessionId: session.id,
            agentId: mainAgentId,
            ts,
            kind: 'text',
            label: textLabel(item.text),
            payload: { type: 'assistant', text: cut.text, messageId: item.messageId },
            uuid: item.uuid,
            messageId: item.messageId,
          });
          texts.set(key, { eventId: event.id, text: item.text });
        }
        break;
      }
      case 'tool-use': {
        const { input, truncated } = clipInput(item.input);
        const payload: ToolPayload = { type: 'tool', name: item.name, toolUseId: item.toolUseId, input, ...(truncated ? { inputTruncated: true } : {}) };
        const event = await append({
          sessionId: session.id,
          agentId: mainAgentId,
          ts,
          kind: toolEventKind(item.name),
          label: toolLabel(item.name, item.input),
          payload,
          uuid: item.uuid,
          messageId: item.messageId,
          toolUseId: item.toolUseId,
        });
        tools.set(item.toolUseId, event.id);
        break;
      }
      case 'tool-result': {
        const eventId = tools.get(item.toolUseId) ?? (await store.events.findByToolUseId(session.id, item.toolUseId))?.id;
        if (eventId === undefined) break;
        const event = await store.events.get(eventId);
        const payload = event?.payload as ToolPayload | null | undefined;
        if (!event || payload?.type !== 'tool' || payload.result !== undefined) break;
        const cut = clip(item.text);
        const updated = await store.events.update(eventId, {
          payload: { ...payload, result: cut.text, ...(cut.truncated ? { resultTruncated: true } : {}), isError: item.isError },
          endTs: item.ts ?? new Date().toISOString(),
        });
        if (updated) onEvent(updated);
        break;
      }
    }
  }

  const patch: { lastTranscriptUuid?: string; lastActivityAt?: string; context?: ContextState } = {};
  // D49: the context meter from the whole main chain (what the terminal did included): its last usage and compaction.
  const stored = readContextState(session.context);
  const context = contextFromTranscript(stored, newestChain(entries));
  if (context !== stored && JSON.stringify(context) !== JSON.stringify(stored)) patch.context = context;
  if (slice.tip) patch.lastTranscriptUuid = slice.tip;
  const lastTs = counts.lastTs;
  if (lastTs !== null && (!session.lastActivityAt || lastTs > session.lastActivityAt)) patch.lastActivityAt = lastTs;
  if (Object.keys(patch).length > 0) await store.sessions.update(session.id, patch);
  return { imported: counts.imported, found: true, forked: slice.forked, tip: slice.tip };
}
