import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_BLOCK_START, MEMORY_SETTING, type MemoryEntry, memoryListText } from '../../../src/core/memory.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { migrate } from '../../../src/server/db/migrate.ts';
import { failureText, runCommand, succeeded } from '../../../src/server/exec.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { MEMORY_DB_FILE, MEMORY_MIGRATIONS, MemoryDb } from '../../../src/server/memory/db.ts';
import { repoRefOf } from '../../../src/server/memory/reach.ts';
import { type MemoryPeers, MemoryService } from '../../../src/server/memory/service.ts';
import { sessionInstruction } from '../../../src/server/sessions/instruction.ts';
import { type TeamMemberRef, registerTeamHooks } from '../../../src/server/team/hooks.ts';
import { SessionRepos } from '../../../src/server/worktrees/session-repos.ts';
import { SessionTouchedFiles } from '../../../src/server/worktrees/touched.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D107 follow-up 2026-10-15 · scopes on Project memory (`docs/memory.md` → *Scopes*), on the real
 * service with the real repo set (`SessionRepos`) over temp git repos and Team's hooks registered
 * by hand: who sees what (member / repo through a linked worktree / workspace), the charter outside
 * the cap, proposals' default scope per session, approving with another scope, `memory_list`, the
 * draft ask without duplicates, the migration (old rows → workspace; migration 1 unchanged) and a
 * moved member's entries going to the other machine.
 */

const GIT_ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand(['git'], args, { cwd, env: { ...process.env, ...GIT_ENV } });
  if (!succeeded(result)) throw new Error(`git ${args.join(' ')}: ${failureText(result)}`);
}

interface Sent {
  readonly sessionId: string;
  readonly text: string;
}

interface Rig {
  readonly root: string;
  readonly store: Store;
  readonly memory: MemoryService;
  readonly sent: Sent[];
  /** A workspace folder (no git), the folder of the member and the plain session. */
  readonly workspace: string;
  /** A repo folder (a main checkout with an `origin`) and its linked worktree. */
  readonly repo: string;
  readonly linked: string;
  readonly clock: { now: Date };
  members: TeamMemberRef[];
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.memory.close();
    await rig.store.close();
    await removeTempDir(rig.root);
  }
});

async function setup(label = 'memory-scopes', options: { readonly peers?: MemoryPeers } = {}): Promise<Rig> {
  const root = await realpath(await makeTempDir(label));
  const store = await openTempStore(path.join(root, 'data'));
  const workspace = path.join(root, 'acme-workspace');
  const repo = path.join(root, 'acme-app');
  const linked = path.join(root, 'acme-app-wt-feature');
  await mkdir(workspace, { recursive: true });
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/acme-app.git');
  await git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  const sent: Sent[] = [];
  const clock = { now: new Date('2026-10-15T10:00:00.000Z') };
  const repos = new SessionRepos({ store, touched: new SessionTouchedFiles({ store }) });
  const memory = new MemoryService({
    dataDir: path.join(root, 'data'),
    store,
    bus: new HubBus(),
    supervisor: {
      instructionSettingChanged: async () => undefined,
      sendMessage: async (sessionId, text) => {
        sent.push({ sessionId, text });
      },
    },
    repos,
    ...(options.peers ? { peers: options.peers } : {}),
    now: () => clock.now,
    onError: () => undefined,
  });
  const rig: Rig = { root, store, memory, sent, workspace, repo, linked, clock, members: [] };
  // Team (D100) as Project memory sees it: the charter, the member of a session and the members.
  registerTeamHooks(store, {
    charterFor: async (sessionId) => (rig.members.some((member) => member.sessionId === sessionId) ? `CHARTER ${'x'.repeat(5_000)}` : null),
    roleOf: (sessionId) => rig.members.find((member) => member.sessionId === sessionId)?.name ?? null,
    switchChanged: async () => undefined,
    memberOf: (sessionId) => rig.members.find((member) => member.sessionId === sessionId && member.here) ?? null,
    memberList: () => rig.members,
  });
  await store.settings.set(MEMORY_SETTING, true);
  await memory.start();
  rigs.push(rig);
  return rig;
}

