/**
 * D131 · lane S · a reply's ⋯ menu (the prototype's `msgMenu`): Copy, Copy code,
 * Save as result, Add to tasks (the selected text, else the reply's first
 * sentence), Undo from here (the D80 revert to before the reply's turn). Pure: which
 * items there are, what each does and why one is disabled; the view runs them.
 */
import { NO_CHECKPOINT, STOP_FIRST, type TurnRevert, turnRevertFor } from '../../views/session/checkpoints.ts';
import type { SessionCheckpoints } from '../../../core/checkpoints.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { codeBlocks, replyCopyText } from './chat-model.ts';

/** What a reply menu item does. */
export type ReplyAction =
  | { readonly type: 'copy'; readonly text: string }
  | { readonly type: 'copy-code'; readonly text: string }
  | { readonly type: 'save'; readonly text: string }
  | { readonly type: 'task'; readonly title: string }
  | { readonly type: 'undo'; readonly turn: number };

/** One item of the menu. */
export interface ReplyMenuItem {
  readonly id: 'copy' | 'copy-code' | 'save' | 'task' | 'undo';
  readonly label: string;
  readonly icon: string;
  /** Why it is disabled; absent = enabled. */
  readonly disabledReason?: string;
  /** What it does (absent while disabled). */
  readonly action?: ReplyAction;
  /** A separator before it. */
  readonly separated?: boolean;
}

/** The longest task title taken from a reply (the todo title cap is longer; a title is a line). */
export const TASK_TITLE_MAX = 80;

/** A task title from a selection or the reply: the selection, else the reply's first sentence; trimmed to {@link TASK_TITLE_MAX}. */
export function taskTitle(selection: string | null, text: string): string {
  const source = selection && selection.trim() !== '' ? selection : firstSentence(text);
  const line = source.replace(/\s+/g, ' ').replace(/^[#>*\-\s]+/, '').trim();
  return line.length > TASK_TITLE_MAX ? `${line.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** The first sentence of Markdown text (without code blocks), `''` when there is none. */
export function firstSentence(text: string): string {
  const prose = text.replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ').replace(/`([^`]*)`/g, '$1').trim();
  const line = prose.split('\n').find((l) => l.trim() !== '') ?? '';
  const match = /^(.+?[.!?])(\s|$)/.exec(line.trim());
  return (match?.[1] ?? line).trim();
}

/** What {@link replyMenu} reads. */
export interface ReplyMenuInput {
  readonly text: string;
  /** The text selected inside this reply, `null` when none. */
  readonly selection: string | null;
  /** The developer's message that started the reply's turn. */
  readonly turnEventId: number | null;
  readonly checkpoints: SessionCheckpoints | null;
  /** Why nothing can change now (an offline computer, a closed agent, a conversation), `null` otherwise. */
  readonly blocked: string | null;
  /** A conversation never changes files: no Undo from here. */
  readonly conversation: boolean;
}

/** Why Undo from here is not offered for a reply, `null` when it is. */
export function undoReason(input: Pick<ReplyMenuInput, 'turnEventId' | 'checkpoints' | 'blocked' | 'conversation'>): { readonly turn: number | null; readonly reason: string | null } {
  if (input.conversation) return { turn: null, reason: 'Conversations never change files.' };
  if (input.blocked) return { turn: null, reason: input.blocked };
  if (input.turnEventId === null) return { turn: null, reason: 'The message that started this reply is not loaded.' };
  const revert: TurnRevert | null = turnRevertFor(input.checkpoints, input.turnEventId);
  if (!revert) return { turn: null, reason: 'Reading the save points…' };
  return { turn: revert.turn, reason: revert.reason === null ? null : revert.reason === STOP_FIRST ? 'The agent is working: stop it first.' : revert.reason === NO_CHECKPOINT ? 'No save point for this reply (save points were off, or it is more than 7 days / 100 replies old).' : revert.reason };
}

/** The menu of one reply. */
export function replyMenu(input: ReplyMenuInput): ReplyMenuItem[] {
  const code = codeBlocks(input.text);
  const selection = input.selection && input.selection.trim() !== '' ? input.selection.trim() : null;
  const title = taskTitle(selection, input.text);
  const undo = undoReason(input);
  const items: ReplyMenuItem[] = [
    { id: 'copy', label: AGENT_WORDS.copy, icon: 'copy', action: { type: 'copy', text: replyCopyText(input.text) } },
    code.length > 0
      ? { id: 'copy-code', label: AGENT_WORDS.copyCode, icon: 'copy', action: { type: 'copy-code', text: code.join('\n\n') } }
      : { id: 'copy-code', label: AGENT_WORDS.copyCode, icon: 'copy', disabledReason: AGENT_WORDS.copyCodeNone },
    input.blocked
      ? { id: 'save', label: AGENT_WORDS.saveResult, icon: 'results', disabledReason: input.blocked }
      : { id: 'save', label: AGENT_WORDS.saveResult, icon: 'results', action: { type: 'save', text: input.text } },
    input.blocked
      ? { id: 'task', label: AGENT_WORDS.addToTasks, icon: 'task', disabledReason: input.blocked }
      : title === ''
        ? { id: 'task', label: AGENT_WORDS.addToTasks, icon: 'task', disabledReason: 'Select some text in the reply first.' }
        : { id: 'task', label: selection ? AGENT_WORDS.addSelectionToTasks(shortQuote(selection)) : AGENT_WORDS.addToTasks, icon: 'task', action: { type: 'task', title } },
    undo.turn !== null && undo.reason === null
      ? { id: 'undo', label: AGENT_WORDS.undoFromHere, icon: 'undo', separated: true, action: { type: 'undo', turn: undo.turn } }
      : { id: 'undo', label: AGENT_WORDS.undoFromHere, icon: 'undo', separated: true, disabledReason: undo.reason ?? 'Not available.' },
  ];
  return items;
}

/** A selection in a menu label ("Add “the summary card…” to tasks"). */
export function shortQuote(text: string, max = 24): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}
