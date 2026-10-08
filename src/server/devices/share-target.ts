/**
 * D81 · the phone's share sheet (`docs/devices.md` → *Share to Switchboard (D81)*): on the
 * **device origin** (paired phones and tablets, D73) the installed app is a Web Share Target.
 * The manifest served there carries {@link SHARE_TARGET}; a share is a POST of `title` / `text` /
 * `url` to {@link SHARE_TARGET_ACTION}, which the service worker (or, without one, the server)
 * turns into a page load of {@link SHARE_PAGE} with the shared fields in the query: the page
 * asks "Add to which session?" and saves the item through the capture route (device-authenticated
 * like any other `/api` call). The loopback origin's manifest has no share target.
 */

/** Where the operating system POSTs a share. */
export const SHARE_TARGET_ACTION = '/share-target';

/** The page that asks which session a share goes to. */
export const SHARE_PAGE = '/share';

/** The manifest's `share_target` member (Web Share Target, level 2; no files). */
export const SHARE_TARGET = {
  action: SHARE_TARGET_ACTION,
  method: 'POST',
  enctype: 'application/x-www-form-urlencoded',
  params: { title: 'title', text: 'text', url: 'url' },
} as const;

/** Each shared field is cut to this many characters before it goes into the page's address. */
export const SHARED_FIELD_MAX = 4_000;

/** The manifest's text with {@link SHARE_TARGET} added (the text unchanged when it is not a JSON object). */
export function manifestWithShareTarget(body: string): string {
  try {
    const manifest: unknown = JSON.parse(body);
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return body;
    return `${JSON.stringify({ ...manifest, share_target: SHARE_TARGET }, null, 2)}\n`;
  } catch {
    return body;
  }
}

/** The share page's address for the shared fields (strings only, each cut to {@link SHARED_FIELD_MAX}; empty ones left out). */
export function sharePagePath(fields: Readonly<Record<string, unknown>>): string {
  const query = new URLSearchParams();
  for (const key of ['title', 'text', 'url'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim() !== '') query.set(key, value.slice(0, SHARED_FIELD_MAX));
  }
  const text = query.toString();
  return text ? `${SHARE_PAGE}?${text}` : SHARE_PAGE;
}
