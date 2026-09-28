import { FRAME_HELPER_ATTRIBUTE } from '../../core/site-tools.ts';

/**
 * D28 (`docs/frame-helper.md`): whether the Switchboard frame helper (the browser
 * extension in `tools/frame-helper/`) is installed in this browser and works here.
 * Its content script marks the page's `<html>` with `data-sb-frame-helper="<version>"`
 * at document_start; the marker may land slightly after the page loads (Safari), so
 * it is watched for {@link MARKER_WAIT_MS} before the helper counts as absent (and
 * still afterwards, in case it arrives late). With the marker, a hidden frame of
 * `FRAME_CHECK_PATH` (a page that refuses every frame) tells whether the helper
 * really removes frame headers in this browser (`ready`) or not (`blocked`: Safari's
 * extensions cannot modify response headers today; a Chrome helper without site access).
 * D28 ruling (narrowed scope): the helper removes those headers only for the hosts
 * this page gives it, in this tab only ({@link createSitesSync}); the capability
 * check waits for its first answer, and a site frames only once its host is confirmed
 * ({@link siteFrameStatus}).
 * This file is the logic (no DOM, unit-tested); `useFrameHelper.ts` wires it to the page.
 */
export type FrameHelperStatus = 'checking' | 'absent' | 'blocked' | 'ready';

/** The helper's state for this page. */
export interface FrameHelperState {
  readonly status: FrameHelperStatus;
  /** The extension's version from the marker; `null` while unknown or absent. */
  readonly version: string | null;
}

/** How long the page waits for the marker before it shows "needs the frame helper". */
export const MARKER_WAIT_MS = 1_500;

/** How long the capability check frame may take before it counts as refused. */
export const CHECK_TIMEOUT_MS = 4_000;

/** The marker's version on `root` (`<html>`), or `null` when it is missing or blank. */
export function readFrameHelperMarker(root: { getAttribute(name: string): string | null } | null | undefined): string | null {
  const value = root?.getAttribute(FRAME_HELPER_ATTRIBUTE)?.trim();
  return value ? value : null;
}

/** What {@link watchFrameHelper} needs from the page: the DOM in the app, fakes in tests. */
export interface FrameHelperEnvironment {
  /** The marker's version now (see {@link readFrameHelperMarker}). */
  readMarker(): string | null;
  /** Calls `onChange` whenever the marker may have changed; returns a function that stops. */
  observeMarker(onChange: () => void): () => void;
  /** Runs `run` once after `ms`; returns a function that cancels it. */
  setTimer(run: () => void, ms: number): () => void;
  /**
   * Resolves once the helper answered the page's latest host list (or gave up
   * waiting): the capability check needs the helper's rule for this page's own host.
   */
  sitesSettled(): Promise<void>;
  /** Resolves `true` when a frame of `FRAME_CHECK_PATH` shows in this browser. */
  checkFraming(): Promise<boolean>;
}

/**
 * Watches for the helper and reports each state change to `onState`: `checking`
 * first; `absent` when no marker arrived within `waitMs`; once a marker is seen
 * (in time or later), `checking` with its version, then (once the helper answered
 * the page's host list, {@link FrameHelperEnvironment.sitesSettled}) `ready` or
 * `blocked` from one capability check (a failing check counts as `blocked`).
 * Returns a function that stops watching (later results are dropped).
 */
export function watchFrameHelper(env: FrameHelperEnvironment, onState: (state: FrameHelperState) => void, waitMs: number = MARKER_WAIT_MS): () => void {
  let stopped = false;
  let seen: string | null = null;
  const report = (state: FrameHelperState): void => {
    if (!stopped) onState(state);
  };
  report({ status: 'checking', version: null });
  const evaluate = (): void => {
    if (stopped || seen !== null) return;
    const version = env.readMarker();
    if (version === null) return;
    seen = version;
    report({ status: 'checking', version });
    env
      .sitesSettled()
      .then(() => env.checkFraming())
      .then(
        (ok) => report({ status: ok ? 'ready' : 'blocked', version }),
        () => report({ status: 'blocked', version }),
      );
  };
  const stopObserving = env.observeMarker(evaluate);
  const cancelTimer = env.setTimer(() => {
    if (seen === null) report({ status: 'absent', version: null });
  }, waitMs);
  evaluate();
  return () => {
    stopped = true;
    stopObserving();
    cancelTimer();
  };
}

