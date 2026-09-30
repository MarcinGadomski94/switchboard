import type { NewSession, SessionModelOption } from '../../core/api.ts';
import { type SessionBranching, type SessionEpic, DEFAULT_EPIC_BASE, TASK_ONLY, checkBranchName, checkEpicKey, epicBranchName } from '../../core/branching.ts';
import { SIMPLE_BRANCH_EXAMPLE, simpleBranchOfName } from '../../core/simple-session.ts';
import { PARENT_RULE, effectiveParent, parentConflict, parentText, parseParent } from '../../core/stacking.ts';
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
 * present only when the session creates worktrees under the ticket rule. D40:
 * `branching` likewise, normalized ({@link SessionBranching}; a body without one
 * is a task without an epic). D42:
 * `model` and `effort` are both present (normalized, `null` = the CLI's default)
 * only when the body named either. D56: `simple` is `true` only for a simple
 * start (the router fields are `null` for a workspace too, and the first message
 * carries no answers block).
 */
export type ValidNewSession = Omit<NewSession, 'workType' | 'mode' | 'phase' | 'folder' | 'branching'> & {
  readonly workType: WorkType | null;
  readonly mode: SessionMode | null;
  readonly phase: Phase | null;
  readonly branching?: SessionBranching;
  readonly simple?: true;
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

/**
 * D59: why a Full start (and a schedule, whose runs are Full starts) is refused in
 * a plain folder: its router answers, solutions and branching need a workspace or
 * a git repository. Simple starts there.
 */
export const PLAIN_FOLDER_FULL_MESSAGE = "this folder has no AGENTS.md and isn't a git repository: start a Simple session there";

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

/** The example the D40 branch-name messages show. */
const EPIC_BRANCH_EXAMPLE = 'feature/PROJ-3010-Platform-tracking';
const BASE_EXAMPLE = DEFAULT_EPIC_BASE;
/** The longest epic summary taken (a Jira summary is at most 255 characters). */
const EPIC_SUMMARY_MAX = 255;

/**
 * D40: the branching of the worktrees (`docs/worktrees.md` → *Epic/task
 * branching (D40)*). Read under the `ticket` rule with `worktrees: true` only
 * (scheduled runs keep `session/{name}`): omitted or `null` = a task without an
 * epic ({@link TASK_ONLY}); else `epic` (`{ key, summary?, branch? }`: a ticket
 * key, text, a valid branch name or blank = derived with `epicBranchName`),
 * `base` (a valid branch name, blank = `dev`), `dropped` (solutions in scope,
 * never all of them, never a repo folder's one repo) and `bases` (solution in
 * scope and not dropped → a valid branch name). D47: `parent` (a task key or a
 * valid branch name, `parseParent`; not the task branch or its key, not the
 * epic's base; the epic branch itself or blank = not stacked, left out). Failures
 * are on fields `branching…`.
 */
function branchingOf(
  body: Record<string, unknown>,
  worktrees: unknown,
  checks: NewSessionChecks,
  solutions: readonly string[] | null,
  fail: (field: string, message: string) => void,
): SessionBranching | null {
  if ((checks.worktreeBranch ?? 'ticket') !== 'ticket' || worktrees !== true) return null;
  const raw = body['branching'];
  if (raw === undefined || raw === null) return TASK_ONLY;
  if (!isRecord(raw)) {
    fail('branching', 'branching must be an object: { epic?, base?, bases?, dropped?, parent? }');
    return null;
  }
  const state = { failed: false };
  const failHere = (field: string, message: string): void => {
    state.failed = true;
    fail(field, message);
  };

  let epic: SessionEpic | null = null;
  const rawEpic = raw['epic'];
  if (rawEpic !== undefined && rawEpic !== null) {
    if (!isRecord(rawEpic)) failHere('branching.epic', 'branching.epic must be { key, summary?, branch? }');
    else {
      const key = checkEpicKey(rawEpic['key']);
      if (!key.ok) failHere('branching.epic.key', key.message);
      const rawSummary = rawEpic['summary'] ?? '';
      const summary = typeof rawSummary === 'string' ? rawSummary.trim() : null;
      if (summary === null || summary.length > EPIC_SUMMARY_MAX) failHere('branching.epic.summary', `the epic summary must be text of at most ${EPIC_SUMMARY_MAX} characters`);
      const rawBranch = rawEpic['branch'];
      let branch: string | null = null;
      if (rawBranch === undefined || rawBranch === null || (typeof rawBranch === 'string' && rawBranch.trim() === '')) {
        branch = key.ok && summary !== null ? epicBranchName(key.name, summary) : null;
      } else {
        const check = checkBranchName(rawBranch, 'epic branch', EPIC_BRANCH_EXAMPLE);
        if (check.ok) branch = check.name;
        else failHere('branching.epic.branch', check.message);
      }
      if (key.ok && summary !== null && branch !== null) epic = { key: key.name, summary, branch };
    }
  }

  let base = DEFAULT_EPIC_BASE;
  const rawBase = raw['base'];
  if (rawBase !== undefined && rawBase !== null && !(typeof rawBase === 'string' && rawBase.trim() === '')) {
    const check = checkBranchName(rawBase, 'epic base branch', BASE_EXAMPLE);
    if (check.ok) base = check.name;
    else failHere('branching.base', check.message);
  }
  if (epic !== null && epic.branch === base) failHere('branching.epic.branch', `the epic branch cannot be its own base (${base})`);

  const inScope = (solution: string): boolean => solutions === null || solutions.includes(solution);
  let dropped: string[] = [];
  const rawDropped = raw['dropped'];
  if (rawDropped !== undefined && rawDropped !== null) {
    if (!Array.isArray(rawDropped) || !rawDropped.every((s): s is string => typeof s === 'string')) {
      failHere('branching.dropped', 'branching.dropped must be a list of solutions in scope');
    } else {
      dropped = [...new Set(rawDropped)];
      const foreign = dropped.filter((s) => !inScope(s));
      if (checks.folder?.kind === 'repo' && dropped.length > 0) failHere('branching.dropped', `a repo folder's one solution (${checks.folder.repoName}) cannot be dropped`);
      else if (foreign.length > 0) failHere('branching.dropped', `not a solution in scope: ${foreign.join(', ')}`);
      else if (solutions !== null && solutions.length > 0 && dropped.length === solutions.length) failHere('branching.dropped', 'every solution in scope is dropped: keep one, or start without solutions');
    }
  }

  const bases: Record<string, string> = {};
  const rawBases = raw['bases'];
  if (rawBases !== undefined && rawBases !== null) {
    if (!isRecord(rawBases)) failHere('branching.bases', 'branching.bases must map a solution in scope to a base branch');
    else {
      for (const [solution, value] of Object.entries(rawBases)) {
        if (!inScope(solution) || dropped.includes(solution)) {
          failHere('branching.bases', `not a solution in scope: ${solution}`);
          continue;
        }
        const check = checkBranchName(value, `base branch of ${solution}`, BASE_EXAMPLE);
        if (check.ok) bases[solution] = check.name;
        else failHere('branching.bases', check.message);
      }
    }
  }

  let parent: string | null = null;
  const rawParent = raw['parent'];
  if (rawParent !== undefined && rawParent !== null) {
    const check = typeof rawParent === 'string' ? parseParent(rawParent) : ({ ok: false, message: PARENT_RULE } as const);
    if (!check.ok) failHere('branching.parent', check.message);
    else if (check.parent !== null) {
      const task = typeof body['branch'] === 'string' && body['branch'].trim() !== '' ? body['branch'].trim() : null;
      const conflict = parentConflict(check.parent, { task, base, epic: epic?.branch ?? null });
      if (conflict !== null) failHere('branching.parent', conflict);
      else {
        const effective = effectiveParent(check.parent, epic?.branch ?? null);
        if (effective !== null) parent = parentText(effective);
      }
    }
  }
  return state.failed ? null : { epic, base, bases, dropped, ...(parent !== null ? { parent } : {}) };
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
  // D56: a simple start (the simple New-session form), in any folder kind.
  if (isRecord(body) && body['simple'] !== undefined && body['simple'] !== null && body['simple'] !== false) {
    if (body['simple'] !== true) return { ok: false, errors: [{ field: 'simple', message: 'simple must be true or false' }] };
    return validateSimpleSession(body, checks);
  }
  // D59: a plain folder (no AGENTS.md, not a git repository) takes Simple starts only.
  if (checks.folder?.kind === 'plain') return { ok: false, errors: [{ field: 'folder', message: PLAIN_FOLDER_FULL_MESSAGE }] };
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
  const branching = branchingOf(body, worktrees, checks, Array.isArray(solutions) && solutions.every((s) => typeof s === 'string') ? (solutions as string[]) : null, fail);
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
      ...(branching !== null ? { branching } : {}),
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
  // D40: the repo is the one solution the branching choices can name.
  const branching = branchingOf(body, worktrees, checks, [repoName], fail);
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
      ...(branching !== null ? { branching } : {}),
      ...(model ?? {}),
    },
  };
}

