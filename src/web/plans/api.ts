import type { Plan, PlanMergeMode, PlansState } from '../../core/plans.ts';
import { ApiError } from '../api/client.ts';

/**
 * D99 · the Plans page's calls (contract → *Plans (D99)* in
 * `docs/handoff/contracts/local-api.md`). Kept here rather than in `api/client.ts`, so
 * removing Plans (`docs/plans-removal.md`) deletes them with the folder. Errors are
 * {@link ApiError}s like the client's (`body` = `{ error, message, field? }`).
 */

const enc = encodeURIComponent;

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
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

/** The body of `POST /api/plans`. */
export interface NewPlanBody {
  readonly sourceSessionId: string;
  readonly title: string;
  /** `null` = no target branch: a plan without a merge step (D99 follow-up 2026-10-15). */
  readonly targetBranch: string | null;
  readonly baseBranch?: string;
}

/** D99 follow-up 2026-10-15: the developer's acknowledgement that agents merge straight into a protected target. */
export interface StartOptions {
  readonly allowProtectedTarget?: boolean;
}

/** The error code of a refusal (`{ error }`), `null` when there is none. */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: unknown } | null;
  return body && typeof body.error === 'string' ? body.error : null;
}

/** A refusal's text for the page: the server's `message`, else the error's. */
export function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | null;
    if (body && typeof body.message === 'string' && body.message !== '') return body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether an error says Plans is switched off (`404 plans-off`). */
export function isPlansOff(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && refusalCode(error) === 'plans-off';
}

/** The REST calls of the Plans UI. */
export const plansApi = {
  /** The switch (answered also while Plans is off). */
  state: () => call<PlansState>('GET', '/api/plans/state'),
  list: () => call<Plan[]>('GET', '/api/plans'),
  get: (id: string) => call<Plan>('GET', `/api/plans/${enc(id)}`),
  create: (body: NewPlanBody) => call<Plan>('POST', '/api/plans', body),
  update: (id: string, body: Readonly<Record<string, unknown>>) => call<Plan>('PUT', `/api/plans/${enc(id)}`, body),
  remove: (id: string) => call<null>('DELETE', `/api/plans/${enc(id)}`),
  /** D117 follow-up: cancels a running or paused plan and stops its running item sessions (server-side), then deletes it. */
  removeStopping: (id: string) => call<{ cancelled: boolean; stopped: Array<{ itemId: string; sessionId: string; outcome: string }> }>('DELETE', `/api/plans/${enc(id)}?stop=1`),
  addItem: (id: string, body: Readonly<Record<string, unknown>>) => call<{ plan: Plan; itemId: string }>('POST', `/api/plans/${enc(id)}/items`, body),
  updateItem: (id: string, itemId: string, body: Readonly<Record<string, unknown>>) => call<Plan>('PUT', `/api/plans/${enc(id)}/items/${enc(itemId)}`, body),
  removeItem: (id: string, itemId: string) => call<Plan>('DELETE', `/api/plans/${enc(id)}/items/${enc(itemId)}`),
  retryItem: (id: string, itemId: string) => call<Plan>('POST', `/api/plans/${enc(id)}/items/${enc(itemId)}/retry`),
  /** Mark done (also the developer's confirmation of a held item of a plan without a merge step). */
  markItemDone: (id: string, itemId: string) => call<Plan>('POST', `/api/plans/${enc(id)}/items/${enc(itemId)}/done`),
  /** D102: the Merge step of a ready-to-merge item (merge locally into the target; open its PR; send it back with a comment). */
  mergeItem: (id: string, itemId: string) => call<Plan>('POST', `/api/plans/${enc(id)}/items/${enc(itemId)}/merge`),
  openItemPr: (id: string, itemId: string) => call<Plan>('POST', `/api/plans/${enc(id)}/items/${enc(itemId)}/open-pr`),
  sendBackItem: (id: string, itemId: string, comment: string) => call<Plan>('POST', `/api/plans/${enc(id)}/items/${enc(itemId)}/send-back`, { comment }),
  addEdge: (id: string, from: string, to: string) => call<Plan>('POST', `/api/plans/${enc(id)}/edges`, { from, to }),
  removeEdge: (id: string, from: string, to: string) => call<Plan>('DELETE', `/api/plans/${enc(id)}/edges/${enc(from)}/${enc(to)}`),
  start: (id: string, mergeMode: PlanMergeMode, options: StartOptions = {}) => call<Plan>('POST', `/api/plans/${enc(id)}/start`, { mergeMode, ...options }),
  pause: (id: string) => call<Plan>('POST', `/api/plans/${enc(id)}/pause`),
  resume: (id: string) => call<Plan>('POST', `/api/plans/${enc(id)}/resume`),
  cancel: (id: string) => call<Plan>('POST', `/api/plans/${enc(id)}/cancel`),
  setMode: (id: string, mergeMode: PlanMergeMode, options: StartOptions = {}) => call<Plan>('PUT', `/api/plans/${enc(id)}/mode`, { mergeMode, ...options }),
  setHolds: (id: string, holds: Readonly<Record<string, boolean>>) => call<Plan>('PUT', `/api/plans/${enc(id)}/holds`, { holds }),
};