/*
 * D28 ruling (2026-09-28, narrowed scope): the page tells the helper which hosts it
 * frames. Switchboard posts `{ source: 'switchboard', type: 'frame-helper:sites',
 * id, hosts }` to its own window; the helper's content script (marker.js) relays it
 * to the extension's service worker (background.js), which replaces this tab's
 * session rule and answers; the content script posts the answer back as
 * `{ source: 'switchboard-frame-helper', type: 'frame-helper:sites-applied', id,
 * ok, hosts, error }`.
 */

/** The `source` of Switchboard's messages to the frame helper. */
export const PAGE_MESSAGE_SOURCE = 'switchboard';

/** The `source` of the frame helper's answers to the page. */
export const HELPER_MESSAGE_SOURCE = 'switchboard-frame-helper';

/** Page → helper: "frame these hosts in my tab" (the whole list; it replaces the last one). */
export const SITES_MESSAGE_TYPE = 'frame-helper:sites';

/** Helper → page: the answer to a {@link SITES_MESSAGE_TYPE} message. */
export const SITES_APPLIED_MESSAGE_TYPE = 'frame-helper:sites-applied';

/** How long the page waits for the helper to answer a host list before it stops waiting. */
export const SITES_TIMEOUT_MS = 2_000;

/** A host list for the helper ({@link SITES_MESSAGE_TYPE}). */
export interface SitesMessage {
  readonly source: typeof PAGE_MESSAGE_SOURCE;
  readonly type: typeof SITES_MESSAGE_TYPE;
  /** Counts up per page; the answer carries it back. */
  readonly id: number;
  readonly hosts: readonly string[];
}

/** The helper's answer ({@link SITES_APPLIED_MESSAGE_TYPE}). */
export interface SitesAnswer {
  readonly id: number;
  /** `true` when the helper now removes the frame headers for exactly {@link hosts} in this tab. */
  readonly ok: boolean;
  /** The hosts the helper keeps for this tab (empty when it refused the list). */
  readonly hosts: readonly string[];
  /** Why the helper refused the list; `null` when it took it. */
  readonly error: string | null;
}

/** `data` as a {@link SitesAnswer}, or `null` for any other message. */
export function readSitesAnswer(data: unknown): SitesAnswer | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record['source'] !== HELPER_MESSAGE_SOURCE || record['type'] !== SITES_APPLIED_MESSAGE_TYPE) return null;
  const id = record['id'];
  const hosts = record['hosts'];
  if (typeof id !== 'number' || !Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string')) return null;
  const ok = record['ok'] === true;
  const error = record['error'];
  return { id, ok, hosts: ok ? [...(hosts as string[])] : [], error: ok ? null : typeof error === 'string' && error ? error : 'refused' };
}

/** What the page knows about the helper's rules for its tab. */
export interface FrameHelperSites {
  /** `true` once the helper answered any host list, i.e. it keeps tab-scoped rules (not an older helper). */
  readonly answered: boolean;
  /** `true` while the latest list waits for its answer (at most {@link SITES_TIMEOUT_MS}). */
  readonly pending: boolean;
  /** The hosts the helper confirmed for this tab in its answer to the latest list. */
  readonly applied: readonly string[];
  /** The helper's reason when it refused the latest list; `null` otherwise. */
  readonly error: string | null;
}

