/**
 * D131 · lane S · the composer dock's states (the prototype's `dockHTML`): the
 * live line above the box (working with its timer and Stop, waiting for you,
 * stopped, paused, offline…), the **queued** messages (sent while the agent
 * works: Send now / Edit / Remove), the **paused** ones (held while every account
 * is out of usage, D103: Edit / Remove) and the box's placeholder. Pure; the
 * rules mirror the classic composer's (`views/session/ChatTab.tsx`, `stop.ts`).
 */
import type { ChatRow } from './chat-model.ts';
import { AGENT_WORDS } from '../glossary.ts';

/** What the live line says and offers. */
export type LiveKind = 'offline' | 'reconnecting' | 'working' | 'background' | 'needs' | 'stopped' | 'paused' | 'held' | 'done' | 'idle' | 'failed';

/** The live line. */
export interface LiveLine {
  readonly kind: LiveKind;
  readonly text: string;
  /** The ticking time (`0:42`, `1m 12s`), `null` when none. */
  readonly time: string | null;
  /** The button on its right. */
  readonly action: 'stop' | 'resume' | 'stop-background' | null;
}

/** What {@link liveLine} reads. */
export interface LiveInput {
  /** `null` = this computer, else the paired computer's name and state. */
  readonly machine: { readonly name: string; readonly state: 'online' | 'reconnecting' | 'offline' } | null;
  readonly status: string | null;
  /** The activity line's words and time (`chatActivityLine`), `null` when no turn runs. */
  readonly activity: { readonly state: string; readonly text: string; readonly time: string } | null;
  /** A turn can be stopped (`canStop`). */
  readonly stoppable: boolean;
  /** Background tasks can be stopped (`stoppableBackground` not empty). */
  readonly backgroundStoppable: boolean;
  /** The developer stopped the last turn from here (until the next message). */
  readonly stoppedByYou: string | null;
  /** Messages wait for an account with allowance. */
  readonly held: boolean;
  readonly live: boolean;
  readonly conversation: boolean;
}

/** The live line for the dock (see {@link LiveKind}). */
export function liveLine(input: LiveInput): LiveLine {
  if (input.machine && input.machine.state === 'offline') return { kind: 'offline', text: AGENT_WORDS.offlineLine(input.machine.name), time: null, action: null };
  // A question or permission is open: the turn waits for the developer (Stop still ends it).
  if (input.activity && input.activity.state === 'waiting') return { kind: 'needs', text: AGENT_WORDS.waitingForYou, time: input.activity.time, action: input.stoppable ? 'stop' : null };
  if (input.activity && input.activity.state !== 'background' && (input.stoppable || input.status === 'run')) {
    return { kind: 'working', text: input.activity.text, time: input.activity.time, action: input.stoppable ? 'stop' : null };
  }
  if (input.activity && input.activity.state === 'background') {
    return { kind: 'background', text: input.activity.text, time: input.activity.time, action: input.backgroundStoppable ? 'stop-background' : null };
  }
  if (input.status === 'run') return { kind: 'working', text: 'Working…', time: null, action: input.stoppable ? 'stop' : null };
  if (input.machine && input.machine.state === 'reconnecting') return { kind: 'reconnecting', text: AGENT_WORDS.reconnectingLine(input.machine.name), time: null, action: null };
  if (input.held) return { kind: 'held', text: AGENT_WORDS.allOut, time: null, action: null };
  if (input.status === 'need') return { kind: 'needs', text: AGENT_WORDS.waitingForYou, time: null, action: input.stoppable ? 'stop' : null };
  if (input.stoppedByYou) return { kind: 'stopped', text: AGENT_WORDS.stoppedByYou, time: input.stoppedByYou, action: null };
  if (input.status === 'paused') return { kind: 'paused', text: AGENT_WORDS.pausedLine, time: null, action: input.conversation ? null : 'resume' };
  if (input.status === 'fail') return { kind: 'failed', text: 'Stopped with an error · send a message to try again', time: null, action: null };
  if (input.status === 'done') return { kind: 'done', text: AGENT_WORDS.doneLine, time: null, action: null };
  return { kind: 'idle', text: AGENT_WORDS.idleLine, time: null, action: null };
}

/** A message in the dock: queued behind the running reply, or paused for usage. */
export type DockMessage = Extract<ChatRow, { kind: 'you' }>;

/** The chat's rows split: what the chat draws, and what the dock holds (queued and paused messages). */
export interface DockSplit {
  readonly chat: readonly ChatRow[];
  /** Waiting for the running reply (D44 `turn` / `resume`, and messages on their way, D114). */
  readonly queued: readonly DockMessage[];
  /** Held until an account has allowance (D103 `credits`). */
  readonly paused: readonly DockMessage[];
}

/**
 * Moves the developer's messages that the agent has not taken up into the dock
 * (the prototype's queued and paused lines): a held one (`credits`) is paused; a
 * queued one (`turn` / `resume`) or one still on its way while a turn runs is
 * queued. Everything else stays in the chat.
 */
export function splitDock(rows: readonly ChatRow[], working: boolean): DockSplit {
  const chat: ChatRow[] = [];
  const queued: DockMessage[] = [];
  const paused: DockMessage[] = [];
  for (const row of rows) {
    if (row.kind === 'you' && row.queued === 'credits') paused.push(row);
    else if (row.kind === 'you' && (row.queued === 'turn' || row.queued === 'resume' || (row.id < 0 && working))) queued.push(row);
    else chat.push(row);
  }
  return { chat, queued, paused };
}

/** The reset time a held message's note names ("… back at 23:30" → `23:30`), `null` when none. */
export function resetTimeOf(note: string | null | undefined): string | null {
  if (!note) return null;
  const match = /\b(?:back at|resets(?: at)?|at)\s+(\d{1,2}:\d{2})\b/i.exec(note);
  return match?.[1] ?? null;
}

/** The box's placeholder. */
export function composerPlaceholder(input: { readonly conversation: boolean; readonly working: boolean; readonly blocked: string | null; readonly short?: boolean }): string {
  if (input.blocked) return input.blocked;
  if (input.short) return input.conversation ? 'Ask a follow-up' : input.working ? 'Send a follow-up' : AGENT_WORDS.placeholder;
  if (input.conversation) return AGENT_WORDS.placeholderConversation;
  return input.working ? AGENT_WORDS.placeholderWorking : AGENT_WORDS.placeholder;
}

/** What ⌘↩ / Enter do in the box: ⌘↩ (Ctrl+Enter) and Enter send; Shift+Enter is a new line; nothing while an IME composes. */
export function composerKey(event: { readonly key: string; readonly shiftKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly isComposing: boolean }): 'send' | null {
  if (event.key !== 'Enter' || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey) return 'send';
  return event.shiftKey ? null : 'send';
}

/** The queued messages' text once taken back by a Stop (D50), joined as the classic composer does (oldest first, a blank line apart). */
export function joinWithdrawn(texts: readonly string[]): string {
  return texts.map((text) => text.trim()).filter((text) => text !== '').join('\n\n');
}
