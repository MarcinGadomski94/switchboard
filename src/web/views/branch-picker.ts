import type { IsolateRequest, RepoBranch, RepoBranches } from '../../core/api.ts';
import { formatAge } from '../shell/format.ts';

/**
 * Pure view logic of the conflict card's **Existing branch** picker (D60,
 * `docs/solutions.md` → *Conflicts*): search, what each row shows, why a row is
 * disabled, the fetch status line and the isolate request a choice makes. The
 * component is `ExistingBranchPicker.tsx`.
 */

/** The confirm step's two choices: a new ticket branch (D32) or an existing branch (D60). */
export type BranchMode = 'new' | 'existing';

/** The confirm step's choice labels. */
export const BRANCH_MODE_LABELS: Readonly<Record<BranchMode, string>> = { new: 'New branch', existing: 'Existing branch' };

/** One row of the picker. */
export interface BranchRow {
  /** `RepoBranch.name`: what the row shows and the request sends. */
  readonly name: string;
  /** `local`, or `remote · <remote>`. */
  readonly kind: string;
  /** The tip's subject and age (`Fix the login · 3d ago`); empty when git gave neither. */
  readonly detail: string;
  /** A branch checked out elsewhere cannot get the worktree (git checks a branch out once). */
  readonly disabled: boolean;
  /** Why it is disabled (`checked out in <path>`); empty otherwise. */
  readonly reason: string;
  /** What else the developer should know: the local branch a remote row uses, a local branch's upstream; empty when nothing. */
  readonly note: string;
}

/** The picker row of `branch` (`now` for the age). */
export function branchRow(branch: RepoBranch, now: number = Date.now()): BranchRow {
  const age = branch.committedAt ? formatAge(branch.committedAt, now) : '';
  const when = age === '' ? '' : age === 'now' ? 'just now' : `${age} ago`;
  const detail = [branch.subject ?? '', when].filter((part) => part !== '').join(' · ');
  const disabled = branch.checkedOutAt !== null;
  let note = '';
  if (branch.kind === 'remote') note = branch.localExists ? `uses the local branch ${branch.localName}` : `makes the local branch ${branch.localName} tracking it`;
  else if (branch.upstream) note = `tracks ${branch.upstream}`;
  return {
    name: branch.name,
    kind: branch.kind === 'local' ? 'local' : `remote · ${branch.remote ?? ''}`,
    detail,
    disabled,
    reason: disabled ? `checked out in ${branch.checkedOutAt as string}` : '',
    note,
  };
}

/**
 * The branches matching the search: every whitespace-separated word must occur
 * in the name (case-insensitive); an empty search keeps them all, in the
 * server's order (local first, newest first).
 */
export function filterBranches(branches: readonly RepoBranch[], search: string): RepoBranch[] {
  const words = search.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...branches];
  return branches.filter((branch) => {
    const name = branch.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/** The picked branch when it is still listed and selectable, else `null`. */
export function pickedBranch(branches: readonly RepoBranch[] | null, picked: string | null): RepoBranch | null {
  if (picked === null || branches === null) return null;
  const branch = branches.find((candidate) => candidate.name === picked) ?? null;
  return branch && branch.checkedOutAt === null ? branch : null;
}

/** What the picker's list state is. */
export interface PickerLoad {
  /** The last list (`null` before the first answer). */
  readonly list: RepoBranches | null;
  /** A fetch (`fetch=1`) is running. */
  readonly fetching: boolean;
  /** The list could not be read at all (the server's refusal). */
  readonly error: string | null;
}

/** The status line under the search: loading, fetching, the fetch warning, or empty. */
export function pickerStatus(load: PickerLoad): { readonly text: string; readonly warn: boolean } {
  if (load.error) return { text: load.error, warn: true };
  if (load.list === null) return { text: 'Loading branches…', warn: false };
  if (load.fetching) return { text: 'Fetching from the remotes… (showing the branches known locally)', warn: false };
  if (load.list.fetchError) return { text: `Could not fetch: ${load.list.fetchError}. Showing the branches known locally.`, warn: true };
  return { text: '', warn: false };
}

/** The note under the picker: what the worktree will be on, or what is missing. */
export function pickerNote(branch: RepoBranch | null): { readonly text: string; readonly ok: boolean } {
  if (!branch) return { text: 'Pick the branch the worktree will be on', ok: false };
  if (branch.kind === 'remote' && !branch.localExists) return { text: `⎇ a new local ${branch.localName} tracking ${branch.name}`, ok: true };
  return { text: `⎇ the worktree will be on ${branch.localName}`, ok: true };
}

/** D60: the confirm step's line in the Existing branch choice. */
export function existingConfirmText(action: { readonly sessionTitle: string; readonly repo: string }): string {
  return `${action.sessionTitle} gets a new worktree of ${action.repo} on an existing branch (local or remote):`;
}

/** The `POST /api/solutions/{repo}/isolate` body of a choice. */
export function isolateBody(sessionId: string, choice: { readonly mode: 'new'; readonly branch: string } | { readonly mode: 'existing'; readonly branch: RepoBranch }): IsolateRequest {
  return choice.mode === 'new' ? { sessionId, branch: choice.branch } : { sessionId, existingBranch: choice.branch.name };
}
