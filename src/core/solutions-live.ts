/**
 * Pure rules behind the live fields of the Solutions view (M6.2,
 * `docs/solutions.md` → *Live fields*): the gap #12 phase-ledger parser, the
 * row's phase / status / changes summaries, the current branch from `.git/HEAD`
 * and the codebase-memory freshness match against `.claude/.codebase-memory-dirty`.
 * No file system: `src/server/solutions/live.ts` reads the files.
 */
import type { CodebaseMemoryFreshness, PhaseLedgerEntry } from './api.ts';
import type { Phase, SessionStatus } from './model.ts';

/** The phase labels a ledger or a session can have (the prototype's copy). */
export type PhaseLabel = 'UI-first' | 'integration';

/** A row's phase when several interfaces or sessions disagree (the prototype's copy). */
export const MIXED_PHASE = 'mixed';

/** Shown when a value is not known (never invented). */
export const NO_VALUE = '—';

const PHASE_WORD = /\b(ui[\s-]?first|integration)\b/i;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_ROW = /^\s*\|(.*)\|?\s*$/;
const TABLE_SEPARATOR = /^:?-{2,}:?$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
/** Separators between the parts of a bullet (`→`, `->`, `=>`, `:`, dashes, `|`, `,`, `·`). */
const SEPARATORS = /^[\s→←<>:=|,·–—-]+|[\s→←<>:=|,·–—-]+$/g;

/** `UI-first` / `integration` for a phase word (`ui-first`, `UI first`, `Integration`), else `null`. */
export function phaseLabel(text: string): PhaseLabel | null {
  const match = PHASE_WORD.exec(text);
  if (!match) return null;
  return /^ui/i.test(match[1] as string) ? 'UI-first' : 'integration';
}

/** The label of a session's NewSession phase. */
export function sessionPhaseLabel(phase: Phase): PhaseLabel {
  return phase === 'ui-first' ? 'UI-first' : 'integration';
}

