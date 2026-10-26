/**
 * Fix after 2.0 · Markdown in the answer card (`docs/design/v2-decisions.md` →
 * *Fixes after 2.0* → *Markdown in the answer card*): the rules that are not React,
 * kept here so they can be unit-tested.
 */

/** Where an answer card is shown (`AnswerCard`'s `variant`). */
export type CardVariant = 'queue' | 'chat' | 'popover' | 'phone';

/** Lines of Markdown a queue card shows before "Show more". */
export const CLAMP_LINES = 8;

/** `true` where long Markdown folds behind "Show more" (the queue cards: Needs you, Home). */
export function clampsIn(variant: CardVariant): boolean {
  return variant === 'queue';
}

/**
 * `markdown` as plain text, for places that cannot show Markdown (a `title`
 * tooltip, an `aria-label`, the answered line): emphasis, inline code and fence
 * markers, heading and quote marks go; a link or image keeps its text; list
 * items keep a bullet; blank lines and spaces collapse.
 */
export function plainText(markdown: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      lines.push(raw.trim());
      continue;
    }
    let line = raw
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '• ')
      .replace(/^\s*[-*+]\s+/, '• ');
    line = inline(line);
    lines.push(line.trim());
  }
  return lines
    .filter((line) => line !== '')
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** One line's inline Markdown as text. */
function inline(line: string): string {
  // Inline code first: what is inside it is kept verbatim.
  const codes: string[] = [];
  let out = line.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_match, _ticks: string, code: string) => {
    codes.push(code.trim());
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2');
  return out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? '');
}
