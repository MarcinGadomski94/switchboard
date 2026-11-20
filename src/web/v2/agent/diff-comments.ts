/**
 * D180 · comments on the lines of a diff, collected in the side panel's Changes and
 * handed to the agent as one message. Kept for this page's life only.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** One comment on a line of a changed file. */
export interface DiffComment {
  readonly id: string;
  /** The repository (or separate copy) the file is in, as the diff names it. */
  readonly repo: string;
  /** The file's identity in the diff (`fileKey`: solution + path). */
  readonly fileKey: string;
  /** The file as the message names it: its path inside its repo. */
  readonly path: string;
  /** `new`: a line of the file as it is now; `old`: a line the change removed. */
  readonly side: 'new' | 'old';
  /** The line's number on its side, `null` when the diff does not say. */
  readonly line: number | null;
  /** The line's own text (without its `+` / `-`). */
  readonly code: string;
  readonly text: string;
}

/** A longer line is cut in the message. */
export const COMMENT_CODE_MAX = 160;

/** The comments made on one line of one file. */
export function commentsAt(comments: readonly DiffComment[], fileKey: string, side: 'new' | 'old', line: number | null): DiffComment[] {
  if (line === null) return [];
  return comments.filter((comment) => comment.fileKey === fileKey && comment.side === side && comment.line === line);
}

/** `text` as Markdown inline code, also when it holds backticks itself. */
function inlineCode(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

/** `path:line` (or the path alone), as the message and the panel name a comment's place. */
export function commentPlace(comment: Pick<DiffComment, 'path' | 'line'>): string {
  return comment.line === null ? comment.path : `${comment.path}:${comment.line}`;
}

/**
 * The comments as one message for the agent: by repository, file and line, each with
 * where it is (`path:line`, and the repository when the comments are on more than
 * one), the line itself and what you wrote. `''` without comments.
 */
export function reviewMessage(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return '';
  const severalRepos = new Set(comments.map((comment) => comment.repo)).size > 1;
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => order(a.comment.repo, b.comment.repo) || order(a.comment.path, b.comment.path) || (a.comment.line ?? 0) - (b.comment.line ?? 0) || a.index - b.index);
  const items = ordered.map(({ comment }, index) => {
    const place = `${inlineCode(commentPlace(comment))}${severalRepos ? ` in ${inlineCode(comment.repo)}` : ''}`;
    const removed = comment.side === 'old' ? ' (a line you removed)' : '';
    const code = comment.code.trim();
    const quoted = code === '' ? '' : ` · ${inlineCode(code.length > COMMENT_CODE_MAX ? `${code.slice(0, COMMENT_CODE_MAX)}…` : code)}`;
    const text = comment.text
      .trim()
      .split(/\r?\n/)
      .map((line) => `   ${line}`.trimEnd())
      .join('\n');
    return `${index + 1}. ${place}${removed}${quoted}\n${text}`;
  });
  return `Review comments on your changes:\n\n${items.join('\n\n')}`;
}

// ── The comments of this page, per agent ─────────────────────────────────────

const NONE: readonly DiffComment[] = [];
const store = new Map<string, readonly DiffComment[]>();
const listeners = new Set<() => void>();
let made = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function put(sessionId: string, comments: readonly DiffComment[]): void {
  if (comments.length === 0) store.delete(sessionId);
  else store.set(sessionId, comments);
  for (const listener of [...listeners]) listener();
}

export interface DiffComments {
  readonly comments: readonly DiffComment[];
  readonly add: (comment: Omit<DiffComment, 'id'>) => void;
  readonly remove: (id: string) => void;
  readonly clear: () => void;
}

/** The agent's comments, live: they stay while the panel shows another tab or another agent, until the page reloads. */
export function useDiffComments(sessionId: string): DiffComments {
  const comments = useSyncExternalStore(subscribe, () => store.get(sessionId) ?? NONE);
  const add = useCallback(
    (comment: Omit<DiffComment, 'id'>): void => {
      made += 1;
      put(sessionId, [...(store.get(sessionId) ?? NONE), { ...comment, id: `c${made}` }]);
    },
    [sessionId],
  );
  const remove = useCallback((id: string): void => put(sessionId, (store.get(sessionId) ?? NONE).filter((comment) => comment.id !== id)), [sessionId]);
  const clear = useCallback((): void => put(sessionId, NONE), [sessionId]);
  return { comments, add, remove, clear };
}
