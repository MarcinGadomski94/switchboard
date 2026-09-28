import type { HubEvents, InboxItem } from '../../core/api.ts';

/**
 * Notifications for a new question batch (M3.4, SPEC → Modals → Toast; contract:
 * `/hub` `questionBatch` → "UI plays the sound, shows a toast and sends an OS
 * notification"). Kept free of React so it can be unit-tested; the browser APIs
 * (Web Audio, Web Notifications) are passed in. `docs/notifications.md` has the
 * rules.
 */

/** The `/hub` `questionBatch` payload (contract). */
export type QuestionBatchEvent = HubEvents['questionBatch'];

/** What an OS notification says. */
export interface OsNotice {
  readonly title: string;
  readonly body: string;
  /** Same tag = the OS replaces the earlier one (two open tabs notify once). */
  readonly tag: string;
}

/** A toast's content (the shape of `Toast` in `ToastHost.tsx`, kept free of the React module). */
export interface ToastContent {
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly branch: string;
  readonly text: string;
  readonly sessionId: string | null;
}

/** The toast and the OS notification of one question batch. */
export interface QuestionNotice {
  readonly toast: ToastContent;
  readonly os: OsNotice;
}

/** The toast's sub line for a batch of `count` questions (prototype: `question · now`). */
export function questionSub(count: number): string {
  return count === 1 ? 'question · now' : `${count} questions · now`;
}

/** The OS notification title (prototype `arrive()`: `<session> needs you`). */
export function osTitle(sessionName: string): string {
  return `${sessionName} needs you`;
}

/**
 * The toast + OS notification of a question batch. `item` is the batch's Inbox
 * item (`GET /api/inbox`, id = batch id), which names the session (D22: its
 * `sourceTitle`, the session's title else its name; else `source`) and its branch
 * chips; without it the session's display title comes from `sessionName`, else the
 * session id. The text is the first question, verbatim (SPEC → Copy rules); the
 * sub line says how many questions the batch holds.
 */
export function questionNotice(event: QuestionBatchEvent, item: InboxItem | null, sessionName: string | null): QuestionNotice {
  const name = item?.sourceTitle || item?.source || sessionName || event.sessionId;
  const questions = item?.questions?.length ? item.questions : event.questions;
  const text = questions[0]?.text ?? '';
  const branch = (item?.branches ?? []).map((ref) => `${ref.solution} ⎇ ${ref.branch}`).join(' · ');
  return {
    toast: {
      id: event.batchId,
      title: name,
      sub: questionSub(Math.max(questions.length, 1)),
      branch,
      text,
      sessionId: event.sessionId,
    },
    os: { title: osTitle(name), body: text, tag: `switchboard-batch-${event.batchId}` },
  };
}

/** A question toast still showing: its session, when it was shown (ms) and its OS notification. */
export interface OpenNotice {
  readonly sessionId: string;
  readonly shownAt: number;
  readonly os: { close(): void } | null;
}

/**
 * Which question toasts to take away (developer request 2026-09-28): those of the
 * session the page now shows (`viewing`, the session route's id, else `null`), and
 * those whose batch left the Inbox (answered, withdrawn, stale), known from an
 * Inbox read that started after the toast was shown (`inbox`: the listed item ids
 * and when the read started; `null` = no read).
 */
export function noticesToClear(
  open: ReadonlyMap<string, OpenNotice>,
  viewing: string | null,
  inbox: { readonly ids: ReadonlySet<string>; readonly readStartedAt: number } | null,
): string[] {
  const clear: string[] = [];
  for (const [batchId, notice] of open) {
    if (viewing !== null && notice.sessionId === viewing) clear.push(batchId);
    else if (inbox && notice.shownAt < inbox.readStartedAt && !inbox.ids.has(batchId)) clear.push(batchId);
  }
  return clear;
}

// ── Sound ───────────────────────────────────────────────────────────────

/** One tone of the chime: start (s after the chime starts) and frequency. */
export interface ChimeTone {
  readonly at: number;
  readonly hz: number;
}

/** The two-tone chime (prototype `beep()`: 784 Hz, then 1046 Hz 0.14 s later). */
export const CHIME_TONES: readonly ChimeTone[] = [
  { at: 0, hz: 784 },
  { at: 0.14, hz: 1046 },
];

/** Envelope of each tone (prototype `beep()`), in seconds from the tone's start. */
export const CHIME_ENVELOPE = { floor: 0.0001, peak: 0.12, attack: 0.02, release: 0.22, stop: 0.25 } as const;

