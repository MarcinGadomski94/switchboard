import type { Session } from '../../../core/api.ts';
import type { Plan } from '../../../core/plans.ts';
import { onMachine } from '../../api/client.ts';
import type { JiraConnectionStatus, JiraPreview, JiraSyncMode, JiraTransitionNames, PlanEdgeProposal, PlanJiraState } from '../../../core/plans-jira.ts';

/** A refused call: the HTTP status and the answer's `error` / `message` / field errors. */
export class JiraApiError extends Error {
  override name = 'JiraApiError';
  readonly status: number;
  readonly code: string | null;
  readonly fields: Readonly<Record<string, string>>;
  constructor(status: number, code: string | null, message: string, fields: Readonly<Record<string, string>> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method, credentials: 'same-origin', headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new JiraApiError(0, null, 'Switchboard could not be reached');
  }
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const answer = (parsed ?? {}) as { error?: string; message?: string; errors?: Array<{ field: string; message: string }> };
    const fields = Object.fromEntries((answer.errors ?? []).map((entry) => [entry.field, entry.message]));
    throw new JiraApiError(response.status, answer.error ?? null, answer.message ?? `HTTP ${response.status}`, fields);
  }
  return parsed as T;
}

const enc = encodeURIComponent;

/** The body of an import (`POST /api/sessions/{id}/plans/jira/import`). */
export interface JiraImportBody {
  readonly epic: string;
  readonly targetBranch: string;
  readonly title?: string;
  readonly baseBranch?: string;
  readonly repos?: readonly string[];
  readonly sync?: JiraSyncMode;
  readonly transitions?: Partial<JiraTransitionNames>;
  /** D116: move a ticket to Done once its item is merged into the target (omitted = on). */
  readonly doneOnMerge?: boolean;
}

/**
 * D112 · the body of an import into a folder (`POST /api/plans/jira/import`): the import's, plus
 * where the plan's new session runs (that machine's saved folder, CLI, model, effort, account).
 */
export interface JiraFolderImportBody extends JiraImportBody {
  readonly folder?: string;
  readonly provider?: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly profileId?: string;
}

/** The answer of an import. */
export interface JiraImportAnswer {
  readonly plan: Plan;
  readonly jira: PlanJiraState;
  readonly preview: JiraPreview;
  readonly askedForOrder: boolean;
}

/** The Jira lane's calls (contract → *Plans · Jira (D99)*). */
export const jiraApi = {
  status: () => call<JiraConnectionStatus>('GET', '/api/integrations/jira'),
  saveCredentials: (body: { readonly baseUrl: string; readonly email: string; readonly token: string }) => call<JiraConnectionStatus>('PUT', '/api/integrations/jira', body),
  clearCredentials: () => call<JiraConnectionStatus>('DELETE', '/api/integrations/jira'),
  preview: (sessionId: string, epic: string) => call<JiraPreview>('POST', `/api/sessions/${enc(sessionId)}/plans/jira/preview`, { epic }),
  importPlan: (sessionId: string, body: JiraImportBody) => call<JiraImportAnswer>('POST', `/api/sessions/${enc(sessionId)}/plans/jira/import`, body),
  /** D112: a preview on `machine` (`null` = this one) with no session yet. */
  previewForFolder: (machine: string | null, epic: string) => call<JiraPreview>('POST', onMachine(machine, '/api/plans/jira/preview'), { epic }),
  /** D112: the import into a folder of `machine`: a new session there owns the plan. */
  importIntoFolder: (machine: string | null, body: JiraFolderImportBody) => call<JiraImportAnswer & { readonly session: Session | null }>('POST', onMachine(machine, '/api/plans/jira/import'), body),
  state: (planId: string) => call<PlanJiraState>('GET', `/api/plans/${enc(planId)}/jira`),
  update: (planId: string, body: { readonly sync?: JiraSyncMode; readonly transitions?: Partial<JiraTransitionNames>; readonly doneOnMerge?: boolean }) => call<PlanJiraState>('PUT', `/api/plans/${enc(planId)}/jira`, body),
  refresh: (planId: string) => call<PlanJiraState>('POST', `/api/plans/${enc(planId)}/jira/refresh`),
  proposals: (planId: string) => call<PlanEdgeProposal[]>('GET', `/api/plans/${enc(planId)}/proposals`),
  askForOrder: (planId: string) => call<{ readonly asked: true; readonly sessionId: string }>('POST', `/api/plans/${enc(planId)}/proposals/ask`),
  /** D115: Ask again: the plan's agent picks the repositories of the items without any. */
  askForRepos: (planId: string) => call<{ readonly asked: true; readonly sessionId: string; readonly items: number }>('POST', `/api/plans/${enc(planId)}/solutions/ask`),
  decide: (planId: string, proposalId: string | 'all', action: 'accept' | 'reject') =>
    call<{ readonly proposals: PlanEdgeProposal[]; readonly refused: ReadonlyArray<{ readonly id: string; readonly text: string; readonly reason: string }> }>(
      'POST',
      proposalId === 'all' ? `/api/plans/${enc(planId)}/proposals/${action}-all` : `/api/plans/${enc(planId)}/proposals/${enc(proposalId)}/${action}`,
    ),
};
