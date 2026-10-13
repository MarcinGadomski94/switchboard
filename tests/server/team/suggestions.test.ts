import { describe, expect, it } from 'vitest';
import type { SuggestionEvidence, TeamSuggestion } from '../../../src/core/team.ts';
import { classifySuggestion, dedupeSuggestions } from '../../../src/server/team/suggestions.ts';

/** D100 · the suggestions' heuristics: enough signal and a template's pattern, or nothing. */

const base: SuggestionEvidence = { repos: 1, loops: 0, cliLoops: 0, events7d: 120, edits: 0, reads: 0, editRatio: null, planning: 0 };
const ev = (patch: Partial<SuggestionEvidence>): SuggestionEvidence => ({ ...base, ...patch });

describe('D100 · suggestions: classifySuggestion', () => {
  it('suggests nothing with too little activity, whatever the pattern', () => {
    expect(classifySuggestion(ev({ events7d: 4 }))).toBeNull();
    expect(classifySuggestion(ev({ events7d: 49, edits: 40, reads: 2, editRatio: 0.95 }))).toBeNull();
    expect(classifySuggestion(ev({ events7d: 49, loops: 2 }))).toBeNull();
  });

  it('suggests nothing without a clear pattern (no generic Planner)', () => {
    expect(classifySuggestion(ev({}))).toBeNull();
    expect(classifySuggestion(ev({ edits: 4, reads: 6, editRatio: 0.4 }))).toBeNull();
    expect(classifySuggestion(ev({ edits: 1, reads: 2, editRatio: 0.33 }))).toBeNull();
  });

  it('matches the templates\' patterns', () => {
    expect(classifySuggestion(ev({ loops: 1, reads: 30, editRatio: 0 }))?.templateId).toBe('on-call');
    expect(classifySuggestion(ev({ cliLoops: 2 }))?.templateId).toBe('delivery-tracking');
    expect(classifySuggestion(ev({ edits: 18, reads: 6, editRatio: 0.75 }))).toEqual({ templateId: 'developer', reason: '75% of its 24 file tool calls edit: looks like implementation.' });
    expect(classifySuggestion(ev({ reads: 40, edits: 2, editRatio: 0.05 }))?.templateId).toBe('reviewer');
    expect(classifySuggestion(ev({ planning: 8, reads: 5, editRatio: 0 }))?.templateId).toBe('planner');
    expect(classifySuggestion(ev({ planning: 8, edits: 20, reads: 5, editRatio: 0.8 }))?.templateId).toBe('developer');
  });

  it('keeps one suggestion per template among identical evidence', () => {
    const s = (id: string, score: number, evidence: SuggestionEvidence, templateId = 'developer'): TeamSuggestion => ({ sessionId: id, title: id, folder: null, evidence, templateId, reason: '', score, charterDraft: null });
    const same = ev({ edits: 18, reads: 6, editRatio: 0.75 });
    const out = dedupeSuggestions([s('a', 100, same), s('b', 120, same), s('c', 100, ev({ edits: 19, reads: 6, editRatio: 0.76 })), s('d', 100, same, 'on-call')]);
    expect(out.map((x) => x.sessionId)).toEqual(['b', 'c', 'd']);
  });
});
