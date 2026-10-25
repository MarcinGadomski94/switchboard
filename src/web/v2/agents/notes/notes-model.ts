/**
 * D131 · lane A · the Notes page's pure model (`/notes`, "What agents know"): the
 * Project memory entries (D107, `src/core/memory.ts`) of this computer and the paired
 * ones as rows with their scope in v2 words ("Folder · …", "Code project · …",
 * "Teammate · …"), the scope filter, proposed first, and the draft answer's toast.
 * DOM-free; unit-tested in `tests/web/v2-notes.test.ts`.
 */
import type { MemoryDraftAnswer, MemoryEntry, MemoryScope, MemoryStatus } from '../../../../core/memory.ts';
import { folderName, memoryOrder, scopeKindOf } from '../../../../core/memory.ts';
// Project memory (D107) hook (docs/memory-removal.md): the imports above.
import { isChat, type KindOf } from '../../../../core/chats.ts';
import { NOTES_WORDS } from '../../glossary.ts';

/** A note's scope kind in v2 words: the memory `workspace` / `repo` / `member`. */
export type NoteScopeKind = 'folder' | 'codeProject' | 'teammate';

/** Where a note applies. `key` is the filter's value (`folder:<path>`, `repo:<key>`, `member:<id>`). */
export interface NoteScope {
  readonly key: string;
  readonly kind: NoteScopeKind;
  /** The name alone ("Checkout"). */
  readonly name: string;
  /** "Folder · Checkout". */
  readonly label: string;
}

/** The computer a note lives on (`id` `null` = this one). */
export interface NoteComputer {
  readonly id: string | null;
  readonly name: string;
  readonly state: 'online' | 'reconnecting' | 'offline';
}

/** One note as the page shows it. */
export interface NoteRow {
  /** Unique across computers: `<computer id or "local">:<entry id>`. */
  readonly key: string;
  readonly entry: MemoryEntry;
  readonly status: MemoryStatus;
  readonly scope: NoteScope;
  /** The folder the entry is stored under (`?scope=` filters by it too). */
  readonly folder: string;
  /** That folder's label ("Checkout"). */
  readonly folderLabel: string;
  /** `null` = this computer. */
  readonly computer: NoteComputer | null;
  /** "You", "Reviewer/QA", "Reviewer/QA, edited by you". */
  readonly by: string;
  /** "13:41", "Mon", "Oct 20". */
  readonly when: string;
  /** Why nothing can be done with it now (its computer is offline), else `null`. */
  readonly blocked: string | null;
}

/** One computer's notes as read (`entries` = `GET /api/memory/entries`, `scopes` = `GET /api/memory/scopes`). */
export interface NoteSource {
  readonly computer: NoteComputer | null;
  readonly entries: readonly MemoryEntry[];
  readonly scopes: readonly MemoryScope[];
}

/** One option of the scope filter. */
export interface NoteFilterOption {
  readonly key: string;
  readonly label: string;
  readonly kind: NoteScopeKind | 'all';
  /** Notes in it (proposed + approved; rejected ones are not counted). */
  readonly count: number;
  /** Proposals waiting in it. */
  readonly proposed: number;
}

const KIND_WORD: Readonly<Record<NoteScopeKind, string>> = {
  folder: NOTES_WORDS.scopeFolder,
  codeProject: NOTES_WORDS.scopeCodeProject,
  teammate: NOTES_WORDS.scopeTeammate,
};

/** The filter value that shows every note. */
export const ALL_NOTES = 'all';

/** A folder's label: the saved folder's label (from `scopes`), else its last path segment. */
export function folderLabel(folder: string, scopes: readonly Pick<MemoryScope, 'scope' | 'label'>[]): string {
  return scopes.find((scope) => scope.scope === folder)?.label || folderName(folder);
}

