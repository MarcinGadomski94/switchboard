/**
 * Pure rules of the workspace scanner (M6.1, `docs/solutions.md`): reading the
 * folder rules out of the router `AGENTS.md`, merging them with the layout the
 * handoff documents (ARCHITECTURE → *Workspace rules*), and turning a scan into
 * the `GET /api/solutions` groups. No file system: `src/server/solutions/`
 * walks the folders.
 */
import path from 'node:path';
import type { FolderRule, Solution, SolutionGroup } from './api.ts';
import { solutionCandidates } from './worktrees.ts';

/**
 * How deep a top-level folder holds its solutions: `0` = the folder is one
 * solution (`mobile/`), `1` = each child (`microfrontends/<repo>/`), `2` = each
 * grandchild (`deprecated/<type-group>/<repo>/`).
 */
export type FolderDepth = number;

/** The deepest level the scanner walks, whatever the router's patterns say. */
export const MAX_FOLDER_DEPTH = 3;

/** A top-level workspace folder and how sessions may use it. */
export interface FolderSpec {
  /** Folder name at the workspace root, without a slash (`microfrontends`). */
  readonly folder: string;
  readonly rule: FolderRule;
  readonly depth: FolderDepth;
  /** Filter pill of its solutions (SPEC → Solutions): `Web`, `Mobile`, `NuGet`, `Backend`, `Read-only`, else `Other`. */
  readonly type: string;
  /** `true` when the router `AGENTS.md` names the folder (else it comes from the baseline only). */
  readonly inRouter: boolean;
}

/** One folder rule read from the router `AGENTS.md`. */
export interface RouterFolderRule {
  readonly folder: string;
  readonly rule: FolderRule;
  readonly depth: FolderDepth;
}

/**
 * The workspace layout the handoff documents (ARCHITECTURE → *Workspace rules*,
 * "from the router AGENTS.md"): the floor the router's own text is merged onto.
 * The order is the Solutions view's group order (the prototype's).
 */
export const BASELINE_FOLDERS: readonly Omit<FolderSpec, 'inRouter'>[] = [
  { folder: 'microfrontends', rule: 'editable', depth: 1, type: 'Web' },
  { folder: 'mobile', rule: 'editable', depth: 0, type: 'Mobile' },
  { folder: 'nugets', rule: 'editable', depth: 1, type: 'NuGet' },
  { folder: 'microservices', rule: 'editable', depth: 1, type: 'Backend' },
  { folder: 'functions', rule: 'editable', depth: 1, type: 'Backend' },
  { folder: 'other', rule: 'on-request', depth: 1, type: 'Other' },
  { folder: 'deprecated', rule: 'read-only', depth: 2, type: 'Read-only' },
  { folder: 'infrastructure', rule: 'read-only', depth: 0, type: 'Read-only' },
];

/** Filter pill of read-only solutions. */
export const READ_ONLY_TYPE = 'Read-only';
/** Filter pill of a folder the baseline does not know. */
export const OTHER_TYPE = 'Other';
/** `folder` of the one group that holds every read-only folder's solutions (the prototype's label). */
export const READ_ONLY_GROUP = 'read-only';
/** `note` of an on-request group (gap #15: "other/", on request only). */
export const ON_REQUEST_NOTE = 'on request only';

const STRICTNESS: Record<FolderRule, number> = { editable: 0, 'on-request': 1, 'read-only': 2 };

