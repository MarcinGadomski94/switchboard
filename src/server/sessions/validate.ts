import type { NewSession, SessionModelOption } from '../../core/api.ts';
import { MODEL_VALUE_MAX, checkModelChoice, normalizeEffort, normalizeModel } from '../../core/model-choice.ts';
import { checkTitle } from '../../core/session-title.ts';
import { checkTicketBranch } from '../../core/ticket-branch.ts';
import { COORDINATIONS, type FolderKind, PHASES, type Phase, QA_STACKS, SESSION_MODES, type SessionMode, WORK_TYPES, type WorkType, isOneOf } from '../../core/model.ts';

/** One validation failure of a request body. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * A validated NewSession (D14: without `folder`, which the caller resolved; the
 * router-only fields `workType`, `mode`, `phase` are `null` for a repo folder).
 * D22: `title` is present (trimmed) only when the body had one. D32: `branch` is
 * present only when the session creates worktrees under the ticket rule. D42:
 * `model` and `effort` are both present (normalized, `null` = the CLI's default)
 * only when the body named either.
 */
export type ValidNewSession = Omit<NewSession, 'workType' | 'mode' | 'phase' | 'folder'> & {
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
};

/** Result of {@link validateNewSession}. */
export type NewSessionValidation = { readonly ok: true; readonly value: ValidNewSession } | { readonly ok: false; readonly errors: FieldError[] };

/** The folder a NewSession starts in, as the validation needs it (D14). */
export interface ValidationFolder {
  readonly kind: FolderKind;
  /** A repo folder's one solution (its name). */
  readonly repoName: string;
}

/**
 * How a new session's worktree branch is named (D32): `ticket` = the developer
 * names it (`NewSession.branch`, required with `worktrees: true`, a ticket
 * branch); `session` = `session/{name}` as before, `branch` is not read
 * (scheduled runs and their templates, D32 *Unchanged*).
 */
export type WorktreeBranchRule = 'ticket' | 'session';

/** What the validation needs to know beyond the body. */
export interface NewSessionChecks {
  /** `true` if a session with this name exists. */
  readonly nameTaken: (name: string) => Promise<boolean>;
  /**
   * `true` if the router marks this solution read-only. The static layout check
   * ({@link isReadOnlyByLayout}) always applies; the workspace scan (M6.1) can add more.
   * Workspace folders only (D14).
   */
  readonly readOnly?: (solution: string) => Promise<boolean>;
  /** The session's folder (D14). Default: a workspace. */
  readonly folder?: ValidationFolder;
  /** D32: how the worktree branch is named. Default: `ticket`. */
  readonly worktreeBranch?: WorktreeBranchRule;
  /**
   * D42: the latest model list any claude process reported (the service's
   * `models.options`): `model` / `effort` are checked against it like D31's
   * route (`checkModelChoice`); absent or `null` = unknown (D31's rules: any
   * model name, one of the CLI's effort levels).
   */
  readonly modelOptions?: readonly SessionModelOption[] | null;
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
 * D22: the optional `title`: omitted or `null` = none; otherwise text of 1–80
 * characters once trimmed (`checkTitle`), else a failure on field `title`.
 */
function titleOf(body: Record<string, unknown>, fail: (field: string, message: string) => void): string | null {
  const raw = body['title'];
  if (raw === undefined || raw === null) return null;
  const check = checkTitle(raw);
  if (check.ok) return check.title;
  fail('title', check.message);
  return null;
}

/**
 * D32: the worktree branch. Under the `ticket` rule with `worktrees: true`, the
 * body's `branch` must pass `checkTicketBranch` (else a failure on field
 * `branch`); without a worktree, or under the `session` rule, it is not read.
 */
function branchOf(body: Record<string, unknown>, worktrees: unknown, checks: NewSessionChecks, fail: (field: string, message: string) => void): string | null {
  if ((checks.worktreeBranch ?? 'ticket') !== 'ticket' || worktrees !== true) return null;
  const check = checkTicketBranch(body['branch']);
  if (check.ok) return check.name;
  fail('branch', check.message);
  return null;
}

/**
 * D42: the optional `model` / `effort` (each text of at most {@link MODEL_VALUE_MAX}
 * characters, or `null`; normalized: blank / `default` = `null`), checked like
 * D31's route against {@link NewSessionChecks.modelOptions} (`checkModelChoice`),
 * else a failure on that field. `null` when the body names neither (the session
 * starts on the CLI's defaults and is no "choice").
 */
function modelOf(body: Record<string, unknown>, checks: NewSessionChecks, fail: (field: string, message: string) => void): { readonly model: string | null; readonly effort: string | null } | null {
  const rawModel = body['model'];
  const rawEffort = body['effort'];
  if (rawModel === undefined && rawEffort === undefined) return null;
  let ok = true;
  for (const [field, raw] of [
    ['model', rawModel],
    ['effort', rawEffort],
  ] as const) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.length <= MODEL_VALUE_MAX)) continue;
    fail(field, `${field} must be text of at most ${MODEL_VALUE_MAX} characters, or null for the CLI default`);
    ok = false;
  }
  if (!ok) return null;
  const choice = { model: normalizeModel((rawModel as string | null | undefined) ?? null), effort: normalizeEffort((rawEffort as string | null | undefined) ?? null) };
  const problem = checkModelChoice(choice, checks.modelOptions ?? null);
  if (problem) {
    fail(problem.field, problem.message);
    return null;
  }
  return choice;
}

