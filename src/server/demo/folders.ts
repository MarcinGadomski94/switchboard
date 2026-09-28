import type { FolderCheck } from '../../core/api.ts';
import type { DemoData } from './data.ts';

/**
 * Demo mode's folder check (D14): the prototype's workspace root
 * (`D:\acme`) is not on this machine, so the disk check would refuse it.
 * The demo answers it as the prototype shows it instead: a workspace whose router
 * is "AGENTS.md (Workspace Router)" (640 lines, the wizard's "found · 640 lines")
 * with the prototype's solutions. Only for the demo folder; any other path is
 * checked on disk as usual.
 */
export function demoFolderChecks(data: DemoData): ReadonlyMap<string, FolderCheck> {
  const root = data.solutions.root;
  const solutionCount = data.solutions.groups.reduce((sum, group) => sum + group.solutions.length, 0);
  const check: FolderCheck = {
    path: root,
    canonicalPath: root,
    exists: true,
    kind: 'workspace',
    router: { title: 'AGENTS.md (Workspace Router)', lines: 640 },
    solutionCount,
    repoName: null,
    problem: null,
    message: '',
  };
  return new Map([[root, check]]);
}