/** The stricter of two rules: read-only > on-request > editable. */
export function stricterRule(a: FolderRule, b: FolderRule): FolderRule {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

const READ_ONLY_WORDS: readonly RegExp[] = [/\bread[\s-]?only\b/i, /\bnever\s+(?:modif|edit)/i];
const ON_REQUEST_WORDS: readonly RegExp[] = [
  /\bon[\s-](?:explicit\s+)?(?:developer\s+)?request\b/i,
  /\bexplicit(?:ly)?\s+(?:developer\s+)?request/i,
  /\bexplicitly\s+direct/i,
  /\bonly\s+when\s+(?:the\s+)?developer\b/i,
];

/**
 * The rule a router bullet's text gives its folder: any read-only wording
 * ("read-only", "never modify/edited") → `read-only`; else any on-request
 * wording ("on request", "on explicit developer request", "explicitly directs",
 * "only when the developer …") → `on-request`; else `editable`.
 */
export function ruleFromText(text: string): FolderRule {
  if (READ_ONLY_WORDS.some((word) => word.test(text))) return 'read-only';
  if (ON_REQUEST_WORDS.some((word) => word.test(text))) return 'on-request';
  return 'editable';
}

/** A list item whose first thing is a backticked token, optionally in bold: `` - `x/` … `` or `` - **`x/` is …** ``. */
const FOLDER_BULLET = /^\s*[-*+]\s+(?:\*\*|__)?`([^`\s]+)`(.*)$/;
/** A folder token: a plain top-level name, then optional deeper segments, ending with `/`. */
const FOLDER_TOKEN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/((?:[^/]+\/)*)$/;
/** Any list item (bulleted or numbered), which ends the previous item's continuation lines. */
const ANY_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Reads the folder rules out of the router `AGENTS.md`: every list item whose
 * first token is a backticked folder ending with `/` (`mobile/`,
 * `microfrontends/<repo-name>-front/`, `deprecated/<type-group>/<repo-name>/`,
 * `**`other/` is …**`) gives that top-level folder a rule from the item's text
 * (its line and indented continuation lines, {@link ruleFromText}) and a depth
 * (the segments after the folder). Several items for one folder merge: the
 * strictest rule, the deepest depth. Fenced code blocks are skipped. Returned in
 * first-mention order.
 */
export function parseRouterRules(text: string): RouterFolderRule[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const found = new Map<string, RouterFolderRule>();
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bullet = FOLDER_BULLET.exec(line);
    if (!bullet) continue;
    const token = FOLDER_TOKEN.exec(bullet[1] as string);
    if (!token) continue;
    const folder = token[1] as string;
    const depth = Math.min((token[2] as string).split('/').filter(Boolean).length, MAX_FOLDER_DEPTH);
    let body = bullet[2] as string;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (!/^\s+\S/.test(next) || ANY_ITEM.test(next) || FENCE.test(next)) break;
      body += ` ${next.trim()}`;
    }
    const rule = ruleFromText(body);
    const previous = found.get(folder);
    found.set(
      folder,
      previous
        ? { folder, rule: stricterRule(previous.rule, rule), depth: Math.max(previous.depth, depth) }
        : { folder, rule, depth },
    );
  }
  return [...found.values()];
}

/**
 * The folders a workspace has: the {@link BASELINE_FOLDERS} in their order, each
 * tightened (never loosened) and deepened by the router's rule for it, then the
 * folders only the router names, in its order. A read-only folder's type is
 * `Read-only`; a folder the baseline does not know is `Other`.
 */
export function mergeFolderRules(router: readonly RouterFolderRule[]): FolderSpec[] {
  const byFolder = new Map(router.map((rule) => [rule.folder, rule]));
  const specs: FolderSpec[] = BASELINE_FOLDERS.map((base) => {
    const fromRouter = byFolder.get(base.folder);
    const rule = fromRouter ? stricterRule(base.rule, fromRouter.rule) : base.rule;
    return {
      folder: base.folder,
      rule,
      depth: fromRouter ? Math.max(base.depth, fromRouter.depth) : base.depth,
      type: rule === 'read-only' ? READ_ONLY_TYPE : base.type,
      inRouter: fromRouter !== undefined,
    };
  });
  const known = new Set(BASELINE_FOLDERS.map((base) => base.folder));
  for (const rule of router) {
    if (known.has(rule.folder)) continue;
    specs.push({ ...rule, type: rule.rule === 'read-only' ? READ_ONLY_TYPE : OTHER_TYPE, inRouter: true });
  }
  return specs;
}

/** What the folder rules say about a NewSession solution (a bare name or a workspace-relative path). */
export interface ReadOnlyCheck {
  /** `true` when the solution's own path starts in a read-only folder (`deprecated/…`, `infrastructure`, one the router adds). */
  readonly always: boolean;
  /**
   * Folders the name can resolve to under the router layout
   * ({@link solutionCandidates}, the worktree manager's resolution) that lie in
   * a read-only folder: the solution is read-only when one of them exists.
   */
  readonly candidates: readonly string[];
}

/**
 * The read-only check of a NewSession solution (`POST /api/sessions`, 422). A
 * bare `mobile` is never refused because of `deprecated/mobile/`, which it
 * cannot resolve to; a bare name is refused when a folder it can resolve to sits
 * in a folder the router made read-only and exists. Names that are not
 * workspace solutions at all (absolute, `..`) are left to the other checks.
 */
export function readOnlyCheck(specs: readonly FolderSpec[], root: string, solution: string): ReadOnlyCheck {
  const readOnly = new Set(specs.filter((spec) => spec.rule === 'read-only').map((spec) => spec.folder));
  const first = solution.replace(/\\/g, '/').split('/').find((part) => part !== '' && part !== '.');
  if (first === undefined) return { always: false, candidates: [] };
  if (readOnly.has(first)) return { always: true, candidates: [] };
  const candidates = (solutionCandidates(root, solution) ?? []).filter((candidate) => {
    const top = relativeParts(root, candidate)[0];
    return top !== undefined && readOnly.has(top);
  });
  return { always: false, candidates };
}

/** Segments of `target` below `root`; empty when it is not inside. */
function relativeParts(root: string, target: string): string[] {
  const relative = path.relative(root, target);
  if (relative === '' || path.isAbsolute(relative)) return [];
  const parts = relative.split(/[\\/]/).filter(Boolean);
  return parts[0] === '..' ? [] : parts;
}

/** The router file the scan read. */
export interface RouterFile {
  /** Absolute path of `<root>/AGENTS.md`. */
  readonly path: string;
  readonly found: boolean;
  /** Line count (the setup wizard's "found · n lines"); `0` when not found. */
  readonly lines: number;
}

/** One solution folder found by the scan. */
export interface ScannedSolution {
  /** Folder name (`acme-app-front`, `mobile`). */
  readonly name: string;
  /** Path from the workspace root, `/`-separated (`microfrontends/acme-app-front`). */
  readonly relativePath: string;
  /** Absolute path in the current OS's form (gap #17). */
  readonly path: string;
  /** `true` when the folder is a git main checkout (`.git` is a directory). */
  readonly git: boolean;
}

/** One top-level folder of the scan. */
export interface ScannedFolder extends FolderSpec {
  /** `true` when the folder exists in the workspace (a real directory, not a symlink). */
  readonly exists: boolean;
  /** Its solutions, sorted by relative path. */
  readonly solutions: readonly ScannedSolution[];
}

/** A whole workspace scan (M6.1). */
export interface WorkspaceScan {
  readonly root: string;
  readonly router: RouterFile;
  /** In {@link mergeFolderRules} order. */
  readonly folders: readonly ScannedFolder[];
}

function compareSolutions(a: Solution, b: Solution): number {
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en');
  return byName !== 0 ? byName : a.path.localeCompare(b.path, 'en');
}

function toSolution(solution: ScannedSolution, folder: ScannedFolder): Solution {
  return {
    name: solution.name,
    path: solution.path,
    type: folder.type,
    // M6.2 fills the live fields (sessions, worktrees, phase-ledger, changes, conflicts).
    status: 'idle',
    rule: folder.rule,
    phase: '—',
    changes: folder.rule === 'read-only' ? 'locked' : '—',
    flag: '',
    conflict: false,
    branches: [],
  };
}

/**
 * The `GET /api/solutions` groups of a scan: one group per writable folder
 * (`microfrontends/`, `mobile/`, …, `other/` with the note "on request only",
 * gap #15), then one `read-only` group holding every read-only folder's
 * solutions with the note `deprecated/ · infrastructure/ · never edited` (built
 * from the folders that have solutions). Groups without solutions are left out.
 * Solutions are sorted by name. The live fields (status, branches, phase,
 * changes, flag, conflict) are neutral here; M6.2 fills them.
 */
export function toSolutionGroups(scan: WorkspaceScan): SolutionGroup[] {
  const groups: SolutionGroup[] = [];
  for (const folder of scan.folders) {
    if (folder.rule === 'read-only' || folder.solutions.length === 0) continue;
    groups.push({
      folder: `${folder.folder}/`,
      note: folder.rule === 'on-request' ? ON_REQUEST_NOTE : '',
      rule: folder.rule,
      solutions: folder.solutions.map((solution) => toSolution(solution, folder)).sort(compareSolutions),
    });
  }
  const readOnly = scan.folders.filter((folder) => folder.rule === 'read-only' && folder.solutions.length > 0);
  if (readOnly.length > 0) {
    groups.push({
      folder: READ_ONLY_GROUP,
      note: [...readOnly.map((folder) => `${folder.folder}/`), 'never edited'].join(' · '),
      rule: 'read-only',
      solutions: readOnly.flatMap((folder) => folder.solutions.map((solution) => toSolution(solution, folder))).sort(compareSolutions),
    });
  }
  return groups;
}
