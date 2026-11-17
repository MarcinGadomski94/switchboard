import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/core/api.ts';
import { slugForCwd } from '../../../src/core/transcript.ts';
import { buildApp } from '../../../src/server/app.ts';
import { createBackup } from '../../../src/server/backup/archive.ts';
import { type KdfParams, newKey, passphraseKey } from '../../../src/server/backup/crypto.ts';
import { applyRestore, prepareRestore } from '../../../src/server/backup/restore.ts';
import { BackupService } from '../../../src/server/backup/service.ts';
import { loadConfig } from '../../../src/server/config.ts';
import type { Store } from '../../../src/server/db/store.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { newMachineId } from '../../../src/server/peers/tokens.ts';
import { JIRA_SECRET_REF } from '../../../src/server/plans/jira/credentials.ts';
import { MemorySecretStore } from '../../../src/server/team/access/secret-store.ts';
import { generateToken } from '../../../src/server/token.ts';
import { makeTempDir, removeTempDir } from '../../helpers/net.ts';
import { openTempStore } from '../../helpers/store.ts';

/**
 * D168 (`docs/backup.md`): a whole setup backed up on one "computer" (temp folders A) and restored
 * into a fresh install on another (temp folders B) with its folders mapped: the agents, their
 * folders and paths, an account's own folder, both agents' conversations at the new working
 * folder's slug, an attachment, the keychain value and a new identity; a wrong passphrase, a
 * changed byte and an install that already has agents restore nothing; the automatic backups keep N.
 */

const FAST: KdfParams = { logN: 10, r: 8, p: 1 };
const PASS = 'a long enough passphrase';

let tmp: string;
let a: { data: string; ws: string; claude: string; home: string };
let b: { data: string; ws: string; claude: string; home: string };

beforeEach(async () => {
  tmp = await makeTempDir('backup');
  const side = async (name: string) => {
    const root = path.join(tmp, name);
    const out = { data: path.join(root, 'data'), ws: path.join(root, 'ws'), claude: path.join(root, 'claude-default'), home: path.join(root, 'home') };
    for (const dir of Object.values(out)) await mkdir(dir, { recursive: true });
    return out;
  };
  a = await side('a');
  b = await side('b');
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** The old computer: two agents (one on the Default account, one on its own account), a folder, an attachment, a keychain value. */
async function oldComputer(): Promise<{ secrets: MemorySecretStore; ids: { main: string; work: string; claudeMain: string; claudeWork: string; self: string } }> {
  const store = await openTempStore(a.data);
  const self = newMachineId();
  try {
    await store.settings.set('peers.self', { id: self, name: 'Old PC' });
    const app = path.join(a.ws, 'app');
    await mkdir(app, { recursive: true });
    const folder = await store.folders.create({ path: a.ws, canonicalPath: a.ws, kind: 'workspace', isDefault: true });
    const profileDir = path.join(a.data, 'profiles', 'claude', 'p1');
    await store.profiles.create({ id: 'p1', cli: 'claude', name: 'Work', dir: profileDir, shareSettings: false });
    const claudeMain = randomUUID();
    const claudeWork = randomUUID();
    const main = await store.sessions.create({ name: 'main-agent', claudeSessionId: claudeMain, cwd: app, root: a.ws, rootKind: 'workspace', folderId: folder.id, extraDirs: [path.join(a.ws, 'other')] });
    const work = await store.sessions.create({ name: 'work-agent', claudeSessionId: claudeWork, cwd: app, root: a.ws, folderId: folder.id, profileId: 'p1' });
    // Agent 1's conversation in the CLI's Default folder (outside the data folder), with a subagent file.
    const project = path.join(a.claude, 'projects', slugForCwd(app));
    await mkdir(path.join(project, claudeMain, 'subagents'), { recursive: true });
    await writeFile(path.join(project, `${claudeMain}.jsonl`), '{"type":"user","message":"hello"}\n');
    await writeFile(path.join(project, claudeMain, 'subagents', 'agent-1.jsonl'), '{"type":"assistant"}\n');
    // Agent 2's in its account's own folder (inside the data folder).
    const own = path.join(profileDir, 'projects', slugForCwd(app));
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, `${claudeWork}.jsonl`), '{"type":"user","message":"work"}\n');
    await mkdir(path.join(a.data, 'attachments', main.id), { recursive: true });
    await writeFile(path.join(a.data, 'attachments', main.id, 'a1-note.txt'), 'attached');
    await writeFile(path.join(a.data, 'sb_token'), 'old-token');
    const secrets = new MemorySecretStore();
    await secrets.set(JIRA_SECRET_REF, 'jira-token-123');
    return { secrets, ids: { main: main.id, work: work.id, claudeMain, claudeWork, self } };
  } finally {
    await store.close();
  }
}