/** How long after the chime starts its AudioContext is closed (ms): after the last tone stops. */
export const CHIME_CLOSE_MS = 600;

/** How long a `suspended` context may take to resume before the chime is dropped (ms). */
export const CHIME_RESUME_MS = 200;

/** The part of `AudioParam` the chime uses. */
interface ChimeParam {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

/** The part of `AudioNode` the chime uses. */
interface ChimeNode {
  connect(destination: unknown): unknown;
}

/** The part of `AudioContext` the chime uses. */
export interface ChimeContext {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  createOscillator(): ChimeNode & { readonly frequency: ChimeParam; start(when?: number): void; stop(when?: number): void };
  createGain(): ChimeNode & { readonly gain: ChimeParam };
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** An `AudioContext` constructor (or a test double). */
export type ChimeContextFactory = new () => ChimeContext;

/** The page's `AudioContext` (or the prefixed one), `null` when the browser has none. */
export function browserAudioContext(): ChimeContextFactory | null {
  const w = globalThis as unknown as { AudioContext?: ChimeContextFactory; webkitAudioContext?: ChimeContextFactory };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Timers the chime uses (tests pass their own). */
export interface ChimeTimers {
  readonly after: (run: () => void, ms: number) => unknown;
}

const REAL_TIMERS: ChimeTimers = { after: (run, ms) => setTimeout(run, ms) };

/** `true` once `ctx` runs: at once, or after a `resume()` that settles within {@link CHIME_RESUME_MS}. */
async function running(ctx: ChimeContext, timers: ChimeTimers): Promise<boolean> {
  if (ctx.state === 'running') return true;
  const resumed = ctx.resume().then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => timers.after(() => resolve(false), CHIME_RESUME_MS));
  return (await Promise.race([resumed, timeout])) && ctx.state === 'running';
}

/**
 * Plays the two-tone chime on a fresh `AudioContext`, closed again once the tones
 * have stopped (prototype `beep()`). Nothing plays, and nothing throws, when the
 * browser has no Web Audio or its autoplay policy keeps the context `suspended`
 * (nobody has clicked the page yet): that context is closed at once, so a chime
 * never plays late. Resolves `true` when the tones were scheduled.
 */
export async function playChime(Context: ChimeContextFactory | null = browserAudioContext(), timers: ChimeTimers = REAL_TIMERS): Promise<boolean> {
  if (!Context) return false;
  let ctx: ChimeContext;
  try {
    ctx = new Context();
  } catch {
    return false;
  }
  const close = (): void => {
    try {
      ctx.close().catch(() => undefined);
    } catch {
      // already closed
    }
  };
  try {
    if (!(await running(ctx, timers))) {
      close();
      return false;
    }
    const start = ctx.currentTime;
    const { floor, peak, attack, release, stop } = CHIME_ENVELOPE;
    for (const tone of CHIME_TONES) {
      const t = start + tone.at;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = tone.hz;
      gain.gain.setValueAtTime(floor, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + attack);
      gain.gain.exponentialRampToValueAtTime(floor, t + release);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(t);
      oscillator.stop(t + stop);
    }
  } catch {
    close();
    return false;
  }
  timers.after(close, CHIME_CLOSE_MS);
  return true;
}

// ── OS notification ─────────────────────────────────────────────────────

/** The part of a `Notification` the app uses. */
export interface OsNotification {
  onclick: ((this: unknown, event: unknown) => unknown) | null;
  close(): void;
}

/** A `Notification` constructor (or a test double). */
export interface OsNotificationFactory {
  readonly permission: string;
  new (title: string, options: { body: string; tag: string }): OsNotification;
}

/** The page's `Notification`, `null` when the browser has none. */
export function browserNotification(): OsNotificationFactory | null {
  const w = globalThis as unknown as { Notification?: OsNotificationFactory };
  return w.Notification ?? null;
}

/**
 * Sends an OS notification when the developer allowed them
 * (`Notification.permission === 'granted'`); it never asks for the permission
 * (Settings and the setup wizard do, M8.2 / M5.3). A click runs `onClick` and
 * closes the notification. Returns the notification, or `null` when none was sent.
 */
export function notifyOs(
  notice: OsNotice,
  onClick: () => void,
  Ctor: OsNotificationFactory | null = browserNotification(),
): OsNotification | null {
  if (!Ctor) return null;
  try {
    if (Ctor.permission !== 'granted') return null;
    const notification = new Ctor(notice.title, { body: notice.body, tag: notice.tag });
    notification.onclick = () => {
      onClick();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
}