async function session(r: Rig, name: string, where: { readonly root: string; readonly rootKind: 'workspace' | 'repo'; readonly cwd?: string }): Promise<string> {
  return (await r.store.sessions.create({ name, claudeSessionId: `c-${name}`, attached: true, title: name, root: where.root, rootKind: where.rootKind, cwd: where.cwd ?? where.root })).id;
}

function member(r: Rig, sessionId: string, name: string, extra: Partial<TeamMemberRef> = {}): TeamMemberRef {
  const ref: TeamMemberRef = { id: `m-${name.toLowerCase()}`, name, teamId: 'team', sessionId, machineId: 'self', here: true, paused: false, ...extra };
  r.members.push(ref);
  return ref;
}

async function approve(r: Rig, sessionId: string, title: string, scope?: Record<string, unknown>): Promise<MemoryEntry> {
  const proposed = await r.memory.propose(sessionId, { title, text: `${title.toUpperCase().replace(/\s+/g, '-')}`, ...(scope ?? {}) });
  return r.memory.approve(proposed.id, {});
}

/** Three sessions: a member in the workspace, a plain one in the workspace, one in the repo's linked worktree. */
async function world(r: Rig) {
  const memberSession = await session(r, 'builder', { root: r.workspace, rootKind: 'workspace' });
  const plain = await session(r, 'plain', { root: r.workspace, rootKind: 'workspace' });
  const inRepo = await session(r, 'in-repo', { root: r.repo, rootKind: 'repo', cwd: r.linked });
  const builder = member(r, memberSession, 'Builder');
  return { memberSession, plain, inRepo, builder };
}

describe('D107 follow-up · scopes: who sees what', () => {
  it('a linked worktree is its repository (the remote key), the main checkout too', async () => {
    const r = await setup();
    const main = await repoRefOf(r.repo);
    const linked = await repoRefOf(r.linked);
    expect(main).toEqual({ key: 'github.com/acme/acme-app', label: 'acme-app' });
    expect(linked).toEqual(main);
    // Without a remote: the main checkout's path, from the linked worktree as well.
    await git(r.repo, 'remote', 'remove', 'origin');
    expect(await repoRefOf(r.linked)).toEqual({ key: r.repo, label: 'acme-app' });
  });

  it('member entries reach only the member, repo entries every session in the repo (any folder), workspace entries the folder', async () => {
    const r = await setup();
    const { memberSession, plain, inRepo } = await world(r);
    await approve(r, memberSession, 'Member only fact');
    await approve(r, inRepo, 'Repo fact');
    await approve(r, plain, 'Workspace fact');
    const block = async (id: string): Promise<string> => (await r.memory.blockFor({ id, kind: 'session', root: (await r.store.sessions.get(id))?.root ?? null })) ?? '';
    const memberBlock = await block(memberSession);
    expect(memberBlock).toContain('MEMBER-ONLY-FACT');
    expect(memberBlock).toContain('WORKSPACE-FACT');
    expect(memberBlock).not.toContain('REPO-FACT');
    expect(memberBlock).toContain('-- For you, Builder (member memory) --');
    expect(memberBlock.indexOf('MEMBER-ONLY-FACT')).toBeLessThan(memberBlock.indexOf('WORKSPACE-FACT'));
    const plainBlock = await block(plain);
    expect(plainBlock).toContain('WORKSPACE-FACT');
    expect(plainBlock).not.toContain('MEMBER-ONLY-FACT');
    expect(plainBlock).not.toContain('REPO-FACT');
    // A workspace-only block reads as before scopes (no headings).
    expect(plainBlock).not.toContain('-- ');
    const repoBlock = await block(inRepo);
    expect(repoBlock).toContain('-- Repository acme-app (repo memory) --');
    expect(repoBlock).toContain('REPO-FACT');
    expect(repoBlock).not.toContain('MEMBER-ONLY-FACT');
    expect(repoBlock).not.toContain('WORKSPACE-FACT');
    // Another session in the main checkout of the same repo (another folder kind) sees the repo entry too.
    const elsewhere = await session(r, 'main-checkout', { root: r.repo, rootKind: 'repo' });
    expect(await block(elsewhere)).toContain('REPO-FACT');
  });

  it('the panel count and memory_list follow the same visibility, each entry labelled with its scope', async () => {
    const r = await setup();
    const { memberSession, plain } = await world(r);
    await approve(r, memberSession, 'Member only fact');
    await approve(r, plain, 'Workspace fact');
    await r.memory.propose(plain, { title: 'Waiting proposal', text: 'NOT YET' });
    expect(await r.memory.sessionCount(memberSession)).toEqual({ count: 2, member: 1, repo: 0, workspace: 1, overflow: 0, proposed: 1, folder: r.workspace });
    expect(await r.memory.sessionCount(plain)).toMatchObject({ count: 1, member: 0, workspace: 1 });
    const listed = await r.memory.agentList(memberSession);
    expect(listed.entries.map((entry) => [entry.scopeKind, entry.title])).toEqual([
      ['member', 'Member only fact'],
      ['workspace', 'Workspace fact'],
    ]);
    const text = memoryListText(listed.entries, listed.label);
    expect(text).toContain('[member Builder] - Member only fact');
    expect(text).toContain('[workspace] - Workspace fact');
    expect((await r.memory.agentList(plain)).entries.map((entry) => entry.title)).toEqual(['Workspace fact']);
  });

  it("the Team charter is not counted against the memory cap", async () => {
    const r = await setup();
    const { memberSession } = await world(r);
    await r.memory.setSettings({ cap: 500 });
    await approve(r, memberSession, 'Member only fact');
    const record = await r.store.sessions.get(memberSession);
    if (!record) throw new Error('gone');
    const instruction = (await sessionInstruction(r.store, record)) ?? '';
    // The 5,000-character charter is there and so is the entry, though the cap is 500.
    expect(instruction).toContain('CHARTER xxx');
    expect(instruction).toContain(MEMORY_BLOCK_START);
    expect(instruction).toContain('MEMBER-ONLY-FACT');
    expect(instruction).not.toContain('more approved entr');
  });
});

