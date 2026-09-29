/**
 * D53 "Live activity for remote and hooked sessions" (`docs/derivations.md` →
 * *Live activity* → *Hooked terminal sessions (D53)*): what a hooked terminal
 * session's turn is doing now, and what a message sent to it waits on. A hooked
 * session has no stream-json: Switchboard sees only its transcript (as it grows)
 * and its hook calls (UserPromptSubmit, PostToolUse, Stop, SessionEnd, a held
 * PermissionRequest, the waiter). This module is the pure part: transcript entries
 * + hook signals → the same {@link SessionActivity} a supervised session has, so
 * the chat line, the sidebar row and the agent cards read the same. No I/O; the
 * clock is a parameter.
 *
 * Transcript facts (VERIFIED D53-transcript on CLI 2.1.284 transcripts, read only):
 * the CLI writes one line per content block as the block completes, each with its
 * own `timestamp` and the message's `stop_reason`; an assistant `tool_use` line
 * is written when the tool starts and the `user` `tool_result` line when it ends;
 * a long thinking block writes nothing until it is done; a turn ends with a
 * `system` `stop_hook_summary` / `turn_duration` line (or an interrupt marker).
 */
import type { AgentActivity, SessionActivity } from '../api.ts';
import { switchboardMessageText } from '../hooks.ts';
import { INTERRUPT_MARKERS, parseStreamObject } from '../stream-json.ts';
import { SYNTHETIC_MODEL, type TranscriptEntry } from '../transcript-sync.ts';
import { toolSummary } from './activity.ts';

export { HOOK_DELIVERY_TEXT, type HookDeliveryInput, type HookDeliveryState, STALE_AFTER_MS, hookDelivery, staleFor } from './hooked-status.ts';


/** `system` subtypes that end a turn in a transcript. */
const TURN_END_SUBTYPES: ReadonlySet<string> = new Set(['stop_hook_summary', 'turn_duration']);

/** What one transcript (the main chain, or a subagent's file) shows about its current turn. */
export interface TranscriptTurn {
  /** A turn is open at the file's end (started, not ended). */
  readonly running: boolean;
  /** When the open turn started (its prompt line; the first line of a turn the tail starts in); `null` when none is open. */
  readonly turnStartedAt: string | null;
  /** When the last turn ended (its end line), `null` when the file shows none. */
  readonly endedAt: string | null;
  /** What the open turn does now (`thinking` / `tool` / `writing`); `thinking` when idle. */
  readonly state: 'thinking' | 'tool' | 'writing';
  /** When that state began (the line's timestamp; for `tool`, the `tool_use` line's). */
  readonly since: string | null;
  /** `tool`: the newest open tool's name and summary; else `null`. */
  readonly tool: string | null;
  readonly summary: string | null;
  /** The newest line's timestamp (any line), `null` for an empty file. */
  readonly lastAt: string | null;
}

/** The turn of an empty file. */
export const NO_TURN: TranscriptTurn = { running: false, turnStartedAt: null, endedAt: null, state: 'thinking', since: null, tool: null, summary: null, lastAt: null };

