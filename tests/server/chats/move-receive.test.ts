import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_MOVE_ATTACHMENT_MAX_BYTES, CHAT_MOVE_ARTIFACT_MAX_BYTES } from '../../../src/core/chat-move.ts';
import { WORKSPACE_FILE_MAX_BYTES } from '../../../src/core/workspace-move.ts';
import { ChatMoveService } from '../../../src/server/chats/move-service.ts';
import { TakeoverError } from '../../../src/server/takeover/service.ts';
import { makeTempDir } from '../../helpers/net.ts';

/**
 * D155: the target's receiver of a chat's data files (`ChatMoveService.receiveData`):
 * every name and size is checked before a byte is written, the checksum at the end,
 * and a scratch file that looks like a secret is never kept. Nothing here needs the
 * rest of the service, so it runs on bare stubs.
 */

let dataDir: string;
let service: ChatMoveService;

beforeEach(async () => {
  dataDir = await makeTempDir('chat-move-receive');
  service = new ChatMoveService({ store: {} as never, config: { dataDir }, supervisor: {} as never, accounts: {} as never, clis: {} as never, folders: {} as never, takeover: {} as never, self: async () => ({ id: 'self', name: 'here' }) });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function send(part: string, name: string, bytes: Buffer, overrides: Partial<{ size: number; sha256: string; offset: number }> = {}): Promise<{ status: number; code: string } | { received: number; done: boolean }> {
  try {
    return await service.receiveData({ opId: 'op-1', part, name, size: overrides.size ?? bytes.length, sha256: overrides.sha256 ?? sha(bytes), offset: overrides.offset ?? 0, data: bytes.toString('base64') });
  } catch (error) {
    if (error instanceof TakeoverError) return { status: error.status, code: error.code };
    throw error;
  }
}

async function staged(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(path.join(dataDir, 'takeover'), '');
  return out.sort();
}

describe('D155 · the chat data receiver', () => {
  it('keeps checked files in the op staging folder', async () => {
    const text = Buffer.from('# plan\n');
    expect(await send('scratch', 'drafts/plan.md', text)).toEqual({ received: text.length, done: true });
    expect(await send('attachment', '0f8fad5b-d9cb-469f-a165-70867728950e', text)).toMatchObject({ done: true });
    expect(await send('artifact', 'a1b2c3d4e5/2', text)).toMatchObject({ done: true });
    expect(await staged()).toEqual(['op-1-chat/artifact/a1b2c3d4e5/2', 'op-1-chat/attachment/0f8fad5b-d9cb-469f-a165-70867728950e', 'op-1-chat/scratch/drafts/plan.md']);
  });

  it('refuses names that could leave the staging folder or are not the part’s own, before writing a byte', async () => {
    const bytes = Buffer.from('x');
    for (const [part, name] of [
      ['scratch', '../escape.txt'],
      ['scratch', '/etc/passwd'],
      ['scratch', 'a/../../b'],
      ['scratch', 'C:/x.txt'],
      ['scratch', 'a\\b.txt'],
      ['scratch', '.git/config'],
      ['attachment', '../../x'],
      ['attachment', 'not-a-uuid'],
      ['artifact', '../a/1'],
      ['artifact', 'abc/0'],
      ['artifact', 'abc'],
      ['other', 'x'],
    ] as const) {
      expect(await send(part, name, bytes), `${part} ${name}`).toMatchObject({ status: 422 });
    }
    expect(await staged()).toEqual([]);
  });

  it('holds the size caps (a scratch file by D152’s cap, an attachment, an artifact version)', async () => {
    const one = Buffer.from('x');
    expect(await send('scratch', 'big.txt', one, { size: WORKSPACE_FILE_MAX_BYTES + 1 })).toMatchObject({ status: 413 });
    expect(await send('attachment', '0f8fad5b-d9cb-469f-a165-70867728950e', one, { size: CHAT_MOVE_ATTACHMENT_MAX_BYTES + 1 })).toMatchObject({ status: 413 });
    expect(await send('artifact', 'abc/1', one, { size: CHAT_MOVE_ARTIFACT_MAX_BYTES + 1 })).toMatchObject({ status: 413 });
    // More bytes than announced.
    expect(await send('scratch', 'small.txt', Buffer.from('four'), { size: 2 })).toMatchObject({ status: 422 });
    expect(await staged()).toEqual([]);
  });

  it('deletes a damaged file (checksum) and a scratch file that looks like a secret', async () => {
    expect(await send('scratch', 'notes.txt', Buffer.from('hello'), { sha256: '0'.repeat(64) })).toMatchObject({ status: 422, code: 'checksum' });
    expect(await send('scratch', '.env', Buffer.from('API_TOKEN=abcdefghijklmnopqrstuvwxyz123456\n'))).toMatchObject({ status: 422, code: 'secret-not-copied' });
    expect(await staged()).toEqual([]);
  });

  it('refuses a chunk out of order', async () => {
    const bytes = Buffer.from('hello world');
    expect(await send('scratch', 'a.txt', bytes.subarray(0, 5), { size: bytes.length, offset: 0 })).toEqual({ received: 5, done: false });
    expect(await send('scratch', 'a.txt', bytes.subarray(5), { size: bytes.length, offset: 3 })).toMatchObject({ status: 409 });
  });
});
