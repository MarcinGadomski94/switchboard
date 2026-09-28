/**
 * D22 (`docs/decisions.md` → *Session titles*): every session keeps its technical
 * short name (`name`: kebab-case, unique; its worktree `../{repo}-wt-{name}` and
 * branch `session/{name}` are built from it) and may carry a free-text **title**
 * (trimmed, 1–80 characters, not unique), which the UI shows wherever a session
 * is named. The pure rules shared by the server (validation, the scheduler, D16
 * moves) and the UI (the New-session form's live summary, every place that names
 * a session): the title check, the short name derived from a title, the name
 * the UI shows. `docs/derivations.md` → *Session titles*.
 */

/** Longest title, in characters after trimming. */
export const TITLE_MAX = 80;

/** Longest short name (the contract's kebab-case rule, `SESSION_NAME` in `src/server/sessions/validate.ts`). */
export const SHORT_NAME_MAX = 64;

/** The short name of a title that has no letter or digit. */
export const SHORT_NAME_FALLBACK = 'session';

/** Why a title is refused (the 422 message on field `title`). */
export const TITLE_RULE = `the title must be text of 1–${TITLE_MAX} characters`;

/** Result of {@link checkTitle}: the trimmed title, or why it is refused. */
export type TitleCheck = { readonly ok: true; readonly title: string } | { readonly ok: false; readonly message: string };

/** A title as the API takes it: text that is 1–{@link TITLE_MAX} characters once trimmed. */
export function checkTitle(value: unknown): TitleCheck {
  if (typeof value !== 'string') return { ok: false, message: TITLE_RULE };
  const title = value.trim();
  if (title.length === 0 || title.length > TITLE_MAX) return { ok: false, message: TITLE_RULE };
  return { ok: true, title };
}

/**
 * The short name a title gives before any `-2`… suffix: lower-case (accents
 * dropped), every run of anything but a letter or a digit becomes one `-`,
 * trimmed of `-`, at most `max` characters (and never ending in `-`);
 * {@link SHORT_NAME_FALLBACK} when nothing is left. `JIRA Ticket handling` →
 * `jira-ticket-handling`.
 */
export function shortNameBase(title: string, max: number = SHORT_NAME_MAX): string {
  const plain = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const kebab = plain
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Math.max(0, max))
    .replace(/-+$/, '');
  return kebab === '' ? SHORT_NAME_FALLBACK : kebab;
}

/**
 * The short name a new session gets from its title (D22): {@link shortNameBase},
 * and when that is in `taken`, the first free `<base>-2`, `<base>-3`, … (the base
 * cut so the whole stays within {@link SHORT_NAME_MAX} characters).
 */
export function shortNameFromTitle(title: string, taken: Iterable<string>): string {
  const names = taken instanceof Set ? (taken as ReadonlySet<string>) : new Set(taken);
  const base = shortNameBase(title);
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${shortNameBase(title, SHORT_NAME_MAX - suffix.length)}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

/** What {@link displayTitle} reads from a session (a `Session`, a stored record, a demo row). */
export interface TitledSession {
  readonly name: string;
  readonly title?: string | null;
  readonly displayTitle?: string;
}

/** The name the UI shows for a session (D22): its title, else its short name. */
export function displayTitle(session: TitledSession): string {
  return session.displayTitle || session.title || session.name;
}
