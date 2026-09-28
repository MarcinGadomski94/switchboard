/**
 * D32 (`docs/decisions.md` → *Ticket branches*): whenever the developer creates a
 * git worktree (a New-session worktree, "Move … to worktree"), its branch is named
 * after the ticket: the Jira-style key, its number and a kebab-case description,
 * e.g. `PROJ-0001-short-description`, with no `session/` prefix. The pure rules
 * shared by the server (validation) and the UI (the Branch fields): the check,
 * the tidying of typed text, and the name a session title suggests.
 * `docs/worktrees.md` → *Ticket branches*.
 */

/** A ticket branch: `KEY-123-kebab-description` (the key upper case, the description lower case). */
export const TICKET_BRANCH = /^[A-Z][A-Z0-9]*-[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The example every message and the fields' placeholder show. */
export const TICKET_BRANCH_EXAMPLE = 'PROJ-0001-short-description';

/** Why an empty branch is refused (422 on field `branch`). */
export const BRANCH_REQUIRED = `name the branch after its ticket: the key, its number and a short description, e.g. ${TICKET_BRANCH_EXAMPLE}`;

/** Why a branch that is not a ticket branch is refused (422 on field `branch`). */
export const BRANCH_RULE = `the branch must be a ticket key, its number and a short kebab-case description, e.g. ${TICKET_BRANCH_EXAMPLE}`;

/** Result of {@link checkTicketBranch}: the branch (trimmed), or why it is refused. */
export type TicketBranchCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string };

/**
 * A branch as the API takes it (D32): text that, once trimmed, matches
 * {@link TICKET_BRANCH}. Missing or blank → {@link BRANCH_REQUIRED}; anything
 * else → {@link BRANCH_RULE}. Nothing is tidied here: the UI tidies what the
 * developer typed ({@link tidyTicketBranch}), the server takes the name as sent.
 */
export function checkTicketBranch(value: unknown): TicketBranchCheck {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { ok: false, message: BRANCH_REQUIRED };
  if (typeof value !== 'string') return { ok: false, message: BRANCH_RULE };
  const name = value.trim();
  return TICKET_BRANCH.test(name) ? { ok: true, name } : { ok: false, message: BRANCH_RULE };
}

/** A ticket key and number at the start of kebab text, followed by the end or a `-`. */
const KEY_START = /^([A-Za-z][A-Za-z0-9]*)-([0-9]+)(?:-(.*))?$/;

/** `text` without accents (`é` → `e`), each run of anything but a letter or a digit one `-`, no `-` at either end. */
function kebab(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Tidies typed text into a ticket branch where it can (D32): trimmed, accents
 * dropped, each run of anything but a letter or a digit one `-` (none at either
 * end); when it starts with a ticket key and number (`proj-1984`, `PROJ 1984`),
 * the key is upper-cased and everything after the number lower-cased.
 * `proj-1984 Purchase Complete!` → `PROJ-1984-purchase-complete`. Text without a
 * key and number keeps its letters' case (it is not a ticket branch either way;
 * {@link checkTicketBranch} says why).
 */
export function tidyTicketBranch(text: string): string {
  const tidy = kebab(text.trim());
  const match = KEY_START.exec(tidy);
  if (!match) return tidy;
  const [, key = '', number = '', description] = match;
  return `${key.toUpperCase()}-${number}${description ? `-${description.toLowerCase()}` : ''}`;
}

/**
 * A title that starts with a ticket key and its number, in any case (developer
 * ruling 2026-09-28: `proj-1984 …` counts too; leading brackets or spaces allowed).
 */
const TITLE_KEY = /^[^A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*-[0-9]+(?![A-Za-z0-9])/;

/**
 * The branch a session title suggests (D32): the title tidied
 * ({@link tidyTicketBranch}) when it starts with a ticket key, else `null`.
 * `PROJ-1984 Purchase complete` → `PROJ-1984-purchase-complete`;
 * `[PROJ-1984] Purchase` → `PROJ-1984-purchase`; `PROJ-1984` → `PROJ-1984`
 * (no description yet: the field says what is missing). A lower-case key counts
 * too (`proj-1984 purchase` → `PROJ-1984-purchase`), so `mobile-360 layout`
 * suggests `MOBILE-360-layout`: only a suggestion the developer can edit.
 */
export function branchFromTitle(title: string): string | null {
  return TITLE_KEY.test(title.trim()) ? tidyTicketBranch(title) : null;
}
