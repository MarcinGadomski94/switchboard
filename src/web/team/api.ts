import type { TeamHandoff, TeamMember, TeamMoveRun, TeamNeedsYouItem, TeamRequest, TeamState, TeamSuggestion, TeamView } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import { ApiError } from '../api/client.ts';

/**
 * D100 · the Team page's calls (contract → *Team (D100)*). Kept here rather than in
 * `api/client.ts`, so removing Team (`docs/team-removal.md`) deletes them with the
 * folder. Errors are {@link ApiError}s like the client's (`body` = `{ error, message }`).
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

/** The body of an adopt (`sessionId`) or a create (`session`). */
export interface MemberBody {
  readonly sessionId?: string;
  readonly session?: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly charter: { readonly owns: string; readonly produces: string; readonly neverDoes: string };
  readonly charterDraft?: { readonly owns: string; readonly produces: string; readonly neverDoes: string } | null;
  readonly templateId?: string | null;
  readonly rhythm?: { readonly loopIds: readonly string[]; readonly onHandoff: boolean };
  readonly budget?: { readonly dailyPct: number | null; readonly profileId: string | null };
  readonly gates?: readonly string[];
  readonly model?: string | null;
  readonly effort?: string | null;
}

/** `POST /api/team/members/{id}/move/check`. */
export interface MoveCheck {
  readonly ok: boolean;
  readonly blockers: readonly string[];
  readonly preview: unknown;
}

/** The Team routes. */
export const teamApi = {
  state: () => call<TeamState>('GET', '/api/team/state'),
  view: () => call<TeamView>('GET', '/api/team'),
  rename: (name: string) => call<TeamView>('PUT', '/api/team', { name }),
  reorder: (memberIds: readonly string[]) => call<TeamView>('PUT', '/api/team/order', { memberIds }),
  templates: () => call<TeamTemplate[]>('GET', '/api/team/templates'),
  suggestions: () => call<TeamSuggestion[]>('GET', '/api/team/suggestions'),
  needsYou: () => call<TeamNeedsYouItem[]>('GET', '/api/team/needs-you'),
  addMember: (body: MemberBody) => call<TeamMember>('POST', '/api/team/members', body),
  updateMember: (id: string, body: Partial<Omit<MemberBody, 'sessionId' | 'session'>>) => call<TeamMember>('PUT', `/api/team/members/${enc(id)}`, body),
  pause: (id: string) => call<TeamMember>('POST', `/api/team/members/${enc(id)}/pause`),
  resume: (id: string) => call<TeamMember>('POST', `/api/team/members/${enc(id)}/resume`),
  returnMember: (id: string) => call<{ readonly sessionId: string }>('POST', `/api/team/members/${enc(id)}/return`),
  moveCheck: (id: string, targetMachineId: string) => call<MoveCheck>('POST', `/api/team/members/${enc(id)}/move/check`, { targetMachineId }),
  move: (id: string, targetMachineId: string) => call<TeamMoveRun>('POST', `/api/team/members/${enc(id)}/move`, { targetMachineId }),
  moveRun: (runId: string) => call<TeamMoveRun>('GET', `/api/team/moves/${enc(runId)}`),
  handoff: (to: string, brief: string, expected: string) => call<TeamHandoff>('POST', '/api/team/handoffs', { to, brief, expected }),
  decide: (requestId: string, decision: 'approve' | 'decline' | 'dismiss') => call<TeamRequest>('POST', `/api/team/requests/${enc(requestId)}/${decision}`),
};

/** A readable line for a refused call (`message` of the error body, else the status). */
export function refusalText(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown; errors?: Array<{ message?: unknown }> } | null;
    const detail = Array.isArray(body?.errors) ? body.errors.map((e) => (typeof e.message === 'string' ? e.message : '')).filter(Boolean).join('; ') : '';
    if (body && typeof body.message === 'string') return detail && !body.message.includes(detail) ? `${body.message}: ${detail}` : body.message;
    if (error.unreachable) return 'Switchboard is not reachable.';
    return `The request failed (HTTP ${error.status}).`;
  }
  return error instanceof Error ? error.message : String(error);
}
