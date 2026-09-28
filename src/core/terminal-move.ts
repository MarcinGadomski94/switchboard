/**
 * D16 (`docs/decisions.md`): a conversation started in a terminal continues in
 * Switchboard as the same conversation. The pure rules shared by the server
 * (`src/server/history/continue.ts`) and the UI (the New-session form's preview):
 * the name a moved session gets. `docs/derivations.md` → *History* → *Continue in
 * Switchboard*.
 */

/** A session name (contract: kebab-case; the server's `SESSION_NAME` in `src/server/sessions/validate.ts`), at most 64 characters. */
export const SESSION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest name taken from a title or a prompt, before a `-2`… suffix (session names allow 64). */
export const MOVED_NAME_MAX = 40;

/** The name of a conversation that has neither a title nor a prompt worth a name. */
export const MOVED_NAME_FALLBACK = 'terminal-session';

/**
 * `text` as a kebab-case session name (`[a-z0-9]` words joined by single dashes):
 * accents dropped, everything else a separator, whole words only up to `max`
 * characters (a first word longer than that is cut). Empty when nothing is left.
 */
export function kebabName(text: string, max: number = MOVED_NAME_MAX): string {
  const plain = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const word of plain.split(/[^a-z0-9]+/).filter(Boolean)) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > max) {
      if (!out) out = word.slice(0, max);
      break;
    }
    out = next;
  }
  return out;
}

/** `base`, else `base-2`, `base-3`, … : the first one not in `taken`. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What a moved session's name is made from (the transcript's facts). */
export interface MovedNameSource {
  /** The last `custom-title` (`--name`, `/rename`). */
  readonly customTitle?: string | null;
  /** The last `ai-title`. */
  readonly aiTitle?: string | null;
  readonly firstPrompt?: string | null;
  /** The first slash command (`/loop 1h Watch the build`), for a conversation without a prompt. */
  readonly firstCommand?: string | null;
}

/**
 * The name a moved conversation gets (D16): its title (custom, else AI), else its
 * first prompt, else its first command, in kebab-case ({@link kebabName}), made
 * unique against `taken` ({@link uniqueName}); {@link MOVED_NAME_FALLBACK} when
 * none of them has a letter or a digit.
 */
export function movedSessionName(source: MovedNameSource, taken: ReadonlySet<string>): string {
  const candidates = [source.customTitle, source.aiTitle, source.firstPrompt, source.firstCommand];
  const base = candidates.map((text) => (text ? kebabName(text) : '')).find((name) => name !== '') ?? MOVED_NAME_FALLBACK;
  return uniqueName(base, taken);
}
