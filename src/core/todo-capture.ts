/**
 * D81 (`docs/todos.md` → *Quick capture (D81)*): the rules of capturing a todo quickly
 * (the ⌘K palette's `todo <text>`, a chat selection's "Add to todo", the phone's share
 * sheet) and of the one message that asks the session's agent to fill a captured item in.
 * Shared by the server and the UI. Pure: no I/O.
 */
import type { Session, SessionTodo, TodoCaptureSource } from './api.ts';
import { openSessions } from './session-close.ts';
import { TODO_DESCRIPTION_MAX, TODO_TITLE_MAX } from './todos.ts';

/** D81: the ways an item can be captured. */
export const TODO_CAPTURE_SOURCES: readonly TodoCaptureSource[] = ['palette', 'selection', 'share'];

/** D81: `true` for one of {@link TODO_CAPTURE_SOURCES}. */
export function isTodoCaptureSource(value: unknown): value is TodoCaptureSource {
  return typeof value === 'string' && (TODO_CAPTURE_SOURCES as readonly string[]).includes(value);
}

/** D81: a generated title is clipped to this many characters (a short title; the whole text goes into the note). */
export const CAPTURE_TITLE_CLIP = 80;

/**
 * D81: a short title generated from a text (a chat selection, a shared text): its first
 * non-empty line, spaces collapsed, clipped to `max` characters at a word when one is near
 * (with `…`). `''` for a text without any.
 */
export function captureTitle(text: string, max: number = CAPTURE_TITLE_CLIP): string {
  const line = (text.split(/\r?\n/).find((part) => part.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(2, Math.min(max, TODO_TITLE_MAX));
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** D81: a text as a Markdown block quote (each line `> `), clipped so the note fits a description. */
export function quoteNote(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  let out = lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n');
  if (out.length > TODO_DESCRIPTION_MAX) out = `${out.slice(0, TODO_DESCRIPTION_MAX - 1)}…`;
  return out;
}

/**
 * D81 · the palette: the text after `todo ` (case-insensitive, at least one space after
 * the word), trimmed; `null` when the query is not a `todo` command. `todo ` alone answers `''`.
 */
export function paletteTodoText(query: string): string | null {
  const match = /^\s*todo\s+([\s\S]*)$/i.exec(query);
  return match ? (match[1] ?? '').trim() : null;
}

/** D81 · the share sheet: what the operating system shared (`title`, `text`, `url`; any may be missing). */
export interface SharedData {
  readonly title?: string | null;
  readonly text?: string | null;
  readonly url?: string | null;
}

/**
 * D81 · the share sheet: the item a share becomes. The title is the shared title, else the
 * text's first line, else the link (clipped like {@link captureTitle}); the note holds the
 * shared text and the link (when the text does not already contain it), `null` when that adds
 * nothing to the title.
 */
export function sharedCapture(data: SharedData): { readonly title: string; readonly note: string | null } {
  const title = (data.title ?? '').trim();
  const text = (data.text ?? '').trim();
  const url = (data.url ?? '').trim();
  const head = captureTitle(title || text || url, TODO_TITLE_MAX);
  const parts = [text, url && !text.includes(url) ? url : ''].filter((part) => part !== '');
  const note = parts.join('\n\n');
  if (note === '' || note === head) return { title: head, note: null };
  return { title: head, note: note.length > TODO_DESCRIPTION_MAX ? `${note.slice(0, TODO_DESCRIPTION_MAX - 1)}…` : note };
}

/** D81: a note in the enrichment message is cut to this many characters (one line). */
export const ENRICH_NOTE_CLIP = 200;

function oneLine(text: string, max: number): string {
  const line = text.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * D81 · the agent fills it in: the ONE message Switchboard sends a session's agent, when it is
 * next idle, for the items captured there since (several pending captures → one message):
 * `The developer added todo [<id>] '<title>' (<note if any>). Fill in its description, handover
 * plan, priority and estimate with todo_update — don't start it.`
 */
export function todoEnrichMessage(items: readonly Pick<SessionTodo, 'id' | 'title' | 'description'>[]): string {
  const one = (item: Pick<SessionTodo, 'id' | 'title' | 'description'>): string => {
    const note = item.description ? oneLine(item.description, ENRICH_NOTE_CLIP) : '';
    return `[${item.id}] '${item.title}'${note ? ` (${note})` : ''}`;
  };
  if (items.length === 1 && items[0]) {
    return `The developer added todo ${one(items[0])}. Fill in its description, handover plan, priority and estimate with todo_update — don't start it.`;
  }
  return `The developer added todos ${items.map(one).join(', ')}. Fill in their description, handover plan, priority and estimate with todo_update — don't start them.`;
}

/** D81: the card's note while a captured item waits for its agent. */
export const ENRICH_WAITING_LABEL = '✎ waiting for the agent to fill in';

/** D81: sessions to capture into, most recently active first (closed sessions left out). */
export function captureTargets(sessions: readonly Session[]): Session[] {
  return openSessions(sessions).sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
}
