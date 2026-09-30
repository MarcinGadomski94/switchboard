/**
 * D57 · the pure attachment rules (`src/core/attachments.ts`): sniffing,
 * classification, safe names, caps, the delivery plan (inline vs file), the
 * content blocks and the stdin line, the attached files' lines; the queue's
 * matching of a message sent with those lines; transcript images and History's
 * placeholder.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_FILE_MAX,
  ATTACHMENT_MESSAGE_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  INLINE_BUDGET_BASE64,
  INLINE_IMAGE_MAX,
  INLINE_PDF_MAX,
  attachedFilesText,
  attachmentsLabel,
  fileCapProblem,
  formatSize,
  inlineBlock,
  kindOf,
  mediaCounts,
  messageCapProblem,
  messageWithFiles,
  pdfPageCount,
  placeholderImage,
  planDelivery,
  safeFileName,
  servedType,
  sniffType,
  transcriptImages,
  userContent,
} from '../../src/core/attachments.ts';
import { QueueTracker } from '../../src/core/derive/queued.ts';
import { userMessageLine } from '../../src/core/stdin.ts';
import { IMAGE_PROMPT_PLACEHOLDER, humanPromptText } from '../../src/core/transcript.ts';
import { transcriptItems } from '../../src/core/transcript-sync.ts';
import { PDF_TEXT, PNG_1X1 } from '../helpers/attachments.ts';

const PDF = PDF_TEXT;

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

describe('sniffType / kindOf / servedType', () => {
  it('knows PNG, JPEG, GIF, WebP and PDF by their magic bytes', () => {
    expect(sniffType(new Uint8Array(Buffer.from(PNG_1X1, 'base64')))).toBe('image/png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffType(bytes('GIF89a....'))).toBe('image/gif');
    expect(sniffType(bytes('GIF87a....'))).toBe('image/gif');
    expect(sniffType(bytes('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(bytes(PDF))).toBe('application/pdf');
  });

  it('never trusts a name: SVG, HTML, text and short files are files', () => {
    expect(sniffType(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffType(bytes('hello'))).toBeNull();
    expect(sniffType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffType(bytes('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(kindOf(null)).toBe('file');
    expect(kindOf('image/gif')).toBe('image');
    expect(kindOf('application/pdf')).toBe('pdf');
    expect(servedType(null)).toBe('application/octet-stream');
    expect(servedType('image/webp')).toBe('image/webp');
  });
});

describe('safeFileName', () => {
  it('keeps the last segment and replaces what is unsafe', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\a b.txt')).toBe('a b.txt');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('a<b>c:d*e?.log')).toBe('a_b_c_d_e_.log');
    expect(safeFileName('line\nbreak\u0000.txt')).toBe('line_break_.txt');
    expect(safeFileName(undefined)).toBe('file');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('Screenshot 2026-09-30 at 10.12.44.png')).toBe('Screenshot 2026-09-30 at 10.12.44.png');
  });

  it('cuts long names but keeps the extension', () => {
    const name = safeFileName(`${'x'.repeat(300)}.csv`);
    expect(name.length).toBe(120);
    expect(name.endsWith('.csv')).toBe(true);
  });
});

describe('sizes and caps', () => {
  it('formats sizes', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(12 * 1024)).toBe('12 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatSize(1.25 * 1024 * 1024)).toBe('1.3 MB');
  });

  it('refuses empty and too large files, too many and too much together', () => {
    expect(fileCapProblem(0)).toBe('the file is empty');
    expect(fileCapProblem(ATTACHMENT_FILE_MAX)).toBeNull();
    expect(fileCapProblem(ATTACHMENT_FILE_MAX + 1)).toMatch(/^a file is at most 20 MB/);
    expect(messageCapProblem(Array.from({ length: ATTACHMENTS_PER_MESSAGE_MAX }, () => 1))).toBeNull();
    expect(messageCapProblem(Array.from({ length: ATTACHMENTS_PER_MESSAGE_MAX + 1 }, () => 1))).toMatch(/at most 20 attachments/);
    expect(messageCapProblem([ATTACHMENT_MESSAGE_MAX / 2, ATTACHMENT_MESSAGE_MAX / 2])).toBeNull();
    expect(messageCapProblem([ATTACHMENT_MESSAGE_MAX / 2, ATTACHMENT_MESSAGE_MAX / 2 + 1])).toMatch(/at most 50 MB of attachments/);
  });
});

describe('planDelivery (D57 ruling: images + PDFs inline, others as files)', () => {
  it('images and PDFs inline, other files as files', () => {
    expect(planDelivery([{ kind: 'image', size: 1000 }, { kind: 'pdf', size: 1000, pages: 2 }, { kind: 'file', size: 10 }], { inline: true })).toEqual(['inline', 'inline', 'file']);
  });

  it('a hooked session gets only files', () => {
    expect(planDelivery([{ kind: 'image', size: 1000 }, { kind: 'pdf', size: 1000 }], { inline: false })).toEqual(['file', 'file']);
  });

  it('what the CLI would not take inline goes as a file', () => {
    expect(planDelivery([{ kind: 'image', size: INLINE_IMAGE_MAX + 1 }], { inline: true })).toEqual(['file']);
    expect(planDelivery([{ kind: 'pdf', size: INLINE_PDF_MAX + 1 }], { inline: true })).toEqual(['file']);
    expect(planDelivery([{ kind: 'pdf', size: 1000, pages: 101 }], { inline: true })).toEqual(['file']);
  });

  it('keeps the message inside the inline budget, in order', () => {
    const pdf = { kind: 'pdf' as const, size: 10 * 1024 * 1024, pages: 5 };
    const plan = planDelivery([pdf, pdf, { kind: 'image' as const, size: 1000 }], { inline: true });
    expect(plan).toEqual(['inline', 'file', 'inline']);
    expect(Math.ceil(pdf.size / 3) * 4 * 2).toBeGreaterThan(INLINE_BUDGET_BASE64);
  });
});

describe('content blocks and the stdin line (CLI 2.1.284 / 2.1.285 shapes)', () => {
  it('an image block and a PDF document block', () => {
    expect(inlineBlock('image', 'image/png', 'AAAA', 'shot.png')).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(inlineBlock('pdf', 'application/pdf', 'BBBB', 'spec.pdf')).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' }, title: 'spec.pdf' });
  });

  it('blocks first, then the text; text alone stays a string; no empty text block', () => {
    const image = inlineBlock('image', 'image/png', 'AAAA', 'a.png');
    expect(userContent('hi', [])).toBe('hi');
    expect(userContent('hi', [image])).toEqual([image, { type: 'text', text: 'hi' }]);
    expect(userContent('', [image])).toEqual([image]);
    expect(userMessageLine('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(userMessageLine('look', [image])).toEqual({ type: 'user', message: { role: 'user', content: [image, { type: 'text', text: 'look' }] } });
  });

  it('the attached files are named by their absolute paths after the text', () => {
    const lines = attachedFilesText([
      { path: '/data/attachments/s1/a-log.txt', size: 12 * 1024 },
      { path: '/data/attachments/s1/b-data.csv', size: 20 },
    ]);
    expect(lines).toBe('Attached files:\n- /data/attachments/s1/a-log.txt (12 KB)\n- /data/attachments/s1/b-data.csv (20 B)');
    expect(attachedFilesText([])).toBe('');
    expect(messageWithFiles('Read these.', lines)).toBe(`Read these.\n\n${lines}`);
    expect(messageWithFiles('', lines)).toBe(lines);
    expect(messageWithFiles('Only text', '')).toBe('Only text');
  });

  it('labels a message of only attachments', () => {
    expect(attachmentsLabel([{ id: 'a', name: 'shot.png', size: 1, kind: 'image', mediaType: 'image/png' }])).toBe('Attached shot.png');
    expect(attachmentsLabel([placeholderImage(), placeholderImage()])).toBe('Attached 2 files');
  });
});

describe('pdfPageCount', () => {
  it('counts /Type /Page objects, not /Pages', () => {
    expect(pdfPageCount(bytes(PDF))).toBe(2);
    expect(pdfPageCount(bytes('%PDF-1.7 nothing here'))).toBe(0);
  });

  it('counts across its reading chunks', () => {
    const page = '<</Type /Page>>';
    const filler = ' '.repeat((1 << 20) - 5);
    expect(pdfPageCount(bytes(`%PDF-${filler}${page}${filler}${page}`))).toBe(2);
  });
});

describe('transcript images', () => {
  it('reads image blocks with and without their bytes', () => {
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
      { type: 'image', source: { type: 'file', file_id: 'f1' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' } },
      { type: 'text', text: 'look' },
    ];
    expect(transcriptImages(content)).toEqual([
      { mediaType: 'image/png', data: PNG_1X1 },
      { mediaType: null, data: null },
    ]);
    expect(transcriptImages('text')).toEqual([]);
    expect(mediaCounts(content)).toEqual({ images: 2, documents: 1 });
  });

  it('a terminal prompt keeps its images; an image alone is a prompt too', () => {
    const entry = (uuid: string, parent: string | null, content: unknown): Record<string, unknown> => ({
      type: 'user',
      uuid,
      parentUuid: parent,
      isSidechain: false,
      timestamp: '2026-09-30T10:00:00.000Z',
      message: { role: 'user', content },
    });
    const items = transcriptItems([
      entry('u1', null, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }, { type: 'text', text: 'what is this?' }]),
      entry('u2', 'u1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }]),
      entry('u3', 'u2', 'plain'),
    ]);
    expect(items).toEqual([
      { kind: 'prompt', uuid: 'u1', ts: '2026-09-30T10:00:00.000Z', text: 'what is this?', images: [{ mediaType: 'image/png', data: PNG_1X1 }] },
      { kind: 'prompt', uuid: 'u2', ts: '2026-09-30T10:00:00.000Z', text: '', images: [{ mediaType: 'image/png', data: PNG_1X1 }] },
      { kind: 'prompt', uuid: 'u3', ts: '2026-09-30T10:00:00.000Z', text: 'plain' },
    ]);
  });

  it("History reads an image-only prompt as the placeholder", () => {
    const entry = { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }] } };
    expect(humanPromptText(entry)).toBe(IMAGE_PROMPT_PLACEHOLDER);
    expect(humanPromptText({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'hi' }] } })).toBe('hi');
  });
});

describe('QueueTracker (D44 / D50) with attachments', () => {
  it("matches the CLI's echo on the text as sent, and a Stop gives back the typed text and the attachments", () => {
    const queue = new QueueTracker();
    const shot = { id: 'a1', name: 'shot.png', size: 10, kind: 'image' as const, mediaType: 'image/png', delivery: 'inline' as const };
    queue.sent(1, 'first', null);
    queue.sent(2, 'Look', 'turn', { match: 'Look\n\nAttached files:\n- /x (1 B)', attachments: [shot] });
    expect(queue.replayed('Look\n\nAttached files:\n- /x (1 B)')).toMatchObject({ eventId: 2 });
    queue.sent(3, '', 'turn', { attachments: [shot] });
    queue.turnStarted();
    expect(queue.withdraw()).toEqual([{ eventId: 3, text: '', attachments: [shot], wasQueued: true }]);
  });
});