async function backup(secrets: MemorySecretStore): Promise<string> {
  const out = path.join(tmp, 'out', 'setup.sbbackup');
  const key = await newKey(PASS, FAST);
  await createBackup({ dataDir: a.data, env: { CLAUDE_CONFIG_DIR: a.claude, CODEX_HOME: path.join(a.home, '.codex') }, home: a.home, version: '2.4.43', secrets }, out, key);
  return out;
}

function targetOf(secrets: MemorySecretStore) {
  return { dataDir: b.data, env: { CLAUDE_CONFIG_DIR: b.claude, CODEX_HOME: path.join(b.home, '.codex') }, home: b.home, version: '2.4.43', secrets };
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe('D168 · backup on one computer, restore into a fresh install on another', () => {
  it('everything comes back, at this computer’s paths; the conversations are where its CLI looks; a new identity', async () => {
    const old = await oldComputer();
    const file = await backup(old.secrets);
    expect((await readFile(file)).subarray(0, 4).toString()).toBe('SBBK');
    expect((await readFile(file)).includes(Buffer.from('jira-token-123'))).toBe(false);
    await mkdir(path.join(b.ws, 'app'), { recursive: true });
    const secretsB = new MemorySecretStore();
    const staging = path.join(b.data, 'restore-pending');
    const plan = await prepareRestore(file, passphraseKey(PASS), targetOf(secretsB), { maps: [{ from: a.ws, to: b.ws }], identity: 'new', replace: false, allowMissing: false }, staging);
    expect(plan.missingFolders).toEqual([]);
    expect(plan.conversations).toBe(2);
    const report = await applyRestore(staging, targetOf(secretsB));
    expect(report).toMatchObject({ ok: true, agents: 2, folders: 1, secrets: 1, secretsFailed: 0, identity: 'new', conversations: 2, conversationsMissing: 0 });
    expect(await exists(staging)).toBe(false);
    // The keychain value is in this computer's keychain.
    expect(await secretsB.get(JIRA_SECRET_REF)).toBe('jira-token-123');
    // The conversations at the new working folder's slug.
    const newApp = path.join(b.ws, 'app');
    const slug = slugForCwd(newApp);
    expect(await readFile(path.join(b.claude, 'projects', slug, `${old.ids.claudeMain}.jsonl`), 'utf8')).toContain('hello');
    expect(await exists(path.join(b.claude, 'projects', slug, old.ids.claudeMain, 'subagents', 'agent-1.jsonl'))).toBe(true);
    expect(await readFile(path.join(b.data, 'profiles', 'claude', 'p1', 'projects', slug, `${old.ids.claudeWork}.jsonl`), 'utf8')).toContain('work');
    expect(await readFile(path.join(b.data, 'attachments', old.ids.main, 'a1-note.txt'), 'utf8')).toBe('attached');
    // A new computer keeps its own token (none here yet) and gets a new identity.
    expect(await exists(path.join(b.data, 'sb_token'))).toBe(false);
    const store: Store = await openTempStore(b.data);
    try {
      const folders = await store.folders.list();
      expect(folders.map((folder) => folder.path)).toEqual([b.ws]);
      const main = await store.sessions.get(old.ids.main);
      expect(main).toMatchObject({ cwd: newApp, root: b.ws, extraDirs: [path.join(b.ws, 'other')], transcriptPath: path.join(b.claude, 'projects', slug, `${old.ids.claudeMain}.jsonl`) });
      expect((await store.profiles.get('p1'))?.dir).toBe(path.join(b.data, 'profiles', 'claude', 'p1'));
      const self = (await store.settings.get('peers.self')) as { id: string };
      expect(self.id).not.toBe(old.ids.self);
    } finally {
      await store.close();
    }
    // The restored Switchboard lists the same agents, at this computer's paths.
    const storeB = await openTempStore(b.data);
    const config = { ...loadConfig({ env: { SWITCHBOARD_DATA_DIR: b.data }, platform: 'linux', home: b.home, cwd: b.home }), port: 4879 };
    const token = generateToken();
    const app: FastifyInstance = await buildApp({ config, token, store: storeB, webRoot: b.home, bus: new HubBus(), backup: { secrets: secretsB, kdf: FAST, home: b.home, env: targetOf(secretsB).env, version: '2.4.43' } });
    try {
      await app.ready();
      const answer = await app.inject({ method: 'GET', url: '/api/sessions?closed=include', headers: { host: '127.0.0.1:4879', cookie: `sb_token=${token}` } });
      const sessions = answer.json() as Session[];
      expect(sessions.map((session) => session.name).sort()).toEqual(['main-agent', 'work-agent']);
      expect(sessions.every((session) => session.cwd === newApp)).toBe(true);
      // Backup is a local route; its last restore is shown.
      const status = await app.inject({ method: 'GET', url: '/api/backup', headers: { host: '127.0.0.1:4879', cookie: `sb_token=${token}` } });
      expect(status.json()).toMatchObject({ lastRestore: { ok: true, agents: 2 } });
    } finally {
      await app.close();
      await storeB.close();
    }
  });

  it('a wrong passphrase, a changed byte, a missing folder or an install with agents: nothing is restored', async () => {
    const old = await oldComputer();
    const file = await backup(old.secrets);
    const staging = path.join(b.data, 'restore-pending');
    const choices = { maps: [{ from: a.ws, to: b.ws }], identity: 'keep' as const, replace: false, allowMissing: false };
    await mkdir(path.join(b.ws, 'app'), { recursive: true });
    await expect(prepareRestore(file, passphraseKey('the wrong passphrase'), targetOf(new MemorySecretStore()), choices, staging)).rejects.toMatchObject({ code: 'wrong-passphrase' });
    const bytes = await readFile(file);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] as number) ^ 0xff;
    const changed = path.join(tmp, 'changed.sbbackup');
    await writeFile(changed, bytes);
    await expect(prepareRestore(changed, passphraseKey(PASS), targetOf(new MemorySecretStore()), choices, staging)).rejects.toMatchObject({ code: 'damaged' });
    // A folder that does not exist here, without a mapping (the old computer's folder is gone on this one).
    await rm(a.ws, { recursive: true, force: true });
    await expect(prepareRestore(file, passphraseKey(PASS), targetOf(new MemorySecretStore()), { ...choices, maps: [] }, staging)).rejects.toMatchObject({ code: 'missing-folders' });
    expect((await readdir(b.data)).filter((name) => name !== 'restore-pending')).toEqual([]);
    // An install that already has agents: only with replace (its data kept aside).
    const store = await openTempStore(b.data);
    await store.sessions.create({ name: 'here', claudeSessionId: randomUUID() });
    await store.close();
    await expect(prepareRestore(file, passphraseKey(PASS), targetOf(new MemorySecretStore()), choices, staging)).rejects.toMatchObject({ code: 'not-fresh' });
    await prepareRestore(file, passphraseKey(PASS), targetOf(new MemorySecretStore()), { ...choices, replace: true }, staging);
    const report = await applyRestore(staging, targetOf(new MemorySecretStore()));
    expect(report.previousData).toMatch(/\.pre-restore-/);
    expect(await exists(path.join(report.previousData as string, 'switchboard.db'))).toBe(true);
    // keep: the old computer's token and identity came along.
    expect(await readFile(path.join(b.data, 'sb_token'), 'utf8')).toBe('old-token');
  });

  it('automatic backups: the key from the passphrase in the keychain, a day apart, the newest N kept', async () => {
    await oldComputer();
    const store = await openTempStore(a.data);
    let now = new Date(2026, 10, 17, 3, 0, 0);
    const secrets = new MemorySecretStore();
    const folder = path.join(tmp, 'auto');
    const service = new BackupService({ dataDir: a.data, env: { CLAUDE_CONFIG_DIR: a.claude }, home: a.home, version: '2.4.43', settings: store.settings, secrets, kdf: FAST, now: () => now });
    try {
      await expect(service.setAuto({ enabled: true, folder })).rejects.toMatchObject({ code: 'needs-passphrase' });
      const status = await service.setAuto({ enabled: true, folder, keep: 2, passphrase: PASS });
      expect(status.auto).toMatchObject({ enabled: true, keep: 2, hasKey: true });
      expect(JSON.stringify(secrets.entries())).not.toContain(PASS);
      for (let day = 0; day < 3; day++) {
        expect((await service.tick())?.ok).toBe(true);
        // Not again the same day.
        expect(await service.tick()).toBeNull();
        now = new Date(now.getTime() + 24 * 3600_000 + 60_000);
      }
      const files = (await readdir(folder)).sort();
      expect(files).toHaveLength(2);
      expect(files.every((name) => name.endsWith('-auto.sbbackup'))).toBe(true);
      // Restorable with the passphrase.
      const staging = path.join(b.data, 'restore-pending');
      await mkdir(path.join(b.ws, 'app'), { recursive: true });
      const plan = await prepareRestore(path.join(folder, files[1] as string), passphraseKey(PASS), targetOf(new MemorySecretStore()), { maps: [{ from: a.ws, to: b.ws }], identity: 'new', replace: false, allowMissing: false }, staging);
      expect(plan.preview.counts.agents).toBe(2);
    } finally {
      service.stop();
      await store.close();
    }
  });
});
