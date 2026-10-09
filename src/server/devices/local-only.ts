/**
 * D73 (`docs/devices.md` → *What a device may do*, `docs/security.md`): which
 * `/api` routes a paired device may call. **An allow-list** (developer ruling
 * 2026-10-08): a device request to `/api/…` is refused (403 `local-only`) unless
 * its method and path are on {@link DEVICE_ALLOWED}. Pages, static files and
 * `/hub` are not `/api` and are not judged here.
 *
 * Allowed is what a phone needs for normal use: sessions (list, detail, events,
 * diff, attachments, messages, stop, pause / resume, close / reopen, D83's continue in a fresh session, title,
 * model, CLI / account switch, todos, D80's revert of a turn and Redo), the Inbox and its answers, starting a
 * session (folders read, models, solutions, branching preflight, staged
 * attachments), the sidebar layout, History and its Continue, schedules and
 * loops (save, run, pause / resume, delete, hook a terminal session), the reads
 * the UI needs (system / usage, settings, CLIs, accounts, machines, tools and
 * their probes, MCP and hooks status, updates), the UI preferences
 * (`PUT /api/settings`), Reconnect of a paired machine, the device's own name
 * and notifications (D87: and its pages' presence), and (D79) the review cards with Merge, Open PR, Commit, Send
 * back and Dismiss (Discard and Clean up stay on the desktop), and (D85) the
 * tutorial's state (read it, mark a tour seen).
 *
 * Everything else is refused (D84: Clean-up too); {@link DEVICE_REFUSED} lists those routes
 * explicitly so every registered route is classified (a test enumerates the
 * app's routes and fails on one in neither list, or in both). A request to a
 * paired machine's API through `/api/machines/{id}/api/<rest>` is judged as
 * `/api/<rest>`.
 */

/** One rule: methods (`GET`, `POST|PUT|DELETE`, `*` = any; `GET` also covers `HEAD`) and path pattern (decoded, no query). */
export type DeviceRule = readonly [methods: string, path: RegExp];

/** Writes (every method but GET / HEAD). */
const WRITE = 'POST|PUT|DELETE|PATCH';

