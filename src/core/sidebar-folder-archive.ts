import { ARCHIVE_KEPT_LABELS } from './session-archive.ts';
import { type SidebarFolder, type SidebarLayout, descendantIds, normalizeFolders, parentOf } from './sidebar-layout.ts';

/**
 * D141 · delete a sidebar folder and archive the agents in it (`docs/sidebar.md` →
 * *Delete a folder and archive its agents (D141)*). Pure rules shared by the
 * server (`DELETE /api/sidebar/folders/{id}?archive=1`) and both UIs (the
 * confirmation's counts and the result's toast).
 */

/** Why an agent in the folder was not archived (it is moved out, as a delete without archiving does). */
export type FolderArchiveKeptReason = 'pinned' | 'crew' | 'plan' | 'plan-step' | 'offline' | 'failed';

/** An agent the delete archived. */
export interface FolderArchiveAgent {
  readonly sessionId: string;
  /** Its title as listed (title, else its name). */
  readonly name: string;
  /** The paired computer it runs on (its name), `null` = this computer. */
  readonly machine: string | null;
}

/** An agent the delete kept (moved out of the folder instead), with the reason. */
export interface FolderArchiveKept extends FolderArchiveAgent {
  readonly reason: FolderArchiveKeptReason;
  /** `failed`: the refusal's text. */
  readonly message?: string;
}

/** `DELETE /api/sidebar/folders/{id}?archive=1`: the new layout and what happened to each agent. */
export interface SidebarFolderArchiveResult {
  readonly layout: SidebarLayout;
  readonly archived: readonly FolderArchiveAgent[];
  readonly kept: readonly FolderArchiveKept[];
}

/** The folder and its subfolders at any depth, the folder first, then in tree order. */
export function folderSubtree(layout: SidebarLayout, folderId: string): SidebarFolder[] {
  if (!layout.folders.some((f) => f.id === folderId)) return [];
  const ids = new Set([folderId, ...descendantIds(layout, folderId)]);
  return normalizeFolders(layout.folders).filter((f) => ids.has(f.id));
}

/**
 * Every session id placed in the folder or one of its subfolders (any depth): the
 * folder's own first, then each subfolder's in tree order; each once. Closed and
 * unknown ids are included (the callers keep only the listed ones).
 */
