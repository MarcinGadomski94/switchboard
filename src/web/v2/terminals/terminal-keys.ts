/**
 * D170 · the phone's terminal key bar (`docs/terminals.md` → *On a phone*): what each key sends.
 * Pure, unit-tested.
 */

/** A key of the bar (`ctrl` is sticky: the next letter typed becomes its control character). */
export type TerminalKey = 'esc' | 'tab' | 'ctrl' | 'up' | 'down' | 'left' | 'right' | 'ctrlC';

/** The bytes a key of the bar sends (`ctrl` sends nothing by itself). */
export function keySequence(key: TerminalKey): string {
  switch (key) {
    case 'esc':
      return '\x1b';
    case 'tab':
      return '\t';
    case 'up':
      return '\x1b[A';
    case 'down':
      return '\x1b[B';
    case 'right':
      return '\x1b[C';
    case 'left':
      return '\x1b[D';
    case 'ctrlC':
      return '\x03';
    case 'ctrl':
      return '';
  }
}

/** A character typed after the sticky Ctrl: a letter (or `@[\]^_`) becomes its control character; anything else is sent as it is. */
export function ctrlOf(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : char;
}
