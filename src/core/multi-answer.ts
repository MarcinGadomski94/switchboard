/**
 * D128 (`docs/decisions.md` → *Multi-select answers*): a `multiSelect` question is
 * answered with one or more options, plus optionally the developer's own words
 * ("Other…") alongside them. Claude Code takes such an answer as ONE string per
 * question in `updatedInput.answers`: the picked labels (and the own text, last)
 * joined with `", "`, where an item that itself contains `", "` or `"` is written
 * as a quoted JSON string so it can be read back. VERIFIED in the CLI 2.1.303
 * binary's bundled code, read-only (`docs/questions.md` → *Multi-select answers*):
 * its AskUserQuestion form joins a multi-select pick with exactly this helper, and
 * a parser next to it splits such a string back. The pure rule shared by the
 * server (the `control_response`, the stale-answers message), the Codex /
 * OpenCode bridges (string → items) and the question card.
 */

/** One item as the CLI writes it inside a joined answer: verbatim, or a JSON string when it holds `", "` or `"`. */
function itemText(item: string): string {
  return item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item;
}

/**
 * Several picked answers of one question as the CLI's one answer string: the items
 * in order joined with `", "`, an item holding `", "` or `"` written as a quoted
 * JSON string (the CLI's own multi-select join).
 */
export function joinAnswerItems(items: readonly string[]): string {
  return items.map(itemText).join(', ');
}

/**
 * The items of a joined answer string ({@link joinAnswerItems}), read back the way
 * the CLI does: a leading `"` starts a JSON string item, anything else runs to the
 * next `", "`. Empty items are dropped. A string that is not such a list (an
 * unterminated or invalid quoted item) is split on `", "` as plain text.
 */
export function splitAnswerItems(text: string): string[] {
  const items: string[] = [];
  let rest = text;
  for (;;) {
    if (rest.startsWith('"')) {
      const end = closingQuote(rest);
      let parsed: unknown = null;
      if (end > 0) {
        try {
          parsed = JSON.parse(rest.slice(0, end + 1));
        } catch {
          parsed = null;
        }
      }
      if (typeof parsed !== 'string') return plainSplit(text);
      items.push(parsed);
      rest = rest.slice(end + 1);
      if (rest === '') break;
      if (!rest.startsWith(', ')) return plainSplit(text);
      rest = rest.slice(2);
      continue;
    }
    const at = rest.indexOf(', ');
    if (at < 0) {
      items.push(rest);
      break;
    }
    items.push(rest.slice(0, at));
    rest = rest.slice(at + 2);
  }
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** The index of the `"` that closes the JSON string at the start of `text` (escapes skipped), or -1. */
function closingQuote(text: string): number {
  let escaped = false;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') return i;
  }
  return -1;
}

function plainSplit(text: string): string[] {
  return text
    .split(', ')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