/** The routes a paired device may call. */
export const DEVICE_ALLOWED: readonly DeviceRule[] = [
  // Sessions.
  ['GET|POST', /^\/api\/sessions$/],
  ['GET', /^\/api\/sessions\/[^/]+$/],
  ['GET', /^\/api\/sessions\/[^/]+\/(?:events|diff|todos)$/],
  // D90: which views the Diff tab offers (a read, like the diff).
  ['GET', /^\/api\/sessions\/[^/]+\/diff\/targets$/],
  ['GET', /^\/api\/sessions\/[^/]+\/events\/[^/]+\/full$/],
  ['GET', /^\/api\/sessions\/[^/]+\/attachments\/[^/]+$/],
  ['GET', /^\/api\/sessions\/[^/]+\/workflow-agents\/[^/]+\/chat$/],
  ['POST', /^\/api\/sessions\/[^/]+\/(?:messages|attachments|pause|resume|close|reopen|interrupt|account|provider|continue-in-switchboard|fresh)$/],
  ['POST', /^\/api\/sessions\/[^/]+\/background\/stop$/],
  ['POST', /^\/api\/sessions\/[^/]+\/events\/[^/]+\/resend$/],
  ['PUT', /^\/api\/sessions\/[^/]+\/(?:title|remote|model|profile-pin)$/],
  // D80: Undo a turn (the checkpoints, the confirm dialog's plan, revert, Redo): normal use, with the confirm.
  ['GET', /^\/api\/sessions\/[^/]+\/checkpoints(?:\/[^/]+)?$/],
  ['POST', /^\/api\/sessions\/[^/]+\/checkpoints\/(?:redo|[^/]+\/revert)$/],
  // Todos.
  ['GET', /^\/api\/todos$/],
  ['POST', /^\/api\/sessions\/[^/]+\/todos(?:\/clear-done)?$/],
  ['PUT|DELETE', /^\/api\/sessions\/[^/]+\/todos\/[^/]+$/],
  // D75: ▶ Start (normal use: in progress + the start message); D76: ▸ Run in new session (normal use: a new session for the item).
  ['POST', /^\/api\/sessions\/[^/]+\/todos\/[^/]+\/(?:start|run)$/],
  // D79: review cards: the list, Merge (local only), Open PR, Commit, Send back, Dismiss (normal use from the phone).
  ['GET', /^\/api\/reviews$/],
  ['POST', /^\/api\/reviews\/[^/]+\/(?:merge|open-pr|commit|send-back|dismiss)$/],
  // D81: quick capture (the palette, a chat selection, the share sheet's page).
  ['POST', /^\/api\/sessions\/[^/]+\/todos\/capture$/],
  // Inbox and answers.
  ['GET', /^\/api\/inbox$/],
  ['POST', /^\/api\/inbox\/[^/]+\/actions\/[^/]+$/],
  ['POST', /^\/api\/questions\/batch\/[^/]+\/answers$/],
  // Starting a session: folders (read), models, solutions, the branching preflight, staged attachments, artifacts.
  ['GET', /^\/api\/folders(?:\/check)?$/],
  ['GET', /^\/api\/(?:models|solutions|artifacts)$/],
  ['GET', /^\/api\/solutions\/[^/]+\/branches$/],
  ['POST', /^\/api\/branching\/preflight$/],
  ['POST', /^\/api\/attachments$/],
  // Sidebar layout.
  ['GET', /^\/api\/sidebar$/],
  ['POST', /^\/api\/sidebar\/(?:folders|place)$/],
  ['PUT', /^\/api\/sidebar\/folders\/[^/]+(?:\/position)?$/],
  ['DELETE', /^\/api\/sidebar\/folders\/[^/]+$/],
  // History and Continue.
  ['GET', /^\/api\/history$/],
  ['POST', /^\/api\/history\/[^/]+\/continue$/],
  ['POST', /^\/api\/history\/cli\/[^/]+\/[^/]+\/continue$/],
  // Schedules and loops.
  ['GET|POST', /^\/api\/schedules$/],
  ['POST', /^\/api\/schedules\/[^/]+\/(?:run|pause|resume)$/],
  ['DELETE', /^\/api\/schedules\/[^/]+$/],
  ['GET', /^\/api\/terminal-(?:loops|sessions)$/],
  ['POST', /^\/api\/terminal-sessions\/[^/]+\/hook$/],
  // Reads the UI needs (status, usage, settings, lists) and the UI preferences.
  ['GET', /^\/api\/(?:system|settings|clis|accounts|machines|tools|setup|service|hooks|updates|codebase-memory|frame-helper|mcp)$/],
  ['GET', /^\/api\/mcp\/(?:servers|cli)\/[^/]+$/],
  ['GET', /^\/api\/frame-helper\/check$/],
  ['PUT', /^\/api\/settings$/],
  ['POST', /^\/api\/tools\/[^/]+\/probe$/],
  // A paired machine's Reconnect.
  ['POST', /^\/api\/machines\/[^/]+\/reconnect$/],
  // D85: the tutorial (one state per machine; reading it and marking a tour seen is normal use).
  ['GET', /^\/api\/tutorial$/],
  ['PUT', /^\/api\/tutorial\/tours\/[^/]+$/],
  // This device: who is asking, its name and notifications.
  ['GET|PUT', /^\/api\/device$/],
  ['PUT|DELETE', /^\/api\/device\/push$/],
  ['POST', /^\/api\/device\/push\/test$/],
  // D87: this device's open page says whether it is in front (no system notifications meanwhile).
  ['PUT', /^\/api\/device\/presence$/],
];

/**
 * The routes refused to a device, listed so every route is classified (anything
 * not on {@link DEVICE_ALLOWED} is refused anyway): machine administration and
 * the flows that act on this computer itself.
 */
