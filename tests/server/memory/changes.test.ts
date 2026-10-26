import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_PROPOSE_PER_HOUR, type MemoryEntry, memoryListText, memoryWordDiff } from '../../../src/core/memory.ts';
import type { AgentApi } from '../../../src/hook/sb-mcp.ts';
import { memoryList, memoryProposeEdit, memoryProposeRetract } from '../../../src/hook/sb-memory-tools.ts';
import { buildApp } from '../../../src/server/app.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { DEVICE_ALLOWED, DEVICE_REFUSED, isLocalOnly, matchesRule } from '../../../src/server/devices/local-only.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { MEMORY_DB_FILE, MEMORY_MIGRATIONS, MemoryDb } from '../../../src/server/memory/db.ts';
import { MEMORY_PROPOSALS_ITEM, MemoryError, type MemoryPeers, MemoryService } from '../../../src/server/memory/service.ts';
import { peerApiAllowed } from '../../../src/server/peers/service.ts';
import { type TeamMemberRef, registerTeamHooks } from '../../../src/server/team/hooks.ts';
import { agentTokenFor } from '../../../src/server/todos/agent-token.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D135 · agents propose to change or remove an approved Project memory entry, behind the same
 * review (`docs/memory.md` → *Changing approved entries*): `memory_list` shows ids, an edit
 * proposal replaces the entry only once approved (keeping its id), a retract proposal deletes it
 * only once approved, rejecting changes nothing; the refusals; the gate (a change row is never
 * approved, never injected); migration 4 on a v3 database; a moved member's pending change; the
 * agent routes, the MCP tools and the routes' classification for phones and paired machines.
 */

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly memory: MemoryService;
  readonly workspace: string;
  readonly other: string;
  readonly clock: { now: Date };
  members: TeamMemberRef[];
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.memory.close();
    await r.store.close();
    await removeTempDir(r.root);
  }
});

async function setup(label = 'memory-changes', options: { readonly peers?: MemoryPeers } = {}): Promise<Rig> {
  const root = await realpath(await makeTempDir(label));
  const store = await openTempStore(path.join(root, 'data'));
  const workspace = path.join(root, 'acme-workspace');
  const other = path.join(root, 'acme-other');
  await mkdir(workspace, { recursive: true });
  await mkdir(other, { recursive: true });
  const clock = { now: new Date('2026-10-26T10:00:00.000Z') };
  const memory = new MemoryService({
    dataDir: path.join(root, 'data'),
    store,
    bus: new HubBus(),
    supervisor: { instructionSettingChanged: async () => undefined },
    ...(options.peers ? { peers: options.peers } : {}),
    now: () => clock.now,
    onError: () => undefined,
  });
  const r: Rig = { root, store, memory, workspace, other, clock, members: [] };
  registerTeamHooks(store, {
    charterFor: async () => null,
    roleOf: (sessionId) => r.members.find((m) => m.sessionId === sessionId)?.name ?? null,
    memberOf: (sessionId) => r.members.find((m) => m.sessionId === sessionId && m.here) ?? null,
    memberList: () => r.members,
  });
  await memory.start();
  rigs.push(r);
  return r;
}

async function session(r: Rig, name: string, folder: string = r.workspace): Promise<string> {
  return (await r.store.sessions.create({ name, claudeSessionId: `c-${name}`, attached: true, title: `Acme ${name}`, root: folder, rootKind: 'workspace', cwd: folder })).id;
}

/** An approved workspace entry of `folder`, added by the developer. */
async function entry(r: Rig, title: string, text: string, folder: string = r.workspace): Promise<MemoryEntry> {
  return r.memory.add({ scope: folder, title, text });
}

async function refusal(work: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof MemoryError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('not refused');
}

async function block(r: Rig, sessionId: string): Promise<string> {
  return (await r.memory.blockFor({ id: sessionId, kind: 'session', root: r.workspace })) ?? '';
}

describe('D135 · memory_list shows ids', () => {
  it('each approved entry carries its id, scope and update time; the lines before D135 are unchanged', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const added = await entry(r, 'Run the tests', 'npm test with the test ports.');
    const listed = await r.memory.agentList(s);
    expect(listed.entries.map((e) => e.id)).toEqual([added.id]);
    const text = memoryListText(listed.entries, listed.label);
    expect(text).toContain('[workspace] - Run the tests\n  npm test with the test ports.');
    expect(text).toContain(`(id: ${added.id} · updated 2026-10-26 10:00 UTC)`);
    expect(text).toContain('memory_propose_edit or memory_propose_retract');
  });
});

