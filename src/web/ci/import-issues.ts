import type { ImportableIssue, IssueImportQuery } from '../../core/ci.ts';

/**
 * D109 · the Import issues dialog's pure parts (`docs/todos.md` → *Import issues (D109)*):
 * the query its fields make, which issues can still be ticked, and the result line.
 */

/** The dialog's fields. */
export interface ImportForm {
  readonly source: 'github' | 'jira';
  readonly repo: string;
  readonly label: string;
  readonly mine: boolean;
  /** Jira: a project key (`PROJ`) or a JQL query. */
  readonly jira: string;
}

/** An empty form for a session whose repositories are `repos` (the first is pre-filled). */
export function emptyImportForm(repos: readonly string[]): ImportForm {
  return { source: 'github', repo: repos[0] ?? '', label: '', mine: false, jira: '' };
}

const PROJECT = /^[A-Za-z][A-Za-z0-9_]{0,19}$/;

/** The query the form asks for: a Jira field that looks like a project key is one, else JQL. */
export function importQuery(form: ImportForm): IssueImportQuery {
  if (form.source === 'github') return { source: 'github', repo: form.repo.trim(), label: form.label.trim() === '' ? null : form.label.trim(), mine: form.mine };
  const text = form.jira.trim();
  return PROJECT.test(text) ? { source: 'jira', jql: null, project: text.toUpperCase() } : { source: 'jira', jql: text, project: null };
}

/** Whether the form can be previewed. */
export function canPreview(form: ImportForm): boolean {
  return form.source === 'github' ? /^[^/\s]+\/[^/\s]+$/.test(form.repo.trim()) : form.jira.trim() !== '';
}

/** The issues that can be ticked (not imported yet). */
export function importable(issues: readonly ImportableIssue[]): ImportableIssue[] {
  return issues.filter((issue) => !issue.imported);
}

/** "Import 3 issues". */
export function importLabel(count: number): string {
  return count === 1 ? 'Import 1 issue' : `Import ${count} issues`;
}

/** The toast after an import: how many were added. */
export function importedText(count: number, sessionTitle: string): string {
  return `${count === 1 ? '1 issue' : `${count} issues`} added to the todos of ${sessionTitle}`;
}
