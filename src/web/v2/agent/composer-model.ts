/**
 * D131 · lane S · the composer dock's states (the prototype's `dockHTML`): the
 * live line above the box (working with its timer and Stop, waiting for you,
 * stopped, paused, offline…), the **queued** messages (sent while the agent
 * works: Send now / Edit / Remove), the **paused** ones (held while every account
 * is out of usage, D103: Edit / Remove) and the box's placeholder. Pure; the
 * rules mirror the classic composer's (`views/session/ChatTab.tsx`, `stop.ts`).
 */
import type { QueuedReason } from '../../../core/event-payload.ts';
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
 * The developer's messages that the agent has not taken up, for the dock's queued
 * and paused lines (Send now, Edit, Remove): a held one (`credits`) is paused; a
 * queued one (`turn` / `resume`) or one still on its way while a turn runs is
 * queued. Fix after 2.0 (developer request 2026-10-26: "the bubble with the message
 * that user sends should appear immediately"): every message also stays in the
 * chat as its bubble, from the moment it is sent (D114), with its Queued / Paused
 * note; the dock only lists them for the actions.
 */
export function splitDock(rows: readonly ChatRow[], working: boolean): DockSplit {
  const chat: ChatRow[] = [];
  const queued: DockMessage[] = [];
  const paused: DockMessage[] = [];
  for (const row of rows) {
    chat.push(row);
    if (row.kind === 'you' && row.queued === 'credits') paused.push(row);
    else if (row.kind === 'you' && (row.queued === 'turn' || row.queued === 'resume' || (row.id < 0 && working))) queued.push(row);
  }
  return { chat, queued, paused };
}

/** The note under a bubble the agent has not taken up yet (`null`: none): Queued (a reply runs, or no process yet) or Paused (held for usage). */
export function youWaitNote(row: { readonly id: number; readonly queued: QueuedReason | null; readonly heldNote?: string | null }, working: boolean): string | null {
  if (row.queued === 'credits') return AGENT_WORDS.paused(resetTimeOf(row.heldNote));
  if (row.queued === 'turn' || (row.id < 0 && working)) return `${AGENT_WORDS.queued} · ${AGENT_WORDS.queuedNote}`;
  if (row.queued === 'resume') return `${AGENT_WORDS.queued} · ${AGENT_WORDS.queuedResume}`;
  return null;
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

// ── Fix after 2.0 · one compact status row above the box ─────────────

/** What {@link dockStatus} reads. */
export interface DockStatusInput {
  readonly live: LiveLine;
  /** This agent's tasks (`null` / total 0 = none). */
  readonly tasks: { readonly total: number; readonly done: number; readonly current: string | null } | null;
  /** Working memory: its percentage (`null` = unknown), the clean-slate offer, a continuation's step. */
  readonly memory: { readonly pct: number | null; readonly offer: boolean; readonly running: string | null } | null;
  readonly queued: number;
  readonly paused: number;
}

/** One part of the status row. */
export interface DockStatusPart {
  readonly id: 'live' | 'tasks' | 'memory' | 'queue';
  readonly text: string;
  /** The longer words for its tooltip (and the part's details). */
  readonly title: string;
  readonly tone: 'grey' | 'blue' | 'amber' | 'red';
}

/** The status row: its parts in order (live, tasks, memory, queue) and the whole line in words (the row's label). */
export interface DockStatus {
  readonly parts: readonly DockStatusPart[];
  readonly text: string;
  /** The clean-slate offer shows in the row (D83: past the Settings threshold, between replies). */
  readonly offer: boolean;
}

/** Working memory shows in the row from this percentage (the strip's old threshold). */
export const MEMORY_SHOWN_FROM = 50;

function liveTone(kind: LiveKind): DockStatusPart['tone'] {
  if (kind === 'working' || kind === 'background') return 'blue';
  if (kind === 'needs' || kind === 'held' || kind === 'reconnecting') return 'amber';
  if (kind === 'stopped' || kind === 'failed') return 'red';
  return 'grey';
}

/**
 * Merges the live line, the tasks strip, the working-memory strip and the
 * queued / paused count into ONE compact row ("● Running tests 0:42 · Tasks 1/3 ·
 * Memory 64% · 2 queued"), details on click or hover. Pure.
 */
export function dockStatus(input: DockStatusInput): DockStatus {
  const parts: DockStatusPart[] = [{ id: 'live', text: input.live.time ? `${input.live.text} ${input.live.time}` : input.live.text, title: input.live.text, tone: liveTone(input.live.kind) }];
  const tasks = input.tasks;
  if (tasks && tasks.total > 0) {
    parts.push({ id: 'tasks', text: `Tasks ${tasks.done}/${tasks.total}`, title: `${AGENT_WORDS.tasksStrip(tasks.total - tasks.done, tasks.done)}${tasks.current ? ` · ${tasks.current}` : ''}`, tone: 'grey' });
  }
  const memory = input.memory;
  if (memory?.running) parts.push({ id: 'memory', text: memory.running, title: memory.running, tone: 'blue' });
  else if (memory && memory.pct !== null && (memory.offer || memory.pct >= MEMORY_SHOWN_FROM)) {
    parts.push({ id: 'memory', text: `Memory ${memory.pct}%`, title: memory.offer ? AGENT_WORDS.memoryFullBanner(memory.pct) : `${AGENT_WORDS.workingMemory} · ${AGENT_WORDS.memoryUsed(memory.pct)}`, tone: memory.offer || memory.pct >= 80 ? 'amber' : 'grey' });
  }
  const waiting = input.queued + input.paused;
  if (waiting > 0) {
    const words = [input.queued ? `${input.queued} queued` : '', input.paused ? `${input.paused} paused` : ''].filter(Boolean).join(' · ');
    parts.push({ id: 'queue', text: words, title: words, tone: input.paused ? 'amber' : 'grey' });
  }
  return { parts, text: parts.map((part) => part.text).join(' · '), offer: memory?.offer === true && !memory.running };
}

/**
 * The box's height cap: about a fifth of the visible height (`share`; a phone,
 * with its top bar and tabs, passes less) so the whole dock stays under a third,
 * never under 4 lines (`lineHeight` px) plus its padding.
 */
export function composerMaxHeight(viewportHeight: number, lineHeight: number, share = 0.22, padding = 18): number {
  const lines = Math.ceil(lineHeight * 4 + padding);
  return Math.max(lines, Math.round(viewportHeight * share));
}

/** What the composer's autosize measured last (`Dock`): the text's length and line breaks, and the cap it used. */
export interface ComposerMeasure {
  readonly length: number;
  readonly breaks: number;
  readonly viewHeight: number;
  readonly share: number;
  /** The cap ({@link composerMaxHeight}) for that visible height and share. */
  readonly max: number;
}

/** The number of line breaks in `text`. */
export function lineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1;
  return count;
}

/**
 * Typing lag fix (2026-10-29): `true` when the composer must be collapsed to measure
 * its natural height, i.e. when it may have shrunk: the first measure, the text got
 * shorter or lost a line break, it was emptied, or the cap changed. Growing needs no
 * collapse (at its current height the field's `scrollHeight` is the text's height),
 * so a keystroke that only adds text costs one layout read and no write.
 */
export function composerMayShrink(last: ComposerMeasure | null, next: ComposerMeasure): boolean {
  if (last === null) return true;
  if (next.length === 0) return true;
  if (next.length < last.length || next.breaks < last.breaks) return true;
  return next.max !== last.max;
}

/** Your long message folds after this many lines (Show more). */
export const YOU_FOLD_LINES = 12;

/** `true` when your message is long enough to fold: more than {@link YOU_FOLD_LINES} lines (a long line counts as `width` characters per line). */
export function foldsYou(text: string, charsPerLine = 90): boolean {
  let lines = 0;
  for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  return lines > YOU_FOLD_LINES;
}
