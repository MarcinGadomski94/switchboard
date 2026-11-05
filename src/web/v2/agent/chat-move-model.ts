import type { ChatLookAtChoice, ChatLookAtMatch, ChatMovePreview } from '../../../core/chat-move.ts';
import { chatDataLine } from '../../../core/chat-move.ts';

/**
 * D155 · the v2 **Move to computer…** dialog of a chat (`ChatMoveDialog.tsx`): its
 * pure parts. What each folder the chat looks at becomes on the other computer
 * (the suggestion, a folder picked there, or left out), the choice the next
 * preview and the start send, and why **Move** is disabled. No React, no network.
 */

/** How a looked-at folder row is set: the target's suggestion, a folder picked there, or left out. */
export type LookAtMode = 'suggested' | 'picked' | 'left-out';

/** One row of the dialog's "Folders it looks at" list. */
export interface LookAtRowView {
  readonly source: string;
  readonly name: string;
  readonly mode: LookAtMode;
  /** The folder on the target it will look at (`null` = left out). */
  readonly target: string | null;
  readonly suggestion: string | null;
  /** Why the suggestion was made, in words (`null` = no suggestion). */
  readonly why: string | null;
  /** The target's reason the chosen folder cannot be used (Move is disabled until it is changed or left out). */
  readonly problem: string | null;
  /** The row's one line: "Uses <path> on <PC>" / "Left out: the chat cannot read it on <PC>". */
  readonly line: string;
}

/** The suggestion's reason in words. */
export function matchWords(match: ChatLookAtMatch | null): string | null {
  if (match === 'remote') return 'the same code project (by its remote)';
  if (match === 'path') return 'the same path';
  if (match === 'name') return 'a saved folder with the same name';
  return null;
}

/** The dialog's rows from a preview (its plan is made with the current choice). */
export function lookAtRows(preview: ChatMovePreview, targetName: string): LookAtRowView[] {
  return preview.target.lookAt.map((row) => {
    const mode: LookAtMode = row.target === null ? 'left-out' : row.suggestion !== null && row.target === row.suggestion ? 'suggested' : 'picked';
    const line = row.target === null ? `Left out: the chat cannot read it on ${targetName}` : row.problem !== null ? `${row.target}: ${row.problem}` : `Uses ${row.target} on ${targetName}`;
    return { source: row.source, name: row.name, mode, target: row.target, suggestion: row.suggestion, why: matchWords(row.match), problem: row.problem, line };
  });
}

/** The choice as the preview answered it (every folder: its target or `null`). */
export function choiceOf(preview: ChatMovePreview): Record<string, string | null> {
  return { ...preview.lookAt };
}

/** `choice` with `source` looking at `target` on the other computer. */
export function withFolder(choice: ChatLookAtChoice, source: string, target: string): Record<string, string | null> {
  const typed = target.trim();
  return { ...choice, [source]: typed === '' ? null : typed };
}

/** `choice` with `source` left out. */
export function withLeftOut(choice: ChatLookAtChoice, source: string): Record<string, string | null> {
  return { ...choice, [source]: null };
}

/** What the dialog says it copies: "The chat is copied (2 files) · 1 attachment · 1 scratch file · 2 artifacts". */
export function carriesLine(preview: ChatMovePreview): string {
  const conversation =
    preview.source.conversation.kind === 'claude-transcript'
      ? `The conversation is copied (${preview.source.conversation.files.length} file${preview.source.conversation.files.length === 1 ? '' : 's'}) and continues there`
      : (preview.source.conversation.note ?? 'The conversation is handed over');
  return `${conversation} · ${chatDataLine(preview.source)}`;
}

/** The scratch files and attachments that stay behind, with why (shown under the facts). */
export function staysBehind(preview: ChatMovePreview): string[] {
  return [
    ...preview.source.scratchFiles.files.filter((file) => file.refused !== null).map((file) => `${file.name}: ${file.refused as string}`),
    ...preview.source.attachments.filter((entry) => entry.refused !== null).map((entry) => `${entry.name}: ${entry.refused as string}`),
  ];
}

/** Why **Move** is disabled, in words (`null` = it may start). */
export function chatMoveBlockedReason(input: {
  readonly preview: ChatMovePreview | null;
  readonly previewError: string | null;
  readonly other: { readonly name: string; readonly state: 'online' | 'reconnecting' | 'offline' } | null;
  readonly running: boolean;
  /** A folder row is being edited ("Another folder…" open with a typed path not used yet). */
  readonly editing: boolean;
}): string | null {
  if (input.running) return 'It is moving now.';
  if (input.other && input.other.state === 'offline') return `${input.other.name} is offline: it can move once it reconnects.`;
  if (input.other && input.other.state === 'reconnecting') return `Reconnecting to ${input.other.name}…`;
  if (input.previewError) return input.previewError;
  if (!input.preview) return 'Checking both computers…';
  if (input.preview.blockers.length > 0) return input.preview.blockers[0] ?? 'Something on one of the computers stops it.';
  if (!input.preview.ok) return 'Something on one of the computers stops it.';
  if (input.editing) return 'Use the folder you typed, or close the folder picker.';
  return null;
}

/**
 * Whether a chat offers **Move to computer…**: it is open, was not moved already,
 * and (a paired computer's chat) its computer is reachable. Unlike a session's
 * take-over, a chat Switchboard never ran here has nothing to stop, so no demo rule.
 */
export function offersChatMove(chat: { readonly closedAt?: string | null; readonly movedTo?: unknown; readonly machine?: { readonly state: string } | null }): boolean {
  if ((chat.closedAt ?? null) !== null || chat.movedTo) return false;
  if (chat.machine && chat.machine.state !== 'online' && chat.machine.state !== 'reconnecting') return false;
  return true;
}
