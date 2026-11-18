import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem } from '../../../src/core/api.ts';
import type { DeviceNotice } from '../../../src/core/devices.ts';
import { type UserProfile, inboxItemSession } from '../../../src/core/user-profiles.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { PushNotifier, inboxNotice } from '../../../src/server/devices/push/notifier.ts';
import { HubBus, type HubMessage } from '../../../src/server/hub/bus.ts';
import { listInbox } from '../../../src/server/inbox/wire.ts';
import { generateToken } from '../../../src/server/token.ts';
import { hubTransform } from '../../../src/server/user-profiles/scope.ts';
import { UserProfileService } from '../../../src/server/user-profiles/service.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D178 · Home's Needs you and its notifications per profile (`docs/profiles.md` → *Scope*). The
 * developer's report (2026-11-18): "i could see my notification appeared for Eskil". Two profiles
 * (Ann, Bo) and an agent each: Home's list (`/api/inbox`), the `/hub` toast (`notice`) and a phone's
 * push of an item that links to the Inbox, a failed move of a paired computer's agent, and a paired
 * computer's new agent this computer does not know yet.
 */

const PORT = 4879;
const HOST = `127.0.0.1:${PORT}`;

let tmp: string;
let store: Store;
let app: FastifyInstance;
let token: string;
let ann: UserProfile;
let bo: UserProfile;
let ids: { a: string; b: string };

beforeEach(async () => {
  tmp = await makeTempDir('user-profiles-home');
  store = await openTempStore(tmp);
  token = generateToken();
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: tmp }, platform: 'linux', home: tmp, cwd: tmp }), port: PORT };
  app = await buildApp({ config, token, store, webRoot: tmp, bus: new HubBus() });
  await app.ready();
  ann = (await call('POST', '/api/user-profiles', { name: 'Ann' })).json() as UserProfile;
  bo = (await call('POST', '/api/user-profiles', { name: 'Bo' })).json() as UserProfile;
  ids = {
    a: (await store.sessions.create({ name: 'ann-agent', claudeSessionId: randomUUID(), userProfileId: ann.id })).id,
    b: (await store.sessions.create({ name: 'bo-agent', claudeSessionId: randomUUID(), userProfileId: bo.id })).id,
  };
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

async function cookieOf(id: string): Promise<string> {
  const answer = await call('POST', '/api/user-profiles/switch', { id });
  return String(answer.headers['set-cookie']).split(';')[0] as string;
}

const titlesFor = async (id: string): Promise<string[]> => ((await call('GET', '/api/inbox', undefined, await cookieOf(id))).json() as InboxItem[]).map((item) => item.title).sort();

