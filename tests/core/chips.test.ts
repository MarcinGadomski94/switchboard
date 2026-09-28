import { describe, expect, it } from 'vitest';
import { type ChipSession, sessionChips } from '../../src/core/derive/chips.ts';

const base: ChipSession = { workType: 'feature', mode: 'single', phase: 'ui-first', qaStack: null, solutions: ['acme-app-front'], ultracode: false };
const text = (chips: ReturnType<typeof sessionChips>) => chips.map((c) => `${c.k} ${c.v}${c.loop ? ' [blue]' : ''}`);

describe('session header chips (M4.1)', () => {
  it('the session-start answers in the prototype new-session words (nsLaunch)', () => {
    expect(text(sessionChips(base))).toEqual(['work feature-building', 'mode single-solution', 'phase UI-first', 'scope acme-app-front']);
    expect(text(sessionChips({ ...base, mode: 'orchestrator', phase: 'integration', solutions: ['acme-app-front', 'mobile'], ultracode: true }))).toEqual([
      'work feature-building',
      'mode orchestrator',
      'phase integration',
      'scope acme-app-front + mobile',
      'ultracode on [blue]',
    ]);
  });

  it('a QA session shows its stack; unknown answers are left out, never invented', () => {
    expect(text(sessionChips({ ...base, workType: 'qa', mode: 'orchestrator', qaStack: 'both' }))).toEqual([
      'work test-authoring (QA)',
      'mode orchestrator',
      'phase UI-first',
      'stack both',
      'scope acme-app-front',
    ]);
    expect(sessionChips({ workType: null, mode: null, phase: null, qaStack: 'web', solutions: [], ultracode: false })).toEqual([]);
  });

  it('observed loops are blue: a Workflow is a "run" chip, anything else a "loop" chip (label, else the kind)', () => {
    const chips = sessionChips(base, [
      { kind: 'Workflow', label: 'workflow 7f3a · reconcile' },
      { kind: 'Ralph', label: 'Ralph · loop-until-dry' },
      { kind: '/loop', label: null },
      { kind: 'CronCreate', label: '  ' },
    ]);
    expect(text(chips).slice(4)).toEqual(['run workflow 7f3a · reconcile [blue]', 'loop Ralph · loop-until-dry [blue]', 'loop /loop [blue]', 'loop CronCreate [blue]']);
  });
});
