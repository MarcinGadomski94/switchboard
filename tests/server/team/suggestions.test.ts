import { afterEach, describe, expect, it } from 'vitest';
import type { SuggestionEvidence, TeamSuggestion } from '../../../src/core/team.ts';
import type { Store } from '../../../src/server/db/store.ts';
import type { LoopService } from '../../../src/server/loops/owned.ts';
import { behaviourTemplate, classifySuggestion, computeSuggestions, dedupeSuggestions, titleTemplate } from '../../../src/server/team/suggestions.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/** D100 · the suggestions' heuristics: enough signal, then the title and / or a behaviour pattern, with a confidence; or nothing. */

const base: SuggestionEvidence = { repos: 1, loops: 0, cliLoops: 0, events7d: 120, edits: 0, reads: 0, editRatio: null, planning: 0 };
const ev = (patch: Partial<SuggestionEvidence>): SuggestionEvidence => ({ ...base, ...patch });

describe('D100 · suggestions: classifySuggestion (behaviour only)', () => {
  it('suggests nothing with too little activity, whatever the pattern or title', () => {
    expect(classifySuggestion(ev({ events7d: 4 }))).toBeNull();
    expect(classifySuggestion(ev({ events7d: 49, edits: 40, reads: 2, editRatio: 0.95 }))).toBeNull();
    expect(classifySuggestion(ev({ events7d: 49, loops: 2 }))).toBeNull();
    expect(classifySuggestion(ev({ events7d: 49, loops: 2 }), 'Acme KPI tracking')).toBeNull();
  });

  it('suggests nothing without a title keyword or a clear pattern (no generic Planner)', () => {
    expect(classifySuggestion(ev({}))).toBeNull();
    expect(classifySuggestion(ev({}), 'Acme chat')).toBeNull();
    expect(classifySuggestion(ev({ edits: 4, reads: 6, editRatio: 0.4 }))).toBeNull();
    expect(classifySuggestion(ev({ edits: 1, reads: 2, editRatio: 0.33 }))).toBeNull();
  });

  it("matches the templates' patterns at medium confidence", () => {
    expect(classifySuggestion(ev({ loops: 1, reads: 30, editRatio: 0 }))).toMatchObject({ templateId: 'on-call', confidence: 'medium' });
    expect(classifySuggestion(ev({ cliLoops: 2 }))?.templateId).toBe('delivery-tracking');
    expect(classifySuggestion(ev({ edits: 18, reads: 6, editRatio: 0.75 }))).toEqual({ templateId: 'developer', reason: '75% of its 24 file tool calls edit: looks like implementation.', confidence: 'medium' });
    expect(classifySuggestion(ev({ reads: 40, edits: 2, editRatio: 0.05 }))?.templateId).toBe('reviewer');
    expect(classifySuggestion(ev({ planning: 8, reads: 5, editRatio: 0 }))?.templateId).toBe('planner');
    expect(classifySuggestion(ev({ planning: 8, edits: 20, reads: 5, editRatio: 0.8 }))?.templateId).toBe('developer');
  });

  it('loops alone do not make a monitor: an orchestrator that reads a lot but edits every day is not On-call', () => {
    // 45 edits over 2 active days (22 a day) with a loop and a 10 % edit ratio: orchestrating, not watching.
    expect(behaviourTemplate(ev({ loops: 1, edits: 45, reads: 400, editRatio: 0.1, activeDays: 2 }))).toBeNull();
    // Under 3 edits per active day with a loop: watching.
    expect(behaviourTemplate(ev({ loops: 1, edits: 10, reads: 400, editRatio: 0.02, activeDays: 7 }))?.templateId).toBe('on-call');
    // Without activeDays (an older machine) the edits count as one day: stricter.
    expect(behaviourTemplate(ev({ loops: 1, edits: 10, reads: 400, editRatio: 0.02 }))).toBeNull();
  });

  it('a middle edit ratio with many file calls and real edits is a Developer at medium confidence', () => {
    expect(classifySuggestion(ev({ edits: 60, reads: 110, editRatio: 0.35 }))).toEqual({ templateId: 'developer', reason: '60 edits in 170 file tool calls: looks like implementation.', confidence: 'medium' });
    expect(classifySuggestion(ev({ edits: 19, reads: 40, editRatio: 0.32 }))).toBeNull();
    expect(classifySuggestion(ev({ edits: 8, reads: 20, editRatio: 0.29 }))).toBeNull();
  });
});

