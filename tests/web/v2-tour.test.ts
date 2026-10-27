import { describe, expect, it } from 'vitest';
import {
  MAIN_TOUR_ID,
  MAX_V2_TOUR_STEPS,
  type TourStatus,
  type TutorialState,
  V2_COVERS,
  V2_WELCOME_ID,
  WHATS_NEW,
  coveredByWelcome,
  isV2Tour,
  pendingTours,
  toursForUi,
  v2AutoTours,
} from '../../src/core/tutorial.ts';
import { endV2Tours, missingMove, nextLabel, startV2Tours, v2Features, v2KickerOf, v2PathOf, v2StepsOf, v2TourRunning, v2ToursOf } from '../../src/web/v2/tour/tour-model.ts';
import { TOUR_WORDS } from '../../src/web/v2/glossary.ts';

/** D131 · lane X · the v2 tour's pure rules (docs/tutorial.md → Two themes). */

function stateOf(statuses: Readonly<Record<string, TourStatus | null>>, options: { readonly main?: TourStatus | null; readonly autoOpen?: boolean } = {}): TutorialState {
  return {
    autoOpen: options.autoOpen ?? true,
    install: 'existing',
    lastVersion: '2.0.0',
    main: { status: options.main ?? null, updatedAt: null },
    whatsNew: WHATS_NEW.map((feature) => ({ id: feature.id, title: feature.title, version: feature.version, status: statuses[feature.id] ?? null, updatedAt: null })),
  };
}

const welcome = WHATS_NEW.find((feature) => feature.id === V2_WELCOME_ID);

describe('the v2 welcome tour', () => {
  it('is a v2 tour of 2.0.0 with Home, the start box, Agents, the agent view, Projects and Crews, and Appearance', () => {
    expect(welcome?.ui).toBe('v2');
    expect(welcome?.version).toBe('2.0.0');
    expect(welcome?.title).toBe('Welcome to Switchboard 2');
    expect(welcome?.steps.map((step) => step.id)).toEqual(['home', 'start', 'agents', 'agent', 'projects-crews', 'appearance']);
    expect(welcome?.steps.length).toBeLessThanOrEqual(MAX_V2_TOUR_STEPS);
    for (const step of welcome?.steps ?? []) {
      // Every step goes to its v2 page, names anchors and never vanishes silently.
      expect(step.v2Route, step.id).toBeTruthy();
      expect(step.anchors.length, step.id).toBeGreaterThan(0);
      expect(step.missing, step.id).not.toBeNull();
      expect(step.route, step.id).toBeUndefined();
    }
    expect(welcome?.steps.find((step) => step.id === 'appearance')?.anchors).toEqual(['v2-theme']);
  });

  it('the v2 tours are the welcome, the redrawn Project graph and D140\'s remote update; the classic What’s new gains the theme switch', () => {
    expect(isV2Tour(V2_WELCOME_ID)).toBe(true);
    expect(isV2Tour('graduated')).toBe(false);
    expect(isV2Tour(MAIN_TOUR_ID)).toBe(false);
    expect(v2Features().map((feature) => feature.id)).toEqual([V2_WELCOME_ID, 'project-graph', 'remote-update']);
    // D140 (2.4.3): one step, on a paired computer's update line in Settings › Computers.
    const remote = WHATS_NEW.find((feature) => feature.id === 'remote-update');
    expect(remote?.version).toBe('2.4.3');
    expect(remote?.steps.map((step) => step.anchors)).toEqual([['v2-computer-update']]);
    expect(remote?.steps[0]?.v2Route).toBe('/settings/computers');
    // The redrawn Project graph (2.4.2): one step, on the graph when it is on screen, else on Projects in the rail or More.
    const graph = WHATS_NEW.find((feature) => feature.id === 'project-graph');
    expect(graph?.version).toBe('2.4.2');
    expect(graph?.steps.map((step) => step.anchors)).toEqual([['v2-project-graph', 'v2-nav-projects', 'v2-tab-more']]);
    expect(graph?.steps[0]?.v2Route).toBe('/projects');
    const themes = WHATS_NEW.find((feature) => feature.id === 'two-themes');
    expect(themes?.ui).toBeUndefined();
    expect(themes?.steps[0]?.anchors).toEqual(['theme-switch']);
    expect(themes?.steps[0]?.route).toEqual({ view: 'settings', section: 'appearance' });
    // The welcome covers only classic tours that exist.
    for (const id of V2_COVERS) expect(WHATS_NEW.some((feature) => feature.id === id && feature.ui !== 'v2'), id).toBe(true);
  });

  it('each UI runs only its own tours', () => {
    expect(toursForUi([MAIN_TOUR_ID, 'graduated', V2_WELCOME_ID, 'two-themes'], 'classic')).toEqual([MAIN_TOUR_ID, 'graduated', 'two-themes']);
    expect(toursForUi([MAIN_TOUR_ID, 'graduated', V2_WELCOME_ID], 'v2')).toEqual([V2_WELCOME_ID]);
    expect(v2ToursOf(['graduated', 'nope', V2_WELCOME_ID])).toEqual([V2_WELCOME_ID]);
  });
});