describe('D107 follow-up · proposals and approval', () => {
  it("a proposal's default scope: member for a member, repo with exactly one repo, else workspace", async () => {
    const r = await setup();
    const { memberSession, plain, inRepo, builder } = await world(r);
    const byMember = await r.memory.propose(memberSession, { title: 'From the member', text: 'a' });
    expect([byMember.scopeKind, byMember.scopeKey, byMember.scopeLabel]).toEqual(['member', builder.id, 'Builder']);
    const byRepo = await r.memory.propose(inRepo, { title: 'From the repo session', text: 'b' });
    expect([byRepo.scopeKind, byRepo.scopeKey, byRepo.scopeLabel]).toEqual(['repo', 'github.com/acme/acme-app', 'acme-app']);
    const byPlain = await r.memory.propose(plain, { title: 'From the plain session', text: 'c' });
    expect([byPlain.scopeKind, byPlain.scopeKey]).toEqual(['workspace', null]);
    // Asked explicitly: workspace from a member is fine; member from a non-member is refused; repo without a repo is refused.
    expect((await r.memory.propose(memberSession, { title: 'Everyone needs this', text: 'd', scope: 'workspace' })).scopeKind).toBe('workspace');
    await expect(r.memory.propose(plain, { title: 'Not a member', text: 'e', scope: 'member' })).rejects.toMatchObject({ status: 422, code: 'invalid' });
    await expect(r.memory.propose(plain, { title: 'No repo here', text: 'f', scope: 'repo' })).rejects.toMatchObject({ status: 422 });
    expect((await r.memory.propose(inRepo, { title: 'Named repo', text: 'g', scope: 'repo', repo: 'acme-app' })).scopeKey).toBe('github.com/acme/acme-app');
    await expect(r.memory.propose(inRepo, { title: 'Wrong repo', text: 'h', scope: 'repo', repo: 'other' })).rejects.toMatchObject({ status: 422 });
  });

  it('approving with another scope: the developer’s choice is what is injected; a scope outside the options is refused', async () => {
    const r = await setup();
    const { memberSession, plain, inRepo } = await world(r);
    const options = await r.memory.scopeOptions(r.workspace);
    expect(options.map((option) => option.kind)).toEqual(expect.arrayContaining(['workspace', 'member']));
    const proposal = await r.memory.propose(memberSession, { title: 'Actually for everyone', text: 'WIDENED' });
    expect(proposal.scopeKind).toBe('member');
    await expect(r.memory.approve(proposal.id, { scopeKind: 'member', scopeKey: 'someone-else' })).rejects.toMatchObject({ status: 422 });
    const approved = await r.memory.approve(proposal.id, { scopeKind: 'workspace' });
    expect([approved.scopeKind, approved.scopeKey, approved.status]).toEqual(['workspace', null, 'approved']);
    expect(await r.memory.blockFor({ id: plain, kind: 'session', root: r.workspace })).toContain('WIDENED');
    // A repo proposal narrowed to the member (an option: Team's members).
    const repoProposal = await r.memory.propose(inRepo, { title: 'Builder only after all', text: 'NARROWED' });
    const repoOptions = await r.memory.scopeOptions(r.repo, repoProposal.id);
    expect(repoOptions.find((option) => option.kind === 'repo')?.label).toBe('acme-app');
    const narrowed = await r.memory.approve(repoProposal.id, { scopeKind: 'member', scopeKey: 'm-builder' });
    expect([narrowed.scopeKind, narrowed.scopeLabel]).toEqual(['member', 'Builder']);
    expect(await r.memory.blockFor({ id: inRepo, kind: 'session', root: r.repo })).toBeNull();
    expect(await r.memory.blockFor({ id: memberSession, kind: 'session', root: r.workspace })).toContain('NARROWED');
    // The edit form changes the scope of an approved entry too.
    const back = await r.memory.update(narrowed.id, { scopeKind: 'repo', scopeKey: 'github.com/acme/acme-app' });
    expect(back.scopeKind).toBe('repo');
    expect(await r.memory.blockFor({ id: inRepo, kind: 'session', root: r.repo })).toContain('NARROWED');
  });

  it('a near-identical title is refused across the scopes a session sees', async () => {
    const r = await setup();
    const { memberSession, plain } = await world(r);
    await approve(r, plain, 'Run the tests');
    await expect(r.memory.propose(memberSession, { title: 'Run the test', text: 'x' })).rejects.toMatchObject({ status: 409, code: 'duplicate' });
  });
});

