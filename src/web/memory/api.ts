import type { MemoryCheckSettings, MemoryCheckStatus, MemoryRemovedEntry } from '../../core/memory-check.ts';
import type { MemoryDraftAllAnswer, MemoryDraftAnswer, MemoryEntry, MemoryScope, MemoryScopeKind, MemoryScopeOption, MemorySessionCount, MemorySettings, MemoryState } from '../../core/memory.ts';
import { ApiError, keepaliveNow } from '../api/client.ts';

/**
 * D107 · the Memory page's calls (contract → *Project memory (D107)*), on this machine or, through
 * the D48 proxy (`/api/machines/{id}/api/memory/…`), on a paired machine. Kept here so removing
 * Project memory (`docs/memory-removal.md`) deletes them with the folder.
 */

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      ...(keepaliveNow() ? { keepalive: true } : {}),
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, `${method} ${path}: ${error instanceof Error ? error.message : 'network error'}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) throw new ApiError(response.status, `${method} ${path}: HTTP ${response.status}`, parsed);
  return parsed as T;
}

/** A refusal's text for the page: the server's `message`, else the error's. */
export function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string' && body.message !== '') return body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** What an entry form sends. */
export interface MemoryFields {
  readonly title?: string;
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  /** D107 follow-up 2026-10-15: who it is for (left out: unchanged; workspace for a new entry). */
  readonly scopeKind?: MemoryScopeKind;
  /** The repository's key or the member id (`repo` / `member`). */
  readonly scopeKey?: string | null;
  /** D136: approve and move the note the proposal check found (a duplicate or a conflict) to the removed list. */
  readonly removeConflicting?: boolean;
}

/** The calls on one machine: `null` = this one, else a paired machine's id (through the proxy). */
export function memoryApi(machineId: string | null) {
  const base = machineId ? `/api/machines/${encodeURIComponent(machineId)}/api/memory` : '/api/memory';
  const entry = (id: string): string => `${base}/entries/${encodeURIComponent(id)}`;
  return {
    state: () => call<MemoryState>('GET', `${base}/state`),
    scopes: () => call<MemoryScope[]>('GET', `${base}/scopes`),
    entries: (scope: string) => call<MemoryEntry[]>('GET', `${base}/entries?scope=${encodeURIComponent(scope)}`),
    add: (scope: string, fields: MemoryFields) => call<MemoryEntry>('POST', `${base}/entries`, { scope, ...fields }),
    update: (id: string, fields: MemoryFields) => call<MemoryEntry>('PUT', entry(id), fields),
    approve: (id: string, fields: MemoryFields = {}) => call<MemoryEntry>('POST', `${entry(id)}/approve`, fields),
    reject: (id: string) => call<MemoryEntry>('POST', `${entry(id)}/reject`, {}),
    remove: (id: string) => call<null>('DELETE', entry(id)),
    scopeOptions: (scope: string, entryId?: string) => call<MemoryScopeOption[]>('GET', `${base}/scope-options?scope=${encodeURIComponent(scope)}${entryId ? `&entry=${encodeURIComponent(entryId)}` : ''}`),
    sessionCount: (sessionId: string) => call<MemorySessionCount>('GET', `${base}/sessions/${encodeURIComponent(sessionId)}`),
    draft: (target: { readonly sessionId: string } | { readonly memberId: string }) => call<MemoryDraftAnswer>('POST', `${base}/draft`, target),
    draftAll: (teamId?: string) => call<MemoryDraftAllAnswer>('POST', `${base}/draft-all`, teamId ? { teamId } : {}),
    // D136: memory checks.
    removed: (scope: string) => call<MemoryRemovedEntry[]>('GET', `${base}/removed${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
    restore: (id: string) => call<MemoryEntry>('POST', `${base}/removed/${encodeURIComponent(id)}/restore`, {}),
    checkStatus: (scope: string) => call<MemoryCheckStatus>('GET', `${base}/check?scope=${encodeURIComponent(scope)}`),
    setCheckFolder: (scope: string, enabled: boolean) => call<MemoryCheckStatus>('PUT', `${base}/check`, { scope, enabled }),
    checkNow: (scope: string) => call<MemoryCheckStatus>('POST', `${base}/check/run`, { scope }),
    checkSettings: () => call<MemoryCheckSettings>('GET', `${base}/check/settings`),
    setCheckSettings: (patch: Partial<MemoryCheckSettings>) => call<MemoryCheckSettings>('PUT', `${base}/check/settings`, patch),
    settings: () => call<MemorySettings>('GET', `${base}/settings`),
    setSettings: (cap: number) => call<MemorySettings>('PUT', `${base}/settings`, { cap }),
  };
}
