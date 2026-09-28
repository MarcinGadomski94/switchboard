import type { HistoryItem } from '../../core/api.ts';
import { formatHistoryDate } from '../../core/history.ts';
import { movedSessionName } from '../../core/terminal-move.ts';
import { FOLDER_KIND_LABEL } from '../folders/folders.ts';
import { type FormFolder, type StartNames, type SummaryLine, TITLE_TOO_LONG, startNames, titleTooLong } from './new-session.ts';

/**
 * D16 in the New-session form (`docs/new-session.md` → *Resume a terminal
 * conversation*): next to the task, **Resume a terminal conversation** lists the
 * chosen folder's terminal conversations that are not in Switchboard yet (title,
 * date, first prompt). Picking one replaces the task, and Start moves it
 * (`POST /api/history/{id}/continue`) instead of starting a new session. Pure
 * rules: the entries, the name, when Start is enabled, the summary. D22
 * (developer ruling 2026-09-28): text typed in the name field is the moved
 * session's title (sent as `title`; the service derives the short name from it as
 * for a new session); an empty field keeps D16 (the conversation's own title).
 */

/** The choice next to the task. */
export const RESUME_TERMINAL_CONVERSATION = 'Resume a terminal conversation';

/** A picked conversation: what the form shows and sends. */
export type ResumePick = Pick<HistoryItem, 'claudeSessionId' | 'name' | 'startedAt' | 'firstPrompt' | 'cwd' | 'folder'>;

/** The pick of a History row. */
export function resumePickOf(row: HistoryItem): ResumePick {
  return { claudeSessionId: row.claudeSessionId, name: row.name, startedAt: row.startedAt, firstPrompt: row.firstPrompt ?? null, cwd: row.cwd ?? null, folder: row.folder };
}

/** An entry's second line: `09-27 21:41 · <first prompt>` (the date in the browser's time zone). */
export function resumeEntryMeta(row: Pick<HistoryItem, 'startedAt' | 'firstPrompt'>): string {
  const date = formatHistoryDate(row.startedAt);
  return row.firstPrompt ? `${date} · ${row.firstPrompt}` : date;
}

/** The name the service gives the moved session when the name field is empty (`src/core/terminal-move.ts`, from the row's title). */
export function resumeNamePreview(pick: Pick<ResumePick, 'name'>, takenNames: readonly string[]): string {
  return movedSessionName({ customTitle: pick.name }, new Set(takenNames));
}

/**
 * The moved session's names (D22): typed text is its title and the short name is
 * derived from it (`startNames`: `-2`, `-3`, … when taken, the rule the service
 * applies to the posted `title`); an empty field has no title of its own and the
 * {@link resumeNamePreview} name.
 */
export function resumeNames(pick: Pick<ResumePick, 'name'>, typed: string, takenNames: readonly string[]): StartNames {
  if (typed.trim() === '') return { name: resumeNamePreview(pick, takenNames), title: null };
  return startNames({ name: typed }, takenNames);
}

/** Why the typed text cannot be used, `null` when it can (D22: any text up to 80 characters is a title; an empty field: the service names it). */
export function resumeNameProblem(typed: string): string | null {
  return titleTooLong({ name: typed }) ? TITLE_TOO_LONG : null;
}

/** Start moves the picked conversation: a pick, and a usable title (or none). */
export function canStartResume(pick: ResumePick | null, typed: string): boolean {
  return pick !== null && resumeNameProblem(typed) === null;
}

/**
 * The live summary while a conversation is picked: the folder, the cwd it
 * continues in (where it started), the command it resumes with, the short name
 * ({@link resumeNames}), and what happens (no first message, the history
 * imported, idle).
 */
export function resumeSummaryLines(pick: ResumePick, folder: FormFolder | null, typed: string, takenNames: readonly string[]): SummaryLine[] {
  const value = (text: string): SummaryLine => ({ text, tone: 'value' });
  const lines: SummaryLine[] = [{ text: '# claude code · background · Max', tone: 'comment' }];
  if (folder) lines.push(value(`folder    ${folder.displayName} · ${FOLDER_KIND_LABEL[folder.kind]}`));
  lines.push(
    value(`cwd       ${pick.cwd ?? '—'}`),
    value(`resume    claude --resume ${pick.claudeSessionId}`),
    value(`name      ${resumeNames(pick, typed, takenNames).name}`),
    value(' '),
    { text: '# moves the terminal conversation · no first message', tone: 'comment' },
  );
  const problem = resumeNameProblem(typed);
  if (problem) lines.push({ text: problem, tone: 'warn' });
  lines.push(value(' '), { text: '✓ same conversation · history imported · idle', tone: 'ok' });
  return lines;
}
