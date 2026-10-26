import { describe, expect, it } from 'vitest';
import { CLAMP_LINES, clampsIn, plainText } from '../../src/web/v2/shared/card-markdown.ts';

/**
 * Fix after 2.0 · Markdown in the answer card: the plain text of a Markdown string
 * (an option description's tooltip, the card's aria-label, the answered line) and
 * which variants fold long text behind Show more.
 */

describe('plainText', () => {
  it('drops emphasis, inline code and strike marks, keeping the words', () => {
    expect(plainText('Deploy **Acme EU** with `npm run deploy` and _then_ *check* ~~it~~')).toBe('Deploy Acme EU with npm run deploy and then check it');
    expect(plainText('__bold__ text')).toBe('bold text');
  });

  it('keeps what is inside inline code verbatim (no emphasis stripped there)', () => {
    expect(plainText('Run `a **b** c` now')).toBe('Run a **b** c now');
    expect(plainText('Use ``code with ` tick``')).toBe('Use code with ` tick');
  });

  it('keeps a link or image text, not its URL', () => {
    expect(plainText('See [the Acme docs](https://acme.example/docs) and ![logo](https://acme.example/l.png)')).toBe('See the Acme docs and logo');
    expect(plainText('Mail <mailto:ops@acme.example>')).toBe('Mail mailto:ops@acme.example');
  });

  it('drops heading and quote marks, bullets list items, drops fences but keeps the code', () => {
    expect(plainText('# Plan\n> quoted\n- one\n* two\n- [x] done\n\n```ts\nconst a = 1;\n```')).toBe('Plan\nquoted\n• one\n• two\n• done\nconst a = 1;');
  });

  it('leaves plain text and intraword underscores or asterisks alone', () => {
    expect(plainText('Acme EU')).toBe('Acme EU');
    expect(plainText('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4');
    expect(plainText('  spaced   out  ')).toBe('spaced out');
  });
});

describe('clampsIn', () => {
  it('folds long Markdown only in the queue (Needs you, Home), after 8 lines', () => {
    expect(CLAMP_LINES).toBe(8);
    expect(clampsIn('queue')).toBe(true);
    for (const variant of ['chat', 'popover', 'phone'] as const) expect(clampsIn(variant)).toBe(false);
  });
});