describe('D100 · suggestions: the title', () => {
  it('maps title keywords to templates, whole words only', () => {
    expect(titleTemplate('Acme KPI tracking and metrics')).toEqual({ templateId: 'delivery-tracking', words: ['KPI', 'tracking', 'metrics'] });
    expect(titleTemplate('Acme dashboard report')?.templateId).toBe('delivery-tracking');
    expect(titleTemplate('Monitor prod errors')?.templateId).toBe('on-call');
    expect(titleTemplate('Acme log monitoring')?.templateId).toBe('on-call');
    expect(titleTemplate('Acme incidents')?.templateId).toBe('on-call');
    expect(titleTemplate('Q4 roadmap')?.templateId).toBe('planner');
    expect(titleTemplate('Acme planning')?.templateId).toBe('planner');
    expect(titleTemplate('PROJ-123 feature')?.templateId).toBe('developer');
    expect(titleTemplate('Acme epic implementation')?.templateId).toBe('developer');
    expect(titleTemplate('PROJ-123 Jira ticket')?.templateId).toBe('developer');
    expect(titleTemplate('Acme maintenance')?.templateId).toBe('developer');
    expect(titleTemplate('Fix the login bug')?.templateId).toBe('developer');
    expect(titleTemplate('PR review')?.templateId).toBe('reviewer');
    expect(titleTemplate('Acme QA')?.templateId).toBe('reviewer');
    expect(titleTemplate('Release 2.4')?.templateId).toBe('release-manager');
    // "Platform" is not "plan"; "implementation" is not "plan" either.
    expect(titleTemplate('Acme platform')).toBeNull();
    expect(titleTemplate('board-watch')).toBeNull();
    expect(titleTemplate(null)).toBeNull();
  });

  it('title + behaviour agree → high, naming both', () => {
    expect(classifySuggestion(ev({ loops: 1, edits: 86, reads: 126, editRatio: 0.41, activeDays: 7 }), 'Acme KPI tracking')).toEqual({
      templateId: 'delivery-tracking',
      reason: 'The title (“KPI”, “tracking”) and the behaviour (1 recurring loop) agree: looks like tracking.',
      confidence: 'high',
    });
    // An orchestrating implementation session: reads a lot, has a loop, still edits.
    expect(classifySuggestion(ev({ loops: 1, edits: 45, reads: 403, editRatio: 0.1, activeDays: 2 }), 'Acme implementation')).toMatchObject({ templateId: 'developer', confidence: 'high' });
    expect(classifySuggestion(ev({ edits: 41, reads: 12, editRatio: 0.77 }), 'PROJ-123 ticket')).toEqual({
      templateId: 'developer',
      reason: 'The title (“ticket”) and the behaviour (77% of its 53 file tool calls edit) agree: looks like implementation.',
      confidence: 'high',
    });
    expect(classifySuggestion(ev({ planning: 9, reads: 30, editRatio: 0 }), 'Acme roadmap')).toMatchObject({ templateId: 'planner', confidence: 'high' });
  });

  it('title and behaviour disagree → the title wins at medium, naming both', () => {
    expect(classifySuggestion(ev({ edits: 71, reads: 66, editRatio: 0.52 }), 'Acme planning')).toEqual({
      templateId: 'planner',
      reason: 'The title (“planning”) says planning; the behaviour (52% of its 137 file tool calls edit) looks like implementation. Going by the title.',
      confidence: 'medium',
    });
  });

  it('a title alone → medium; with almost no file activity and no loops → low', () => {
    expect(classifySuggestion(ev({ edits: 5, reads: 10, editRatio: 0.33 }), 'Acme release')).toMatchObject({ templateId: 'release-manager', confidence: 'medium' });
    expect(classifySuggestion(ev({ events7d: 200 }), 'Acme maintenance')).toEqual({
      templateId: 'developer',
      reason: 'The title (“maintenance”) says implementation; the behaviour shows no clear pattern (almost no file activity).',
      confidence: 'low',
    });
  });
});

describe('D100 · suggestions: dedupeSuggestions', () => {
  it('keeps one suggestion per template among identical evidence', () => {
    const s = (id: string, score: number, evidence: SuggestionEvidence, templateId = 'developer'): TeamSuggestion => ({ sessionId: id, title: id, folder: null, evidence, templateId, reason: '', score, charterDraft: null });
    const same = ev({ edits: 18, reads: 6, editRatio: 0.75 });
    const out = dedupeSuggestions([s('a', 100, same), s('b', 120, same), s('c', 100, ev({ edits: 19, reads: 6, editRatio: 0.76 })), s('d', 100, same, 'on-call')]);
    expect(out.map((x) => x.sessionId)).toEqual(['b', 'c', 'd']);
  });
});

describe('D100 · suggestions: computeSuggestions over a store', () => {
  let dir: string | null = null;
  let store: Store | null = null;
  afterEach(async () => {
    await store?.close();
    store = null;
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  it('counts done and idle (not closed) sessions, reads the title, and returns the confidence and active days', async () => {
    dir = await makeTempDir('sb-suggest-');
    store = await openTempStore(dir);
    const now = Date.now();
    const tracker = await store.sessions.create({ name: 'acme-tracking', title: 'Acme KPI tracking', claudeSessionId: 'c-1', attached: true, status: 'done' });
    const builder = await store.sessions.create({ name: 'proj-123', title: 'PROJ-123 feature', claudeSessionId: 'c-2', attached: true, status: 'idle' });
    const quiet = await store.sessions.create({ name: 'acme-chat', title: 'Acme chat', claudeSessionId: 'c-3', attached: true });
    const day = (n: number): string => new Date(now - n * 24 * 3600_000).toISOString();
    for (let i = 0; i < 60; i++) await store.events.append({ sessionId: tracker.id, kind: 'tool', ts: day(i % 3), payload: { type: 'tool', name: i % 2 === 0 ? 'Edit' : 'Read' } });
    for (let i = 0; i < 60; i++) await store.events.append({ sessionId: builder.id, kind: 'tool', ts: day(0), payload: { type: 'tool', name: i % 4 === 0 ? 'Read' : 'Edit' } });
    for (let i = 0; i < 60; i++) await store.events.append({ sessionId: quiet.id, kind: 'tool', ts: day(0), payload: { type: 'tool', name: 'Bash' } });
    const loops = { list: async (sessionId: string) => (sessionId === tracker.id ? [{ id: 'l-1', state: 'active' }] : []) } as unknown as LoopService;
    const out = await computeSuggestions({ store, loops, exclude: new Set(), now });
    const byId = new Map(out.map((s) => [s.sessionId, s]));
    expect(byId.get(tracker.id)).toMatchObject({ title: 'Acme KPI tracking', templateId: 'delivery-tracking', confidence: 'high', evidence: { loops: 1, activeDays: 3 } });
    expect(byId.get(builder.id)).toMatchObject({ templateId: 'developer', confidence: 'high', evidence: { activeDays: 1 } });
    expect(byId.has(quiet.id)).toBe(false);
  });
});
