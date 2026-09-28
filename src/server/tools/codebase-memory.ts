import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CodebaseMemoryProject, CodebaseMemoryStatus } from '../../core/api.ts';
import type { CodebaseMemoryProvider } from '../providers.ts';

/**
 * The Codebase Memory tool's strip (SPEC → Tools; M8.1, gap #4): the projects the
 * workspace's freshness hook marked in `.claude/.codebase-memory-dirty`, and the
 * built-in prompt of the "Reindex n now" session. The file is only ever read here;
 * the reindex session's agent removes the lines it refreshed (workspace router →
 * *Code-intelligence MCP usage*). M6.4 reads the same file for the Solutions view;
 * the lane merge keeps one reader. Details in `docs/tools.md`.
 */

/** The dirty list, relative to the workspace root. */
export const DIRTY_FILE = path.join('.claude', '.codebase-memory-dirty');

/** The router's top-level folders the hook recognizes (`<category>/<repo>/…`). */
export const PROJECT_CATEGORIES: readonly string[] = ['microfrontends', 'microservices', 'functions', 'nugets', 'mobile', 'other', 'infrastructure'];

/**
 * codebase-memory's project id of an absolute path, the way the workspace hook
 * computes it: backslashes as `/`, trailing slashes dropped, every run of `:` `/`
 * `\` turned into one `-`, leading and trailing `-` trimmed
 * (`/Users/me/ws` → `Users-me-ws`, `D:\ws` → `D-ws`).
 */
export function projectId(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Names one line of the dirty file. An id that starts with the workspace root's id
 * (case-insensitively; `rootIds` = the ids of the root as configured and as its
 * real path, since the hook sees the path Claude Code runs in) followed by
 * `-<category>-<repo>` is that repo: its name is the repo folder, its path
 * `<root>/<category>/<repo>`. `mobile/` is itself the repo in the router layout,
 * so a `mobile-…` id is `mobile` at `<root>/mobile`. Anything else keeps the id as
 * its name and has no path. Times are unknown: the file holds none.
 */
export function describeProject(
  id: string,
  workspaceRoot: string | null,
  rootIds: readonly string[] = workspaceRoot ? [projectId(path.resolve(workspaceRoot))] : [],
): CodebaseMemoryProject {
  const unknown: CodebaseMemoryProject = { id, name: id, path: null, markedAt: null };
  if (!workspaceRoot) return unknown;
  const rootId = rootIds.find((candidate) => candidate !== '' && id.toLowerCase().startsWith(`${candidate.toLowerCase()}-`));
  if (!rootId) return unknown;
  const rest = id.slice(rootId.length + 1);
  const dash = rest.indexOf('-');
  if (dash <= 0) return unknown;
  const category = rest.slice(0, dash);
  const repo = rest.slice(dash + 1);
  if (!PROJECT_CATEGORIES.includes(category) || repo === '') return unknown;
  if (category === 'mobile') return { id, name: 'mobile', path: path.join(workspaceRoot, 'mobile'), markedAt: null };
  return { id, name: repo, path: path.join(workspaceRoot, category, repo), markedAt: null };
}

/** The dirty file's text → its projects, in file order, blank lines and duplicates dropped. */
export function parseDirtyFile(text: string, workspaceRoot: string | null, rootIds?: readonly string[]): CodebaseMemoryProject[] {
  const seen = new Set<string>();
  const projects: CodebaseMemoryProject[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    projects.push(describeProject(id, workspaceRoot, rootIds));
  }
  return projects;
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
  return parseDirtyFile(text, workspaceRoot, [...new Set([projectId(resolved), projectId(real)])]);
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