describe('D135 · memory_propose_edit', () => {
  it('creates a pending edit; approval replaces the entry and keeps its id; nothing reaches a session before', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme test command', 'npm test');
    const proposal = await r.memory.proposeEdit(s, { entry: target.id, text: 'npm run test:unit', reason: 'The command was renamed.' });
    expect(proposal).toMatchObject({ status: 'proposed', changeKind: 'edit', targetId: target.id, title: 'Acme test command', text: 'npm run test:unit', reason: 'The command was renamed.', targetText: 'npm test', scope: r.workspace, scopeKind: 'workspace' });
    expect(proposal.target?.id).toBe(target.id);
    // The review reads it with its target; the agent's list and the block still have the old text.
    const queue = r.memory.entries({ scope: r.workspace, status: 'proposed' });
    expect(queue.map((e) => [e.id, e.changeKind, e.target?.text])).toEqual([[proposal.id, 'edit', 'npm test']]);
    expect((await r.memory.agentList(s)).entries.map((e) => e.text)).toEqual(['npm test']);
    expect(await block(r, s)).toContain('  npm test');
    expect(await block(r, s)).not.toContain('test:unit');

    r.clock.now = new Date('2026-10-26T11:00:00.000Z');
    const approved = await r.memory.approve(proposal.id, {});
    expect(approved).toMatchObject({ id: target.id, title: 'Acme test command', text: 'npm run test:unit', status: 'approved', decidedBy: 'developer', decidedAt: '2026-10-26T11:00:00.000Z', updatedAt: '2026-10-26T11:00:00.000Z', changeKind: 'add' });
    // One approved entry (the same id), the proposal gone.
    expect(r.memory.entries({ scope: r.workspace }).map((e) => [e.id, e.status, e.text])).toEqual([[target.id, 'approved', 'npm run test:unit']]);
    expect(await block(r, s)).toContain('npm run test:unit');
  });

  it('rejecting leaves the entry unchanged (the proposal is kept as rejected)', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme deploy', 'Deploy from main.');
    const proposal = await r.memory.proposeEdit(s, { entry: target.id, title: 'Acme deploys', text: 'Deploy from release.', reason: 'Policy changed.' });
    await r.memory.reject(proposal.id);
    expect(r.memory.entries({ scope: r.workspace }).map((e) => [e.id, e.status, e.title, e.text])).toEqual([
      [target.id, 'approved', 'Acme deploy', 'Deploy from main.'],
      [proposal.id, 'rejected', 'Acme deploys', 'Deploy from release.'],
    ]);
    expect(await block(r, s)).toContain('Deploy from main.');
  });

  it("Edit first: the developer's words are what replaces the entry; a field the agent left alone keeps the developer's later change", async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme ports', 'Use ports 4600-4699.');
    const proposal = await r.memory.proposeEdit(s, { entry: target.id, text: 'Use ports 4700-4799.', reason: 'Range moved.' });
    // The developer retitles the entry meanwhile; the edit only changes the text.
    await r.memory.update(target.id, { title: 'Acme test ports' });
    expect(r.memory.entries({ scope: r.workspace, status: 'proposed' })[0]?.target?.title).toBe('Acme test ports');
    const approved = await r.memory.approve(proposal.id, { text: 'Use ports 4700-4799 (tests only).' });
    expect(approved).toMatchObject({ id: target.id, title: 'Acme test ports', text: 'Use ports 4700-4799 (tests only).' });
  });

  it('refuses an unknown entry, one outside the session’s reach, no change, neither field and a duplicate pending edit', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const other = await session(r, 'other-agent', r.other);
    const target = await entry(r, 'Acme lint', 'npm run lint');
    const elsewhere = await entry(r, 'Acme other folder', 'Only for the other folder.', r.other);
    const waiting = await r.memory.propose(s, { title: 'Acme waiting proposal', text: 'Not approved yet.' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: 'nope000000', text: 'x' }))).toEqual({ status: 404, code: 'not-found' });
    // A proposal is not an approved entry (agents cannot see it).
    expect(await refusal(r.memory.proposeEdit(s, { entry: waiting.id, text: 'x' }))).toEqual({ status: 404, code: 'not-found' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: elsewhere.id, text: 'x' }))).toEqual({ status: 403, code: 'out-of-scope' });
    expect(await refusal(r.memory.proposeEdit(other, { entry: target.id, text: 'x' }))).toEqual({ status: 403, code: 'out-of-scope' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: target.id, title: 'Acme lint', text: 'npm  run lint ' }))).toEqual({ status: 422, code: 'no-change' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: target.id }))).toEqual({ status: 422, code: 'invalid' });
    expect(await refusal(r.memory.proposeEdit(s, { text: 'x' }))).toEqual({ status: 422, code: 'invalid' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: target.id, text: 'x', reason: 'r'.repeat(501) }))).toEqual({ status: 422, code: 'invalid' });
    await r.memory.proposeEdit(s, { entry: target.id, text: 'npm run lint -- --fix', reason: 'Fix too.' });
    expect(await refusal(r.memory.proposeEdit(s, { entry: target.id, text: 'npm run lint:all', reason: 'Again.' }))).toEqual({ status: 409, code: 'duplicate' });
    // Another session may propose its own edit of the same entry.
    const second = await session(r, 'second');
    expect((await r.memory.proposeEdit(second, { entry: target.id, text: 'npm run lint:all', reason: 'All files.' })).changeKind).toBe('edit');
  });

  it('an approved edit of an entry that was deleted meanwhile is refused (target-gone)', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme cache', 'Clear the cache first.');
    const proposal = await r.memory.proposeEdit(s, { entry: target.id, text: 'No cache any more.', reason: 'Removed.' });
    await r.memory.delete(target.id);
    // Deleting the entry drops the proposals about it.
    expect(r.memory.entries({ scope: r.workspace })).toEqual([]);
    expect(await refusal(r.memory.approve(proposal.id, {}))).toEqual({ status: 404, code: 'not-found' });
  });

  it('counts against the per-hour proposal limit shared with memory_propose', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme limit', 'Ten an hour.');
    for (let i = 0; i < MEMORY_PROPOSE_PER_HOUR; i++) await r.memory.propose(s, { title: `Acme fact number ${String.fromCharCode(65 + i)}${i}`, text: `Fact ${i}` });
    expect(await refusal(r.memory.proposeEdit(s, { entry: target.id, text: 'Eleven.', reason: 'x' }))).toEqual({ status: 429, code: 'rate-limited' });
  });
});

