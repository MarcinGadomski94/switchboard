import { describe, expect, it } from 'vitest';
import {
  SHORT_NAME_FALLBACK,
  SHORT_NAME_MAX,
  TITLE_MAX,
  TITLE_RULE,
  checkTitle,
  displayTitle,
  shortNameBase,
  shortNameFromTitle,
} from '../../src/core/session-title.ts';
import { SESSION_NAME_PATTERN } from '../../src/core/terminal-move.ts';

/** D22 (`docs/decisions.md` → *Session titles*): the title check and the short name derived from a title. */
describe('short name from a title (D22)', () => {
  it('lower-cases and turns every run of anything but letters and digits into one dash, trimmed', () => {
    expect(shortNameBase('JIRA Ticket handling')).toBe('jira-ticket-handling');
    expect(shortNameBase('  Fix: the login (again)!  ')).toBe('fix-the-login-again');
    expect(shortNameBase('free-talk-640')).toBe('free-talk-640');
    expect(shortNameBase('--a__b--')).toBe('a-b');
    expect(shortNameBase('Café déjà vu')).toBe('cafe-deja-vu');
  });

  it('is never empty: a title without a letter or a digit gives "session"', () => {
    expect(shortNameBase('')).toBe(SHORT_NAME_FALLBACK);
    expect(shortNameBase('  !!! ')).toBe('session');
    expect(shortNameBase('日本語')).toBe('session');
  });

  it('keeps at most 64 characters and never ends in a dash', () => {
    const long = 'word '.repeat(40);
    const name = shortNameBase(long);
    expect(name.length).toBeLessThanOrEqual(SHORT_NAME_MAX);
    expect(name).toMatch(SESSION_NAME_PATTERN);
    expect(name.endsWith('-')).toBe(false);
    expect(shortNameBase('a'.repeat(70))).toBe('a'.repeat(64));
    // Cut right after a separator: the dash is dropped.
    expect(shortNameBase(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
  });

  it('adds -2, -3, … when the short name is taken', () => {
    expect(shortNameFromTitle('JIRA Ticket handling', [])).toBe('jira-ticket-handling');
    expect(shortNameFromTitle('JIRA Ticket handling', ['jira-ticket-handling'])).toBe('jira-ticket-handling-2');
    expect(shortNameFromTitle('JIRA Ticket handling', new Set(['jira-ticket-handling', 'jira-ticket-handling-2']))).toBe('jira-ticket-handling-3');
    expect(shortNameFromTitle('', ['session'])).toBe('session-2');
    // A different title with the same short name collides the same way.
    expect(shortNameFromTitle('jira ticket: handling', ['jira-ticket-handling'])).toBe('jira-ticket-handling-2');
  });

  it('cuts the base so a suffixed name still fits 64 characters', () => {
    const title = 'b'.repeat(64);
    const second = shortNameFromTitle(title, [title]);
    expect(second).toBe(`${'b'.repeat(62)}-2`);
    expect(second).toHaveLength(64);
    const tenth = shortNameFromTitle(title, [title, ...Array.from({ length: 8 }, (_, i) => `${'b'.repeat(62)}-${i + 2}`)]);
    expect(tenth).toBe(`${'b'.repeat(61)}-10`);
    expect(tenth).toMatch(SESSION_NAME_PATTERN);
  });
});

describe('title check (D22)', () => {
  it('takes text of 1–80 characters, trimmed', () => {
    expect(checkTitle('  JIRA Ticket handling ')).toEqual({ ok: true, title: 'JIRA Ticket handling' });
    expect(checkTitle('x'.repeat(TITLE_MAX))).toEqual({ ok: true, title: 'x'.repeat(80) });
    expect(checkTitle(` ${'x'.repeat(80)} `)).toEqual({ ok: true, title: 'x'.repeat(80) });
  });

  it('refuses an empty, an 81-character or a non-text title', () => {
    for (const value of ['', '   ', 'x'.repeat(81), 42, null, undefined, ['a']]) {
      expect(checkTitle(value), JSON.stringify(value)).toEqual({ ok: false, message: TITLE_RULE });
    }
  });
});

describe('display title (D22)', () => {
  it('is the title, else the name', () => {
    expect(displayTitle({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' })).toBe('JIRA Ticket handling');
    expect(displayTitle({ name: 'free-talk-640', title: null })).toBe('free-talk-640');
    expect(displayTitle({ name: 'free-talk-640' })).toBe('free-talk-640');
    expect(displayTitle({ name: 'n', title: 't', displayTitle: 'shown' })).toBe('shown');
  });
});
