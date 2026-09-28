import path from 'node:path';
import type { BranchRef, CodebaseMemoryStatus, FileDiff, FolderRule, HistoryItem, Solution, SolutionGroup, SystemInfo, UsageWindow } from '../../core/api.ts';
import { USAGE_ROW_LABELS } from '../../core/usage.ts';
import type {
  CodebaseMemoryProvider,
  DiffProvider,
  HistoryProvider,
  Providers,
  SolutionsProvider,
  SystemProvider,
  ToolProbeProvider,
} from '../providers.ts';
import type { DemoData, DemoFile } from './data.ts';
import { createDemoLoginService } from './login-service.ts';
import { DEMO_FOLDER_ID } from './seed.ts';

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
    // The prototype shows "Not committed. Commit only when you approve." for every demo file.
    uncommitted: true,
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

/** A footer usage figure `62% · 1h48` → its % and minutes until the reset; `null` when it has another shape. */
function parseUsageFigure(text: string | undefined): { readonly pct: number; readonly minutes: number } | null {
  const match = /^(\d+)% · (\d+)h(\d+)$/.exec(text ?? '');
  return match ? { pct: Number(match[1]), minutes: Number(match[2]) * 60 + Number(match[3]) } : null;
}

/**
 * Demo providers over `data`; `now` anchors the relative values (usage reset, History dates).
 * Every provider except D15's framing proxies (`toolFrames`): the demo runs none.
 */
export function createDemoProviders(data: DemoData, now: () => Date = () => new Date()): Required<Omit<Providers, 'toolFrames'>> {
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
      const resetsAt = (minutes: number): string => new Date(now().getTime() + minutes * 60_000).toISOString();
      // The prototype's one "Max" figure (62% · 1h48) stays usagePct; D17: it is the Session window,
      // and the Week window exists only when the demo data has one (the prototype has none).
      const usage = parseUsageFigure(footer.max);
      const week = parseUsageFigure(footer.week);
      const windows: UsageWindow[] = [
        ...(usage ? [{ key: 'session' as const, label: USAGE_ROW_LABELS.session, pct: usage.pct, resetsAt: resetsAt(usage.minutes) }] : []),
        ...(week ? [{ key: 'week' as const, label: USAGE_ROW_LABELS.week, pct: week.pct, resetsAt: resetsAt(week.minutes) }] : []),
      ];
      return {
        cli: data.system.cli,
        cliVersion: null,
        signedIn: data.system.signedIn,
        ghSignedIn: data.system.ghSignedIn,
        cpu: Number.parseFloat(footer.cpu),
        ramUsed: ramUsed * GIB,
        ramTotal: ramTotal * GIB,
        processes: footer.processes,
        ...(usage ? { usagePct: usage.pct, usageResetsAt: resetsAt(usage.minutes) } : {}),
        ...(windows.length > 0 ? { usageWindows: windows } : {}),
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
            // `various` (the prototype's prod-monitoring row) has no branch refs; it stays readable as the solutions line.
            solutions: parseBranchRefs(row.branches).length === 0 ? [row.branches] : [],
            outcome: row.outcome,
            status: row.status,
            // D14: every demo row belongs to the demo's one folder (the prototype's root).
            folder: DEMO_FOLDER_ID,
            folderPath: data.solutions.root,
          };
        });
    },
  };

  // The prototype's screenshots show the tools unreachable (its live probe of
  // localhost:13000 fails); the demo never touches the network (and has no framing proxies, D15).
  const toolProbe: ToolProbeProvider = {
    async probe() {
      return { state: 'down', framing: null };
    },
  };

  // The prototype's dirty list (`dirtyIds` with their times, today) and its
  // "16 projects indexed · full mode".
  const codebaseMemory: CodebaseMemoryProvider = {
    async status(): Promise<CodebaseMemoryStatus> {
      const today = now();
      return {
        projects: data.solutions.codebaseMemoryDirty.map((entry) => {
          const [hour = 0, minute = 0] = entry.ts.split(':').map(Number);
          const markedAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute).toISOString();
          return { id: entry.project, name: entry.project, path: null, markedAt };
        }),
        indexed: { ...data.solutions.codebaseMemoryIndexed },
      };
    },
  };

  return { diff, solutions, system, history, loginService: createDemoLoginService(), toolProbe, codebaseMemory };
}
