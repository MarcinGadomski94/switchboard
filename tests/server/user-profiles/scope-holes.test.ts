import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InsightsRows } from '../../../src/core/insights.ts';
import { utcDay } from '../../../src/core/insights.ts';
import type { UsageRows } from '../../../src/core/usage-breakdown.ts';
import type { TeamState, TeamSummary } from '../../../src/core/team.ts';
import type { UserProfile } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { wholeIndex } from '../../../src/server/api/sidebar.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { inboxChangedPayload } from '../../../src/server/inbox/wire.ts';
import { generateToken } from '../../../src/server/token.ts';
import { LIST_FILTERS, hubTransform } from '../../../src/server/user-profiles/scope.ts';
import { UserProfileService } from '../../../src/server/user-profiles/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D165 · the scoping holes closed (`docs/profiles.md` → *Scope*), with three profiles (Default,
 * Ann with a password, Bo) and an agent each: History and its continue, Insights and the usage
 * breakdown (rows and the merged answer's cache), the crews' Needs you / state / suggestions, Plans'
 * state, the terminal-session list and hooking, the hub's Inbox count, plan and crew events; and a
 * sidebar position counted in one profile's rows.
 */

const PORT = 4878;
const HOST = `127.0.0.1:${PORT}`;
const today = utcDay(new Date());

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let ann: UserProfile;
let bo: UserProfile;
let ids: { d: string; a: string; b: string };
let claude: { a: string };

beforeEach(async () => {
  tmp = await makeTempDir('user-profiles-holes');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
  ann = (await call('POST', '/api/user-profiles', { name: 'Ann', password: 'ann-secret' })).json() as UserProfile;
  bo = (await call('POST', '/api/user-profiles', { name: 'Bo' })).json() as UserProfile;
  claude = { a: randomUUID() };
  ids = {
    d: (await store.sessions.create({ name: 'dee', claudeSessionId: randomUUID() })).id,
    a: (await store.sessions.create({ name: 'ann-agent', claudeSessionId: claude.a, userProfileId: ann.id })).id,
    b: (await store.sessions.create({ name: 'bo-agent', claudeSessionId: randomUUID(), userProfileId: bo.id })).id,
  };
  for (const id of Object.values(ids)) {
    await store.events.append({ sessionId: id, kind: 'ok', label: 'Done', payload: { type: 'result', isError: false, durationMs: 1_000, tokens: 1_000, usage: { input: 0, output: 1_000, cacheWrite: 0, cacheRead: 0 }, model: 'claude-opus-5-5' } });
  }
});

afterEach(async () => {
  await app.close();
  await store.close();
  await removeTempDir(tmp);
});

function call(method: InjectOptions['method'], url: string, payload?: unknown, profileCookie?: string) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${token}${profileCookie ? `; ${profileCookie}` : ''}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function cookieOf(id: string, password?: string): Promise<string> {
  const answer = await call('POST', '/api/user-profiles/switch', { id, ...(password ? { password } : {}) });
  return String(answer.headers['set-cookie']).split(';')[0] as string;
}

const sees = (mine: readonly string[]) => (id: string | null): boolean => id === null || mine.includes(id);

describe('D165 · the scoping holes closed', () => {
  it('1 · History: a conversation not in Switchboard is everyone’s; a session’s only its profile’s; continue refuses another profile’s', async () => {
    const items = [{ sessionId: null, claudeSessionId: 't' }, { sessionId: ids.a }, { sessionId: ids.b }];
    const filter = LIST_FILTERS['/api/history'] as (body: unknown, sees: (id: string | null) => boolean, context: never) => unknown;
    expect(filter(items, sees([ids.a]), undefined as never)).toEqual([{ sessionId: null, claudeSessionId: 't' }, { sessionId: ids.a }]);
    const boCookie = await cookieOf(bo.id);
    expect((await call('POST', `/api/history/${claude.a}/continue`, {}, boCookie)).statusCode).toBe(404);
    // Its own profile gets the usual answer (already in Switchboard).
    expect((await call('POST', `/api/history/${claude.a}/continue`, {}, await cookieOf(ann.id, 'ann-secret'))).statusCode).toBe(409);
  });

  it('2 · Insights and the usage breakdown count only the profile’s sessions', async () => {
    const rowsOf = async (cookie?: string): Promise<string[]> => ((await call('GET', `/api/insights/rows?from=${today}&to=${today}`, undefined, cookie)).json() as InsightsRows).turns.map((row) => row.sessionId).sort();
    expect(await rowsOf()).toEqual([ids.d]);
    expect(await rowsOf(await cookieOf(ann.id, 'ann-secret'))).toEqual([ids.a]);
    expect(await rowsOf(await cookieOf(bo.id))).toEqual([ids.b]);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const usageOf = async (cookie?: string): Promise<string[]> => ((await call('GET', `/api/insights/usage/rows?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined, cookie)).json() as UsageRows).turns.map((row) => row.sessionId);
    expect(await usageOf(await cookieOf(bo.id))).toEqual([ids.b]);
    // The merged page (its answer cache is per profile): Bo's turns, then Default's, never each other's.
    const turnsOf = async (cookie?: string): Promise<unknown> => ((await call('GET', '/api/insights?period=7d&machine=local', undefined, cookie)).json() as { time?: { totals?: { turns?: number } } }).time?.totals?.turns;
    const boTurns = await turnsOf(await cookieOf(bo.id));
    const defaultTurns = await turnsOf();
    expect(boTurns).toBe(1);
    expect(defaultTurns).toBe(1);
  });

  it('3 · the crews’ Needs you, state and suggestions: only the profile’s', async () => {
    const annCookie = await cookieOf(ann.id, 'ann-secret');
    const boCookie = await cookieOf(bo.id);
    const team = (await call('POST', '/api/team/teams', { name: 'Ann crew' }, annCookie)).json() as TeamSummary;
    expect((await call('POST', '/api/team/members', { sessionId: ids.a, name: 'Ann dev', teamId: team.id }, annCookie)).statusCode).toBe(201);
    expect(((await call('GET', '/api/team/state', undefined, annCookie)).json() as TeamState).hiddenSessionIds).toContain(ids.a);
    expect(((await call('GET', '/api/team/state', undefined, boCookie)).json() as TeamState).hiddenSessionIds).not.toContain(ids.a);
    expect((await call('GET', `/api/team/needs-you?teamId=${team.id}`, undefined, boCookie)).statusCode).toBe(404);
    expect((await call('GET', `/api/team/needs-you?teamId=${team.id}`, undefined, annCookie)).statusCode).toBe(200);
    const suggestions = LIST_FILTERS['/api/team/suggestions'] as (body: unknown, sees: (id: string | null) => boolean, context: never) => unknown;
    expect(suggestions([{ sessionId: ids.a }, { sessionId: ids.b }], sees([ids.b]), undefined as never)).toEqual([{ sessionId: ids.b }]);
    const needs = LIST_FILTERS['/api/team/needs-you'] as (body: unknown, sees: (id: string | null) => boolean, context: never) => unknown;
    expect(needs([{ sessionRef: ids.a }, { sessionRef: ids.b }], sees([ids.a]), undefined as never)).toEqual([{ sessionRef: ids.a }]);
  });

  it('4 · Plans’ state carries no plan: only whether Plans is on', async () => {
    expect(Object.keys((await call('GET', '/api/plans/state', undefined, await cookieOf(bo.id))).json() as object).sort()).toEqual(['available', 'enabled', 'problem']);
  });

  it('5 · terminal sessions: one not followed is the machine’s (everyone); a followed one is its profile’s; hooking another profile’s refuses', async () => {
    const filter = LIST_FILTERS['/api/terminal-sessions'] as (body: unknown, sees: (id: string | null) => boolean, context: never) => unknown;
    expect(filter([{ id: 't1', sessionId: null }, { id: 't2', sessionId: ids.a }, { id: 't3', sessionId: ids.b }], sees([ids.b]), undefined as never)).toEqual([{ id: 't1', sessionId: null }, { id: 't3', sessionId: ids.b }]);
    expect((await call('POST', `/api/terminal-sessions/${claude.a}/hook`, undefined, await cookieOf(bo.id))).statusCode).toBe(404);
  });

  it('6 · the hub’s Inbox count is the client’s profile’s', async () => {
    await store.systemItems.create({ kind: 'test', source: 'test', title: 'for Bo', detail: '', sessionId: ids.b, payload: null });
    await store.systemItems.create({ kind: 'test', source: 'test', title: 'for Ann', detail: '', sessionId: ids.a, payload: null });
    await store.systemItems.create({ kind: 'test', source: 'test', title: 'for everyone', detail: '', sessionId: null, payload: null });
    const payload = await inboxChangedPayload(store);
    expect(payload.count).toBe(3);
    expect(payload.byProfile).toEqual({ default: 1, [ann.id]: 2, [bo.id]: 2 });
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'x' });
    const message = { name: 'inboxChanged', payload } as unknown as HubMessage;
    expect(hubTransform(service, bo.id)(message)?.payload).toEqual({ count: 2 });
    expect(hubTransform(service, 'default')(message)?.payload).toEqual({ count: 1 });
    expect(hubTransform(service, null)(message)?.payload).toEqual({ count: 0 });
  });

  it('7 · plan and crew events go only to the profile that owns them', async () => {
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'x' });
    service.hubLookups = { planSession: (planId) => (planId === 'p-ann' ? ids.a : null), teamProfile: (teamId) => (teamId === 't-bo' ? bo.id : null), folderProfile: () => null };
    const plan = { name: 'planChanged', payload: { planId: 'p-ann' } } as unknown as HubMessage;
    const team = { name: 'teamChanged', payload: { teamId: 't-bo', what: ['members'] } } as unknown as HubMessage;
    expect(hubTransform(service, ann.id)(plan)).not.toBeNull();
    expect(hubTransform(service, bo.id)(plan)).toBeNull();
    expect(hubTransform(service, 'default')(plan)).toBeNull();
    expect(hubTransform(service, bo.id)(team)).not.toBeNull();
    expect(hubTransform(service, ann.id)(team)).toBeNull();
  });

  it('9 · a sidebar position counted in one profile’s rows lands before the same row in the whole list', () => {
    // The whole pinned list: a (Ann), x (Bo), b (Ann), y (Bo); Ann sees [a, b].
    const annSees = (id: string): boolean => id === 'a' || id === 'b' || id === 'n';
    expect(wholeIndex(['a', 'x', 'b', 'y'], 'n', 1, annSees)).toBe(2);
    expect(wholeIndex(['a', 'x', 'b', 'y'], 'n', 2, annSees)).toBe(3);
    expect(wholeIndex(['a', 'x', 'b', 'y'], 'n', 0, annSees)).toBe(0);
    // Moving b to the top of Ann's rows.
    expect(wholeIndex(['a', 'x', 'b', 'y'], 'b', 0, annSees)).toBe(0);
    // Nothing of hers there: the end.
    expect(wholeIndex(['x', 'y'], 'n', 0, annSees)).toBe(2);
  });
});