export function folderSessionIds(layout: SidebarLayout, folderId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const folder of folderSubtree(layout, folderId)) {
    for (const id of folder.sessionIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The folder and all its subfolders are deleted; every session placed in them
 * goes, in {@link folderSessionIds}'s order, to the end of the folder's parent
 * (or out of the folders, unplaced, for a top-level folder), as D54 / D58's
 * delete does with a folder's own sessions. `null` when there is no such folder.
 */
export function removeFolderTree(layout: SidebarLayout, folderId: string): SidebarLayout | null {
  const folder = layout.folders.find((f) => f.id === folderId);
  if (!folder) return null;
  const gone = new Set(folderSubtree(layout, folderId).map((f) => f.id));
  const moved = folderSessionIds(layout, folderId);
  const parent = parentOf(folder);
  const folders = normalizeFolders(layout.folders)
    .filter((f) => !gone.has(f.id))
    .map((f) => (parent !== null && f.id === parent ? { ...f, sessionIds: [...f.sessionIds, ...moved.filter((s) => !f.sessionIds.includes(s))] } : f));
  return { ...layout, folders: normalizeFolders(folders) };
}

/** What the server knows about one listed agent in the folder. */
export interface FolderArchiveCandidate {
  readonly sessionId: string;
  readonly name: string;
  /** The paired computer it runs on, `null` = this computer. */
  readonly machine: { readonly name: string; readonly online: boolean } | null;
}

/** The holds the server found (the archive's own, D137). */
export interface FolderArchiveHolds {
  readonly pinned: ReadonlySet<string>;
  readonly crew: ReadonlySet<string>;
  /** Plans (D99): the source of an unfinished plan (`plan`) and a step of a running / paused plan (`plan-step`). */
  readonly plans: ReadonlyMap<string, 'plan' | 'plan-step'>;
}

/** The order the held-back reasons are checked in (the first that holds is reported). */
export const FOLDER_ARCHIVE_HOLD_ORDER: readonly FolderArchiveKeptReason[] = ['pinned', 'crew', 'plan', 'plan-step', 'offline'];

/** Why `candidate` is not archived, or `null` when it is. */
export function folderArchiveHold(candidate: FolderArchiveCandidate, holds: FolderArchiveHolds): FolderArchiveKeptReason | null {
  if (holds.pinned.has(candidate.sessionId)) return 'pinned';
  if (holds.crew.has(candidate.sessionId)) return 'crew';
  const plan = holds.plans.get(candidate.sessionId);
  if (plan) return plan;
  if (candidate.machine && !candidate.machine.online) return 'offline';
  return null;
}

/** Splits the candidates into the ones to archive and the ones held back (with the reason), keeping their order. */
export function splitFolderArchive(candidates: readonly FolderArchiveCandidate[], holds: FolderArchiveHolds): { readonly archive: FolderArchiveCandidate[]; readonly kept: FolderArchiveKept[] } {
  const archive: FolderArchiveCandidate[] = [];
  const kept: FolderArchiveKept[] = [];
  for (const candidate of candidates) {
    const reason = folderArchiveHold(candidate, holds);
    if (reason === null) archive.push(candidate);
    else kept.push({ sessionId: candidate.sessionId, name: candidate.name, machine: candidate.machine?.name ?? null, reason });
  }
  return { archive, kept };
}

// ── words (both UIs) ─────────────────────────────────────────────────

/** Which UI's words: classic says "sessions", v2 "agents". */
export type FolderArchiveVoice = 'classic' | 'v2';

const NOUN: Readonly<Record<FolderArchiveVoice, string>> = { classic: 'session', v2: 'agent' };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The names the confirmation lists at most. */
export const FOLDER_ARCHIVE_NAMES_MAX = 5;

/** One agent in the confirmation. */
export interface FolderArchiveListed {
  readonly name: string;
  /** Running or waiting (a turn runs, or it waits for the developer): archiving stops it. */
  readonly working: boolean;
}

/** The confirmation's words (an empty folder keeps the simple confirm: the caller does not use these). */
export interface FolderArchiveConfirm {
  /** "Delete “Acme” and archive its 3 agents?" (ticked) or "Delete “Acme”?" (unticked). */
  readonly title: string;
  readonly checkbox: string;
  /** "2 are working and will be stopped." (ticked only; `null` when none). */
  readonly working: string | null;
  /** Up to {@link FOLDER_ARCHIVE_NAMES_MAX} names, then `more`. */
  readonly names: readonly string[];
  /** "+ 4 more", or `null`. */
  readonly more: string | null;
}

/** The confirmation of deleting folder `name` holding `agents` (in it and its subfolders), ticked = archive them. */
export function folderArchiveConfirm(name: string, agents: readonly FolderArchiveListed[], ticked: boolean, voice: FolderArchiveVoice): FolderArchiveConfirm {
  const noun = NOUN[voice];
  const n = agents.length;
  const working = agents.filter((agent) => agent.working).length;
  const names = agents.slice(0, FOLDER_ARCHIVE_NAMES_MAX).map((agent) => agent.name);
  const rest = n - names.length;
  return {
    title: ticked ? `Delete “${name}” and archive its ${n === 1 ? noun : plural(n, noun)}?` : `Delete “${name}”?`,
    checkbox: `Also archive the ${noun}s in it`,
    working: ticked && working > 0 ? `${working} ${working === 1 ? 'is' : 'are'} working and will be stopped.` : null,
    names,
    more: rest > 0 ? `+ ${rest} more` : null,
  };
}

/** Short words for each held-back reason, per UI (the archive's own words where they exist, D137). */
export const FOLDER_ARCHIVE_KEPT_WORDS: Readonly<Record<FolderArchiveVoice, Readonly<Record<Exclude<FolderArchiveKeptReason, 'offline'>, string>>>> = {
  classic: { pinned: ARCHIVE_KEPT_LABELS.pinned, crew: ARCHIVE_KEPT_LABELS.crew, plan: 'its plan is not finished', 'plan-step': 'a step of a running plan', failed: 'could not be archived' },
  v2: { pinned: 'pinned', crew: 'a teammate in a crew', plan: 'its project is not finished', 'plan-step': 'a step of a running project', failed: 'could not be archived' },
};

/** One kept agent's reason in words ("pinned", "Laptop is offline"). */
export function folderArchiveKeptText(kept: Pick<FolderArchiveKept, 'reason' | 'machine'>, voice: FolderArchiveVoice): string {
  if (kept.reason === 'offline') return `${kept.machine ?? 'its computer'} is offline`;
  return FOLDER_ARCHIVE_KEPT_WORDS[voice][kept.reason];
}

/**
 * The result toast: "Deleted “Acme”. 3 archived · 1 kept: pinned." Each distinct reason once,
 * in the order first met ("Laptop is offline" for a paired computer that is not connected).
 */
export function folderArchiveResultText(folderName: string, result: Pick<SidebarFolderArchiveResult, 'archived' | 'kept'>, voice: FolderArchiveVoice): string {
  const parts = [`${result.archived.length} archived`];
  if (result.kept.length > 0) {
    const reasons: string[] = [];
    for (const kept of result.kept) {
      const text = folderArchiveKeptText(kept, voice);
      if (!reasons.includes(text)) reasons.push(text);
    }
    parts.push(`${result.kept.length} kept: ${reasons.join(', ')}`);
  }
  return `Deleted “${folderName}”. ${parts.join(' · ')}.`;
}
