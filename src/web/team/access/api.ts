import type { AccessSharedServer, AccessTestResult, TeamAccessEntryView, TeamAccessView } from '../../../core/team-access.ts';
import type { AccessCatalogEntry } from '../../../core/team-access-catalog.ts';
import type { TeamRequest } from '../../../core/team.ts';

/**
 * D100-T2 · the Access tab's calls (contract → *Team access (D100-T2)*). Values are
 * sent only in `setUp`'s body, over the page's own origin, and never come back.
 */

/** A refused call: the HTTP status and the server's `{ error, message, errors? }`. */
export class AccessApiError extends Error {
  override name = 'AccessApiError';
  readonly status: number;
  readonly code: string | null;
  readonly errors: ReadonlyArray<{ readonly field: string; readonly message: string }>;
  constructor(status: number, body: unknown) {
    const b = (body ?? {}) as { error?: unknown; message?: unknown; errors?: unknown };
    super(typeof b.message === 'string' ? b.message : `HTTP ${status}`);
    this.status = status;
    this.code = typeof b.error === 'string' ? b.error : null;
    this.errors = Array.isArray(b.errors) ? (b.errors as Array<{ field: string; message: string }>) : [];
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new AccessApiError(response.status, parsed);
  return parsed as T;
}

const enc = encodeURIComponent;

/** What a setup sends: the values of exactly the declared fields, plus a custom server, a shared server or an expiry. */
export interface AccessSetupBody {
  readonly values: Readonly<Record<string, string>>;
  readonly server?: { readonly transport: 'stdio' | 'http'; readonly command?: string; readonly args?: readonly string[]; readonly url?: string; readonly headers?: Readonly<Record<string, string>> };
  readonly shared?: AccessSharedServer;
  readonly expiresAt?: string | null;
  /** D146 "Set up here too": this computer's keychain, not the one of the computer the member runs on (the default). */
  readonly here?: boolean;
}

/** A server of the MCP page that can be shared. */
export interface ShareableServer {
  readonly name: string;
  readonly scope: AccessSharedServer['scope'];
  readonly transport: string;
  readonly command: string | null;
  readonly url: string | null;
}

/** The calls. */
export const accessApi = {
  view: (memberId: string) => call<TeamAccessView>('GET', `/api/team/members/${enc(memberId)}/access`),
  shareable: (memberId: string) => call<ShareableServer[]>('GET', `/api/team/members/${enc(memberId)}/access/shareable`),
  catalog: () => call<AccessCatalogEntry[]>('GET', '/api/team/access/catalog'),
  setUp: (accessId: string, body: AccessSetupBody) => call<TeamAccessEntryView>('POST', `/api/team/access/${enc(accessId)}/setup`, body),
  /** D146: on the computer the member runs on (its values), or with `here` on this one (a "Set up here too" copy). */
  test: (accessId: string, here = false) => call<AccessTestResult>('POST', `/api/team/access/${enc(accessId)}/test`, here ? { here: true } : {}),
  revoke: (accessId: string) => call<TeamAccessEntryView>('POST', `/api/team/access/${enc(accessId)}/revoke`),
  setExpiry: (accessId: string, expiresAt: string | null) => call<TeamAccessEntryView>('PUT', `/api/team/access/${enc(accessId)}`, { expiresAt }),
  /** Needs you: Deny (`decline`) / Not now (`dismiss`). */
  decide: (requestId: string, decision: 'decline' | 'dismiss' | 'approve') => call<TeamRequest>('POST', `/api/team/requests/${enc(requestId)}/${decision}`),
};
