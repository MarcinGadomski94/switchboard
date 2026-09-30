/**
 * D57 · the composer's attachment model (`src/web/components/attachments.ts`):
 * what a paste or a drop holds, the chips' caps, what blocks Send, the message
 * to send, a withdrawn attachment's chip, the downscale plan, names of pasted
 * images; and the chat's user item carrying its attachments.
 */
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/core/api.ts';
import { ATTACHMENT_FILE_MAX } from '../../src/core/attachments.ts';
import {
  type DraftAttachment,
  acceptFiles,
  attachmentUrl,
  attachmentsBlocker,
  bytesToBase64,
  chipOf,
  downscalePlan,
  dragHasFiles,
  filesFromTransfer,
  guessKind,
  messageToSend,
  pastedName,
  readyIds,
} from '../../src/web/components/attachments.ts';
import { chatItems } from '../../src/web/views/session/chat.ts';

function chip(overrides: Partial<DraftAttachment> = {}): DraftAttachment {
  return { key: 'k', name: 'a.png', size: 10, kind: 'image', previewUrl: null, state: 'ready', id: 'id-1', error: null, ...overrides };
}

describe('paste and drop', () => {
  const png = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
  const log = new File(['x'], 'server.log', { type: 'text/plain' });

  it('a screenshot on the clipboard is a file item; files come from `files` otherwise', () => {
    expect(filesFromTransfer({ items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => png }] })).toEqual([png]);
    expect(filesFromTransfer({ items: [{ kind: 'string', getAsFile: () => null }], files: [log] })).toEqual([log]);
    expect(filesFromTransfer({ items: [], files: [] })).toEqual([]);
    expect(filesFromTransfer(null)).toEqual([]);
  });

  it('only a drag with files lights the drop zone', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true);
    expect(dragHasFiles({ types: ['text/plain'] })).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });

  it('names a pasted image that has none, keeps real names', () => {
    const at = new Date(2026, 8, 30, 9, 5, 7);
    expect(pastedName({ name: 'image.png', type: 'image/png' }, at)).toBe('pasted-image-090507.png');
    expect(pastedName({ name: '', type: 'image/jpeg' }, at)).toBe('pasted-image-090507.jpg');
    expect(pastedName({ name: 'Screenshot 2026.png', type: 'image/png' }, at)).toBe('Screenshot 2026.png');
  });

  it('guesses the chip\'s look from the type (the server sniffs for real)', () => {
    expect(guessKind('image/png', 'a')).toBe('image');
    expect(guessKind('image/svg+xml', 'a.svg')).toBe('file');
    expect(guessKind('', 'spec.PDF')).toBe('pdf');
    expect(guessKind('text/csv', 'a.csv')).toBe('file');
  });
});

describe('caps', () => {
  it('refuses empty and too large files, the 21st file, more than 50 MiB together', () => {
    const result = acceptFiles(
      Array.from({ length: 18 }, () => chip({ size: 1 })),
      [
        { name: 'empty.txt', size: 0 },
        { name: 'huge.bin', size: ATTACHMENT_FILE_MAX + 1 },
        { name: 'a.txt', size: 5 },
        { name: 'b.txt', size: 5 },
        { name: 'c.txt', size: 5 },
      ],
    );
    expect(result.accepted).toEqual([2, 3]);
    expect(result.problems).toEqual([
      'empty.txt: the file is empty',
      'huge.bin: a file is at most 20 MB (this one is 20 MB)',
      'c.txt: a message carries at most 20 attachments',
    ]);
    const heavy = acceptFiles([chip({ size: 20 * 1024 * 1024 }), chip({ size: 20 * 1024 * 1024 })], [{ name: 'd.bin', size: 11 * 1024 * 1024 }]);
    expect(heavy.problems).toEqual(['d.bin: a message carries at most 50 MB of attachments']);
    // A failed chip does not count.
    expect(acceptFiles([chip({ state: 'error', size: 49 * 1024 * 1024 })], [{ name: 'e.bin', size: 2 * 1024 * 1024 }]).accepted).toEqual([0]);
  });
});

