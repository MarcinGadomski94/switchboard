import type { Agent } from '../../../core/api.ts';

/**
 * D36: a subagent's own chat in the chat tab (`docs/chat.md` → *Subagent chats*):
 * its copy, the way back (Esc) and the main chat's scroll kept in memory, kept
 * free of React so `tests/web` can check them. The chat's items come from
 * `subagentChat` in `chat.ts`.
 */

/** The top bar's back link. */
export const SUBAGENT_BACK = '← Main chat';

/** The label over the first bubble (the Agent / Task call's prompt). */
export const SUBAGENT_BRIEF_LABEL = 'Brief from the main agent';

/** The label over the last block (the call's result). */
export const SUBAGENT_RESULT_LABEL = 'Result';

/** The note in the composer's place: its first part (the rest links back to the main chat). */
export const SUBAGENT_NO_MESSAGES = 'Subagents take no messages';

/** The note's link back to the main chat. */
export const SUBAGENT_REPLY_IN_MAIN = 'reply in the main chat';

/** The whole note, as it reads: "Subagents take no messages · reply in the main chat". */
export const SUBAGENT_NOTE = `${SUBAGENT_NO_MESSAGES} · ${SUBAGENT_REPLY_IN_MAIN}`;

/** What an unknown agent id (or one without a chat) shows, with the back link. */
export const SUBAGENT_NO_CHAT = 'This subagent has no chat here';

/** The tooltip of every entry point: the chat's Agent step, the agent card, the overview row. */
export const OPEN_SUBAGENT_CHAT = "Open this subagent's chat";

/** The footer of a subagent's question card (read-only there): its first part. */
export const SUBAGENT_QUESTION_NOTE = 'Answer in the main chat or the Inbox';

/** The question card's link to the main chat's card. */
export const SUBAGENT_QUESTION_LINK = 'Open it in the main chat';

/** The top bar's title after the back link: `<name>: <description>` (just the name without one). */
export function subagentTitle(agent: Pick<Agent, 'name' | 'description'>): string {
  return agent.description ? `${agent.name}: ${agent.description}` : agent.name;
}

/** A key press as {@link escGoesBack} reads it. */
export interface EscPress {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

/** Where the page is when the key comes (read from the DOM by the view). */
export interface EscContext {
  /** Focus is in a text field (input, textarea, select, contenteditable). */
  readonly editing: boolean;
  /** A modal, dialog or popover is open (`role="dialog"` / `"alertdialog"`, `aria-modal`). */
  readonly overlayOpen: boolean;
}

/**
 * D36: Esc returns from a subagent's chat to the main chat, unless something else
 * owns the key: a modal or popover is open (Esc closes that), focus is in a text
 * field, a modifier is held, an IME composes, or another handler took it.
 */
export function escGoesBack(press: EscPress, context: EscContext): boolean {
  if (press.key !== 'Escape' || press.defaultPrevented || press.isComposing) return false;
  if (press.altKey || press.ctrlKey || press.metaKey || press.shiftKey) return false;
  return !context.editing && !context.overlayOpen;
}

/** The selector of the overlays that own Esc while open (every modal, dialog and popover of the app). */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** The main chat's place, kept per session while its subagents' chats are open (D36). */
export interface MainChatPlace {
  /** `scrollTop` of the conversation. */
  readonly top: number;
  /** It was at (or within the stick distance of) the bottom, so it follows new items. */
  readonly stick: boolean;
  /** A question batch to bring into view instead (a subagent's card "Open it in the main chat"). */
  readonly reveal?: string;
}

const places = new Map<string, MainChatPlace>();

/** D36: remembers the main chat's place for a session (in memory, for this page's life). */
export function rememberMainChat(sessionId: string, place: MainChatPlace): void {
  places.set(sessionId, place);
}

/** D36: the main chat's remembered place for a session, `null` when there is none. */
export function mainChatPlace(sessionId: string): MainChatPlace | null {
  return places.get(sessionId) ?? null;
}