describe('D135 · memory_propose_retract', () => {
  it('approval deletes the entry (and the other proposals about it); it is gone from the block', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const second = await session(r, 'second');
    const target = await entry(r, 'Acme staging server', 'Deploy to staging first.');
    const keep = await entry(r, 'Acme other fact', 'Stays.');
    const pendingEdit = await r.memory.proposeEdit(second, { entry: target.id, text: 'Staging is optional.', reason: 'x' });
    const proposal = await r.memory.proposeRetract(s, { entry: target.id, reason: 'Staging was retired.' });
    expect(proposal).toMatchObject({ changeKind: 'retract', targetId: target.id, title: target.title, text: target.text, reason: 'Staging was retired.', status: 'proposed' });
    expect(await block(r, s)).toContain('Deploy to staging first.');
    await r.memory.approve(proposal.id, {});
    expect(r.memory.entries({ scope: r.workspace }).map((e) => e.id)).toEqual([keep.id]);
    expect(r.memory.entries({ scope: r.workspace }).some((e) => e.id === pendingEdit.id)).toBe(false);
    expect(await block(r, s)).not.toContain('staging');
  });

  it('rejection keeps the entry; a reason is required; a duplicate pending removal is refused', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme branch names', 'feature/<ticket>.');
    expect(await refusal(r.memory.proposeRetract(s, { entry: target.id }))).toEqual({ status: 422, code: 'invalid' });
    expect(await refusal(r.memory.proposeRetract(s, { entry: target.id, reason: '   ' }))).toEqual({ status: 422, code: 'invalid' });
    const proposal = await r.memory.proposeRetract(s, { entry: target.id, reason: 'Nobody uses it.' });
    expect(await refusal(r.memory.proposeRetract(s, { entry: target.id, reason: 'Again.' }))).toEqual({ status: 409, code: 'duplicate' });
    // A retract has nothing to edit.
    expect(await refusal(r.memory.update(proposal.id, { text: 'x' }))).toEqual({ status: 409, code: 'not-editable' });
    await r.memory.reject(proposal.id);
    expect(r.memory.entries({ scope: r.workspace, status: 'approved' }).map((e) => [e.id, e.text])).toEqual([[target.id, 'feature/<ticket>.']]);
    expect(await block(r, s)).toContain('feature/<ticket>.');
  });
});

