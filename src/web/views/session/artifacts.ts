/**
 * Pure model of the Artifacts tab (SPEC → Session → Artifacts; M4.6): one row
 * per artifact of the session (type tag + name + meta), from `GET
 * /api/sessions/{id}` (`artifacts` + `files`). Copy and row form are the
 * prototype's (`docs/handoff/prototype/Switchboard App.dc.html`, `ss.arts`);
 * the artifacts themselves are derived by the recorder (gap #9). The rules are
 * in `docs/derivations.md` → *Artifacts tab*.
 */
import type { Artifact, FileDiff } from '../../../core/api.ts';
import { deltaText } from './diff.ts';

/** One row of the tab. */
export interface ArtifactRow {
  /** Stable identity across refreshes: the artifact id (`info` for the empty row). */
  readonly key: string;
  /** The type tag (`CONTRACT`, `DIFF`, `PR`, …; `INFO` for the empty row). */
  readonly tag: string;
  readonly name: string;
  /** Short state (`locked`, `+284 −12`, `open`); empty when none is known. */
  readonly meta: string;
  /** Where the artifact lives (`web-front ⎇ session/x`, `workspace root`), for the row's tooltip; empty for the empty row. */
  readonly title: string;
}

/** The single row shown when the session has no artifacts (the Solutions detail's form, M6.2). */
export const NO_ARTIFACTS: ArtifactRow = { key: 'info', tag: 'INFO', name: 'No artifacts', meta: '', title: '' };

/** The file count at the end of a stored DIFF name (`Pages/FreeTalk · 6 files`, `1 file`). */
const COUNT = /(?:^|\s·\s)(\d+ files?)$/;

/** `1 file`, `6 files`. */
export function fileCount(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

/** The file count segment of a stored DIFF name, or `null` when it has none. */
export function storedCount(name: string): string | null {
  return COUNT.exec(name)?.[1] ?? null;
}

/**
 * The session's changed files (`SessionDetail.files`, the git diff, gap #10)
 * that belong to a DIFF artifact: same solution, and the artifact's branch when
 * it has one. A DIFF without a branch (files written outside the session's
 * worktrees, e.g. in place) takes the solution's files on any branch that no
 * other DIFF of that solution in the session names.
 */
export function diffFilesOf(artifact: Artifact, artifacts: readonly Artifact[], files: readonly FileDiff[]): FileDiff[] {
  const solution = artifact.solution;
  if (solution === null) return [];
  if (artifact.branch !== null) return files.filter((file) => file.solution === solution && file.branch === artifact.branch);
  const claimed = new Set(
    artifacts.filter((other) => other.type === 'DIFF' && other.solution === solution && other.branch !== null).map((other) => other.branch),
  );
  return files.filter((file) => file.solution === solution && !claimed.has(file.branch));
}

/** Tooltip: `<solution> ⎇ <branch>`, `<solution>`, or `workspace root` (+ branch). */
export function locationTitle(artifact: Pick<Artifact, 'solution' | 'branch'>): string {
  const where = artifact.solution ?? 'workspace root';
  return artifact.branch ? `${where} ⎇ ${artifact.branch}` : where;
}

/**
 * A DIFF row in the session tab's form `<solution> · <n files>` (the tab has no
 * solution column, unlike the global list). A stored `meta` is kept together
 * with the count in the stored name; otherwise the count and `+added −removed`
 * come from the session's git diff for that solution + branch (the recorder
 * leaves DIFF meta empty, `docs/derivations.md` → *Artifacts*). Without git
 * data (changes gone, solution outside the session's scope) the stored count
 * stays and the meta is empty.
 */
function diffRow(artifact: Artifact, artifacts: readonly Artifact[], files: readonly FileDiff[]): { name: string; meta: string } {
  const solution = artifact.solution;
  if (solution === null) return { name: artifact.name, meta: artifact.meta ?? '' };
  const stored = artifact.meta?.trim() ?? '';
  const count = storedCount(artifact.name);
  if (stored !== '') return { name: `${solution} · ${count ?? artifact.name}`, meta: stored };
  const matched = diffFilesOf(artifact, artifacts, files);
  if (matched.length > 0) {
    let added = 0;
    let removed = 0;
    for (const file of matched) {
      added += file.added;
      removed += file.removed;
    }
    return { name: `${solution} · ${fileCount(matched.length)}`, meta: deltaText(added, removed) };
  }
  return { name: `${solution} · ${count ?? artifact.name}`, meta: '' };
}

/**
 * The tab's rows, in the server's order (most recently updated first). Every
 * type but DIFF shows its stored name and meta verbatim (empty meta when none
 * is known: nothing is invented); no artifacts → {@link NO_ARTIFACTS}.
 */
export function artifactRows(artifacts: readonly Artifact[], files: readonly FileDiff[]): ArtifactRow[] {
  if (artifacts.length === 0) return [NO_ARTIFACTS];
  return artifacts.map((artifact) => {
    const shown = artifact.type === 'DIFF' ? diffRow(artifact, artifacts, files) : { name: artifact.name, meta: artifact.meta ?? '' };
    return { key: artifact.id, tag: artifact.type, name: shown.name, meta: shown.meta, title: locationTitle(artifact) };
  });
}
