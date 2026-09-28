/**
 * D25 (`docs/decisions.md` → *Remote sessions* → D25): continue a remote session
 * locally ("teleport"). The pure rules shared by the server (`POST
 * /api/sessions/teleport`) and the New-session form's **From a remote session**
 * option: what the developer may paste, the one id form Switchboard stores and
 * passes to `claude --teleport`, and the names a teleported session gets.
 *
 * Ids (`docs/spike-remote.md` → R.8): `session_<X>` (the v1 / URL form) and
 * `cse_<X>` (the v2 form) are the **same** session, a plain prefix swap; the
 * session's page is `https://claude.ai/code/session_<X>`.
 */

/** A remote session id as the CLI checks it (R.8, verbatim from the binary). */
export const REMOTE_SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_]+$/;

/** Where a remote session's page lives (R.8); the id follows it. */
export const REMOTE_SESSION_URL_PREFIX = 'https://claude.ai/code/';

/** The sidebar's and History's mode line of a teleported session (like D16's `terminal · moved`). */
export const REMOTE_MODE_LINE = 'remote · local copy';

/** What the session header says about a teleported session (D25). */
export const REMOTE_COPY_NOTE = "Local copy of a remote session: new work here stays local and doesn't appear in the cloud session.";

/** Characters of `<X>` a teleported session's default name and title use. */
export const REMOTE_SHORT_ID_LENGTH = 8;

/** Why a pasted value is refused (the 422 message on field `remote`). */
export const REMOTE_RULE = 'paste a claude.ai/code session URL (https://claude.ai/code/session_…) or a session_… / cse_… id';

/** Result of {@link parseRemoteSession}: the normalized id, or why the value is refused. */
export type RemoteSessionParse = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

/**
 * The remote session a pasted value names, normalized to `session_<X>` (R.8: a
 * `cse_` id is the same session with the other prefix). Accepted, surrounding
 * whitespace ignored:
 * - `https://claude.ai/code/session_<X>` (a query string, a `#…` fragment and a
 *   trailing `/` are ignored; the id may be in its `cse_` form too);
 * - `session_<X>`;
 * - `cse_<X>`.
 * Anything else is refused with {@link REMOTE_RULE}.
 */
export function parseRemoteSession(value: unknown): RemoteSessionParse {
  if (typeof value !== 'string') return { ok: false, message: REMOTE_RULE };
  const text = value.trim();
  let candidate = text;
  if (text.toLowerCase().startsWith('https://') || text.toLowerCase().startsWith('http://')) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, message: REMOTE_RULE };
    }
    if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port !== '' || url.username !== '' || url.password !== '') {
      return { ok: false, message: REMOTE_RULE };
    }
    const segments = url.pathname.replace(/\/+$/, '').split('/');
    if (segments.length !== 3 || segments[0] !== '' || segments[1] !== 'code') return { ok: false, message: REMOTE_RULE };
    candidate = segments[2] ?? '';
  }
  if (!REMOTE_SESSION_ID.test(candidate)) return { ok: false, message: REMOTE_RULE };
  return { ok: true, id: toSessionForm(candidate) };
}

/** `cse_<X>` → `session_<X>`; a `session_` id unchanged (R.8's prefix swap). */
export function toSessionForm(id: string): string {
  return id.startsWith('cse_') ? `session_${id.slice('cse_'.length)}` : id;
}

/** `<X>` of a `session_<X>` / `cse_<X>` id. */
export function remoteIdBody(id: string): string {
  return id.replace(/^(?:session|cse)_/, '');
}

/** The first {@link REMOTE_SHORT_ID_LENGTH} characters of `<X>`, as written. */
export function remoteShortId(id: string): string {
  return remoteIdBody(id).slice(0, REMOTE_SHORT_ID_LENGTH);
}

/**
 * The short name a teleported session gets when no title is typed (D25):
 * `remote-<first 8 characters of X, lower-cased>`, before any `-2`, `-3`, …
 * (the caller makes it unique with the D22 rule, `shortNameFromTitle`).
 */
export function remoteSessionBaseName(id: string): string {
  return `remote-${remoteShortId(id).toLowerCase()}`;
}

/** The title a teleported session gets when none is typed (D25): `Remote <short id>`. */
export function remoteSessionTitle(id: string): string {
  return `Remote ${remoteShortId(id)}`;
}

/** The remote session's page on claude.ai (R.8). */
export function remoteSessionUrl(id: string): string {
  return `${REMOTE_SESSION_URL_PREFIX}${toSessionForm(id)}`;
}
