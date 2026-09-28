import { describe, expect, it } from 'vitest';
import {
  BRANCH_REQUIRED,
  BRANCH_RULE,
  TICKET_BRANCH,
  TICKET_BRANCH_EXAMPLE,
  branchFromTitle,
  checkTicketBranch,
  tidyTicketBranch,
} from '../../src/core/ticket-branch.ts';

describe('TICKET_BRANCH (D32)', () => {
  it('takes a Jira-style key, its number and a kebab-case description', () => {
    for (const name of ['PROJ-0001-test-branch-name', 'PROJD-0001-test-ticket-name', 'PROJ-1984-purchase-complete', 'A-1-x', 'AB2-99-v2-fix', TICKET_BRANCH_EXAMPLE]) {
      expect(TICKET_BRANCH.test(name), name).toBe(true);
    }
  });

  it('refuses lower-case keys, a missing number or description, upper-case descriptions, prefixes and stray separators', () => {
    for (const name of [
      'proj-0001-test-branch-name',
      'Proj-0001-test',
      'PROJ-0001',
      'PROJ-0001-',
      'PROJ-test-branch',
      'SLIT0001-test',
      '1SLIT-0001-test',
      'PROJ-0001-Test-Branch',
      'PROJ-0001-test--branch',
      'PROJ-0001-test_branch',
      'session/free-talk',
      'feature/PROJ-0001-test',
      ' PROJ-0001-test',
      '',
    ]) {
      expect(TICKET_BRANCH.test(name), name).toBe(false);
    }
  });
});

describe('checkTicketBranch (D32)', () => {
  it('passes a ticket branch (trimmed)', () => {
    expect(checkTicketBranch('PROJD-0001-test-ticket-name')).toEqual({ ok: true, name: 'PROJD-0001-test-ticket-name' });
    expect(checkTicketBranch('  PROJ-7-fix  ')).toEqual({ ok: true, name: 'PROJ-7-fix' });
  });

  it('says a missing branch is required, anything else is not a ticket branch; both messages show an example', () => {
    for (const value of [undefined, null, '', '   ']) expect(checkTicketBranch(value)).toEqual({ ok: false, message: BRANCH_REQUIRED });
    for (const value of ['proj-0001-test', 'PROJ-0001', 'session/x', 42, ['PROJ-1-x']]) expect(checkTicketBranch(value)).toEqual({ ok: false, message: BRANCH_RULE });
    expect(BRANCH_REQUIRED).toContain('e.g. PROJ-0001-short-description');
    expect(BRANCH_RULE).toContain('e.g. PROJ-0001-short-description');
  });
});

describe('tidyTicketBranch (D32)', () => {
  it('upper-cases the key, lower-cases the description, turns runs of other characters into one dash', () => {
    expect(tidyTicketBranch('proj-1984 Purchase Complete!')).toBe('PROJ-1984-purchase-complete');
    expect(tidyTicketBranch('  PROJD-0001 Test   ticket__name  ')).toBe('PROJD-0001-test-ticket-name');
    expect(tidyTicketBranch('proj 1984: purchase / complete')).toBe('PROJ-1984-purchase-complete');
    expect(tidyTicketBranch('[PROJ-12] Café crème')).toBe('PROJ-12-cafe-creme');
    expect(tidyTicketBranch('PROJ-0001-test-branch-name')).toBe('PROJ-0001-test-branch-name');
  });

  it('keeps a key without a description, and the text as is (separators only) without a key', () => {
    expect(tidyTicketBranch('proj-1984')).toBe('PROJ-1984');
    expect(tidyTicketBranch('proj-1984 ')).toBe('PROJ-1984');
    expect(tidyTicketBranch('Purchase complete')).toBe('Purchase-complete');
    expect(tidyTicketBranch('SLIT1984 x')).toBe('SLIT1984-x');
    expect(tidyTicketBranch('')).toBe('');
    expect(tidyTicketBranch(' !! ')).toBe('');
  });

  it('gives a ticket branch for typical typed text', () => {
    for (const typed of ['proj-1984 Purchase Complete!', 'projd-0001 test ticket name', 'PROJ 7 fix']) expect(checkTicketBranch(tidyTicketBranch(typed)).ok, typed).toBe(true);
  });
});

describe('branchFromTitle (D32)', () => {
  it('suggests the tidied title when it starts with an upper-case ticket key', () => {
    expect(branchFromTitle('PROJ-1984 Purchase complete')).toBe('PROJ-1984-purchase-complete');
    expect(branchFromTitle('PROJD-0001-test-ticket-name')).toBe('PROJD-0001-test-ticket-name');
    expect(branchFromTitle('PROJD-0001 Test ticket name')).toBe('PROJD-0001-test-ticket-name');
    expect(branchFromTitle(' [PROJ-12] Fix the build ')).toBe('PROJ-12-fix-the-build');
    expect(branchFromTitle('PROJ-12: Fix')).toBe('PROJ-12-fix');
  });

  it('suggests the key alone when the title has no description yet (the field says what is missing)', () => {
    expect(branchFromTitle('PROJ-1984')).toBe('PROJ-1984');
    expect(checkTicketBranch(branchFromTitle('PROJ-1984')).ok).toBe(false);
  });

  it('a lower-case key counts too, upper-cased (developer ruling 2026-09-28)', () => {
    expect(branchFromTitle('proj-1984 purchase complete')).toBe('PROJ-1984-purchase-complete');
    expect(branchFromTitle('Proj-1984 purchase')).toBe('PROJ-1984-purchase');
    expect(branchFromTitle('projd-0001 Test ticket name')).toBe('PROJD-0001-test-ticket-name');
    // Only a suggestion: a title that merely looks like a key suggests one too.
    expect(branchFromTitle('mobile-360 layout')).toBe('MOBILE-360-layout');
  });

  it('suggests nothing without a ticket key at the start', () => {
    for (const title of ['free-talk-640', 'Fix PROJ-1984', 'PROJ-1984purchase', 'PROJ purchase', '', 'JIRA Ticket handling']) {
      expect(branchFromTitle(title), title).toBeNull();
    }
  });
});