/** An entry's scope in v2 words: workspace → Folder, repo → Code project, member → Teammate. */
export function noteScopeOf(entry: Pick<MemoryEntry, 'scope' | 'scopeKey' | 'scopeLabel'> & Partial<Pick<MemoryEntry, 'scopeKind'>>, scopes: readonly Pick<MemoryScope, 'scope' | 'label'>[]): NoteScope {
  const kind = scopeKindOf(entry);
  if (kind === 'repo') {
    const name = entry.scopeLabel || folderName(entry.scopeKey ?? '') || 'code project';
    return { key: `repo:${entry.scopeKey ?? name}`, kind: 'codeProject', name, label: `${KIND_WORD.codeProject} · ${name}` };
  }
  if (kind === 'member') {
    const name = entry.scopeLabel || 'teammate';
    return { key: `member:${entry.scopeKey ?? name}`, kind: 'teammate', name, label: `${KIND_WORD.teammate} · ${name}` };
  }
  const name = folderLabel(entry.scope, scopes);
  return { key: `folder:${entry.scope}`, kind: 'folder', name, label: `${KIND_WORD.folder} · ${name}` };
}

/** Who wrote it: "You" for the developer, else the proposing agent; "…, edited by you" once changed on approval. */
export function noteAuthor(entry: Pick<MemoryEntry, 'authorKind' | 'authorLabel' | 'proposedText' | 'proposedTitle'>): string {
  if (entry.authorKind === 'developer') return NOTES_WORDS.you;
  const agent = entry.authorLabel?.trim() || NOTES_WORDS.anAgent;
  return entry.proposedText !== null || entry.proposedTitle !== null ? `${agent}, ${NOTES_WORDS.editedByYou}` : agent;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The prototype's short time: "13:41" today, "Mon" within the week, else "Oct 20". */
export function shortWhen(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (days < 7) return WEEKDAYS[at.getDay()] ?? '';
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** Why a paired computer's notes cannot be changed now (`null` while online or reconnecting). */
export function noteBlocked(computer: NoteComputer | null): string | null {
  return computer && computer.state === 'offline' ? `${computer.name} is offline` : null;
}

/** Order: proposed first (oldest first, as a queue), then approved (pinned, newest), then rejected (newest first). */
export function sortNotes(rows: readonly NoteRow[]): NoteRow[] {
  const proposed = rows.filter((row) => row.status === 'proposed').sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt));
  const approvedRows = rows.filter((row) => row.status === 'approved');
  const order = memoryOrder(approvedRows.map((row) => row.entry));
  const approved = order.map((entry) => approvedRows.find((row) => row.entry === entry)).filter((row): row is NoteRow => row !== undefined);
  const rejected = rows.filter((row) => row.status === 'rejected').sort((a, b) => (b.entry.decidedAt ?? b.entry.updatedAt).localeCompare(a.entry.decidedAt ?? a.entry.updatedAt));
  return [...proposed, ...approved, ...rejected];
}

/** Every computer's notes as rows, proposed first. */
export function noteRows(sources: readonly NoteSource[], now: number = Date.now()): NoteRow[] {
  const rows: NoteRow[] = [];
  for (const source of sources) {
    for (const entry of source.entries) {
      rows.push({
        key: `${source.computer?.id ?? 'local'}:${entry.id}`,
        entry,
        status: entry.status,
        scope: noteScopeOf(entry, source.scopes),
        folder: entry.scope,
        folderLabel: folderLabel(entry.scope, source.scopes),
        computer: source.computer,
        by: noteAuthor(entry),
        when: shortWhen(entry.status === 'proposed' ? entry.createdAt : (entry.decidedAt ?? entry.updatedAt), now),
        blocked: noteBlocked(source.computer),
      });
    }
  }
  return sortNotes(rows);
}

/**
 * The filter's value from the address's `?scope=`: a filter key as it is
 * (`folder:…`, `repo:…`, `member:…`), a bare folder path (the classic Memory
 * page's and the Needs-you item's links) as that folder, nothing → every note.
 */
