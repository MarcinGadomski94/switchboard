import { shortNameFromTitle } from './session-title.ts';
import { branchFromTitle } from './ticket-branch.ts';

/**
 * D56 (`docs/decisions.md`, `docs/new-session.md` → *Simple mode (D56)*): the
 * simple New-session form starts a session from a folder, a message, an
 * optional title, the model and one "own worktree" checkbox. The pure rules
 * shared by the server (`validateNewSession` with `simple: true`) and the UI
 * (`src/web/modals/simple-session.ts`): the title a message gives, the short name
 * and the worktree branch.
 */

/** The prefix of a simple session's worktree branch (no D32 ticket rule in simple mode). */
export const SIMPLE_BRANCH_PREFIX = 'sb/';

/** The example the simple branch messages show. */
export const SIMPLE_BRANCH_EXAMPLE = `${SIMPLE_BRANCH_PREFIX}short-description`;

/** The longest title taken from a message (whole words; the title itself may have 80 characters). */
export const MESSAGE_TITLE_MAX = 60;

/**
 * The title a message gives when the title field is empty: its first line with
 * text, whitespace collapsed, cut to whole words of at most
 * {@link MESSAGE_TITLE_MAX} characters with `…` when cut (a first word longer
 * than that is cut inside); `''` for a message without text.
 * `Fix the login redirect.\nDetails…` → `Fix the login redirect.`
 */
export function titleFromMessage(message: string): string {
  const line = message.split(/\r?\n/).map((text) => text.replace(/\s+/g, ' ').trim()).find((text) => text !== '') ?? '';
  if (line.length <= MESSAGE_TITLE_MAX) return line;
  let out = '';
  for (const word of line.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > MESSAGE_TITLE_MAX - 1) break;
    out = next;
  }
  if (out === '') out = line.slice(0, MESSAGE_TITLE_MAX - 1);
  return `${out.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** The title a simple start sends: the field trimmed, else {@link titleFromMessage}; `''` = none. */
export function simpleTitle(title: string, message: string): string {
  return title.trim() || titleFromMessage(message);
}

/** The short name of a simple start: the D22 rule over {@link simpleTitle} (`session` when neither has text). */
export function simpleShortName(title: string, message: string, taken: Iterable<string>): string {
  return shortNameFromTitle(simpleTitle(title, message), taken);
}

/** The worktree branch a simple session gets by default: `sb/<name>` (the server's default too). */
export function simpleBranchOfName(name: string): string {
  return `${SIMPLE_BRANCH_PREFIX}${name}`;
}

/**
 * The branch the simple form derives (D56): a title that starts with a ticket
 * key keeps D32's pre-fill (`PROJ-1984 Purchase` → `PROJ-1984-purchase`), any
 * other title gives `sb/<short name>` (`Fix login` → `sb/fix-login`).
 */
export function simpleBranchFromTitle(title: string, name: string): string {
  return branchFromTitle(title) ?? simpleBranchOfName(name);
}
