/** D106: the event ⌘K → Chats sends; the sidebar shows its CHATS section ({@link useRevealChats}). */
const REVEAL_CHATS_EVENT = 'switchboard:reveal-chats';

/** D106: shows the sidebar's CHATS section (⌘K → Chats). */
export function revealChats(): void {
  window.dispatchEvent(new Event(REVEAL_CHATS_EVENT));
}

/**
 * D106: the sidebar's side of {@link revealChats}: `show` makes the sidebar visible
 * (the drawer on a tablet or phone, a hidden sidebar on a desktop), then the CHATS
 * label is scrolled into view and focused.
 */
export function onRevealChats(show: () => void): () => void {
  const listener = (): void => {
    show();
    requestAnimationFrame(() => {
      const head = document.querySelector<HTMLElement>('[data-testid="sidebar-chats-head"]');
      head?.scrollIntoView({ block: 'nearest' });
      head?.focus();
    });
  };
  window.addEventListener(REVEAL_CHATS_EVENT, listener);
  return () => window.removeEventListener(REVEAL_CHATS_EVENT, listener);
}
