import { useSyncExternalStore } from 'react';

/** D155: what the chat's Move to computer… dialog is opened for. */
export interface ChatMoveRequest {
  /** The chat's id as this machine knows it (a remote id for a paired computer's chat: it comes here). */
  readonly chatId: string;
  /** The paired computer a local chat moves to (picked in the dialog); `null` for a paired computer's chat. */
  readonly targetMachine: string | null;
  /** The other computer's name (the title). */
  readonly machineName: string;
  readonly title: string;
}

/**
 * D155: which chat-move dialog is open: a small module store like the take-over's
 * (`store.ts`): Esc must not close a move that is running.
 */
let current: ChatMoveRequest | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Opens the chat-move dialog for `request`. */
export function openChatMove(request: ChatMoveRequest): void {
  current = request;
  notify();
}

/** Closes it. */
export function closeChatMove(): void {
  current = null;
  notify();
}

/** The open request, live. */
export function useChatMoveRequest(): ChatMoveRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
