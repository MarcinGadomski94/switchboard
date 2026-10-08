import { type DeviceNotice, PUSH_EVENT_KINDS, type PushEventKind, type PushEvents } from '../../core/devices.ts';
import type { ToastContent } from './notify.ts';

/**
 * D87 (`docs/devices.md` → *No notifications while Switchboard is open*): the
 * toast a paired device's open page shows for a push-worthy happening, since the
 * device gets no system notification while Switchboard is open in front. The
 * happening arrives as the `/hub` `notice` event, and (rarely, when the server
 * judged the device not in front) as a message from the service worker, which
 * then did not show the system notification; both carry the same id, so one
 * toast. Kept free of React for `tests/web`.
 */

/** The message the service worker posts instead of a system notification (`sw.js`, `pushDecision`). */
export const SW_NOTICE_MESSAGE = 'switchboard-notice';

/** The toast's sub line per kind. */
const SUB: { readonly [K in PushEventKind]: string } = {
  permission: 'permission · now',
  questions: 'question · now',
  turnFinished: 'finished · now',
  errors: 'error · now',
  inbox: 'inbox · now',
  review: 'ready for review · now',
};

/** A notice from the hub or a service-worker message, `null` when it is not one. */
export function readNotice(value: unknown): DeviceNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || !v['id'] || typeof v['title'] !== 'string' || typeof v['body'] !== 'string' || typeof v['url'] !== 'string' || typeof v['tag'] !== 'string') return null;
  if (!(PUSH_EVENT_KINDS as readonly unknown[]).includes(v['kind'])) return null;
  return { id: v['id'], kind: v['kind'] as PushEventKind, title: v['title'], body: v['body'], url: v['url'], tag: v['tag'] };
}

/** The `data` of a service-worker message when it carries a notice, else `null`. */
export function noticeFromMessage(data: unknown): DeviceNotice | null {
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== SW_NOTICE_MESSAGE) return null;
  return readNotice((data as { notice?: unknown }).notice);
}

/** The session a notice links to (`/sessions/<id>`), else `null`. */
export function noticeSession(notice: DeviceNotice): string | null {
  const match = /^\/sessions\/([^/?#]+)$/.exec(notice.url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

/** What decides whether a notice becomes a toast on this page. */
export interface NoticeContext {
  /** This page runs on a paired device (`GET /api/device` names one). */
  readonly device: boolean;
  /** That device's toggles (the defaults while it has no subscription). */
  readonly events: PushEvents;
  /** The session the page shows, else `null`. */
  readonly viewing: string | null;
  /** The page is hidden. */
  readonly hidden: boolean;
  /** Notice ids already handled on this page. */
  readonly seen: ReadonlySet<string>;
}

/**
 * `true` when the notice should raise a toast: on a paired device's page only
 * (this machine's UI is unchanged), once per id, for a kind whose toggle is on;
 * not for a question batch (the M3.4 question toast covers those, the paired
 * machines' too), and not for the session the page shows while it is visible.
 */
export function shouldToast(notice: DeviceNotice, context: NoticeContext): boolean {
  if (!context.device || context.seen.has(notice.id)) return false;
  if (notice.kind === 'questions') return false;
  if (!context.events[notice.kind]) return false;
  const session = noticeSession(notice);
  return !(session !== null && session === context.viewing && !context.hidden);
}

/** The toast of a notice. */
export function noticeToast(notice: DeviceNotice): ToastContent {
  return { id: notice.id, title: notice.title, sub: SUB[notice.kind], branch: '', text: notice.body, sessionId: noticeSession(notice) };
}
