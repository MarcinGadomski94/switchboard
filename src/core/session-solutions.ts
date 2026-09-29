/**
 * D38 (`docs/derivations.md` → *Session solutions*): a workspace session's
 * solutions fill in by themselves from what its agents touch. Every solution an
 * agent writes into (the D21 agent-solution derivation, {@link writtenSolution})
 * or Switchboard adopts a worktree in joins `Session.solutions`, in the order
 * they appear ({@link withSolutions}). Pure rules; the recorder and the worktree
 * adoption call them.
 */
import { type SessionPlace, locateFile, solutionFolder } from './derive/artifacts.ts';

/** Top folders whose solutions are never a write target (router: `deprecated/`, `infrastructure/`). */
const READ_ONLY_TOP = new Set(['deprecated', 'infrastructure']);

/**
 * The solution a file an agent wrote belongs to, as `Session.solutions` names it
 * (the solution's folder name, as the New-session chips do: `acme-app-front`,
 * `mobile`), or `null`: a repo folder's session (its one solution is fixed, D14),
 * the workspace root, a path outside the folder, or a read-only solution. A file
 * in the session's worktree (`<repo>-wt-<name>`) belongs to its repo.
 */
export function writtenSolution(place: SessionPlace, file: string, sessionName: string | null): string | null {
  if (place.kind !== 'workspace') return null;
  const folder = solutionFolder(place.root, file, sessionName);
  if (folder === null) return null;
  const top = folder.split('/')[0] ?? '';
  if (READ_ONLY_TOP.has(top)) return null;
  return locateFile(place.root, file, sessionName).solution;
}

/**
 * `true` when two solution names mean the same solution: equal, or one is a
 * relative path (`microfrontends/web-front`, a chip's value when two rows share a
 * name) whose last segment is the other.
 */
export function sameSolution(a: string, b: string): boolean {
  if (a === b) return true;
  const last = (value: string): string => value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? value;
  return (a.includes('/') || b.includes('/')) && last(a) === last(b);
}

/**
 * `current` with each of `added` appended that it does not name yet
 * ({@link sameSolution}), in order; `null` when nothing is new.
 */
export function withSolutions(current: readonly string[], added: readonly string[]): string[] | null {
  const next = [...current];
  for (const solution of added) {
    if (solution.trim() === '' || next.some((known) => sameSolution(known, solution))) continue;
    next.push(solution);
  }
  return next.length === current.length ? null : next;
}