describe('opening by itself in v2', () => {
  it('an existing install whose welcome is pending opens it (and only it)', () => {
    const state = stateOf({ graduated: 'pending', 'two-themes': 'pending', [V2_WELCOME_ID]: 'pending', drafts: 'pending' });
    expect(v2AutoTours(state)).toEqual([V2_WELCOME_ID]);
    // The classic gate never opens the welcome.
    expect(toursForUi(pendingTours(state), 'classic')).toEqual(['drafts', 'graduated', 'two-themes']);
    expect(coveredByWelcome(state)).toEqual(['graduated', 'two-themes']);
  });

  it('a brand-new install (only the main tour queued) opens the welcome in v2 and keeps the main tour for Classic', () => {
    const state = stateOf({}, { main: 'pending' });
    expect(v2AutoTours(state)).toEqual([V2_WELCOME_ID]);
    expect(pendingTours(state)).toEqual([MAIN_TOUR_ID]);
    expect(coveredByWelcome(state)).toEqual([]);
  });

  it('once seen or skipped, never again; never with auto-open off (tests, demo)', () => {
    expect(v2AutoTours(stateOf({ [V2_WELCOME_ID]: 'completed' }))).toEqual([]);
    expect(v2AutoTours(stateOf({ [V2_WELCOME_ID]: 'skipped' }))).toEqual([]);
    expect(v2AutoTours(stateOf({ [V2_WELCOME_ID]: 'pending' }, { autoOpen: false }))).toEqual([]);
    expect(coveredByWelcome(stateOf({ graduated: 'completed', 'two-themes': null }))).toEqual([]);
  });
});

describe('the v2 host’s rules', () => {
  const step = (over: Partial<Parameters<typeof missingMove>[0]>) => ({ id: 's', title: 't', what: 'w', todo: ['x'], anchors: ['a'], missing: null, ...over });

  it('a step goes to its v2 page; the agent step to the newest open agent, or its card when there is none', () => {
    expect(v2PathOf(step({ v2Route: '/agents' }), null)).toBe('/agents');
    expect(v2PathOf(step({ v2Route: 'agent' }), 'a 1')).toBe('/agents/a%201');
    expect(v2PathOf(step({ v2Route: 'agent' }), null)).toBe('none');
    expect(v2PathOf(step({}), 'x')).toBeNull();
  });

  it('a missing anchor shows the centred card, or skips an optional step in the direction of travel', () => {
    expect(missingMove(step({ missing: 'm' }), 0, 3, 1)).toEqual({ kind: 'centre' });
    expect(missingMove(step({}), 1, 3, 1)).toEqual({ kind: 'step', index: 2 });
    expect(missingMove(step({}), 1, 3, -1)).toEqual({ kind: 'step', index: 0 });
    expect(missingMove(step({}), 2, 3, 1)).toEqual({ kind: 'end' });
  });

  it('the card’s words', () => {
    expect(nextLabel(0, 6, 0, TOUR_WORDS)).toBe('Next');
    expect(nextLabel(5, 6, 0, TOUR_WORDS)).toBe('Done');
    expect(nextLabel(5, 6, 1, TOUR_WORDS)).toBe('Next tour');
    expect(v2KickerOf(V2_WELCOME_ID, 0, 1)).toBe('What’s new · Welcome to Switchboard 2');
    expect(v2KickerOf(V2_WELCOME_ID, 0, 2)).toBe('What’s new · Welcome to Switchboard 2 (1 of 2)');
    expect(v2StepsOf('graduated')).toEqual([]);
    expect(v2StepsOf(V2_WELCOME_ID)).toBe(welcome?.steps);
  });

  it('the run store starts only v2 tours; a replay records nothing it covers', () => {
    startV2Tours(['graduated'], { replay: false });
    expect(v2TourRunning()).toBe(false);
    startV2Tours([V2_WELCOME_ID], { replay: true, covers: ['graduated'] });
    expect(v2TourRunning()).toBe(true);
    endV2Tours();
    expect(v2TourRunning()).toBe(false);
  });
});