/** Markdown emphasis and code marks removed, whitespace collapsed. */
function plain(text: string): string {
  return text.replace(/`/g, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
}

function trimSeparators(text: string): string {
  return plain(text).replace(SEPARATORS, '').trim();
}

function tableEntry(cells: readonly string[]): PhaseLedgerEntry | null {
  const cleaned = cells.map(plain);
  if (cleaned.every((cell) => cell === '' || TABLE_SEPARATOR.test(cell.replace(/\s/g, '')))) return null;
  // The phase cell holds only the phase word (a header cell "Phase" does not count).
  const phaseAt = cleaned.findIndex((cell) => /^\W*(ui[\s-]?first|integration)\W*$/i.test(cell));
  if (phaseAt <= 0) return null;
  const name = cleaned.slice(0, phaseAt).find((cell) => cell !== '');
  const phase = phaseLabel(cleaned[phaseAt] as string);
  if (!name || !phase) return null;
  const seam = cleaned
    .slice(phaseAt + 1)
    .filter((cell) => cell !== '')
    .join(' · ');
  return { interface: name, phase, seam };
}

function bulletEntry(body: string): PhaseLedgerEntry | null {
  const text = plain(body);
  const match = PHASE_WORD.exec(text);
  if (!match) return null;
  const name = trimSeparators(text.slice(0, match.index));
  const phase = phaseLabel(match[1] as string);
  if (!name || !phase) return null;
  return { interface: name, phase, seam: trimSeparators(text.slice(match.index + match[0].length)) };
}

/**
 * Reads a solution's `phase-ledger.md` leniently (gap #12): markdown table rows
 * (`| interface | phase | seam |`, the phase cell holding only `UI-first` or
 * `integration`, the interface = the first non-empty cell before it, the seam =
 * the non-empty cells after it joined with ` · `) and list items
 * (`- FreeTalkService → UI-first → seam TODO · FreeTalkViewModel.cs:41`: the
 * interface before the first phase word, the seam after it, separators such as
 * `→`, `->`, `:`, dashes and `|` trimmed). Header and separator rows, headings,
 * prose, items without a phase word or without an interface and fenced code are
 * skipped. Backticks and bold marks are removed. Entries keep the file's order.
 */
export function parsePhaseLedger(text: string): PhaseLedgerEntry[] {
  const entries: PhaseLedgerEntry[] = [];
  let fenced = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const row = TABLE_ROW.exec(line);
    if (row) {
      const cells = (row[1] as string).split('|');
      const entry = tableEntry(cells);
      if (entry) entries.push(entry);
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const entry = bulletEntry(item[1] as string);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** One phase for a set of phases: the only one, `mixed` when they differ, `null` for none. */
export function summarizePhases(phases: readonly string[]): string | null {
  const distinct = [...new Set(phases)];
  if (distinct.length === 0) return null;
  return distinct.length === 1 ? (distinct[0] as string) : MIXED_PHASE;
}

/**
 * The row's phase: the phase ledger's (one phase, or `mixed`), else the phases of
 * the open sessions working on the solution, else `—`.
 */
export function solutionPhase(ledger: readonly PhaseLedgerEntry[] | null, sessionPhases: readonly Phase[]): string {
  return summarizePhases((ledger ?? []).map((entry) => entry.phase)) ?? summarizePhases(sessionPhases.map(sessionPhaseLabel)) ?? NO_VALUE;
}

/** Most urgent first: a session that needs you, a failure, work in progress, a paused one, a finished one, nothing. */
const URGENCY: readonly SessionStatus[] = ['need', 'fail', 'run', 'paused', 'done', 'idle'];

/** The row's status dot: the most urgent status of the sessions on its branches, `idle` without any. */
export function solutionStatus(statuses: readonly SessionStatus[]): SessionStatus {
  for (const status of URGENCY) if (statuses.includes(status)) return status;
  return 'idle';
}

/**
 * The row's changes column: `+<added>` (the prototype's form) when the sessions'
 * diffs add lines, `−<removed>` when they only remove, `—` without changes;
 * `locked` for a read-only solution.
 */
export function changesText(added: number, removed: number, readOnly: boolean): string {
  if (readOnly) return 'locked';
  if (added > 0) return `+${added}`;
  if (removed > 0) return `\u2212${removed}`;
  return NO_VALUE;
}

/**
 * The checked-out branch from a `.git/HEAD` file: `ref: refs/heads/<branch>` →
 * `<branch>`, a detached HEAD (a commit id) → its first 7 characters, anything
 * else → `null`.
 */
export function branchFromHead(head: string): string | null {
  const text = head.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (ref) return (ref[1] as string).trim() || null;
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text)) return text.slice(0, 7);
  return null;
}

/**
 * The codebase-memory project id of a folder, as the workspace's dirty-tracker
 * hook writes it into `.claude/.codebase-memory-dirty`: the absolute path with `\`
 * turned into `/`, then every run of `:`, `/` and `\` turned into one `-`, and
 * leading / trailing `-` removed (`D:/…/nugets/auth-nuget` →
 * `D-…-nugets-auth-nuget`).
 */
export function codebaseMemoryProjectId(root: string, relativePath: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const absolute = relativePath === '' ? base : `${base}/${relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`;
  return absolute.replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The non-empty, trimmed lines of a `.codebase-memory-dirty` file. */
export function dirtyProjects(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Freshness of one solution against the dirty list (`null` = the file could not
 * be read): `dirty` when a line equals its project id (case-insensitive), or, for
 * a solution that is a whole top-level folder (`mobile/`, depth 0), when a line
 * starts with its id + `-` (the hook records `<root>-mobile-<first subfolder>`
 * for edits there); otherwise `fresh`.
 */
export function freshness(
  dirty: readonly string[] | null,
  root: string,
  relativePath: string,
  wholeFolder: boolean,
): CodebaseMemoryFreshness {
  if (dirty === null) return 'unknown';
  const id = codebaseMemoryProjectId(root, relativePath).toLowerCase();
  for (const line of dirty) {
    const project = line.toLowerCase();
    if (project === id) return 'dirty';
    if (wholeFolder && project.startsWith(`${id}-`)) return 'dirty';
  }
  return 'fresh';
}