describe('D107 follow-up · Draft memory from this session', () => {
  it('sends the session one ask; a second within 24 hours is ignored; then it may ask again', async () => {
    const r = await setup();
    const { memberSession, plain } = await world(r);
    expect(await r.memory.draft({ sessionId: memberSession })).toEqual({ asked: true, reason: null, askedAt: '2026-10-15T10:00:00.000Z' });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.text).toContain('Switchboard asks you to draft project memory from this session.');
    expect(r.sent[0]?.text).toContain('the default for you, Builder');
    expect(r.sent[0]?.text).toContain('Nothing is applied');
    r.clock.now = new Date('2026-10-16T09:59:00.000Z');
    expect(await r.memory.draft({ sessionId: memberSession })).toEqual({ asked: false, reason: 'asked-recently', askedAt: '2026-10-15T10:00:00.000Z' });
    expect(await r.memory.draft({ memberId: 'm-builder' })).toMatchObject({ asked: false, reason: 'asked-recently' });
    expect(r.sent).toHaveLength(1);
    r.clock.now = new Date('2026-10-16T10:01:00.000Z');
    expect((await r.memory.draft({ sessionId: memberSession })).asked).toBe(true);
    expect(r.sent).toHaveLength(2);
    // Nothing is applied by asking.
    expect(r.memory.entries({ scope: r.workspace })).toEqual([]);
    // A non-member's ask names repo / workspace only.
    await r.memory.draft({ sessionId: plain });
    expect(r.sent[2]?.text).not.toContain('"member"');
  });

  it('Draft memory for all members: each member once, paused ones skipped', async () => {
    const r = await setup();
    const { memberSession } = await world(r);
    const other = await session(r, 'tester', { root: r.workspace, rootKind: 'workspace' });
    member(r, other, 'Tester', { paused: true });
    const answer = await r.memory.draftAll({});
    expect(answer.asked).toEqual([{ memberId: 'm-builder', name: 'Builder' }]);
    expect(answer.skipped).toEqual([{ memberId: 'm-tester', name: 'Tester', reason: 'paused' }]);
    expect(r.sent.map((s) => s.sessionId)).toEqual([memberSession]);
    const again = await r.memory.draftAll({ teamId: 'team' });
    expect(again.asked).toEqual([]);
    expect(again.skipped[0]).toEqual({ memberId: 'm-builder', name: 'Builder', reason: 'asked in the last 24 hours' });
  });
});