describe('D135 · the review gate and the Inbox', () => {
  it('a change row is never approved (the database refuses it) and never injected or listed to agents', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme gate', 'Original.');
    const proposal = await r.memory.proposeEdit(s, { entry: target.id, title: 'Acme gate changed', text: 'INJECTED-TOO-EARLY', reason: 'x' });
    expect(() => new DatabaseSync(path.join(r.root, 'data', MEMORY_DB_FILE)).prepare(`UPDATE memory_entries SET status = 'approved' WHERE id = ?`).run(proposal.id)).toThrow(/CHECK/);
    expect(await block(r, s)).not.toContain('INJECTED-TOO-EARLY');
    expect((await r.memory.agentList(s)).entries.map((e) => e.id)).toEqual([target.id]);
    expect(await r.memory.sessionCount(s)).toMatchObject({ count: 1, proposed: 1 });
  });

  it('the folder’s Inbox item counts change proposals and names them; it closes once they are decided', async () => {
    const r = await setup();
    const s = await session(r, 'agent');
    const target = await entry(r, 'Acme inbox fact', 'Old.');
    const edit = await r.memory.proposeEdit(s, { entry: target.id, text: 'New.', reason: 'x' });
    const open = async () => (await r.store.systemItems.list(['open'])).filter((item) => item.kind === MEMORY_PROPOSALS_ITEM);
    expect((await open()).map((item) => [item.title, item.detail.includes('Newest: "Edit: Acme inbox fact"')])).toEqual([['1 memory proposal for acme-workspace', true]]);
    await r.memory.approve(edit.id, {});
    expect(await open()).toEqual([]);
  });
});

describe('D135 · storage', () => {
  it('migration 4 on a v3 database: old rows are adds, change proposals work; migrations 1–3 are unchanged', async () => {
    expect(MEMORY_MIGRATIONS.map((m) => [m.version, m.name, m.checksum])).toEqual([
      [1, 'memory', '6d1bf0aedc3a169a1215c62bf859c6d8e4e8f7aaa272d885ec21b34baf615c13'],
      [2, 'memory_scopes', '72a7166af3aaa3098e9374cf2d1dc374bc5d7d234d181cfd71619d3a715e3af1'],
      [3, 'memory_pending_copies', 'f3ded3785f77bc19dc499888fbcbabb5877114b0f591e507bf37cd0497091b48'],
      // D136: migration 4 as released in 2.2.0 (its checksum pinned once migration 5 followed).
      [4, 'memory_changes', 'e271b6a93973c0a7a1b8ff46dea8dc8f0d0e13145c08d862855b546b36e02c3f'],
      [5, 'memory_checks', expect.any(String)],
    ]);
    const root = await realpath(await makeTempDir('memory-migrate-4'));
    try {
      // A memory.db as 2.1.0 left it (migrations 1–3), with an approved and a proposed entry.
      const raw = new DatabaseSync(path.join(root, MEMORY_DB_FILE));
      migrate(raw, MEMORY_MIGRATIONS.slice(0, 3));
      const insert = raw.prepare(`INSERT INTO memory_entries (id, scope, title, text, tags, author_kind, status, pinned, created_at, updated_at) VALUES (?, '/w', ?, 'Text.', '[]', 'developer', ?, 0, 't', 't')`);
      insert.run('a1', 'Acme approved', 'approved');
      insert.run('p1', 'Acme proposed', 'proposed');
      raw.close();
      const db = await MemoryDb.open(root);
      expect(db.get('a1')).toMatchObject({ title: 'Acme approved', status: 'approved', changeKind: 'add', targetId: null, reason: null });
      expect(db.get('p1')).toMatchObject({ status: 'proposed', changeKind: 'add' });
      const now = '2026-10-26T10:00:00.000Z';
      db.insert({ ...(db.get('a1') as MemoryEntry), id: 'e1', status: 'proposed', authorKind: 'agent', text: 'New text.', createdAt: now, updatedAt: now, decidedAt: null, decidedBy: null, changeKind: 'edit', targetId: 'a1', reason: 'Why.', targetTitle: 'Acme approved', targetText: 'Text.' });
      expect(db.changesFor('a1').map((e) => [e.id, e.changeKind, e.reason])).toEqual([['e1', 'edit', 'Why.']]);
      expect(() => db.update('e1', { status: 'approved' })).toThrow(/CHECK/);
      expect(db.deleteChangesFor('a1')).toBe(1);
      db.close();
    } finally {
      await removeTempDir(root);
    }
  });
});

