import path from 'node:path';
import type { BranchRef, FileDiff, FolderRule, HistoryItem, Solution, SolutionGroup, SystemInfo } from '../../core/api.ts';
import type { DiffProvider, HistoryProvider, Providers, SolutionsProvider, SystemProvider } from '../providers.ts';
import type { DemoData, DemoFile } from './data.ts';
import { createDemoLoginService } from './login-service.ts';

/**
 * Demo implementations of the provider interfaces (providers.ts) for the data the
 * database does not hold: git diffs, the solutions scan, system metrics and the
 * transcript-based History rows. Selected only when `SWITCHBOARD_DEMO=1` (D13).
 */

const GIB = 1024 ** 3;

/** `+51 −12` → 51 added, 12 removed (U+2212 or ASCII minus). */
export function parseDelta(delta: string): { added: number; removed: number } {
  const added = /\+(\d+)/.exec(delta);
  const removed = /[−-](\d+)/.exec(delta);
  return { added: added ? Number(added[1]) : 0, removed: removed ? Number(removed[1]) : 0 };
}

function toFileDiff(file: DemoFile): FileDiff {
  return {
    solution: file.solution,
    path: file.path,
    branch: file.branch === '—' ? null : file.branch,
    ...parseDelta(file.delta),
    lines: [...file.lines],
  };
}

/**
 * A demo solution's path from the workspace root, by the prototype's own rule for
 * the detail path (`sd.path`): `mobile` and `infrastructure` are whole folders,
 * the other read-only rows sit in `deprecated/microfrontends/`, the rest in their
 * group folder.
 */
export function demoRelativePath(folder: string, name: string, readOnly: boolean): string {
  if (readOnly) return name === 'infrastructure' ? name : `deprecated/microfrontends/${name}`;
  if (folder === 'mobile/') return name;
  return `${folder}${name}`;
}

function folderRule(folder: string): FolderRule {
  if (folder === 'read-only') return 'read-only';
  if (folder === 'other/') return 'on-request';
  return 'editable';
}

/** `sol ⎇ branch · sol ⎇ branch` → branch refs (`various` → none). */
export function parseBranchRefs(text: string): BranchRef[] {
  return text
    .split(' · ')
    .map((part) => part.split(' ⎇ '))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== undefined && pair[1] !== undefined)
    .map(([solution, branch]) => ({ solution, branch }));
}

/** Demo providers over `data`; `now` anchors the relative values (usage reset, History dates). */
export function createDemoProviders(data: DemoData, now: () => Date = () => new Date()): Required<Providers> {
  const sessionNames = new Set(data.sessions.map((s) => s.name));

  const diff: DiffProvider = {
    async diff(sessionId, file) {
      const session = data.sessions.find((s) => s.name === sessionId);
      if (!session) return [];
      return session.files.filter((f) => file === undefined || f.path === file).map(toFileDiff);
    },
  };

  const dirty = new Set(data.solutions.codebaseMemoryDirty.map((d) => d.project));
  const solutions: SolutionsProvider = {
    async solutions(): Promise<SolutionGroup[]> {
      return data.solutions.groups.map((group) => ({
        folder: group.folder,
        note: group.note,
        rule: folderRule(group.folder),
        solutions: group.solutions.map((sol) => {
          const relativePath = demoRelativePath(group.folder, sol.name, sol.readOnly);
          const ledger = data.solutions.phaseLedgers[sol.name];
          return {
            name: sol.name,
            // The prototype's Windows paths, verbatim (its root is `D:\acme`).
            path: path.win32.join(data.solutions.root, ...relativePath.split('/')),
            relativePath,
            type: sol.type,
            status: sol.status,
            rule: sol.readOnly ? 'read-only' : folderRule(group.folder),
            phase: sol.phase,
            changes: sol.changes,
            flag: sol.flag,
            conflict: sol.flagKind === 'warn',
            // The card's sessions (prototype `sd.warn`); isolated = its branch here has a worktree folder.
            conflictSessions: (sol.conflictSessions ?? []).map((name) => ({
              sessionId: name,
              name,
              isolated: sol.branches.some((b) => b.owner === name && b.worktree !== null),
              repo: sol.name,
              attached: true,
            })),
            branches: sol.branches.map((b) => ({
              branch: b.branch,
              worktree: b.worktree ? `../${b.worktree}` : null,
              sessionId: sessionNames.has(b.owner) ? b.owner : null,
              owner: b.owner,
              status: b.status,
            })),
            ledger: ledger ? ledger.map((entry) => ({ interface: entry.interface, phase: entry.phase, seam: entry.seam })) : null,
            artifacts: (data.solutions.artifacts[sol.name] ?? []).map((a) => ({ type: a.type, name: a.name, meta: a.meta, sessionId: null })),
            codebaseMemory: dirty.has(sol.name) ? 'dirty' : 'fresh',
          } satisfies Solution;
        }),
      }));
    },
  };

  const system: SystemProvider = {
    async system(): Promise<SystemInfo> {
      const footer = data.system.footer;
      const [ramUsed = 0, ramTotal = 0] = footer.ram.replace(' GB', '').split('/').map(Number);
      const usage = /^(\d+)% · (\d+)h(\d+)$/.exec(footer.max);
      const resetsInMinutes = usage ? Number(usage[2]) * 60 + Number(usage[3]) : null;
      return {
        cli: data.system.cli,
        cliVersion: null,
        signedIn: data.system.signedIn,
        ghSignedIn: data.system.ghSignedIn,
        cpu: Number.parseFloat(footer.cpu),
        ramUsed: ramUsed * GIB,
        ramTotal: ramTotal * GIB,
        processes: footer.processes,
        ...(usage ? { usagePct: Number(usage[1]) } : {}),
        ...(resetsInMinutes === null ? {} : { usageResetsAt: new Date(now().getTime() + resetsInMinutes * 60_000).toISOString() }),
      };
    },
  };

  const history: HistoryProvider = {
    async history(q) {
      const needle = q?.trim().toLowerCase() ?? '';
      const year = now().getFullYear();
      return data.history
        .filter((row) => !needle || Object.values(row).join(' ').toLowerCase().includes(needle))
        .map((row, index): HistoryItem => {
          const [md = '01-01', hm = '00:00'] = row.date.split(' ');
          const [month = 1, day = 1] = md.split('-').map(Number);
          const [hour = 0, minute = 0] = hm.split(':').map(Number);
          return {
            claudeSessionId: `demo-history-${index + 1}`,
            sessionId: null,
            startedAt: new Date(year, month - 1, day, hour, minute).toISOString(),
            name: row.name,
            mode: row.mode,
            summary: row.summary,
            branches: parseBranchRefs(row.branches),
            outcome: row.outcome,
            status: row.status,
          };
        });
    },
  };

  return { diff, solutions, system, history, loginService: createDemoLoginService() };
}