describe('D107 follow-up · storage and moves', () => {
  it('the migration: old entries become workspace; migration 1 is byte-identical', async () => {
    // Migration 1 as released in 1.20.0 (its checksum is what installed databases hold).
    expect(MEMORY_MIGRATIONS[0]?.checksum).toBe('6d1bf0aedc3a169a1215c62bf859c6d8e4e8f7aaa272d885ec21b34baf615c13');
    expect(MEMORY_MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, 'memory'],
      [2, 'memory_scopes'],
    ]);
    const root = await realpath(await makeTempDir('memory-migrate'));
    try {
      // A memory.db as 1.20.0 – 1.21.0 left it: migration 1 only.
      const raw = new DatabaseSync(path.join(root, MEMORY_DB_FILE));
      migrate(raw, MEMORY_MIGRATIONS.slice(0, 1));
      raw
        .prepare(`INSERT INTO memory_entries (id, scope, title, text, tags, author_kind, status, pinned, created_at, updated_at, decided_at, decided_by) VALUES ('old1', '/w', 'Old fact', 'As approved.', '[]', 'developer', 'approved', 1, 't', 't', 't', 'developer')`)
        .run();
      raw.close();
      const db = await MemoryDb.open(root);
      const entry = db.get('old1');
      expect(entry).toMatchObject({ scopeKind: 'workspace', scopeKey: null, scopeLabel: null, title: 'Old fact', text: 'As approved.', status: 'approved', pinned: true });
      expect(db.draftAskedAt('s')).toBeNull();
      db.close();
    } finally {
      await removeTempDir(root);
    }
  });

  it("a moved member's entries go to the machine it now runs on and keep their states", async () => {
    let target: Rig | null = null;
    const forwarded: string[] = [];
    const source = await setup('memory-move-a', {
      peers: {
        forward: async (machineId, method, route, body) => {
          forwarded.push(`${machineId} ${method} ${route}`);
          if (!target) return { status: 502, body: null };
          try {
            return { status: 200, body: await target.memory.importMember(body) };
          } catch (error) {
            return { status: (error as { status?: number }).status ?? 500, body: null };
          }
        },
      },
    });
    target = await setup('memory-move-b');
    const { memberSession, plain } = await world(source);
    await approve(source, memberSession, 'Member only fact');
    const waiting = await source.memory.propose(memberSession, { title: 'Member proposal', text: 'WAITING' });
    await approve(source, plain, 'Workspace fact');
    // On the target the member runs in a session of another folder (D110: other paths).
    const there = await session(target, 'builder-there', { root: target.repo, rootKind: 'repo' });
    member(target, there, 'Builder');
    await source.memory.memberMoved({ memberId: 'm-builder', machineId: 'pc-2', sessionId: there });
    expect(forwarded).toEqual(['pc-2 POST /api/memory/import']);
    // Gone here (the workspace entry stays), there with its states, in the target session's folder.
    expect(source.memory.entries({ scope: source.workspace }).map((entry) => entry.title)).toEqual(['Workspace fact']);
    const moved = target.memory.entries({ scope: target.repo });
    expect(moved.map((entry) => [entry.title, entry.status, entry.scopeKind])).toEqual([
      ['Member only fact', 'approved', 'member'],
      ['Member proposal', 'proposed', 'member'],
    ]);
    expect(moved.find((entry) => entry.id === waiting.id)).toBeDefined();
    expect(await target.memory.blockFor({ id: there, kind: 'session', root: target.repo })).toContain('MEMBER-ONLY-FACT');
  });

  it('a move whose target cannot take the entries keeps them here', async () => {
    const source = await setup('memory-move-c', { peers: { forward: async () => ({ status: 404, body: { error: 'memory-off' } }) } });
    const { memberSession } = await world(source);
    await approve(source, memberSession, 'Member only fact');
    await source.memory.memberMoved({ memberId: 'm-builder', machineId: 'pc-2', sessionId: 'x' });
    expect(source.memory.entries({ scope: source.workspace }).map((entry) => entry.title)).toEqual(['Member only fact']);
  });
});
