import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BranchingPreflight } from '../../core/api.ts';
import { DEFAULT_EPIC_BASE, checkBranchName, isValidBranchName } from '../../core/branching.ts';
import { repoSolutionName } from '../folders/ref.ts';
import type { ApiContext } from '../routes.ts';
import { resolveSessionFolder } from '../sessions/start.ts';

/** The most solutions one preflight checks (a form never picks more; each one is a `git fetch`). */
export const PREFLIGHT_MAX_SOLUTIONS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text once trimmed, `null` for a missing, `null` or blank value. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * D40 (`docs/new-session.md` → *Branching (D40)*, contract → *Epic/task branching
 * (D40)*): `POST /api/branching/preflight` `BranchingPreflightRequest` →
 * `BranchingPreflight { rows }`, the New-session form's preflight table. The
 * folder resolves like a NewSession's (`folder` = a saved folder's id, the
 * default when omitted: 422 / 409 `no-folder` / `folder-missing`); a repo
 * folder checks its one repo whatever `solutions` says; no solutions = no rows.
 * Each repo is fetched (`git fetch origin --prune`, bounded) and read, never
 * changed otherwise (`WorktreeManager.preflight`). 422 `invalid` for a body that
 * is not an object, `solutions` that is not a list of names (at most
 * {@link PREFLIGHT_MAX_SOLUTIONS}), an epic branch or base that is not a valid
 * branch name, or `bases` that is not a map of names to valid branch names. A
 * task branch that is not a valid branch name is simply not checked.
 */
export async function registerBranchingRoutes(app: FastifyInstance, context: ApiContext): Promise<void> {
  app.post('/api/branching/preflight', async (request, reply): Promise<BranchingPreflight | FastifyReply> => {
    const body = request.body;
    if (!isRecord(body)) return reply.code(422).send({ error: 'invalid', errors: [{ field: '', message: 'the body must be a BranchingPreflightRequest object' }] });
    const errors: Array<{ field: string; message: string }> = [];
    const rawSolutions = body['solutions'] ?? [];
    const solutions =
      Array.isArray(rawSolutions) && rawSolutions.every((s): s is string => typeof s === 'string' && s.trim() !== '') ? [...new Set(rawSolutions.map((s) => s.trim()))] : null;
    if (solutions === null) errors.push({ field: 'solutions', message: 'solutions must be a list of solution names' });
    else if (solutions.length > PREFLIGHT_MAX_SOLUTIONS) errors.push({ field: 'solutions', message: `at most ${PREFLIGHT_MAX_SOLUTIONS} solutions per preflight` });
    const rawEpic = optionalText(body['epicBranch']);
    const epic = rawEpic === null ? null : checkBranchName(rawEpic, 'epic branch', 'feature/PROJ-3010-Platform-tracking');
    if (epic && !epic.ok) errors.push({ field: 'epicBranch', message: epic.message });
    const rawBase = optionalText(body['base']);
    const base = rawBase === null ? null : checkBranchName(rawBase, 'epic base branch', DEFAULT_EPIC_BASE);
    if (base && !base.ok) errors.push({ field: 'base', message: base.message });
    const bases: Record<string, string> = {};
    const rawBases = body['bases'];
    if (rawBases !== undefined && rawBases !== null) {
      if (!isRecord(rawBases)) errors.push({ field: 'bases', message: 'bases must map a solution to a base branch' });
      else {
        for (const [solution, value] of Object.entries(rawBases)) {
          const check = checkBranchName(value, `base branch of ${solution}`, DEFAULT_EPIC_BASE);
          if (check.ok) bases[solution] = check.name;
          else errors.push({ field: 'bases', message: check.message });
        }
      }
    }
    if (errors.length > 0 || solutions === null) return reply.code(422).send({ error: 'invalid', errors });

    const resolved = await resolveSessionFolder(context, body);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { folder } = resolved;
    const targets = folder.kind === 'repo' ? [repoSolutionName(folder)] : solutions;
    if (targets.length === 0) return { rows: [] };
    const task = optionalText(body['taskBranch']);
    const rows = await context.worktrees.preflight(folder, {
      solutions: targets,
      epicBranch: epic?.ok ? epic.name : null,
      base: base?.ok ? base.name : DEFAULT_EPIC_BASE,
      taskBranch: task !== null && isValidBranchName(task) ? task : null,
      bases,
    });
    return { rows };
  });
}
