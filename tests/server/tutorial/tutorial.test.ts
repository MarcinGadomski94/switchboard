import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIN_TOUR,
  MAIN_TOUR_ID,
  PRE_TUTORIAL_VERSION,
  type TutorialState,
  type WhatsNewFeature,
  WHATS_NEW,
  compareVersions,
  featuresAfter,
  isTourId,
  parseTourOutcome,
  pendingTours,
  tourSteps,
  tutorialVersion,
} from '../../../src/core/tutorial.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { loadMigrations } from '../../../src/server/db/migrate.ts';
import { type Store, openStore } from '../../../src/server/db/store.ts';
import { TutorialService, tutorialAutoOpen } from '../../../src/server/tutorial/service.ts';
import { PEER_API_ALLOW } from '../../../src/server/peers/service.ts';
import { isLocalOnly } from '../../../src/server/devices/local-only.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { type SupervisorWorld, makeSupervisorWorld } from '../../helpers/supervisor.ts';

/**
 * D85 · the tutorial (docs/tutorial.md): the registry's rules, the service's
 * first-run vs existing-install decision across versions, and the routes
 * through the guard.
 */

let tmp: string | undefined;
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  if (tmp) await removeTempDir(tmp);
  tmp = undefined;
});

async function dir(): Promise<string> {
  tmp ??= await makeTempDir('tutorial');
  return tmp;
}

/** A store at `name`; `before` = the migrations before 0037 only (an install from before the tutorial). */
async function storeAt(name: string, before = false): Promise<Store> {
  const migrations = before ? (await loadMigrations()).filter((m) => m.version < 37) : undefined;
  const store = await openStore(path.join(await dir(), name, 'switchboard.db'), migrations ? { migrations } : {});
  stores.push(store);
  return store;
}

const FEATURE = (id: string, version: string): WhatsNewFeature => ({
  id,
  decision: 'D0',
  version,
  title: id,
  steps: [{ id: 's', title: 't', what: 'w', todo: ['x'], anchors: ['a'], missing: null }],
});

describe('core tutorial rules', () => {
  it('the main tour has ~14 steps with unique ids, each with what to do and an anchor', () => {
    expect(MAIN_TOUR.length).toBeGreaterThanOrEqual(12);
    expect(MAIN_TOUR.length).toBeLessThanOrEqual(16);
    expect(new Set(MAIN_TOUR.map((step) => step.id)).size).toBe(MAIN_TOUR.length);
    for (const step of MAIN_TOUR) {
      expect(step.todo.length, step.id).toBeGreaterThan(0);
      expect(step.anchors.length, step.id).toBeGreaterThan(0);
      // The main tour never skips a step silently: a missing anchor shows a centred card.
      expect(step.missing, step.id).not.toBeNull();
    }
  });

  it("seeds a 1–3 step mini-tour for each of D76–D84, D88, D89, D90 and D91, unique ids, after the pre-tutorial version", () => {
    expect(WHATS_NEW.map((f) => f.decision)).toEqual(['D76', 'D77', 'D78', 'D79', 'D80', 'D81', 'D82', 'D83', 'D84', 'D88', 'D89', 'D90', 'D91', 'D92', 'D93']);
    expect(new Set(WHATS_NEW.map((f) => f.id)).size).toBe(WHATS_NEW.length);
    for (const feature of WHATS_NEW) {
      expect(feature.steps.length, feature.id).toBeGreaterThanOrEqual(1);
      expect(feature.steps.length, feature.id).toBeLessThanOrEqual(3);
      expect(compareVersions(feature.version, PRE_TUTORIAL_VERSION), feature.id).toBe(1);
      // The first step of a mini-tour always shows (a card when its element is missing).
      expect(feature.steps[0]?.missing, feature.id).not.toBeNull();
      expect(feature.id).not.toBe(MAIN_TOUR_ID);
    }
    expect(isTourId('main')).toBe(true);
    expect(isTourId('todo-board')).toBe(true);
    expect(isTourId('nope')).toBe(false);
    expect(tourSteps('main')).toBe(MAIN_TOUR);
    expect(tourSteps('cleanup')?.length).toBe(1);
    expect(tourSteps('nope')).toBeNull();
  });

  it('versions: features after the last one, the tutorial version is the newer of the app and the registry', () => {
    const registry = [FEATURE('a', '1.13.0'), FEATURE('b', '1.14.0'), FEATURE('c', '1.14.1')];
    expect(featuresAfter('1.12.0', registry).map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(featuresAfter('1.14.0', registry).map((f) => f.id)).toEqual(['c']);
    expect(featuresAfter('2.0.0', registry)).toEqual([]);
    expect(tutorialVersion('1.12.0', registry)).toBe('1.14.1');
    expect(tutorialVersion('1.15.0', registry)).toBe('1.15.0');
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('junk', '1.0.0')).toBe(-1);
  });

  it('outcome bodies; pending tours: the main tour alone, else the pending mini-tours; nothing when autoOpen is off', () => {
    expect(parseTourOutcome({ status: 'completed' })).toEqual({ status: 'completed' });
    expect(parseTourOutcome({ status: 'skipped' })).toEqual({ status: 'skipped' });
    expect(parseTourOutcome({ status: 'pending' })).toBeNull();
    expect(parseTourOutcome(null)).toBeNull();
    const base: TutorialState = {
      autoOpen: true,
      install: 'new',
      lastVersion: '1.13.0',
      main: { status: 'pending', updatedAt: 'x' },
      whatsNew: [{ id: 'a', title: 'a', version: '1.13.0', status: 'pending', updatedAt: 'x' }],
    };
    expect(pendingTours(base)).toEqual(['main']);
    expect(pendingTours({ ...base, main: { status: 'completed', updatedAt: 'x' } })).toEqual(['a']);
    expect(pendingTours({ ...base, autoOpen: false })).toEqual([]);
  });

  it('SWITCHBOARD_TUTORIAL=off turns the automatic opening off; anything else keeps it', () => {
    expect(tutorialAutoOpen({})).toBe(true);
    expect(tutorialAutoOpen({ SWITCHBOARD_TUTORIAL: 'off' })).toBe(false);
    expect(tutorialAutoOpen({ SWITCHBOARD_TUTORIAL: ' OFF ' })).toBe(false);
    expect(tutorialAutoOpen({ SWITCHBOARD_TUTORIAL: 'on' })).toBe(true);
  });
});

