/**
 * D16 in v2 · + New › From a terminal (`BringInSheet.tsx`): the pure part, unit-tested in
 * `tests/web/v2-bring-in.test.ts` (no DOM, no JSX). The rows are the classic History's
 * (`GET /api/history`, `?cli=1` for Codex CLI / OpenCode); the move is the classic one
 * (`useConversationMoves` + `views/history-move.ts`); the name rules are the classic
 * New-session form's (`modals/resume-conversation.ts`). What is v2's own: which rows can be
 * brought in, the order, the search, an entry's lines and the stage the confirm step shows.
 */
import type { Folder, HistoryItem } from '../../../core/api.ts';
import { CLI_LABELS } from '../../../core/cli-providers.ts';
import { folderName } from '../../folders/folders.ts';
import type { MoveItem, MoveState } from '../../views/history-move.ts';

/**
 * The rows that can be brought in: terminal conversations of this computer that are not in
 * Switchboard yet (a paired computer's rows are its archived sessions, never terminal ones),
 * newest first (then by id, so the order is stable).
 */
export function bringInRows(rows: readonly HistoryItem[]): HistoryItem[] {
  return rows
    .filter((row) => row.terminal === true && row.sessionId === null && !row.machine)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.claudeSessionId.localeCompare(b.claudeSessionId));
}

/** Everything the search looks in: the name, the first prompt, the folder it started in, its saved folder's path, the CLI and the ids. */
function haystack(row: HistoryItem): string {
  return [row.name, row.firstPrompt ?? '', row.cwd ?? '', row.folderPath ?? '', row.solutions.join(' '), row.provider ? CLI_LABELS[row.provider] : '', row.claudeSessionId, row.nativeId ?? '']
    .join('\n')
    .toLowerCase();
}

/** Whether `row` matches `query`: every word of it (case-insensitive) appears somewhere in the row; an empty query matches all. */
export function bringInMatches(row: HistoryItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const text = haystack(row);
  return words.every((word) => text.includes(word));
}

/** The list the sheet shows: {@link bringInRows} matching `query`. */
export function bringInList(rows: readonly HistoryItem[], query: string): HistoryItem[] {
  return bringInRows(rows).filter((row) => bringInMatches(row, query));
}

/** One entry of the list, in words. */
export interface BringInEntry {
  readonly id: string;
  /** The conversation's title (its name, else its first prompt). */
  readonly title: string;
  /** The first prompt, when it is not already the title. */
  readonly prompt: string | null;
  /** The folder it started in, by name (`app`), with its code project when it differs (`workspace · app`). */
  readonly where: string;
  /** That folder's full path (the tooltip), `null` when unknown. */
  readonly wherePath: string | null;
  /** `Codex CLI` / `OpenCode`; `null` for Claude Code. */
  readonly cli: string | null;
  readonly startedAt: string;
}

/** The entry of a row. */
export function bringInEntry(row: HistoryItem): BringInEntry {
  const prompt = row.firstPrompt?.trim() || null;
  const title = row.name.trim() || prompt || row.claudeSessionId;
  const path = row.cwd ?? row.folderPath ?? null;
  const name = path ? folderName(path) : '';
  const project = row.solutions[0];
  const where = project && project !== name ? (name ? `${name} · ${project}` : project) : name;
  return { id: row.claudeSessionId, title, prompt: prompt && prompt !== title ? prompt : null, where, wherePath: path, cli: row.provider ? CLI_LABELS[row.provider] : null, startedAt: row.startedAt };
}

/** The saved project folder the row lands in (its own, D14), `null` when no saved folder holds it (the move then asks to add it). */
export function bringInFolder(row: Pick<HistoryItem, 'folder'>, folders: readonly Pick<Folder, 'id' | 'displayName'>[]): Pick<Folder, 'id' | 'displayName'> | null {
  if (!row.folder) return null;
  return folders.find((folder) => folder.id === row.folder) ?? null;
}

/**
 * Where the confirm step stands, from the single move it runs (`useConversationMoves`):
 * `pick` before Continue (or after Cancel), `moving` while the service works, then what the
 * service answered: `moved`, `terminal-open` (the warning, with Continue anyway),
 * `needs-folder` (Add the folder and continue) or `refused`.
 */
export type BringInStage = 'pick' | 'moving' | MoveState['kind'];

/** {@link BringInStage} of the move of `id`. */
export function bringInStage(items: readonly MoveItem[] | null, id: string | null): Exclude<BringInStage, 'waiting' | 'skipped'> {
  const item = items && id ? items.find((entry) => entry.claudeSessionId === id) : undefined;
  if (!item) return 'pick';
  switch (item.state.kind) {
    case 'waiting':
    case 'moving':
      return 'moving';
    case 'skipped':
      return 'pick';
    default:
      return item.state.kind;
  }
}