describe("D135 · a moved member's pending change goes with it", () => {
  it('the member entry and the edit proposed about it are copied; approving there replaces it', async () => {
    let target: Rig | null = null;
    const source = await setup('memory-changes-a', {
      peers: {
        forward: async (_machineId, _method, _route, body) => {
          if (!target) return { status: 502, body: null };
          return { status: 200, body: await target.memory.importMember(body) };
        },
      },
    });
    target = await setup('memory-changes-b');
    const builderSession = await session(source, 'builder');
    source.members.push({ id: 'm-builder', name: 'Builder', teamId: 'team', sessionId: builderSession, machineId: 'self', here: true, paused: false });
    const fact = await source.memory.approve((await source.memory.propose(builderSession, { title: 'Acme member fact', text: 'Old member text.' })).id, {});
    const edit = await source.memory.proposeEdit(builderSession, { entry: fact.id, text: 'New member text.', reason: 'Updated.' });
    const there = await session(target, 'builder-there', target.other);
    target.members.push({ id: 'm-builder', name: 'Builder', teamId: 'team', sessionId: there, machineId: 'self', here: true, paused: false });
    await source.memory.memberMoved({ memberId: 'm-builder', machineId: 'pc-2', sessionId: there });
    expect(source.memory.entries({})).toEqual([]);
    const moved = target.memory.entries({ scope: target.other });
    expect(moved.map((e) => [e.id, e.status, e.changeKind, e.targetId])).toEqual([
      [fact.id, 'approved', 'add', null],
      [edit.id, 'proposed', 'edit', fact.id],
    ]);
    await target.memory.approve(edit.id, {});
    expect(target.memory.entries({ scope: target.other }).map((e) => [e.id, e.text])).toEqual([[fact.id, 'New member text.']]);
  });
});

describe('D135 · the word diff of the review', () => {
  it('marks removed and added words; each side joins back to its text', () => {
    const parts = memoryWordDiff('Run npm test with ports 4600-4699.', 'Run npm run test:unit with ports 4600-4699.');
    expect(parts).toEqual([
      { kind: 'same', text: 'Run npm ' },
      { kind: 'del', text: 'test ' },
      { kind: 'add', text: 'run test:unit ' },
      { kind: 'same', text: 'with ports 4600-4699.' },
    ]);
    expect(parts.filter((p) => p.kind !== 'add').map((p) => p.text).join('')).toBe('Run npm test with ports 4600-4699.');
    expect(parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe('Run npm run test:unit with ports 4600-4699.');
    expect(memoryWordDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(memoryWordDiff('', 'new')).toEqual([{ kind: 'add', text: 'new' }]);
  });
});

// ── over the real app: the agent routes, the MCP tools, phones and paired machines ──

const PORT = 4948;
const HOST = `127.0.0.1:${PORT}`;

interface AppRig {
  readonly root: string;
  readonly store: Store;
  readonly app: FastifyInstance;
  readonly token: string;
  readonly workspace: string;
}

let appRig: AppRig | undefined;

afterEach(async () => {
  await appRig?.app.close();
  await appRig?.store.close();
  if (appRig) await removeTempDir(appRig.root);
  appRig = undefined;
});

async function appSetup(): Promise<AppRig> {
  const root = await makeTempDir('memory-changes-app');
  const dataDir = path.join(root, 'data');
  const store = await openTempStore(dataDir);
  const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: dataDir }, platform: 'linux', home: root, cwd: root }), port: PORT };
  const token = generateToken();
  const app = await buildApp({ config, token, store, webRoot: root, agentTools: false });
  await app.ready();
  appRig = { root, store, app, token, workspace: path.join(root, 'acme-workspace') };
  return appRig;
}