export const DEVICE_REFUSED: readonly DeviceRule[] = [
  // Devices: pairing others, revoking, the access switch.
  ['*', /^\/api\/devices(?:\/.*)?$/],
  // Paired machines: pairing, adding, removing, renaming, listener, shared layout.
  ['POST', /^\/api\/machines(?:\/pairing-code)?$/],
  ['PUT', /^\/api\/machines\/[^/]+(?:\/sidebar-sync)?$/],
  ['DELETE', /^\/api\/machines\/[^/]+$/],
  // Terminal hooks install / remove.
  ['POST', /^\/api\/hooks\/(?:install|remove)$/],
  // MCP servers: edits, toggles, reconnects, checks, sign-ins.
  [WRITE, /^\/api\/mcp\/servers(?:\/.*)?$/],
  ['*', /^\/api\/mcp\/(?:auth|check)(?:\/.*)?$/],
  [WRITE, /^\/api\/mcp\/cli\/[^/]+\/servers(?:\/.*)?$/],
  // Updates, Start at login.
  [WRITE, /^\/api\/updates\/.+$/],
  ['PUT', /^\/api\/service$/],
  // CLIs: command overrides, the default, checks.
  [WRITE, /^\/api\/clis\/.+$/],
  // Account profiles and their sign-ins.
  ['*', /^\/api\/accounts\/.+$/],
  // Embedded tools' URLs, the frame helper's openers.
  ['PUT', /^\/api\/tools$/],
  [WRITE, /^\/api\/frame-helper\/.+$/],
  // Saved folders, the setup wizard (Browse… lists the file system).
  [WRITE, /^\/api\/folders(?:\/.*)?$/],
  ['*', /^\/api\/setup\/.+$/],
  // Take-over between machines (D65).
  ['*', /^\/api\/takeover(?:\/.*)?$/],
  // Terminal handoff, teleport, solution isolation, codebase-memory reindex.
  ['POST', /^\/api\/sessions\/[^/]+\/(?:attach|detach)$/],
  ['POST', /^\/api\/sessions\/teleport$/],
  ['POST', /^\/api\/solutions\/[^/]+\/isolate$/],
  ['POST', /^\/api\/codebase-memory\/reindex$/],
  // D84: Clean-up (desktop only).
  ['*', /^\/api\/cleanup(?:\/.*)?$/],
  // Test hooks.
  ['*', /^\/api\/test(?:\/.*)?$/],
  // D79: a review's Discard (drops the changes) and Clean up (removes the worktree and its branch): desktop only.
  ['POST', /^\/api\/reviews\/[^/]+\/(?:discard|cleanup)$/],
];

/** The paired-machine proxy (`/api/machines/{id}/api/<rest>`): judged by its `<rest>`. */
export const DEVICE_PROXY = /^\/api\/machines\/[^/]+\/api\/(.*)$/;

/** The path of a URL (no query), percent-decoded, repeated slashes collapsed; `null` when it cannot be decoded. */
export function normalizedPath(url: string): string | null {
  const cut = url.indexOf('?');
  const raw = cut < 0 ? url : url.slice(0, cut);
  try {
    return decodeURIComponent(raw).replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}

/** `true` when `method path` matches one of `rules` (HEAD counts as GET). */
export function matchesRule(rules: readonly DeviceRule[], method: string, pathname: string): boolean {
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return rules.some(([methods, pattern]) => (methods === '*' || methods.split('|').includes(verb)) && pattern.test(pathname));
}

/**
 * `true` when a paired device may not make this request: an `/api` path not on
 * {@link DEVICE_ALLOWED} (a proxied request is judged by its `<rest>`; a proxy
 * inside a proxy is refused). A path that cannot be decoded is refused.
 * Non-`/api` paths (pages, files, `/hub`) are not judged here.
 */
export function isLocalOnly(method: string, url: string): boolean {
  let pathname = normalizedPath(url);
  if (pathname === null) return true;
  const proxied = DEVICE_PROXY.exec(pathname);
  if (proxied) {
    pathname = `/api/${proxied[1]}`;
    if (DEVICE_PROXY.test(pathname)) return true;
  }
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
  return !matchesRule(DEVICE_ALLOWED, method, pathname);
}