/**
 * D56: {@link validateNewSession} for a **simple** start (`simple: true`, the
 * simple New-session form, `docs/new-session.md` → *Simple mode (D56)*): the
 * name, task, title and model as for any session; no router fields, no QA, no
 * branching (all `null` / left out, whatever the body says); `solutions` empty
 * or omitted (a repo folder may name its one repo); `worktrees` and `ultracode`
 * optional (`false`). A worktree is for a **repo** folder only (422 on field
 * `worktrees` for a workspace or, D59, a plain folder: the simple form offers
 * none there); its branch is
 * any valid git branch name (no D32 ticket rule), omitted or blank =
 * `sb/<name>` ({@link simpleBranchOfName}), and it follows D40's task-only rule
 * ({@link TASK_ONLY}: cut from the origin default branch, an existing branch
 * reused). Under the `session` branch rule (scheduled runs) no branch is read.
 */
async function validateSimpleSession(body: Record<string, unknown>, checks: NewSessionChecks): Promise<NewSessionValidation> {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string): void => {
    errors.push({ field, message });
  };
  const name = body['name'];
  if (typeof name !== 'string' || !SESSION_NAME.test(name) || name.length > 64) {
    fail('name', 'the name must be kebab-case (a-z, 0-9, single dashes), at most 64 characters');
  } else if (await checks.nameTaken(name)) {
    fail('name', `a session named "${name}" already exists`);
  }
  const task = body['task'] ?? '';
  if (typeof task !== 'string') fail('task', 'the task must be text');
  const title = titleOf(body, fail);
  const model = modelOf(body, checks, fail);

  const repo = checks.folder?.kind === 'repo' ? checks.folder.repoName : null;
  const solutions = body['solutions'] ?? [];
  if (!Array.isArray(solutions) || !solutions.every((s) => typeof s === 'string')) {
    fail('solutions', 'solutions must be a list of names');
  } else if (repo !== null ? solutions.some((s) => s !== repo) : solutions.length > 0) {
    fail('solutions', repo !== null ? `a repo folder has one solution, ${repo}` : 'a simple session names no solutions: the agent determines them from the task');
  }

  const worktrees = body['worktrees'] ?? false;
  const where = checks.folder?.kind === 'plain' ? 'a plain folder' : 'a workspace folder';
  if (typeof worktrees !== 'boolean') fail('worktrees', 'worktrees must be true or false');
  else if (worktrees && repo === null) fail('worktrees', `a simple session in ${where} works in place: its own worktree needs a git repo folder`);
  const ultracode = body['ultracode'] ?? false;
  if (typeof ultracode !== 'boolean') fail('ultracode', 'ultracode must be true or false');

  let branch: string | null = null;
  if (worktrees === true && repo !== null && (checks.worktreeBranch ?? 'ticket') === 'ticket') {
    const raw = body['branch'];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      branch = typeof name === 'string' ? simpleBranchOfName(name) : null;
    } else {
      const check = checkBranchName(raw, 'branch', SIMPLE_BRANCH_EXAMPLE);
      if (check.ok) branch = check.name;
      else fail('branch', check.message);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name as string,
      task: task as string,
      workType: null,
      mode: null,
      solutions: repo !== null ? [repo] : [],
      phase: null,
      coordination: null,
      qa: null,
      worktrees: worktrees as boolean,
      ultracode: ultracode as boolean,
      simple: true,
      ...(title !== null ? { title } : {}),
      ...(branch !== null ? { branch, branching: TASK_ONLY } : {}),
      ...(model ?? {}),
    },
  };
}