function ui(r: AppRig, method: InjectOptions['method'], url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return r.app.inject({ method, url, headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

function helperApi(r: AppRig, sessionId: string): AgentApi {
  return async (method, url, body) => {
    const answer = await r.app.inject({
      method,
      url,
      headers: { host: HOST, 'x-switchboard-session': sessionId, authorization: `Bearer ${agentTokenFor(r.token, sessionId)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: answer.statusCode, body: answer.body ? (answer.json() as unknown) : null };
  };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? '').join('');
}

describe('D135 · over the app: the tools, the review routes, phones and paired machines', () => {
  it('memory_list shows the id; memory_propose_edit / _retract land in the queue and are decided through the entry routes', async () => {
    const r = await appSetup();
    const sessionId = (await r.store.sessions.create({ name: 'agent', claudeSessionId: 'c-agent', attached: true, title: 'Acme agent', root: r.workspace, rootKind: 'workspace', cwd: r.workspace })).id;
    const api = helperApi(r, sessionId);
    const added = (await ui(r, 'POST', '/api/memory/entries', { scope: r.workspace, title: 'Acme build', text: 'npm run build' })).json() as MemoryEntry;
    const second = (await ui(r, 'POST', '/api/memory/entries', { scope: r.workspace, title: 'Acme old rule', text: 'Retired rule.' })).json() as MemoryEntry;
    expect(text(await memoryList(api))).toContain(`(id: ${added.id}`);

    const edited = await memoryProposeEdit(api, { entry: added.id, text: 'npm run build:all', reason: 'Builds every package now.' });
    expect(edited.isError).toBeUndefined();
    expect(text(edited)).toContain('Proposed an edit of "Acme build"');
    expect(text(await memoryProposeEdit(api, { entry: added.id, text: 'npm run build:x', reason: 'x' }))).toContain('already proposed an edit');
    expect(text(await memoryProposeEdit(api, { entry: 'nope', text: 'x' }))).toContain('no approved memory entry nope');
    expect((await memoryProposeEdit(api, { entry: added.id })).isError).toBe(true);
    const retracted = await memoryProposeRetract(api, { entry: second.id, reason: 'The rule was retired.' });
    expect(text(retracted)).toContain('Proposed removing "Acme old rule"');
    expect((await memoryProposeRetract(api, { entry: second.id })).isError).toBe(true);

    const queue = (await ui(r, 'GET', `/api/memory/entries?scope=${encodeURIComponent(r.workspace)}&status=proposed`)).json() as MemoryEntry[];
    expect(queue.map((e) => [e.changeKind, e.target?.id, e.reason])).toEqual([
      ['edit', added.id, 'Builds every package now.'],
      ['retract', second.id, 'The rule was retired.'],
    ]);
    const [edit, retract] = queue as [MemoryEntry, MemoryEntry];
    expect((await ui(r, 'POST', `/api/memory/entries/${edit.id}/approve`, { title: 'Acme build command' })).json()).toMatchObject({ id: added.id, title: 'Acme build command', text: 'npm run build:all' });
    expect((await ui(r, 'POST', `/api/memory/entries/${retract.id}/reject`)).statusCode).toBe(200);
    const approved = (await ui(r, 'GET', `/api/memory/entries?scope=${encodeURIComponent(r.workspace)}&status=approved`)).json() as MemoryEntry[];
    expect(approved.map((e) => [e.id, e.title]).sort()).toEqual([
      [added.id, 'Acme build command'],
      [second.id, 'Acme old rule'],
    ].sort());
    // Direct agent routes: an agent can propose, never decide.
    expect((await api('POST', '/agent/v1/memory/retract', { entry: second.id, reason: 'Retired after all.' })).status).toBe(201);
    expect((await api('POST', `/api/memory/entries/${second.id}/approve`, {})).status).toBe(401);
  });

  it('phones and paired machines decide change proposals through the routes they already reach', () => {
    for (const [method, url] of [
      ['POST', '/api/memory/entries/abc/approve'],
      ['POST', '/api/memory/entries/abc/reject'],
      ['PUT', '/api/memory/entries/abc'],
      ['GET', '/api/memory/entries'],
    ] as const) {
      expect([method, url, isLocalOnly(method, url)]).toEqual([method, url, false]);
      expect(matchesRule(DEVICE_ALLOWED, method, url)).toBe(true);
      expect(matchesRule(DEVICE_REFUSED, method, url)).toBe(false);
      expect(peerApiAllowed(method, url)).toBe(true);
    }
    // The agent's routes are never a phone's or a paired machine's.
    expect(peerApiAllowed('POST', '/agent/v1/memory/edit')).toBe(false);
    expect(peerApiAllowed('POST', '/agent/v1/memory/retract')).toBe(false);
  });
});