/**
 * Validates a `POST /api/sessions` body (contract → NewSession): name unique and
 * kebab-case; D38: solutions may be empty or omitted (the agent determines
 * them), a non-empty list is checked as before; read-only solutions rejected; `qa` required
 * when `workType` is `qa`; every enum from the contract; D22: an optional `title`
 * of 1–80 characters (trimmed); D32: with `worktrees: true` a ticket `branch`
 * ({@link branchOf}); D42: an optional `model` / `effort` ({@link modelOf}).
 * Unknown fields (and `folder`, which the caller resolves) are ignored.
 *
 * D14, a **repo** folder ({@link NewSessionChecks.folder}): the router-only
 * fields (`workType`, `mode`, `phase`, `coordination`, `qa`) are not read and come
 * back `null`; `solutions` may be empty or omitted and becomes `[repoName]`; any
 * other solution is refused.
 */
export async function validateNewSession(body: unknown, checks: NewSessionChecks): Promise<NewSessionValidation> {
  if (checks.folder?.kind === 'repo') return validateRepoSession(body, checks, checks.folder.repoName);
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
  const title = titleOf(body, fail);

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

  // D38: a workspace session may start without solutions (empty or omitted): the agent determines them.
  const solutions = body['solutions'] ?? [];
  if (!Array.isArray(solutions)) {
    fail('solutions', 'solutions must be a list of solution names');
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
  const branch = branchOf(body, worktrees, checks, fail);
  const ultracode = body['ultracode'];
  if (typeof ultracode !== 'boolean') fail('ultracode', 'ultracode must be true or false');
  const model = modelOf(body, checks, fail);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name as string,
      task: task as string,
      workType: workType as WorkType,
      mode: mode as SessionMode,
      solutions: solutions as string[],
      phase: phase as Phase,
      coordination: coordination as NewSession['coordination'],
      qa: workType === 'qa' ? qa : null,
      worktrees: worktrees as boolean,
      ultracode: ultracode as boolean,
      ...(title !== null ? { title } : {}),
      ...(branch !== null ? { branch } : {}),
      ...(model ?? {}),
    },
  };
}

/** The fields every folder kind validates the same way: name, task, worktrees, ultracode (D22: and the title; D32: the branch; D42: the model and effort). */
async function commonFields(body: Record<string, unknown>, checks: NewSessionChecks, fail: (field: string, message: string) => void) {
  const name = body['name'];
  if (typeof name !== 'string' || !SESSION_NAME.test(name) || name.length > 64) {
    fail('name', 'the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters');
  } else if (await checks.nameTaken(name)) {
    fail('name', `a session named "${name}" already exists`);
  }
  const task = body['task'] ?? '';
  if (typeof task !== 'string') fail('task', 'the task must be text');
  const worktrees = body['worktrees'];
  if (typeof worktrees !== 'boolean') fail('worktrees', 'worktrees must be true or false');
  const branch = branchOf(body, worktrees, checks, fail);
  const ultracode = body['ultracode'];
  if (typeof ultracode !== 'boolean') fail('ultracode', 'ultracode must be true or false');
  const title = titleOf(body, fail);
  const model = modelOf(body, checks, fail);
  return { name, task, worktrees, ultracode, title, branch, model };
}

/** {@link validateNewSession} for a repo folder (D14): one solution, no router fields. */
async function validateRepoSession(body: unknown, checks: NewSessionChecks, repoName: string): Promise<NewSessionValidation> {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string): void => {
    errors.push({ field, message });
  };
  if (!isRecord(body)) return { ok: false, errors: [{ field: '', message: 'the body must be a NewSession object' }] };
  const { name, task, worktrees, ultracode, title, branch, model } = await commonFields(body, checks, fail);
  const solutions = body['solutions'] ?? [];
  if (!Array.isArray(solutions) || !solutions.every((s) => typeof s === 'string')) {
    fail('solutions', 'solutions must be a list of names');
  } else if (solutions.some((s) => s !== repoName)) {
    fail('solutions', `a repo folder has one solution, ${repoName}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name as string,
      task: task as string,
      workType: null,
      mode: null,
      solutions: [repoName],
      phase: null,
      coordination: null,
      qa: null,
      worktrees: worktrees as boolean,
      ultracode: ultracode as boolean,
      ...(title !== null ? { title } : {}),
      ...(branch !== null ? { branch } : {}),
      ...(model ?? {}),
    },
  };
}