function tsOf(entry: TranscriptEntry): string | null {
  const ts = entry['timestamp'];
  if (typeof ts !== 'string') return null;
  const at = Date.parse(ts);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function stopReason(entry: TranscriptEntry): string | null {
  const message = entry['message'];
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const reason = (message as Record<string, unknown>)['stop_reason'];
  return typeof reason === 'string' ? reason : null;
}

/**
 * The current turn of a transcript, from its entries in file order (a tail is
 * enough: a turn the tail starts in opens at its first line). `sidechain`: the
 * entries are a subagent's own file (its lines carry `isSidechain: true`);
 * otherwise sidechain lines are skipped.
 *
 * - A prompt (a typed `user` line (not a slash command's own lines), a Switchboard wake-up's line or its
 *   `queued_command` fold, a scheduled firing's `isMeta` line with
 *   `turnOrigin: "scheduled"`) opens a turn (a fold into an open turn: back to
 *   thinking).
 * - Thinking block → `thinking`; text → `writing`; `tool_use` → that tool, open
 *   until its `tool_result` (then `thinking` once none is open). An assistant line
 *   outside a turn opens one (the tail began mid-turn, or the CLI started it),
 *   except one whose message ended the turn (`stop_reason: end_turn`).
 * - `end_turn`, a `stop_hook_summary` / `turn_duration` line or an interrupt
 *   marker ends the turn.
 */
export function transcriptTurn(entries: readonly TranscriptEntry[], options: { readonly sidechain?: boolean } = {}): TranscriptTurn {
  let running = false;
  let turnStartedAt: string | null = null;
  let endedAt: string | null = null;
  let since: string | null = null;
  let lastAt: string | null = null;
  let phaseState: 'thinking' | 'writing' = 'thinking';
  const tools = new Map<string, { name: string; summary: string; since: string | null }>();
  const open = (at: string | null): void => {
    if (!running) {
      running = true;
      turnStartedAt = at;
      tools.clear();
    }
  };
  const end = (at: string | null): void => {
    running = false;
    turnStartedAt = null;
    endedAt = at ?? endedAt;
    tools.clear();
    phaseState = 'thinking';
    since = at;
  };
  const phase = (next: 'thinking' | 'writing', at: string | null): void => {
    phaseState = next;
    since = at;
  };
  for (const entry of entries) {
    const own: string | null = tsOf(entry);
    const at: string | null = own ?? lastAt;
    if (own !== null) lastAt = own;
    const type = entry['type'];
    if ((entry['isSidechain'] === true) !== (options.sidechain === true)) continue;
    if (type === 'system') {
      if (TURN_END_SUBTYPES.has(String(entry['subtype']))) end(at);
      continue;
    }
    if (type === 'attachment') {
      const attachment = entry['attachment'];
      if (attachment && typeof attachment === 'object' && !Array.isArray(attachment)) {
        const record = attachment as Record<string, unknown>;
        if (record['type'] === 'queued_command' && typeof record['prompt'] === 'string') {
          open(at);
          phase('thinking', at);
        }
      }
      continue;
    }
    if (type === 'user') {
      const message = parseStreamObject({ ...entry });
      if (message.kind === 'tool-result') {
        for (const result of message.results) tools.delete(result.toolUseId);
        if (running && tools.size === 0) phase('thinking', at);
        continue;
      }
      if (message.kind !== 'user-text') continue;
      if (message.interrupt || INTERRUPT_MARKERS.some((marker) => message.text.trim().startsWith(marker))) {
        end(at);
        continue;
      }
      const woken = switchboardMessageText(message.text) !== null;
      const scheduled = entry['isMeta'] === true && entry['turnOrigin'] === 'scheduled';
      if (entry['isMeta'] === true && !woken && !scheduled) continue;
      // A slash command's own lines (`<command-name>…`, its `<local-command-stdout>`): a local command runs no
      // turn; a prompt command's turn opens at its first assistant line (ASSUMED D53-commands).
      if (/^<(?:local-)?command-/.test(message.text.trim())) continue;
      open(at);
      phase('thinking', at);
      continue;
    }
    if (type === 'assistant') {
      const message = parseStreamObject({ ...entry });
      if (message.kind !== 'assistant' || message.model === SYNTHETIC_MODEL) continue;
      const reason = stopReason(entry);
      if (!running && reason === 'end_turn') continue;
      open(at);
      for (const block of message.blocks) {
        if (block.type === 'thinking') phase('thinking', at);
        else if (block.type === 'text' && block.text.trim() !== '') phase('writing', at);
        else if (block.type === 'tool_use' && block.id) {
          tools.delete(block.id);
          tools.set(block.id, { name: block.name, summary: toolSummary(block.name, block.input), since: at });
        }
      }
      if (reason === 'end_turn') end(at);
    }
  }
  const tool = [...tools.values()].at(-1);
  if (!running) return { running, turnStartedAt: null, endedAt, state: 'thinking', since: null, tool: null, summary: null, lastAt };
  if (tool) return { running, turnStartedAt, endedAt, state: 'tool', since: tool.since, tool: tool.name, summary: tool.summary, lastAt };
  return { running, turnStartedAt, endedAt, state: phaseState, since, tool: null, summary: null, lastAt };
}

/** What the hooks told about a hooked session (`src/server/hooks/service.ts`). */
export interface HookSignals {
  /** The newest turn start (UserPromptSubmit) Switchboard saw, ISO; `null` for none. */
  readonly startedAt: string | null;
  /** The newest turn end (Stop) Switchboard saw, ISO; `null` for none. */
  readonly stoppedAt: string | null;
  /** SessionEnd, or the process is gone. */
  readonly ended: boolean;
  /** A PermissionRequest held open for the developer (the oldest), else `null`. */
  readonly permission: { readonly tool: string; readonly summary: string; readonly since: string } | null;
  /** The newest hook call of any kind, ISO; `null` for none. */
  readonly lastHookAt: string | null;
}

/** Input of {@link hookedActivity}. */
export interface HookedActivityInput {
  readonly mainAgentId: string;
  /** The main transcript's turn ({@link transcriptTurn}); {@link NO_TURN} without a transcript. */
  readonly transcript: TranscriptTurn;
  /** When the transcript (or a subagent's file) last changed (its mtime), ISO; `null` when unknown. */
  readonly transcriptChangedAt: string | null;
  readonly hooks: HookSignals;
  /** The running subagents' turns, by agent id (`Agent.id`); a subagent without an open turn is left out. */
  readonly subagents?: Readonly<Record<string, TranscriptTurn>>;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * A hooked session's live activity (D53), or `null` while no turn runs.
 *
 * - **Running**: a turn start (UserPromptSubmit, the transcript's open turn)
 *   after the newest turn end (Stop, the transcript's end line) runs; the earliest
 *   such start is the turn's start. A held PermissionRequest runs too.
 *   SessionEnd → `null`.
 * - **State**: a held PermissionRequest → `waiting` with its tool ("Waiting for
 *   permission: Bash"); else the transcript's open turn (`● Tool`, `Writing…`, a
 *   thinking verb); a turn only the hook saw start yet → thinking since then.
 * - **quietSince**: the newest transcript change or hook call, so the views can
 *   add "· no activity for 3m" (`STALE_AFTER_MS`, `./hooked-status.ts`).
 * - **Subagents**: each open subagent's own turn in `agents`.
 */
export function hookedActivity(input: HookedActivityInput): SessionActivity | null {
  const { transcript: tx, hooks } = input;
  if (hooks.ended) return null;
  const txStart = tx.running ? (tx.turnStartedAt ?? tx.lastAt) : null;
  const lastEnd = later(hooks.stoppedAt, tx.endedAt);
  const after = (at: string | null): string | null => (at !== null && (lastEnd === null || at > lastEnd) ? at : null);
  const txRunning = after(txStart) !== null;
  const hookStart = after(hooks.startedAt);
  const running = txRunning || hookStart !== null || hooks.permission !== null;
  if (!running) return null;
  const starts = [txRunning ? txStart : null, hookStart, hooks.permission?.since ?? null].filter((s): s is string => s !== null).sort();
  const turnStartedAt = starts[0] ?? new Date(0).toISOString();
  let main: AgentActivity;
  if (txRunning) {
    const since = tx.since ?? turnStartedAt;
    main = { state: tx.state, since, startedAt: turnStartedAt, tool: tx.tool, summary: tx.summary };
  } else {
    main = { state: 'thinking', since: turnStartedAt, startedAt: turnStartedAt, tool: null, summary: null };
  }
  const agents: Record<string, AgentActivity> = { [input.mainAgentId]: main };
  for (const [id, turn] of Object.entries(input.subagents ?? {})) {
    if (!turn.running) continue;
    const startedAt = turn.turnStartedAt ?? turn.lastAt ?? turnStartedAt;
    agents[id] = { state: turn.state, since: turn.since ?? startedAt, startedAt, tool: turn.tool, summary: turn.summary };
  }
  const permission = hooks.permission;
  const top = permission
    ? { state: 'waiting' as const, since: permission.since, tool: permission.tool, summary: permission.summary }
    : { state: main.state, since: main.since, tool: main.tool, summary: main.summary };
  if (permission) agents[input.mainAgentId] = { ...main, state: 'waiting', since: permission.since, tool: permission.tool, summary: permission.summary };
  const quietSince = later(later(input.transcriptChangedAt, tx.lastAt), hooks.lastHookAt) ?? turnStartedAt;
  return { turnStartedAt, ...top, thinkingTokens: null, agents, background: [], quietSince };
}
