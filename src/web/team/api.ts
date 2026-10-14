import type { TeamCharter, TeamHandoff, TeamMember, TeamMoveRun, TeamNeedsYouItem, TeamRequest, TeamState, TeamSuggestion, TeamSummary, TeamView } from '../../core/team.ts';
import type { TeamTemplate } from '../../core/team-templates.ts';
import type { TakeoverPreview, TargetPlacement } from '../../core/takeover.ts';
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
  /** D100 follow-up 2026-10-14: the team it joins (none = the first team). */
  readonly teamId?: string;
  readonly name: string;
  readonly charter: TeamCharter;
  readonly charterDraft?: TeamCharter | null;
  /** D105: after adopting, ask the new member's agent for a specific charter. */
  readonly askCharter?: boolean;
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
  /** The take-over's preview (`TakeoverPreview`; `null` when it could not be made). */
  readonly preview: TakeoverPreview | null;
}

/** D110: the target folders (and clone paths) a member's move uses. */
export interface MoveTarget {
  /** `null` = the target's saved folders (the remembered folders are not used); absent = the remembered ones, if any. */
  readonly placement?: TargetPlacement | null;
  readonly clonePaths?: Readonly<Record<string, string>>;
}

/** `POST /api/team/charters/ask` (D105). */
export interface CharterAskAnswer {
  readonly asked: readonly { readonly memberId: string; readonly name: string }[];
  readonly skipped: readonly { readonly memberId: string; readonly name: string; readonly reason: string }[];
}

/** The Team routes. */
export const teamApi = {
  state: () => call<TeamState>('GET', '/api/team/state'),
  view: (teamId?: string) => call<TeamView>('GET', teamId ? `/api/team?teamId=${enc(teamId)}` : '/api/team'),
  rename: (name: string, teamId?: string) => (teamId ? call<TeamView>('PUT', `/api/team/teams/${enc(teamId)}`, { name }) : call<TeamView>('PUT', '/api/team', { name })),
  reorder: (memberIds: readonly string[], teamId?: string) => call<TeamView>('PUT', '/api/team/order', { memberIds, ...(teamId ? { teamId } : {}) }),
  // D100 follow-up 2026-10-14: multiple teams.
  teams: () => call<TeamSummary[]>('GET', '/api/team/teams'),
  createTeam: (name: string) => call<TeamSummary>('POST', '/api/team/teams', { name }),
  deleteTeam: (teamId: string) => call<{ readonly ok: true; readonly returned: number }>('DELETE', `/api/team/teams/${enc(teamId)}`),
  reorderTeams: (teamIds: readonly string[]) => call<TeamSummary[]>('PUT', '/api/team/teams/order', { teamIds }),
  moveToTeam: (memberId: string, teamId: string) => call<TeamMember>('POST', `/api/team/members/${enc(memberId)}/team`, { teamId }),
  templates: () => call<TeamTemplate[]>('GET', '/api/team/templates'),
  suggestions: () => call<TeamSuggestion[]>('GET', '/api/team/suggestions'),
  needsYou: (teamId?: string) => call<TeamNeedsYouItem[]>('GET', teamId ? `/api/team/needs-you?teamId=${enc(teamId)}` : '/api/team/needs-you'),
  addMember: (body: MemberBody) => call<TeamMember>('POST', '/api/team/members', body),
  updateMember: (id: string, body: Partial<Omit<MemberBody, 'sessionId' | 'session'>>) => call<TeamMember>('PUT', `/api/team/members/${enc(id)}`, body),
  pause: (id: string) => call<TeamMember>('POST', `/api/team/members/${enc(id)}/pause`),
  resume: (id: string) => call<TeamMember>('POST', `/api/team/members/${enc(id)}/resume`),
  returnMember: (id: string) => call<{ readonly sessionId: string }>('POST', `/api/team/members/${enc(id)}/return`),
  /** D110: `choice` carries the chosen target folders (and clone paths) of the move. */
  moveCheck: (id: string, targetMachineId: string, choice: MoveTarget = {}) => call<MoveCheck>('POST', `/api/team/members/${enc(id)}/move/check`, { targetMachineId, ...choice }),
  move: (id: string, targetMachineId: string, choice: MoveTarget = {}) => call<TeamMoveRun>('POST', `/api/team/members/${enc(id)}/move`, { targetMachineId, ...choice }),
  moveRun: (runId: string) => call<TeamMoveRun>('GET', `/api/team/moves/${enc(runId)}`),
  handoff: (to: string, brief: string, expected: string) => call<TeamHandoff>('POST', '/api/team/handoffs', { to, brief, expected }),
  decide: (requestId: string, decision: 'approve' | 'decline' | 'dismiss', body?: { readonly charter?: TeamCharter }) => call<TeamRequest>('POST', `/api/team/requests/${enc(requestId)}/${decision}`, body),
  // D105: better charters.
  askCharter: (memberId: string) => call<{ readonly asked: true; readonly requestId: string }>('POST', `/api/team/members/${enc(memberId)}/charter/ask`),
  askCharters: (teamId: string, templateOnly = false) => call<CharterAskAnswer>('POST', '/api/team/charters/ask', { teamId, ...(templateOnly ? { templateOnly } : {}) }),
  dismissCharterOffer: () => call<{ readonly ok: true }>('POST', '/api/team/charters/offer/dismiss'),
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
