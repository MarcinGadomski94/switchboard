import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../tools/fake-claude/json.ts';
import { attachedFilePaths, mediaReply } from '../../tools/fake-claude/scenarios.ts';
import { PNG_1X1 } from '../helpers/attachments.ts';
import { BASELINE, type FakeEnv, type FakeRun, makeFakeEnv, readTranscript, spawnFake, transcriptPath } from '../helpers/fake-claude.ts';

/**
 * D57: fake-claude takes stream-json user messages with `image` / `document`
 * content blocks (the shapes CLI 2.1.284 / 2.1.285 accept) and answers with what
 * it got, `[fake: 1 image, 1 document]`; the transcript keeps the blocks.
 */
const SID = '0b7e6c1d-7777-4222-8333-44445555d57a';

const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } };
const DOC = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') }, title: 'a.pdf' };

let env: FakeEnv;
let runs: FakeRun[] = [];

beforeEach(async () => {
  env = await makeFakeEnv('fake-media');
});

afterEach(async () => {
  for (const run of runs) run.kill('SIGKILL');
  runs = [];
  await env.cleanup();
});

const isResult = (l: JsonObject): boolean => l['type'] === 'result';

describe('fake-claude · media blocks (parser)', () => {
  it('counts images, documents and the attached files\' paths', () => {
    expect(mediaReply([IMAGE, DOC, { type: 'text', text: 'look' }], 'look')).toBe('[fake: 1 image, 1 document]');
    expect(mediaReply([IMAGE, IMAGE], '')).toBe('[fake: 2 images, 0 documents]');
    const text = 'Read.\n\nAttached files:\n- /d/attachments/s/a-x.log (12 KB)\n- /d/attachments/s/b-y.csv (3 B)';
    expect(attachedFilePaths(text)).toEqual(['/d/attachments/s/a-x.log', '/d/attachments/s/b-y.csv']);
    expect(mediaReply([IMAGE, { type: 'text', text }], text)).toBe('[fake: 1 image, 0 documents, 2 file paths]');
    expect(mediaReply('plain text', 'plain text')).toBeNull();
    expect(mediaReply([{ type: 'text', text: 'x' }], 'x')).toBeNull();
  });

  it('says why a block the CLI would not take is wrong', () => {
    expect(mediaReply([{ type: 'image' }], '')).toBe('[fake: invalid image block: no source object]');
    expect(mediaReply([{ type: 'image', source: { type: 'url', url: 'https://x' } }], '')).toMatch(/source type "url" is not base64/);
    expect(mediaReply([{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } }], '')).toMatch(/media_type "image\/svg\+xml"/);
    expect(mediaReply([{ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'AAAA' } }], '')).toMatch(/is not application\/pdf/);
    expect(mediaReply([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not base64!' } }], '')).toMatch(/data is not base64/);
  });
});

describe('fake-claude · media blocks (process)', () => {
  it('answers a message with an image and a PDF, and writes the blocks to its transcript', async () => {
    const run = spawnFake([...BASELINE, '--replay-user-messages', '--session-id', SID], { cwd: env.cwd, env: { CLAUDE_CONFIG_DIR: env.configDir } });
    runs.push(run);
    run.send({ type: 'user', message: { role: 'user', content: [IMAGE, DOC, { type: 'text', text: 'What are these?' }] } });
    await run.waitFor(isResult, 1);
    expect(run.lines.find(isResult)).toMatchObject({ is_error: false, result: '[fake: 1 image, 1 document]' });
    // The echo carries the content as sent.
    const replay = run.lines.find((l) => l['type'] === 'user' && l['isReplay'] === true);
    expect((replay?.['message'] as JsonObject)['content']).toEqual([IMAGE, DOC, { type: 'text', text: 'What are these?' }]);
    run.end();
    expect((await run.exited).code).toBe(0);
    const transcript = await readTranscript(transcriptPath(env.configDir, env.cwd, SID));
    const prompt = transcript.find((e) => e['type'] === 'user');
    expect((prompt?.['message'] as JsonObject)['content']).toEqual([IMAGE, DOC, { type: 'text', text: 'What are these?' }]);
  });
});
