/**
 * D73 (`docs/devices.md` → *What a device may not do*, `docs/security.md`): the
 * routes a paired device is refused (403 `local-only`) although this machine's
 * own UI may use them. A paired device has the local UI's capabilities for the
 * work itself (sessions, Inbox, answers, schedules, todos, history, …); what stays
 * on this machine is administering the machine and Switchboard:
 *
 * - pairing, renaming or revoking devices, and the device access switch (`/api/devices*`);
 * - paired machines: pairing, adding, removing, renaming, the peer listener, the
 *   shared-layout switch (D48 / D71 writes under `/api/machines*`; reading and
 *   Reconnect stay allowed);
 * - installing or removing the terminal hooks (they edit the CLI's settings file);
 * - MCP server edits, toggles and sign-ins (Claude Code's and the other CLIs');
 * - updating / restarting Switchboard and its update checks (`/api/updates/*` writes);
 * - Start at login (`PUT /api/service`);
 * - the CLIs' command overrides (which executable sessions run) and the account
 *   profiles (adding, removing, signing in or out, their rules and order);
 * - the embedded tools' URLs (their framing proxies) and the frame-helper setup
 *   (opens apps on this machine);
 * - adding or removing saved folders and the setup wizard (its Browse… lists this
 *   machine's file system);
 * - taking a session over to / from a paired machine (D65: stops terminals, moves files);
 * - the test hooks.
 *
 * A request to a paired machine's API through `/api/machines/{id}/api/<rest>` is
 * judged by `/api/<rest>` (so a peer's MCP edits stay local-only too).
 */

/** One rule: method (`*` = any) and path pattern (no query). */
export type LocalOnlyRule = readonly [method: string, path: RegExp];

/** The local-only routes (see the module comment). Anything not listed is allowed. */
export const LOCAL_ONLY_RULES: readonly LocalOnlyRule[] = [
  // Devices: pairing others, revoking, the access switch.
  ['*', /^\/api\/devices(?:\/.*)?$/],
  // Paired machines (D48 / D71): every write but Reconnect.
  ['POST', /^\/api\/machines(?:\/pairing-code)?$/],
  ['PUT', /^\/api\/machines\/.+$/],
  ['DELETE', /^\/api\/machines\/[^/]+$/],
  // Terminal hooks (D48 P4): install / remove edit the CLI's settings.
  ['POST', /^\/api\/hooks\/(?:install|remove)$/],
  // MCP servers (D61, D62 P7): edits, toggles, sign-ins.
  ['POST', /^\/api\/mcp\/servers(?:\/[^/]+\/(?:toggle|auth))?$/],
  ['PUT', /^\/api\/mcp\/servers\/[^/]+$/],
  ['DELETE', /^\/api\/mcp\/servers\/[^/]+$/],
  ['*', /^\/api\/mcp\/auth(?:\/.*)?$/],
  ['POST', /^\/api\/mcp\/cli\/[^/]+\/servers$/],
  ['DELETE', /^\/api\/mcp\/cli\/[^/]+\/servers\/[^/]+$/],
  // Updates (D55): install / restart, checks, dismiss.
  ['POST', /^\/api\/updates(?:\/.*)?$/],
  ['PUT', /^\/api\/updates(?:\/.*)?$/],
  // Start at login (M9.1).
  ['PUT', /^\/api\/service$/],
  ['POST', /^\/api\/service(?:\/.*)?$/],
  // CLIs (D62): which executable runs.
  ['PUT', /^\/api\/clis\/[^/]+\/command$/],
  // Account profiles (D63): add / remove / sign in / out / rules / order (a session's account switch stays allowed).
  ['POST', /^\/api\/accounts(?:\/.*)?$/],
  ['PUT', /^\/api\/accounts(?:\/.*)?$/],
  ['DELETE', /^\/api\/accounts(?:\/.*)?$/],
  // Embedded tools (D15) and the frame helper (D35).
  ['PUT', /^\/api\/tools$/],
  ['POST', /^\/api\/frame-helper(?:\/.*)?$/],
  // Saved folders (D14) and the setup wizard (M5.3).
  ['POST', /^\/api\/folders$/],
  ['DELETE', /^\/api\/folders\/[^/]+$/],
  ['*', /^\/api\/setup\/folders$/],
  ['POST', /^\/api\/setup(?:\/.*)?$/],
  // Take-over between machines (D65).
  ['*', /^\/api\/takeover(?:\/.*)?$/],
  // Test hooks.
  ['*', /^\/api\/test(?:\/.*)?$/],
];

/** The path of a URL (no query), percent-decoded; `null` when it cannot be decoded. */
function pathOf(url: string): string | null {
  const cut = url.indexOf('?');
  const raw = cut < 0 ? url : url.slice(0, cut);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** `/api/machines/{id}/api/<rest>` → `/api/<rest>` (judged like a local call); anything else as it is. */
function judgedPath(pathname: string): string {
  const match = /^\/api\/machines\/[^/]+\/api\/(.*)$/.exec(pathname);
  return match ? `/api/${match[1]}` : pathname;
}

/**
 * `true` when a paired device may not make this request (D73). A path that cannot
 * be decoded counts as local-only. Matching is on the decoded path, with repeated
 * slashes collapsed, so `%2F` or `//` cannot slip past a rule.
 */
export function isLocalOnly(method: string, url: string, rules: readonly LocalOnlyRule[] = LOCAL_ONLY_RULES): boolean {
  const decoded = pathOf(url);
  if (decoded === null) return true;
  const pathname = judgedPath(decoded.replace(/\/{2,}/g, '/'));
  const verb = method.toUpperCase();
  return rules.some(([allowed, pattern]) => (allowed === '*' || allowed === verb) && pattern.test(pathname));
}
