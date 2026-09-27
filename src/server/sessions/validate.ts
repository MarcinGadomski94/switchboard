import type { NewSession } from '../../core/api.ts';
import { COORDINATIONS, PHASES, QA_STACKS, SESSION_MODES, WORK_TYPES, isOneOf } from '../../core/model.ts';

/** One validation failure of a request body. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** Result of {@link validateNewSession}. */
export type NewSessionValidation = { readonly ok: true; readonly value: NewSession } | { readonly ok: false; readonly errors: FieldError[] };

/** What the validation needs to know beyond the body. */
export interface NewSessionChecks {
  /** `true` if a session with this name exists. */
  readonly nameTaken: (name: string) => Promise<boolean>;
  /**
   * `true` if the router marks this solution read-only. The static layout check
   * ({@link isReadOnlyByLayout}) always applies; the workspace scan (M6.1) can add more.
   */
  readonly readOnly?: (solution: string) => Promise<boolean>;
}

/** Session names: kebab-case (contract), at most 64 characters. */
export const SESSION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `deprecated/**` and `infrastructure/` are read-only in the workspace router
 * (ARCHITECTURE → *Workspace rules*): a solution named by such a path, or the
 * folder names themselves, can never be a write target.
 */
export function isReadOnlyByLayout(solution: string): boolean {
  const first = solution.replace(/\\/g, '/').split('/').filter(Boolean)[0] ?? '';
  return first === 'deprecated' || first === 'infrastructure';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a `POST /api/sessions` body (contract → NewSession): name unique and
 * kebab-case; solutions not empty; read-only solutions rejected; `qa` required
 * when `workType` is `qa`; every enum from the contract. Unknown fields are ignored.
 */
export async function validateNewSession(body: unknown, checks: NewSessionChecks): Promise<NewSessionValidation> {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string): void => {
    errors.push({ field, message });
  };
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be a NewSession object' }] };

  const name = body['name'];
  if (typeof name !== 'string' || !SESSION_NAME.test(name) || name.length > 64) {
    fail('name', 'the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters');
  } else if (await checks.nameTaken(name)) {
    fail('name', `a session named "${name}" already exists`);
  }

  const task = body['task'] ?? '';
  if (typeof task !== 'string') fail('task', 'the task must be text');

  const workType = body['workType'];
  if (!isOneOf(WORK_TYPES, workType)) fail('workType', `workType must be one of ${WORK_TYPES.join(', ')}`);
  const mode = body['mode'];
  if (!isOneOf(SESSION_MODES, mode)) fail('mode', `mode must be one of ${SESSION_MODES.join(', ')}`);
  const phase = body['phase'];
  if (!isOneOf(PHASES, phase)) fail('phase', `phase must be one of ${PHASES.join(', ')}`);
  const coordination = body['coordination'] ?? null;
  if (coordination !== null && !isOneOf(COORDINATIONS, coordination)) {
    fail('coordination', `coordination must be null or one of ${COORDINATIONS.join(', ')}`);
  }

  const solutions = body['solutions'];
  if (!Array.isArray(solutions) || solutions.length === 0) {
    fail('solutions', 'choose at least one solution');
  } else if (!solutions.every((s): s is string => typeof s === 'string' && s.trim() !== '' && s === s.trim())) {
    fail('solutions', 'every solution must be a non-empty name');
  } else if (new Set(solutions).size !== solutions.length) {
    fail('solutions', 'a solution is listed twice');
  } else {
    for (const solution of solutions) {
      if (solution.split(/[\\/]/).includes('..') || solution.startsWith('/') || /^[A-Za-z]:/.test(solution)) {
        fail('solutions', `"${solution}" is not a workspace solution`);
      } else if (isReadOnlyByLayout(solution) || (checks.readOnly && (await checks.readOnly(solution)))) {
        fail('solutions', `"${solution}" is read-only and cannot be a write target`);
      }
    }
  }

  let qa: NewSession['qa'] = null;
  const rawQa = body['qa'];
  if (workType === 'qa' || (rawQa !== undefined && rawQa !== null)) {
    if (!isRecord(rawQa)) {
      if (workType === 'qa') fail('qa', 'qa is required for a QA session');
    } else {
      const stack = rawQa['stack'];
      const confluenceUrl = rawQa['confluenceUrl'] ?? '';
      const figmaUrls = rawQa['figmaUrls'] ?? [];
      if (!isOneOf(QA_STACKS, stack)) fail('qa.stack', `qa.stack must be one of ${QA_STACKS.join(', ')}`);
      if (typeof confluenceUrl !== 'string') fail('qa.confluenceUrl', 'qa.confluenceUrl must be text');
      if (!Array.isArray(figmaUrls) || !figmaUrls.every((u) => typeof u === 'string')) fail('qa.figmaUrls', 'qa.figmaUrls must be a list of URLs');
      if (isOneOf(QA_STACKS, stack) && typeof confluenceUrl === 'string' && Array.isArray(figmaUrls)) {
        qa = { stack, confluenceUrl, figmaUrls: figmaUrls as string[] };
      }
    }
  }

  const worktrees = body['worktrees'];
  if (typeof worktrees !== 'boolean') fail('worktrees', 'worktrees must be true or false');
  const ultracode = body['ultracode'];
  if (typeof ultracode !== 'boolean') fail('ultracode', 'ultracode must be true or false');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name as string,
      task: task as string,
      workType: workType as NewSession['workType'],
      mode: mode as NewSession['mode'],
      solutions: solutions as string[],
      phase: phase as NewSession['phase'],
      coordination: coordination as NewSession['coordination'],
      qa: workType === 'qa' ? qa : null,
      worktrees: worktrees as boolean,
      ultracode: ultracode as boolean,
    },
  };
}