export function filterFromQuery(search: string): string {
  const raw = new URLSearchParams(search).get('scope');
  if (!raw) return ALL_NOTES;
  if (raw === ALL_NOTES || /^(folder|repo|member):/.test(raw)) return raw;
  return `folder:${raw}`;
}

/**
 * Whether `row` shows under `filter`. A folder shows every note stored for it
 * (whatever its scope); a code project or a teammate only its own.
 */
export function inFilter(row: Pick<NoteRow, 'scope' | 'folder'>, filter: string): boolean {
  if (filter === ALL_NOTES) return true;
  if (filter.startsWith('folder:')) return row.folder === filter.slice('folder:'.length);
  return row.scope.key === filter;
}

/** The filter's options: All, then the folders, code projects and teammates that have notes (and the asked one, even when empty). */
export function filterOptions(rows: readonly NoteRow[], selected: string = ALL_NOTES): NoteFilterOption[] {
  const live = rows.filter((row) => row.status !== 'rejected');
  const options = new Map<string, NoteFilterOption>();
  const order: NoteScopeKind[] = ['folder', 'codeProject', 'teammate'];
  const add = (key: string, label: string, kind: NoteScopeKind): void => {
    if (options.has(key)) return;
    const inIt = live.filter((row) => inFilter(row, key));
    options.set(key, { key, label, kind, count: inIt.length, proposed: inIt.filter((row) => row.status === 'proposed').length });
  };
  for (const row of rows) {
    add(`folder:${row.folder}`, `${KIND_WORD.folder} · ${row.folderLabel}`, 'folder');
    if (row.scope.kind !== 'folder') add(row.scope.key, row.scope.label, row.scope.kind);
  }
  if (selected !== ALL_NOTES && !options.has(selected)) {
    const kind: NoteScopeKind = selected.startsWith('repo:') ? 'codeProject' : selected.startsWith('member:') ? 'teammate' : 'folder';
    const name = folderName(selected.replace(/^(folder|repo|member):/, ''));
    add(selected, `${KIND_WORD[kind]} · ${name}`, kind);
  }
  const sorted = [...options.values()].sort((a, b) => order.indexOf(a.kind as NoteScopeKind) - order.indexOf(b.kind as NoteScopeKind) || a.label.localeCompare(b.label));
  return [{ key: ALL_NOTES, label: NOTES_WORDS.all, kind: 'all', count: live.length, proposed: live.filter((row) => row.status === 'proposed').length }, ...sorted];
}

/** "Approved. Agents in Checkout now know it." */
export function approvedText(scope: NoteScope): string {
  return NOTES_WORDS.approvedToast.replace('{scope}', scope.name);
}

/** The agents "Draft notes from this agent" can ask: open, this computer's, with a folder, never a conversation. */
export function canDraftNotes(session: KindOf & { readonly closedAt?: string | null; readonly machine?: unknown; readonly folderPath?: string | null }): boolean {
  return !isChat(session) && session.closedAt == null && !session.machine;
}

/** The toast after "Draft notes from this agent". */
export function draftToast(answer: MemoryDraftAnswer, name: string): string {
  if (answer.asked) return `Asked “${name}” to draft notes. They’ll wait for you in Needs you.`;
  if (answer.reason === 'asked-recently') return `“${name}” was asked to draft notes in the last 24 hours. Its notes wait for you in Needs you.`;
  if (answer.reason === 'no-folder') return `“${name}” doesn’t work in a folder, so it can’t keep notes.`;
  if (answer.reason === 'closed') return `“${name}” is closed. Reopen it first.`;
  return `“${name}” wasn’t asked: ${answer.reason ?? 'unknown reason'}.`;
}

/** The note's text as its row quotes it: the text, else the title. */
export function noteQuote(entry: Pick<MemoryEntry, 'title' | 'text'>): string {
  return entry.text.trim() || entry.title.trim();
}
