import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionEvent } from '../../../src/core/api.ts';
import type { ChatMovePreview, ChatMoveRun } from '../../../src/core/chat-move.ts';
import { remoteId } from '../../../src/core/peers.ts';
import { makeTempDir } from '../../helpers/net.ts';
import { type PeerNode, waitFor } from '../../helpers/peers.ts';
import { type TakeoverWorld, fakeLog, removeWorld, sessionSpawns, settle, takeoverWorld } from '../../helpers/takeover.ts';

/**
 * D155 with two real Switchboard processes ("pc-office" = a, "mac-laptop" = b), fake
 * CLIs and temp folders (`docs/peers.md` → *Moving a chat (D155)*): a chat moves with
 * its conversation, attachments, scratch files, artifacts and todos; each folder it
 * looks at is mapped to a folder on the target or left out; a failure half-way
 * leaves nothing on the target and the chat as it was; an older target is refused
 * before anything changes.
 */

let tmp: string;
let world: TakeoverWorld | null = null;

beforeEach(async () => {
  tmp = await makeTempDir('chat-move');
});
afterEach(async () => {
  if (world) await Promise.all([world.a.server.stop(), world.b.server.stop()]);
  world = null;
  await removeWorld(tmp);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A chat on `node` with one attachment and the folders `lookAt`, settled (its first turn over). */
async function startChat(node: PeerNode, lookAt: readonly string[]): Promise<Session> {
  const uploaded = await node.call('POST', '/api/attachments', { name: 'sketch.png', data: PNG.toString('base64') });
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  const created = await node.call('POST', '/api/chats', { message: 'Remember the code word: zeppelin. How should we split billing?', lookAt, attachments: [uploaded.body.id] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return settle(node, (created.body as Session).id);
}

async function runMove(node: PeerNode, body: Record<string, unknown>): Promise<ChatMoveRun> {
  const started = await node.call('POST', '/api/takeover/chat', body);
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const id = (started.body as ChatMoveRun).id;
  return waitFor('the chat move to end', async () => {
    const current = (await node.call('GET', `/api/takeover/chat/runs/${id}`)).body as ChatMoveRun;
    return current.state === 'running' ? null : current;
  }, 90_000);
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

describe('D155: a chat moves to a paired computer', () => {
  it('carries the conversation, attachments, scratch files, artifacts and todos; maps one looked-at folder, leaves the other out; the source shows moved', async () => {
    const w = (world = await takeoverWorld(tmp));
    await mkdir(path.join(tmp, 'a', 'notes'), { recursive: true });
    const notes = await realpath(path.join(tmp, 'a', 'notes'));
    const chat = await startChat(w.a, [w.paths.a.alpha, notes]);
    // The scratch folder: a plan, a nested file, a file that looks like a secret (stays) and a link out (never followed).
    const scratch = chat.cwd as string;
    await writeFile(path.join(scratch, 'plan.md'), '# The plan\n');
    await mkdir(path.join(scratch, 'drafts'));
    await writeFile(path.join(scratch, 'drafts', 'one.txt'), 'first draft\n');
    await writeFile(path.join(scratch, '.env'), 'API_TOKEN=abcdefghijklmnopqrstuvwxyz123456\n');
    await writeFile(path.join(tmp, 'outside.txt'), 'outside the scratch folder\n');
    await symlink(path.join(tmp, 'outside.txt'), path.join(scratch, 'link.txt'));
    // An artifact with two versions and a todo.
    const saved = await w.a.call('POST', `/api/sessions/${chat.id}/artifacts`, { title: 'Billing split', kind: 'markdown', content: '# v1\n' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect((await w.a.call('POST', `/api/sessions/${chat.id}/artifacts`, { id: saved.body.artifact.id, title: 'Billing split', kind: 'markdown', content: '# v2\n' })).status).toBe(201);
    expect((await w.a.call('POST', `/api/sessions/${chat.id}/todos`, { title: 'Decide the module boundary' })).status).toBe(201);

    // The preview: both computers' view; alpha found on the mac by its remote, the notes folder has no match there.
    const previewed = await w.a.call('POST', '/api/takeover/chat/preview', { chatId: chat.id, targetMachine: w.bId });
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(200);
    const preview = previewed.body as ChatMovePreview;
    expect(preview.blockers).toEqual([]);
    expect(preview.source.attachments).toHaveLength(1);
    expect(preview.source.scratchFiles.files.map((file) => [file.name, file.refused === null])).toEqual(
      expect.arrayContaining([
        ['plan.md', true],
        ['drafts/one.txt', true],
        ['.env', false],
      ]),
    );
    expect(preview.source.scratchFiles.files.some((file) => file.name === 'link.txt')).toBe(false);
    expect(preview.source.artifacts).toHaveLength(1);
    expect(preview.target.lookAt).toEqual([
      expect.objectContaining({ source: w.paths.a.alpha, suggestion: w.paths.b.alpha, match: 'remote', target: w.paths.b.alpha, problem: null }),
      expect.objectContaining({ source: notes, suggestion: null, target: null }),
    ]);

    const finished = await runMove(w.a, { chatId: chat.id, targetMachine: w.bId, lookAt: { [notes]: null } });
    expect(finished.error, JSON.stringify(finished)).toBeNull();
    expect(finished).toMatchObject({ kind: 'chat', state: 'done' });
    expect(finished.steps.map((step) => [step.id, step.status])).toEqual([
      ['checks', 'done'],
      ['stop', 'done'],
      ['transfer', 'done'],
      ['resume', 'done'],
      ['finish', 'done'],
    ]);

    // The mac: a chat (plan mode), the same conversation, the mapped folder only, its own scratch folder with the files.
    const sessions = (await w.b.call('GET', '/api/sessions')).body as Session[];
    const moved = sessions.find((session) => session.movedFrom?.sessionId === chat.id) as Session;
    expect(moved).toBeTruthy();
    expect(finished.result).toEqual({ sessionId: remoteId(w.bId, moved.id), machineName: 'mac-laptop', machineId: w.bId, local: false });
    expect(moved).toMatchObject({ kind: 'chat', claudeSessionId: chat.claudeSessionId, lookAt: [w.paths.b.alpha], title: chat.title, folder: null });
    expect(moved.cwd).toBe(path.join(await realpath(w.b.dataDir), 'chats', moved.id));
    expect(await filesUnder(moved.cwd as string)).toEqual(['drafts/one.txt', 'plan.md']);
    expect(await readFile(path.join(moved.cwd as string, 'plan.md'), 'utf8')).toBe('# The plan\n');
    // The attachment, under the same id, served by the mac.
    const attachmentId = preview.source.attachments[0]?.id as string;
    expect((await w.b.call('GET', `/api/sessions/${moved.id}/attachments/${attachmentId}`)).status).toBe(200);
    const attachmentFiles = await filesUnder(path.join(w.b.dataDir, 'attachments', moved.id));
    // (The transcript import also stores the image it finds inline in the conversation, as for any imported chat.)
    expect(attachmentFiles).toContain(`${attachmentId}-sketch.png`);
    expect(Buffer.compare(await readFile(path.join(w.b.dataDir, 'attachments', moved.id, `${attachmentId}-sketch.png`)), PNG)).toBe(0);
    // The artifact with both versions, the todo.
    const artifacts = (await w.b.call('GET', `/api/sessions/${moved.id}/artifacts`)).body as Array<{ id: string; title: string; versions: number }>;
    expect(artifacts).toEqual([expect.objectContaining({ title: 'Billing split', versions: 2 })]);
    const todos = (await w.b.call('GET', `/api/sessions/${moved.id}/todos`)).body as { items?: Array<{ title: string }> } | Array<{ title: string }>;
    expect(JSON.stringify(todos)).toContain('Decide the module boundary');
    // Plan mode kept, the same conversation resumed in the new scratch folder, only the mapped folder readable.
    const spawn = await waitFor('the resumed chat spawn', async () => (await sessionSpawns(w.logs.b)).find((entry) => (entry['argv'] as string[]).includes('--resume')));
    const argv = spawn['argv'] as string[];
    expect(argv[argv.indexOf('--resume') + 1]).toBe(chat.claudeSessionId);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(argv.filter((_, i) => argv[i - 1] === '--add-dir')).toEqual([w.paths.b.alpha]);
    expect(spawn['cwd']).toBe(moved.cwd);
    const stdin = await waitFor('the first message', async () => {
      const lines = (await fakeLog(w.logs.b)).filter((entry) => entry['kind'] === 'stdin').map((entry) => String(entry['line']));
      return lines.join('\n').includes('This chat moved from') ? lines.join('\n') : null;
    });
    expect(stdin).toContain(`${w.paths.a.alpha} → ${w.paths.b.alpha}`);
    expect(stdin).toContain(`Left out on mac-laptop (you cannot read them here): ${notes}`);
    const events = (await w.b.call('GET', `/api/sessions/${moved.id}/events`)).body as SessionEvent[];
    expect(events.some((event) => event.label.startsWith('Moved here from pc-office'))).toBe(true);
    expect(events.some((event) => (event.payload as { text?: string } | null)?.text?.includes('zeppelin'))).toBe(true);

    // The pc: the chat is closed and moved to the mac; reopening is refused.
    const old = (await w.a.call('GET', `/api/sessions/${chat.id}`)).body as Session;
    expect(old.closedAt).not.toBeNull();
    expect(old.movedTo).toMatchObject({ machineId: w.bId, sessionId: moved.id });
    expect((await w.a.call('POST', `/api/sessions/${chat.id}/reopen`)).status).toBe(409);

    // The choices are remembered for the next chat that looks at the same folders.
    const second = await startChat(w.a, [w.paths.a.alpha, notes]);
    const again = (await w.a.call('POST', '/api/takeover/chat/preview', { chatId: second.id, targetMachine: w.bId })).body as ChatMovePreview;
    expect(again.remembered).toBe(true);
    expect(again.lookAt).toEqual({ [w.paths.a.alpha]: w.paths.b.alpha, [notes]: null });
  }, 150_000);

  it('a failure half-way (after the data and the chat were made on the target) undoes everything: nothing is left on the target, the chat stays on the source', async () => {
    const w = (world = await takeoverWorld(tmp, { env: { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_TEST_CHAT_MOVE_FAIL: 'resume' } }));
    const chat = await startChat(w.a, [w.paths.a.alpha]);
    await writeFile(path.join(chat.cwd as string, 'plan.md'), '# The plan\n');
    expect((await w.a.call('POST', `/api/sessions/${chat.id}/artifacts`, { title: 'Billing split', kind: 'markdown', content: '# v1\n' })).status).toBe(201);
    const before = await filesUnder(path.join(w.b.dataDir));

    const failed = await runMove(w.a, { chatId: chat.id, targetMachine: w.bId });
    expect(failed).toMatchObject({ state: 'failed', rolledBack: true, error: { step: 'resume' } });
    expect(failed.error?.message).toContain('test hook');

    // The mac: no chat, no scratch folder, no attachments, no artifacts, no staging, no conversation file.
    const sessions = (await w.b.call('GET', '/api/sessions?closed=include')).body as Session[];
    expect(sessions.filter((session) => session.kind === 'chat' && !session.machine)).toEqual([]);
    expect((await w.b.call('GET', '/api/artifacts')).body.filter((artifact: { machine?: unknown }) => !artifact.machine)).toEqual([]);
    expect(await readdir(path.join(w.b.dataDir, 'chats')).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(w.b.dataDir, 'attachments')).then((names) => names.filter((name) => name !== '_staged')).catch(() => [])).toEqual([]);
    expect(await filesUnder(path.join(w.b.dataDir, 'takeover'))).toEqual([]);
    expect((await filesUnder(w.b.configDir)).filter((name) => name.includes(chat.claudeSessionId))).toEqual([]);
    const after = await filesUnder(path.join(w.b.dataDir));
    expect(after.filter((name) => !before.includes(name) && !/\.(?:db|db-wal|db-shm|log)$/.test(name) && !name.startsWith('logs/'))).toEqual([]);

    // The pc: the chat is open, not moved, and runs again.
    const back = (await w.a.call('GET', `/api/sessions/${chat.id}`)).body as Session;
    expect(back.closedAt).toBeNull();
    expect(back.movedTo ?? null).toBeNull();
    expect(failed.rollbackNotes).toContain('the session runs here again');
    expect((await stat(path.join(chat.cwd as string, 'plan.md'))).isFile()).toBe(true);
  }, 150_000);

  it('a target with an older Switchboard is refused up front ("update Switchboard there"); nothing changes on either computer', async () => {
    const w = (world = await takeoverWorld(tmp, { env: { SWITCHBOARD_PEER_TEST_HOOKS: '1', SWITCHBOARD_TEST_CHAT_MOVE_UNSUPPORTED: '1' } }));
    const chat = await startChat(w.a, []);
    const previewed = await w.a.call('POST', '/api/takeover/chat/preview', { chatId: chat.id, targetMachine: w.bId });
    expect(previewed.status).toBe(409);
    expect(previewed.body).toMatchObject({ error: 'unsupported' });
    expect(previewed.body.message).toContain('mac-laptop runs an older Switchboard that cannot move chats: update Switchboard there');
    const failed = await runMove(w.a, { chatId: chat.id, targetMachine: w.bId });
    expect(failed).toMatchObject({ state: 'failed', rolledBack: null, error: { step: 'checks' } });
    expect(failed.error?.message).toContain('update Switchboard there');
    expect(failed.steps.filter((step) => step.status !== 'pending').map((step) => step.id)).toEqual(['checks']);
    const still = (await w.a.call('GET', `/api/sessions/${chat.id}`)).body as Session;
    expect(still).toMatchObject({ closedAt: null, status: expect.stringMatching(/idle|done/) });
    expect(still.movedTo ?? null).toBeNull();
    // A peer's chat is also refused through the session take-over (it moves with the chat move).
    const takeover = await w.a.call('POST', '/api/takeover/preview', { sessionId: chat.id, targetMachine: w.bId });
    expect(JSON.stringify(takeover.body)).toContain('a chat moves with its own Move to computer');
  }, 150_000);
});