describe('what goes with Send', () => {
  it('waits for uploads, refuses while one failed, sends the uploaded ids with the text', () => {
    expect(attachmentsBlocker([chip({ state: 'uploading', id: null })])).toBe('Attaching…');
    expect(attachmentsBlocker([chip({ state: 'error', id: null, error: 'too large' })])).toBe('Remove the attachments that could not be added');
    expect(attachmentsBlocker([chip()])).toBeNull();
    expect(messageToSend('  hi  ', [])).toEqual({ text: 'hi', attachments: [] });
    expect(messageToSend('', [])).toBeNull();
    expect(messageToSend('', [chip({ id: 'x' })])).toEqual({ text: '', attachments: ['x'] });
    expect(messageToSend('hi', [chip({ state: 'reading', id: null })])).toBeNull();
    expect(readyIds([chip({ id: 'a' }), chip({ id: null, state: 'ready' }), chip({ id: 'b' })])).toEqual(['a', 'b']);
  });

  it('a withdrawn message\'s attachment comes back as a ready chip (its thumbnail served)', () => {
    const url = attachmentUrl('r~m1~s 1', 'a1');
    expect(url).toBe('/api/sessions/r~m1~s%201/attachments/a1');
    expect(attachmentUrl('s', 'a', true)).toBe('/api/sessions/s/attachments/a?download');
    expect(chipOf({ id: 'a1', name: 'shot.png', size: 9, kind: 'image', mediaType: 'image/png', delivery: 'inline' }, 'k1', url)).toEqual({
      key: 'k1',
      name: 'shot.png',
      size: 9,
      kind: 'image',
      previewUrl: url,
      state: 'ready',
      id: 'a1',
      error: null,
    });
    expect(chipOf({ id: 'f1', name: 'a.log', size: 9, kind: 'file', mediaType: 'application/octet-stream' }, 'k2', null).previewUrl).toBeNull();
  });
});

describe('downscale plan (ASSUMED D57-downscale)', () => {
  it('fits the CLI\'s 2000 px and the inline size; GIFs and small images stay as they are', () => {
    expect(downscalePlan('image/png', 1200, 800, 500_000)).toBeNull();
    expect(downscalePlan('image/png', 4000, 3000, 500_000)).toEqual({ width: 2000, height: 1500, type: 'image/png' });
    expect(downscalePlan('image/jpeg', 1000, 3000, 100)).toEqual({ width: 667, height: 2000, type: 'image/jpeg' });
    expect(downscalePlan('image/webp', 1500, 1500, 5_000_000)).toEqual({ width: 1500, height: 1500, type: 'image/jpeg' });
    expect(downscalePlan('image/gif', 5000, 5000, 9_000_000)).toBeNull();
    expect(downscalePlan('application/pdf', 5000, 5000, 9_000_000)).toBeNull();
  });

  it('encodes bytes as base64 in chunks', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('the chat\'s user item (D57)', () => {
  it('carries the message\'s attachments; a message without any has none', () => {
    const event = (id: number, payload: Record<string, unknown>): SessionEvent => ({ id, sessionId: 's', agentId: null, ts: `2026-09-30T10:00:0${id}.000Z`, endTs: null, kind: 'text', label: '', payload });
    const shot = { id: 'a1', name: 'shot.png', size: 9, kind: 'image', mediaType: 'image/png', delivery: 'inline' };
    const items = chatItems([event(1, { type: 'user', text: '', origin: 'user', delivered: true, attachments: [shot] }), event(2, { type: 'user', text: 'plain', origin: 'user', delivered: true })], [], null);
    expect(items.map((item) => (item.kind === 'user' ? [item.text, item.attachments] : null))).toEqual([
      ['', [shot]],
      ['plain', []],
    ]);
  });
});
