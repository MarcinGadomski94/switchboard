import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CodebaseMemoryProject, CodebaseMemoryStatus } from '../../core/api.ts';
import type { CodebaseMemoryProvider } from '../providers.ts';
import { codebaseMemoryProjectId, dirtyLines, dirtyProject } from '../../core/codebase-memory.ts';

/**
 * The Codebase Memory tool's strip (SPEC → Tools; M8.1, gap #4): the projects the
 * workspace's freshness hook marked in `.claude/.codebase-memory-dirty`, and the
 * built-in prompt of the "Reindex n now" session. The file is only ever read here;
 * the reindex session's agent removes the lines it refreshed (workspace router →
 * *Code-intelligence MCP usage*). Lines are read with M6.4's rules
 * (`src/core/codebase-memory.ts`), the same the Solutions view uses. Details in `docs/tools.md`.
 */

/** The dirty list, relative to the workspace root. */
export const DIRTY_FILE = path.join('.claude', '.codebase-memory-dirty');

/**
 * codebase-memory's project id of an absolute path, the way the workspace hook
 * computes it (`/Users/me/ws` → `Users-me-ws`, `D:\\ws` → `D-ws`). The rule lives in
 * `src/core/codebase-memory.ts` (M6.4); this is its one-argument form.
 */
export function projectId(absolutePath: string): string {
  return codebaseMemoryProjectId(absolutePath);
}

/**
 * Names one line of the dirty file with M6.4's rules (`dirtyProject`): an id that
 * is a root form's id followed by `-<category>-<folder>` is that folder, named
 * like its Solutions row (`mobile` for any `mobile/<folder>`, else the folder),
 * with the path the id itself encodes (`<root>/<category>/<folder>`: the indexed
 * project, e.g. the nested `mobile/acme-app-mobile/` clone, which "Reindex"
 * needs). Anything else keeps the id as its name and has no path. `roots` are the
 * root's forms the hook may have seen (as configured, as its real path). Times
 * are unknown: the file holds none.
 */
export function describeProject(
  id: string,
  workspaceRoot: string | null,
  roots: readonly string[] = workspaceRoot ? [path.resolve(workspaceRoot)] : [],
): CodebaseMemoryProject {
  const unknown: CodebaseMemoryProject = { id, name: id, path: null, markedAt: null };
  if (!workspaceRoot) return unknown;
  const { relativePath } = dirtyProject(id, roots);
  if (relativePath === null) return unknown;
  const [category = '', ...rest] = relativePath.split('/');
  const name = category === 'mobile' ? 'mobile' : rest.join('/');
  return { id, name, path: path.join(workspaceRoot, category, ...rest), markedAt: null };
}

/** The dirty file's text → its projects, in file order, blank lines and repeated ids dropped (M6.4's `dirtyLines`). */
export function parseDirtyFile(text: string, workspaceRoot: string | null, roots?: readonly string[]): CodebaseMemoryProject[] {
  return dirtyLines(text).map((id) => describeProject(id, workspaceRoot, roots));
}

/**
 * Reads `<workspaceRoot>/.claude/.codebase-memory-dirty` (async). No workspace
 * root or no file = no dirty projects.
 */
export async function readDirtyProjects(workspaceRoot: string | null): Promise<CodebaseMemoryProject[]> {
  if (!workspaceRoot) return [];
  let text: string;
  try {
    text = await readFile(path.join(workspaceRoot, DIRTY_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
  const resolved = path.resolve(workspaceRoot);
  const real = await realpath(resolved).catch(() => resolved);
  return parseDirtyFile(text, workspaceRoot, [...new Set([resolved, real])]);
}

/**
 * The real {@link CodebaseMemoryProvider}: the dirty file of `workspaceRoot`.
 * The indexed-project count is unknown without calling codebase-memory itself,
 * which gap #4 rules out for the service, so `indexed` is `null`.
 */
export function dirtyFileCodebaseMemory(workspaceRoot: string | null): CodebaseMemoryProvider {
  return {
    async status(): Promise<CodebaseMemoryStatus> {
      return { projects: await readDirtyProjects(workspaceRoot), indexed: null };
    },
  };
}

/** Base name of the reindex sessions; a number is appended while the name is taken. */
export const REINDEX_SESSION_NAME = 'reindex-codebase-memory';

/**
 * The built-in reindex prompt (gap #4): the session re-indexes each listed project
 * through the codebase-memory MCP in full mode, one at a time, and removes its
 * line from the dirty file once it is fresh. It never calls the binary directly
 * and changes nothing else.
 */
export function reindexPrompt(projects: readonly CodebaseMemoryProject[]): string {
  const lines = projects.map((project) =>
    project.path ? `- ${project.name}: ${project.path} (codebase-memory project ${project.id})` : `- codebase-memory project ${project.id}`,
  );
  return [
    `Reindex the codebase-memory graph for the ${projects.length === 1 ? 'project' : `${projects.length} projects`} listed in .claude/.codebase-memory-dirty.`,
    'This is a maintenance task Switchboard started from the Codebase Memory tool ("Reindex now"). It is not feature work or test authoring, and it changes no code.',
    '',
    'For each project below, one at a time:',
    '1. Run the codebase-memory MCP tool index_repository with mode "full" on the repository path.',
    '2. When it succeeds, remove that project\'s line from .claude/.codebase-memory-dirty (delete the file once no lines are left).',
    '',
    'Use only the codebase-memory MCP tools to index: do not run the codebase-memory-mcp binary directly. Do not edit anything else. If a project cannot be indexed, leave its line in place and say why.',
    '',
    'Projects:',
    ...lines,
  ].join('\n');
}
