import { describe, expect, it } from 'vitest';
import {
  branchFromHead,
  branchOwnerTitle,
  changesText,
  parsePhaseLedger,
  phaseLabel,
  solutionPhase,
  solutionStatus,
  summarizePhases,
} from '../../src/core/solutions-live.ts';

describe('parsePhaseLedger (gap #12: table or bullets, lenient)', () => {
  it('reads a markdown table: interface, phase cell, the rest as the seam', () => {
    const text = [
      '# Phase ledger',
      '',
      '| Interface | Phase | Seam |',
      '|---|:---:|---|',
      '| `FreeTalkService` | UI-first | mock-DI | fixtures/free-talk.json |',
      '| **ProfileConnector** | integration | Tier B green 09-24 |',
      '| NoPhaseHere | later | x |',
      '| | UI-first | no interface |',
    ].join('\n');
    expect(parsePhaseLedger(text)).toEqual([
      { interface: 'FreeTalkService', phase: 'UI-first', seam: 'mock-DI · fixtures/free-talk.json' },
      { interface: 'ProfileConnector', phase: 'integration', seam: 'Tier B green 09-24' },
    ]);
  });

  it('reads bullets with arrows, colons and dashes; skips prose, headings and fenced code', () => {
    const text = [
      'Interfaces of this solution (interface → phase → seam):',
      '',
      '- FreeTalkService → UI-first → seam TODO · FreeTalkViewModel.cs:41',
      '* `PushPreferencesClient`: integration — Tier A pending on BFF route',
      '1. Billing -> ui first',
      '- a bullet without any phase word',
      '```',
      '- Hidden → integration → in code',
      '```',
      '  - Nested: Integration | seam in Nested.cs',
    ].join('\r\n');
    expect(parsePhaseLedger(text)).toEqual([
      { interface: 'FreeTalkService', phase: 'UI-first', seam: 'seam TODO · FreeTalkViewModel.cs:41' },
      { interface: 'PushPreferencesClient', phase: 'integration', seam: 'Tier A pending on BFF route' },
      { interface: 'Billing', phase: 'UI-first', seam: '' },
      { interface: 'Nested', phase: 'integration', seam: 'seam in Nested.cs' },
    ]);
  });

  it('a file without entries gives an empty list; a phase word inside a longer name is not a phase', () => {
    expect(parsePhaseLedger('# Phase ledger\n\nNothing yet.\n')).toEqual([]);
    expect(parsePhaseLedger('- IntegrationService → UI-first → x')).toEqual([{ interface: 'IntegrationService', phase: 'UI-first', seam: 'x' }]);
  });

  it('phase words', () => {
    expect(phaseLabel('ui-first')).toBe('UI-first');
    expect(phaseLabel('UI first')).toBe('UI-first');
    expect(phaseLabel('Integration')).toBe('integration');
    expect(phaseLabel('none')).toBeNull();
  });
});

describe('row summaries', () => {
  it('phase: the ledger first (one phase or mixed), else the open sessions, else —', () => {
    const ui = { interface: 'A', phase: 'UI-first', seam: '' };
    const int = { interface: 'B', phase: 'integration', seam: '' };
    expect(solutionPhase([ui], ['integration'])).toBe('UI-first');
    expect(solutionPhase([ui, int], [])).toBe('mixed');
    expect(solutionPhase(null, ['integration', 'integration'])).toBe('integration');
    expect(solutionPhase([], ['ui-first', 'integration'])).toBe('mixed');
    expect(solutionPhase(null, [])).toBe('—');
    expect(summarizePhases([])).toBeNull();
  });

  it('status: the most urgent of the sessions on its branches', () => {
    expect(solutionStatus([])).toBe('idle');
    expect(solutionStatus(['done', 'run', 'need'])).toBe('need');
    expect(solutionStatus(['done', 'fail', 'run'])).toBe('fail');
    expect(solutionStatus(['done', 'paused', 'run'])).toBe('run');
    expect(solutionStatus(['done', 'paused'])).toBe('paused');
    expect(solutionStatus(['idle', 'done'])).toBe('done');
  });

  it('changes: +added, −removed when only removed, — without changes, locked when read-only', () => {
    expect(changesText(508, 12, false)).toBe('+508');
    expect(changesText(0, 12, false)).toBe('\u221212');
    expect(changesText(0, 0, false)).toBe('—');
    expect(changesText(5, 0, true)).toBe('locked');
  });

  it('branch from .git/HEAD: a ref, a detached commit, junk', () => {
    expect(branchFromHead('ref: refs/heads/main\n')).toBe('main');
    expect(branchFromHead('ref: refs/heads/feature/free-talk-360\n')).toBe('feature/free-talk-360');
    expect(branchFromHead('0123456789abcdef0123456789abcdef01234567\n')).toBe('0123456');
    expect(branchFromHead('garbage')).toBeNull();
  });

  it("D22: a branch owner's title is its session's display title (title, else name); null without a session", () => {
    expect(branchOwnerTitle({ name: 'jira-ticket-handling', title: 'JIRA Ticket handling' })).toBe('JIRA Ticket handling');
    expect(branchOwnerTitle({ name: 'button-rollout', title: null })).toBe('button-rollout');
    expect(branchOwnerTitle({ name: 'button-rollout' })).toBe('button-rollout');
    expect(branchOwnerTitle({ name: 'free-talk-640', title: 'free-talk-640' })).toBe('free-talk-640');
    expect(branchOwnerTitle(null)).toBeNull();
    expect(branchOwnerTitle(undefined)).toBeNull();
  });
});