describe('TutorialService', () => {
  it('a brand-new install: the main tour pending, no What\'s-new; once finished it stays finished across restarts', async () => {
    const store = await storeAt('new');
    const first = await new TutorialService({ store, appVersion: '1.13.0' }).state();
    expect(first.install).toBe('new');
    expect(first.main.status).toBe('pending');
    expect(first.whatsNew.every((entry) => entry.status === null)).toBe(true);
    // The newest of the app's version and the registry's (D88's 1.14.0 entry ships before the version bump).
    expect(first.lastVersion).toBe(tutorialVersion('1.13.0'));
    expect(pendingTours(first)).toEqual(['main']);
    const service = new TutorialService({ store, appVersion: '1.13.0' });
    expect((await service.record('main', { status: 'skipped' })).main.status).toBe('skipped');
    const restarted = await new TutorialService({ store, appVersion: '1.13.0' }).state();
    expect(restarted.main.status).toBe('skipped');
    expect(pendingTours(restarted)).toEqual([]);
  });

  it("an existing install (data before 0037): no main tour, every feature after 1.12.0 pending; each remembered once seen", async () => {
    const earlier = await storeAt('old', true);
    await earlier.sessions.create({ name: 'older', claudeSessionId: 'c-older' });
    await earlier.close();
    stores.splice(stores.indexOf(earlier), 1);
    const store = await storeAt('old');
    const service = new TutorialService({ store, appVersion: '1.13.0' });
    const state = await service.state();
    expect(state.install).toBe('existing');
    expect(state.main.status).toBeNull();
    expect(state.whatsNew.map((entry) => entry.status)).toEqual(WHATS_NEW.map(() => 'pending'));
    expect(pendingTours(state)).toEqual(WHATS_NEW.map((f) => f.id));
    expect(state.lastVersion).toBe(tutorialVersion('1.13.0'));
    await service.record('todo-board', { status: 'completed' });
    await service.record('cleanup', { status: 'skipped' });
    const again = await new TutorialService({ store, appVersion: '1.13.0' }).state();
    expect(again.install).toBe('existing');
    expect(pendingTours(again)).toEqual(WHATS_NEW.map((f) => f.id).filter((id) => id !== 'todo-board' && id !== 'cleanup'));
    // A replay of the main tour is recorded but never makes it pending.
    expect((await service.record('main', { status: 'completed' })).main.status).toBe('completed');
  });

  it('a later update queues only the features introduced after the last version the tutorial ran on', async () => {
    const store = await storeAt('update');
    const v13 = [FEATURE('a', '1.13.0')];
    const first = await new TutorialService({ store, appVersion: '1.13.0', registry: v13 }).state();
    expect(pendingTours(first)).toEqual(['main']);
    const service13 = new TutorialService({ store, appVersion: '1.13.0', registry: v13 });
    await service13.record('main', { status: 'completed' });
    // The 1.14 build adds two features.
    const v14 = [...v13, FEATURE('b', '1.14.0'), FEATURE('c', '1.14.0')];
    const after = await new TutorialService({ store, appVersion: '1.14.0', registry: v14 }).state();
    expect(after.install).toBe('new');
    expect(after.whatsNew.map((entry) => [entry.id, entry.status])).toEqual([
      ['a', null],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
    expect(after.lastVersion).toBe('1.14.0');
    expect(pendingTours(after)).toEqual(['b', 'c']);
  });

  it('autoOpen false (demo, SWITCHBOARD_TUTORIAL=off): the state is kept but nothing opens by itself', async () => {
    const store = await storeAt('off');
    const state = await new TutorialService({ store, appVersion: '1.13.0', autoOpen: false }).state();
    expect(state.main.status).toBe('pending');
    expect(pendingTours(state)).toEqual([]);
  });
});

describe('tutorial routes', () => {
  const PORT = 4961; // inject() opens no socket; the port feeds the Host check only
  let world: SupervisorWorld | undefined;
  let app: FastifyInstance | undefined;
  let token = '';

  afterEach(async () => {
    await app?.close();
    await world?.cleanup();
    app = undefined;
    world = undefined;
  });

  function call(method: InjectOptions['method'], url: string, payload?: unknown, cookie = true) {
    if (!app) throw new Error('no app');
    return app.inject({
      method,
      url,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(cookie ? { cookie: `sb_token=${token}` } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  it('GET / PUT behind the cookie guard; 404 for an unknown tour, 422 for a bad body', async () => {
    world = await makeSupervisorWorld();
    token = generateToken();
    const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: world.root }, platform: 'linux', home: world.root, cwd: world.root });
    app = await buildApp({ config: { ...base, port: PORT }, token, store: world.store, webRoot: world.root, supervisor: world.supervisor, tutorial: new TutorialService({ store: world.store, appVersion: '1.13.0', autoOpen: false }) });
    await app.ready();
    expect((await call('GET', '/api/tutorial', undefined, false)).statusCode).toBe(401);
    const state = (await call('GET', '/api/tutorial')).json() as TutorialState;
    expect(state.main.status).toBe('pending');
    expect(state.autoOpen).toBe(false);
    const done = await call('PUT', '/api/tutorial/tours/main', { status: 'completed' });
    expect(done.statusCode).toBe(200);
    expect((done.json() as TutorialState).main.status).toBe('completed');
    expect((await call('PUT', '/api/tutorial/tours/todo-board', { status: 'skipped' })).json()).toMatchObject({ whatsNew: expect.arrayContaining([expect.objectContaining({ id: 'todo-board', status: 'skipped' })]) });
    expect((await call('PUT', '/api/tutorial/tours/nope', { status: 'completed' })).statusCode).toBe(404);
    const bad = await call('PUT', '/api/tutorial/tours/main', { status: 'seen' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'invalid' });
    // One state per machine: a paired device uses it (normal use); a paired machine's peer API does not reach it.
    expect(isLocalOnly('GET', '/api/tutorial')).toBe(false);
    expect(isLocalOnly('PUT', '/api/tutorial/tours/main')).toBe(false);
    for (const [method, url] of [['GET', '/api/tutorial'], ['PUT', '/api/tutorial/tours/main']] as const) {
      expect(PEER_API_ALLOW.some(([verb, pattern]) => verb === method && pattern.test(url))).toBe(false);
    }
  });
});