/** What {@link createSitesSync} needs from the page: `window.postMessage` and timers in the app, fakes in tests. */
export interface SitesEnvironment {
  /** Posts `message` to this page's own window (the helper's content script listens there). */
  post(message: SitesMessage): void;
  /** Runs `run` once after `ms`; returns a function that cancels it. */
  setTimer(run: () => void, ms: number): () => void;
}

/** The page's side of the host list: one per page (`useFrameHelper.ts`). */
export interface SitesSync {
  /** Sends `hosts` to the helper, unless they equal the last list sent. */
  send(hosts: readonly string[]): void;
  /** Sends the last list again (a new document state, e.g. back from the back/forward cache). */
  resend(): void;
  /** Takes a `message` event's data; the helper's answer to the latest list updates the state. */
  receive(data: unknown): void;
  /** The current state. */
  state(): FrameHelperSites;
  /** Calls `listener` on every state change; returns a function that stops. */
  subscribe(listener: () => void): () => void;
  /** Resolves once a list was sent and answered (or its wait ran out), or after {@link SITES_TIMEOUT_MS} at most. */
  settled(): Promise<void>;
}

/**
 * Creates the page's {@link SitesSync}. Each list sent gets a new id and waits up to
 * `timeoutMs` for its answer; an answer to an older list only shows that the helper
 * answers (`answered`), since a newer list replaced it.
 */
export function createSitesSync(env: SitesEnvironment, timeoutMs: number = SITES_TIMEOUT_MS): SitesSync {
  let current: FrameHelperSites = { answered: false, pending: false, applied: [], error: null };
  let lastId = 0;
  let last: readonly string[] | null = null;
  let cancelWait = (): void => {};
  let waiters: Array<() => void> = [];
  const listeners = new Set<() => void>();

  const update = (next: FrameHelperSites): void => {
    current = next;
    if (last !== null && !current.pending && waiters.length > 0) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    }
    for (const listener of listeners) listener();
  };

  const post = (hosts: readonly string[]): void => {
    lastId += 1;
    const id = lastId;
    last = [...hosts];
    cancelWait();
    cancelWait = env.setTimer(() => {
      if (id === lastId && current.pending) update({ ...current, pending: false });
    }, timeoutMs);
    update({ ...current, pending: true });
    env.post({ source: PAGE_MESSAGE_SOURCE, type: SITES_MESSAGE_TYPE, id, hosts: last });
  };

  return {
    send(hosts) {
      if (last !== null && last.length === hosts.length && last.every((host, i) => host === hosts[i])) return;
      post(hosts);
    },
    resend() {
      if (last !== null) post(last);
    },
    receive(data) {
      const answer = readSitesAnswer(data);
      if (answer === null) return;
      if (answer.id !== lastId) {
        if (!current.answered) update({ ...current, answered: true });
        return;
      }
      cancelWait();
      update({ answered: true, pending: false, applied: answer.hosts, error: answer.error });
    },
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled() {
      if (last !== null && !current.pending) return Promise.resolve();
      return new Promise((resolve) => {
        let cancel = (): void => {};
        const finish = (): void => {
          cancel();
          waiters = waiters.filter((waiter) => waiter !== finish);
          resolve();
        };
        waiters.push(finish);
        cancel = env.setTimer(finish, timeoutMs);
      });
    },
  };
}

/**
 * The state a site's Tool view shows (D28 ruling): the helper's own state until it
 * is `ready`; then `ready` only once the helper confirmed `host` for this tab,
 * `checking` while the page's latest list waits for its answer, and `blocked` when
 * the helper answered without it (it refused the list, or the host was left out).
 * A helper that never answers a list (an older one, with a static rule) is trusted
 * on its capability check alone.
 */
export function siteFrameStatus(helper: FrameHelperState, sites: FrameHelperSites, host: string | null): FrameHelperStatus {
  if (helper.status !== 'ready') return helper.status;
  if (host !== null && sites.applied.includes(host)) return 'ready';
  if (sites.pending) return 'checking';
  return sites.answered ? 'blocked' : 'ready';
}
