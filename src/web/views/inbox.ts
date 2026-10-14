import type { InboxItem, NewSessionPrefill } from '../../core/api.ts';

/**
 * The Inbox view's state and copy (SPEC → Inbox; prototype `inboxRaw` / `ib`),
 * kept free of React so it can be unit-tested. `docs/inbox.md` has the rules.
 */

/** Detail pane when nothing waits (prototype copy). */
export const INBOX_ZERO = 'Inbox zero';

/** The line under {@link INBOX_ZERO} (prototype copy). */
export const INBOX_ZERO_HINT = 'New questions, approvals and failed runs show up here with a toast and sound.';

/** The list column when nothing waits (prototype copy). */
export const ALL_CLEAR = 'All clear. Nothing is waiting on you.';

/** The link from a session's item to its session view (prototype copy). */
export const OPEN_SESSION = 'Open session →';

/** The header count (`5 waiting on you`). */
export function waitingLine(count: number): string {
  return `${count} waiting on you`;
}

/**
 * The item the detail shows: the selected one while it is still listed, else the
 * first (prototype: `selId`); `null` for an empty list.
 */
export function selectedItem(items: readonly InboxItem[], selectedId: string | null): InboxItem | null {
  return items.find((item) => item.id === selectedId) ?? items[0] ?? null;
}

/** Items without the ones the page already sent an answer or an action for (until the list reloads). */
export function visibleItems(items: readonly InboxItem[], done: ReadonlySet<string>): InboxItem[] {
  return items.filter((item) => !done.has(item.id));
}

/** What the detail renders under the text: the question card, a permission request, or system actions. */
export type DetailBody = 'questions' | 'permission' | 'system';

/** The detail body of an item. */
export function detailBody(item: InboxItem): DetailBody {
  if (item.kind === 'questions') return 'questions';
  return item.kind === 'permission' ? 'permission' : 'system';
}

/** `true` when the item belongs to a session the detail links to ("Open session →"; prototype: session items only). */
export function linksSession(item: InboxItem): item is InboxItem & { readonly sessionId: string } {
  return item.kind !== 'system' && item.sessionId !== null;
}

/** A permission request's tool input, verbatim, as indented JSON (D6). */
export function formatToolInput(input: unknown): string {
  if (input === undefined) return '';
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * The line shown when the service refuses an answer or an action: the server's
 * `message` when it sent one, else the HTTP status (or "not reachable").
 */
export function refusalText(status: number, body: unknown): string {
  const message =
    typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : null;
  if (message) return `Not sent: ${message}`;
  return status === 0 ? 'Not sent: Switchboard is not reachable.' : `Not sent: HTTP ${status}`;
}

/** The system action that opens the New-session modal once it succeeds (M3.3, prototype "Open fix session"). */
export const OPEN_FIX_SESSION = 'open-fix-session';

/**
 * What the New-session modal opens with after `actionId` succeeded on `item`: the
 * item's `prefill` (empty when it has none) for "Open fix session", `null` for any
 * other action (no modal).
 */
export function newSessionAfter(item: InboxItem, actionId: string): NewSessionPrefill | null {
  if (item.kind !== 'system' || actionId !== OPEN_FIX_SESSION) return null;
  return item.prefill ?? {};
}

/** D102: a plan's "Ready to merge" item's Open plan: goes to the plan (`item.route`) without closing the item. */
export const OPEN_PLAN = 'open-plan';

/** Project memory (D107) hook: a folder's "N memory proposals" item's Review goes to the Memory page at it (docs/memory-removal.md). */
export const OPEN_MEMORY = 'open-memory';

/** D109: the PR watcher's items' links: Open session (the item's session) and Open PR (the PR on GitHub). */
export const OPEN_SESSION_ACTION = 'open-session';
export const OPEN_PR_ACTION = 'open-pr';

/** D102: the route an action goes to without calling the server (Open plan; D107: a memory item's Review; D109: Open session), else `null`. */
export function openRoute(item: InboxItem, actionId: string): string | null {
  if (item.kind !== 'system') return null;
  if (actionId === OPEN_PLAN || actionId === OPEN_MEMORY) return item.route ?? null;
  if (actionId === OPEN_SESSION_ACTION && item.sessionId) return `/sessions/${encodeURIComponent(item.sessionId)}`;
  return null;
}

/** D109: the external page an action opens in a new tab without calling the server (Open PR), else `null`. */
export function openUrl(item: InboxItem, actionId: string): string | null {
  return item.kind === 'system' && actionId === OPEN_PR_ACTION && item.url && /^https:\/\//.test(item.url) ? item.url : null;
}

/** D55: the update item's action that closes it and opens Settings → Updates (the notes and the Update button). */
export const WHATS_NEW = 'whats-new';

/**
 * D55: where the page goes after `actionId` succeeded on `item`:
 * `/settings/updates` for "What's new" of this machine's update item (a paired
 * machine's item only closes: its updates are that machine's), else `null`.
 */
export function routeAfter(item: InboxItem, actionId: string): string | null {
  if (item.kind !== 'system' || actionId !== WHATS_NEW || item.machine) return null;
  return '/settings/updates';
}