describe('D178 · Home’s Needs you and notifications per profile', () => {
  it('Home’s list: an agent’s items only in its profile (an item that links to the Inbox too); the items of no agent in every profile; each item names its agent’s profile', async () => {
    // A "plan ready" / "scheduled run failed" kind of item: on the agent, but its notice links to /inbox.
    await store.systemItems.create({ kind: 'plan-ready', source: 'ann-agent', status: 'idle', title: 'Ann’s project is ready', detail: '', branches: [], actions: [], sessionId: ids.a, payload: {} });
    await store.systemItems.create({ kind: 'review', source: 'bo-agent', status: 'idle', title: 'Bo’s review', detail: '', branches: [], actions: [], sessionId: ids.b, payload: {} });
    await store.systemItems.create({ kind: 'update-available', source: 'switchboard', status: 'idle', title: 'Switchboard 9.9.9 is available', detail: '', branches: [], actions: [], sessionId: null, payload: {} });
    expect(await titlesFor(bo.id)).toEqual(['Bo’s review', 'Switchboard 9.9.9 is available']);
    expect(await titlesFor(ann.id)).toEqual(['Ann’s project is ready', 'Switchboard 9.9.9 is available']);
    expect(await titlesFor('default')).toEqual(['Switchboard 9.9.9 is available']);
    // What a paired computer reads (`listInbox`): each agent's item names its profile; the item of no agent none.
    const listed = await listInbox(store);
    expect(listed.find((item) => item.sessionId === ids.a)?.userProfileId).toBe(ann.id);
    expect(listed.find((item) => item.sessionId === null)?.userProfileId).toBeUndefined();
  });

  it('the toast and the push of an item that links to the Inbox go only to its agent’s profile (the reported leak)', async () => {
    const bus = new HubBus();
    const notices: DeviceNotice[] = [];
    bus.subscribe((message) => {
      if (message.name === 'notice') notices.push(message.payload as DeviceNotice);
    });
    const delivered: DeviceNotice[] = [];
    const notifier = new PushNotifier({ bus, inbox: () => listInbox(store), deliver: async (notice) => void delivered.push(notice.payload as DeviceNotice) });
    await notifier.start();
    await store.systemItems.create({ kind: 'plan-ready', source: 'ann-agent', status: 'idle', title: 'Ann’s project is ready', detail: '', branches: [], actions: [], sessionId: ids.a, payload: {} });
    await store.systemItems.create({ kind: 'update-available', source: 'switchboard', status: 'idle', title: 'Switchboard 9.9.9 is available', detail: '', branches: [], actions: [], sessionId: null, payload: {} });
    bus.publish('inboxChanged', { count: 2 });
    await notifier.idle();
    await notifier.stop();
    const annNotice = notices.find((notice) => notice.body.includes('Ann'));
    const everyone = notices.find((notice) => notice.body.includes('9.9.9'));
    // It links to the Inbox (what let it through before): it names its agent now.
    expect(annNotice).toMatchObject({ url: '/inbox', sessionId: ids.a, userProfileId: ann.id });
    expect(everyone?.sessionId).toBeUndefined();
    expect(delivered.map((notice) => notice.sessionId)).toContain(ids.a);
    // The hub: Ann's pages get it, Bo's and Default's do not; the update's goes to everyone.
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'x' });
    const message = (payload: DeviceNotice): HubMessage => ({ name: 'notice', payload }) as unknown as HubMessage;
    expect(hubTransform(service, ann.id)(message(annNotice as DeviceNotice))).not.toBeNull();
    expect(hubTransform(service, bo.id)(message(annNotice as DeviceNotice))).toBeNull();
    expect(hubTransform(service, 'default')(message(annNotice as DeviceNotice))).toBeNull();
    expect(hubTransform(service, bo.id)(message(everyone as DeviceNotice))).not.toBeNull();
    // A phone: its profile's notice only (the same rule as the pages).
    expect(service.seesNotice(bo.id, annNotice as DeviceNotice)).toBe(false);
    expect(service.seesNotice(ann.id, annNotice as DeviceNotice)).toBe(true);
    expect(service.seesNotice(bo.id, everyone as DeviceNotice)).toBe(true);
  });

  it('a failed move of a paired computer’s agent (no session here) belongs to the moved agent; a peer’s new agent not known here takes the profile its item names, never this computer’s Default', async () => {
    const remoteAgent = 'r~mac-studio~s-1';
    // The moved agent is known (its computer's list): Ann's there.
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'x', remoteSessions: () => [{ id: remoteAgent, userProfileId: ann.id }] });
    const moveItem = { sessionId: null, move: { source: { id: 'mac-studio', name: 'Mac Studio', sessionId: 's-1' } } } as unknown as InboxItem;
    expect(inboxItemSession(moveItem, 'this-pc')).toBe(remoteAgent);
    expect(service.seesInboxItem(ann.id, moveItem)).toBe(true);
    expect(service.seesInboxItem(bo.id, moveItem)).toBe(false);
    // A move of this computer's own agent names it as it is here.
    expect(inboxItemSession({ sessionId: null, move: { source: { id: 'this-pc', sessionId: ids.a } } }, 'this-pc')).toBe(ids.a);
    // A paired computer's agent not in its last list yet: before D178 it was this computer's Default's.
    const unknown = new UserProfileService({ store, bus: new HubBus(), secret: 'x', remoteSessions: () => [] });
    const peerItem = { sessionId: 'r~mac-studio~s-new', userProfileId: ann.id, machine: { id: 'mac-studio', name: 'Mac Studio', state: 'online' } } as unknown as InboxItem;
    expect(unknown.seesInboxItem(ann.id, peerItem)).toBe(true);
    expect(unknown.seesInboxItem('default', peerItem)).toBe(false);
    expect(unknown.seesInboxItem(bo.id, peerItem)).toBe(false);
    // Without a hint (an older computer's item): that computer's Default, not this one's.
    const { userProfileId: _hint, ...older } = peerItem;
    expect(unknown.seesInboxItem('default', older as InboxItem)).toBe(false);
    // The hint from its computer's cached items (a `questionBatch` / toast that names only the session).
    const hinted = new UserProfileService({ store, bus: new HubBus(), secret: 'x', remoteSessions: () => [], remoteProfileHint: (id) => (id === 'r~mac-studio~s-new' ? ann.id : null) });
    expect(hinted.sees(ann.id, 'r~mac-studio~s-new')).toBe(true);
    expect(hinted.sees('default', 'r~mac-studio~s-new')).toBe(false);
  });

  it('a notice of a session opens it: still scoped by its link (an older sender without sessionId)', () => {
    const service = new UserProfileService({ store, bus: new HubBus(), secret: 'x' });
    const notice = { kind: 'errors', title: 'x failed', body: '', url: `/sessions/${ids.a}`, tag: 't', id: 'n' };
    expect(hubTransform(service, bo.id)({ name: 'notice', payload: notice } as unknown as HubMessage)).toBeNull();
    expect(hubTransform(service, ann.id)({ name: 'notice', payload: notice } as unknown as HubMessage)).not.toBeNull();
  });

  it('inboxNotice names the agent it is given (a failed move’s moved agent) and leaves an item of no agent unnamed', () => {
    const item = { id: 'i', kind: 'system', sessionId: null, source: 'switchboard', status: 'idle', title: 'Move failed', label: 'Move failed', detail: '', createdAt: new Date().toISOString(), branches: [] } as unknown as InboxItem;
    expect(inboxNotice(item).payload.sessionId).toBeUndefined();
    expect(inboxNotice(item, 'r~mac-studio~s-1').payload).toMatchObject({ sessionId: 'r~mac-studio~s-1', url: '/inbox' });
    expect(inboxNotice(item, 'r~mac-studio~s-1').payload.userProfileId).toBeUndefined();
  });
});
