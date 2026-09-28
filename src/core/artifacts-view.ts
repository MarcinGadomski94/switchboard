/**
 * The global Artifacts view (M7.3, SPEC → Artifacts), shared by the server's
 * `GET /api/artifacts?type=&q=` and the UI: the prototype's type filters, the
 * `type=` query value, the "Solution · branch" label and the search match.
 * `docs/derivations.md` → *Artifacts view*.
 */
import { ARTIFACT_TYPES, type ArtifactType } from './model.ts';

/** One filter pill of the Artifacts view. `types` is `null` for "All". */
export interface ArtifactFilter {
  readonly label: string;
  readonly types: readonly ArtifactType[] | null;
}

/** The prototype's filter pills (`artFilters` + `AMAP`), in order. */
export const ARTIFACT_FILTERS: readonly ArtifactFilter[] = [
  { label: 'All', types: null },
  { label: 'Diffs', types: ['DIFF'] },
  { label: 'PRs / branches', types: ['PR', 'BRANCH'] },
  { label: 'Docs & contracts', types: ['DOC', 'CONTRACT', 'QA', 'FOLLOWUP'] },
  { label: 'Ticket replies', types: ['TICKET'] },
];

/** The `type=` query value of a filter (`PR,BRANCH`), `undefined` for "All". */
export function typeParam(filter: ArtifactFilter): string | undefined {
  return filter.types ? filter.types.join(',') : undefined;
}

/** Result of {@link parseTypeParam}. */
export type TypeParam =
  | { readonly ok: true; readonly types: readonly ArtifactType[] | null }
  | { readonly ok: false; readonly unknown: readonly string[] };

/**
 * Parses `type=`: artifact types separated by commas (a repeated `type` counts
 * too), case-insensitive. Missing or blank means every type (`types: null`); a
 * value that is not an artifact type is refused.
 */
export function parseTypeParam(raw: unknown): TypeParam {
  const values = (Array.isArray(raw) ? raw : [raw]).filter((value): value is string => typeof value === 'string');
  const parts = values.flatMap((value) => value.split(',')).map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return { ok: true, types: null };
  const known = ARTIFACT_TYPES as readonly string[];
  const unknown = parts.filter((part) => !known.includes(part.toUpperCase()));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, types: [...new Set(parts.map((part) => part.toUpperCase() as ArtifactType))] };
}

/** Shown for artifacts at the workspace root (`solution: null`), as the prototype does. */
export const ROOT_LABEL = 'root';

/** What {@link artifactLocation} and {@link artifactSearchText} read. */
export interface ArtifactRowFields {
  readonly type: ArtifactType;
  readonly name: string;
  readonly solution: string | null;
  readonly branch: string | null;
  readonly meta: string | null;
  readonly sessionName: string | null;
}

/**
 * The "Solution · branch" column: `solution ⎇ branch`, the solution alone without
 * a branch, `root` for the workspace root. A BRANCH artifact names its branch
 * already, so the branch is not repeated (the prototype's BRANCH row shows the
 * solution only).
 */
export function artifactLocation(row: Pick<ArtifactRowFields, 'type' | 'name' | 'solution' | 'branch'>): string {
  const solution = row.solution ?? ROOT_LABEL;
  if (!row.branch || (row.type === 'BRANCH' && row.branch === row.name)) return solution;
  return `${solution} ⎇ ${row.branch}`;
}

/** The text the search matches: type, name, location, session and status, joined by spaces (the prototype's `a.join(' ')` without the age). */
export function artifactSearchText(row: ArtifactRowFields): string {
  return [row.type, row.name, artifactLocation(row), row.sessionName ?? '', row.meta ?? ''].join(' ');
}

/** `true` when `q` (trimmed, case-insensitive) is empty or a substring of {@link artifactSearchText}. */
export function matchesArtifactQuery(row: ArtifactRowFields, q: string | null | undefined): boolean {
  const needle = (q ?? '').trim().toLowerCase();
  if (needle === '') return true;
  return artifactSearchText(row).toLowerCase().includes(needle);
}
