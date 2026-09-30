/**
 * D57 · attachments through the real routes (fake-claude, temp data folder, no demo):
 * uploads (sniffed kinds, safe names, caps, where the files go), a message with
 * attachments (the stdin line's content blocks and files' lines, the event's
 * listing, the fake's reply), serving (types, disposition, nosniff, SVG never
 * inline, traversal), a New-session start with staged uploads, Stop giving the
 * attachments back, a hooked session (paths only) and the start's cleanup.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment, InterruptResult, Session } from '../../../src/core/api.ts';
import type { UserPayload } from '../../../src/core/event-payload.ts';
import { buildApp } from '../../../src/server/app.ts';
import { AttachmentService, STAGED_DIR } from '../../../src/server/attachments/service.ts';
import { loadConfig } from '../../../src/server/config.ts';
import { HubBus } from '../../../src/server/hub/bus.ts';
import { QuestionPipeline } from '../../../src/server/inbox/pipeline.ts';
import { generateToken } from '../../../src/server/token.ts';
import { PDF_TEXT, PNG_1X1, SVG_TEXT, b64 } from '../../helpers/attachments.ts';
import { seedFolder } from '../../helpers/folders.ts';
import { type SupervisorWorld, makeSupervisorWorld, newSession, stdinOf, until, waitForEvent, waitForStatus } from '../../helpers/supervisor.ts';

const PORT = 4912;
const HOST = `127.0.0.1:${PORT}`;

interface Rig {
  readonly w: SupervisorWorld;
  readonly app: FastifyInstance;
  readonly token: string;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.app.close();
  await rig?.w.cleanup();
  rig = undefined;
});

async function setup(scenario?: string): Promise<Rig> {
  const holder: { pipeline?: QuestionPipeline } = {};
  const w = await makeSupervisorWorld({
    ...(scenario ? { scenario } : {}),
    controlHandler: {
      canUseTool: (context) => holder.pipeline?.canUseTool(context),
      cancelled: (sessionId, requestId, answeredOn) => holder.pipeline?.cancelled(sessionId, requestId, answeredOn),
      orphaned: (sessionId, ids) => holder.pipeline?.orphaned(sessionId, ids),
      stopped: (sessionId, ids) => holder.pipeline?.stopped(sessionId, ids),
    },
  });
  const bus = new HubBus();
  const pipeline = new QuestionPipeline({ store: w.store, bus }).bind(w.supervisor);
  holder.pipeline = pipeline;
  const base = loadConfig({ env: { SWITCHBOARD_DATA_DIR: w.root }, platform: 'linux', home: w.root, cwd: w.root });
  await seedFolder(w.store, w.workspace);
  const token = generateToken();
  const app = await buildApp({ config: { ...base, port: PORT }, token, store: w.store, webRoot: w.root, supervisor: w.supervisor, questions: pipeline, bus });
  await app.ready();
  rig = { w, app, token };
  return rig;
}

function call(r: Rig, method: InjectOptions['method'], url: string, payload?: unknown) {
  return r.app.inject({
    method,
    url,
    headers: { host: HOST, cookie: `sb_token=${r.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function startSession(r: Rig, task: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const response = await call(r, 'POST', '/api/sessions', { ...newSession({ task }), ...extra });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Session;
}

async function upload(r: Rig, sessionId: string | null, name: string, data: string): Promise<Attachment> {
  const response = await call(r, 'POST', sessionId === null ? '/api/attachments' : `/api/sessions/${sessionId}/attachments`, { name, data });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as Attachment;
}

/** The user message lines (content) the process got, in order. */
async function userLines(r: Rig, sessionId: string): Promise<unknown[]> {
  const record = await r.w.store.sessions.get(sessionId);
  const lines = await stdinOf(r.w.logFile, record?.pid ?? -1);
  return lines.filter((line) => line['type'] === 'user').map((line) => (line['message'] as { content: unknown }).content);
}

describe('POST /api/sessions/{id}/attachments (D57)', () => {
  it('stores a sniffed image, a PDF and a file under the data folder (0600), with safe names', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    await waitForStatus(r.w.store, session.id, ['done']);

    const image = await upload(r, session.id, 'shot.png', PNG_1X1);
    expect(image).toMatchObject({ name: 'shot.png', kind: 'image', mediaType: 'image/png', size: Buffer.from(PNG_1X1, 'base64').length });
    const pdf = await upload(r, session.id, 'spec.pdf', b64(PDF_TEXT));
    expect(pdf).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf' });
    // The browser's name and extension are never trusted: an SVG (or a PNG-named text) is a file.
    const svg = await upload(r, session.id, 'logo.svg', b64(SVG_TEXT));
    expect(svg).toMatchObject({ kind: 'file', mediaType: 'application/octet-stream' });
    const fakePng = await upload(r, session.id, 'not-really.png', b64('hello'));
    expect(fakePng.kind).toBe('file');
    const sneaky = await upload(r, session.id, '../../../etc/passwd', b64('root:x'));
    expect(sneaky.name).toBe('passwd');

    const folder = path.join(r.w.root, 'attachments', session.id);
    const files = await readdir(folder);
    expect(files.sort()).toEqual([image, pdf, svg, fakePng, sneaky].map((a) => `${a.id}-${a.name}`).sort());
    expect((await stat(path.join(folder, `${sneaky.id}-passwd`))).mode & 0o777).toBe(0o600);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(folder, `${image.id}-shot.png`))).toEqual(Buffer.from(PNG_1X1, 'base64'));
  });

  it('refuses a body that is not base64, an empty file, an unknown session', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    expect((await call(r, 'POST', `/api/sessions/${session.id}/attachments`, { name: 'a', data: 'not base64!' })).statusCode).toBe(422);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/attachments`, { name: 'a', data: '' })).statusCode).toBe(422);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/attachments`, { name: 'a' })).statusCode).toBe(422);
    expect((await call(r, 'POST', '/api/sessions/no-such/attachments', { name: 'a', data: b64('x') })).statusCode).toBe(404);
  });

  it('refuses a file over 20 MiB (413)', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61).toString('base64');
    const response = await call(r, 'POST', `/api/sessions/${session.id}/attachments`, { name: 'big.txt', data: big });
    expect(response.statusCode).toBe(413);
    expect(await readdir(path.join(r.w.root, 'attachments', session.id)).catch(() => [])).toEqual([]);
  });
});

describe('a message with attachments (D57)', () => {
  it('images and PDFs go inline, other files as paths; the event lists them; the fake says what it got', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    await waitForStatus(r.w.store, session.id, ['done']);
    const image = await upload(r, session.id, 'shot.png', PNG_1X1);
    const pdf = await upload(r, session.id, 'spec.pdf', b64(PDF_TEXT));
    const log = await upload(r, session.id, 'server.log', b64('line 1\nline 2\n'));

    const sent = await call(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Please look.', attachments: [image.id, pdf.id, log.id] });
    expect(sent.statusCode, sent.body).toBe(202);

    const reply = await waitForEvent(r.w.store, session.id, (event) => (event.payload as { type?: string; text?: string }).type === 'assistant' && String((event.payload as { text?: string }).text).startsWith('[fake:'));
    expect((reply.payload as { text: string }).text).toBe('[fake: 1 image, 1 document, 1 file path]');

    const content = (await userLines(r, session.id)).at(-1) as Array<Record<string, unknown>>;
    const logPath = path.join(r.w.root, 'attachments', session.id, `${log.id}-server.log`);
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(PDF_TEXT) }, title: 'spec.pdf' },
      { type: 'text', text: `Please look.\n\nAttached files:\n- ${logPath} (14 B)` },
    ]);

    const event = (await r.w.store.events.list(session.id)).find((e) => (e.payload as UserPayload).text === 'Please look.');
    const payload = event?.payload as UserPayload;
    expect(payload.attachments?.map((a) => [a.id, a.kind, a.delivery])).toEqual([
      [image.id, 'image', 'inline'],
      [pdf.id, 'pdf', 'inline'],
      [log.id, 'file', 'file'],
    ]);
    expect(payload.sentText).toBe(`Please look.\n\nAttached files:\n- ${logPath} (14 B)`);
    // The bytes never go into the database.
    expect(JSON.stringify(event?.payload)).not.toContain(PNG_1X1);
    // Delivered: the echo matched the text as sent.
    await until(async () => ((await r.w.store.events.get(event?.id ?? -1))?.payload as UserPayload).delivered, 'delivered');
  });

  it('a message may be only attachments; unknown ids, another session\'s ids and bad lists are refused', async () => {
    const r = await setup();
    const one = await startSession(r, 'Hello.');
    await waitForStatus(r.w.store, one.id, ['done']);
    const two = await startSession(r, 'Hello again.', { name: 'second-session' });
    await waitForStatus(r.w.store, two.id, ['done']);
    const image = await upload(r, one.id, 'shot.png', PNG_1X1);
    const theirs = await upload(r, two.id, 'theirs.png', PNG_1X1);

    expect((await call(r, 'POST', `/api/sessions/${one.id}/messages`, { text: '', attachments: [] })).statusCode).toBe(422);
    expect((await call(r, 'POST', `/api/sessions/${one.id}/messages`, { text: 'x', attachments: 'nope' })).statusCode).toBe(422);
    expect((await call(r, 'POST', `/api/sessions/${one.id}/messages`, { text: 'x', attachments: [image.id, image.id] })).statusCode).toBe(422);
    const foreign = await call(r, 'POST', `/api/sessions/${one.id}/messages`, { text: 'x', attachments: [theirs.id] });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ error: 'invalid', errors: [{ field: 'attachments' }] });

    expect((await call(r, 'POST', `/api/sessions/${one.id}/messages`, { text: '', attachments: [image.id] })).statusCode).toBe(202);
    const reply = await waitForEvent(r.w.store, one.id, (event) => (event.payload as { text?: string }).text === '[fake: 1 image, 0 documents]');
    expect(reply).toBeDefined();
    const content = (await userLines(r, one.id)).at(-1);
    expect(content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }]);
    const event = (await r.w.store.events.list(one.id)).find((e) => (e.payload as UserPayload).attachments?.[0]?.id === image.id);
    expect(event?.label).toBe('Attached shot.png');
  });
});

describe('GET /api/sessions/{id}/attachments/{attachmentId} (D57)', () => {
  it('serves images and PDFs inline with their type, everything else as a download; never an SVG inline', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    const image = await upload(r, session.id, 'shot.png', PNG_1X1);
    const pdf = await upload(r, session.id, 'spec.pdf', b64(PDF_TEXT));
    const svg = await upload(r, session.id, 'logo.svg', b64(SVG_TEXT));
    const html = await upload(r, session.id, 'päge "x".html', b64('<script>alert(1)</script>'));

    const png = await call(r, 'GET', `/api/sessions/${session.id}/attachments/${image.id}`);
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toBe(`inline; filename="shot.png"; filename*=UTF-8''shot.png`);
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    expect(png.headers['content-security-policy']).toContain("default-src 'none'");
    expect(png.headers['content-security-policy']).toContain('sandbox');
    expect(png.rawPayload).toEqual(Buffer.from(PNG_1X1, 'base64'));

    const doc = await call(r, 'GET', `/api/sessions/${session.id}/attachments/${pdf.id}`);
    expect(doc.headers['content-type']).toBe('application/pdf');
    expect(doc.headers['content-disposition']).toMatch(/^inline;/);
    expect(doc.headers['x-content-type-options']).toBe('nosniff');

    for (const file of [svg, html]) {
      const answer = await call(r, 'GET', `/api/sessions/${session.id}/attachments/${file.id}`);
      expect(answer.statusCode).toBe(200);
      expect(answer.headers['content-type']).toBe('application/octet-stream');
      expect(answer.headers['content-disposition']).toMatch(/^attachment;/);
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      expect(answer.headers['content-security-policy']).toContain('sandbox');
    }
    const named = await call(r, 'GET', `/api/sessions/${session.id}/attachments/${html.id}`);
    expect(named.headers['content-disposition']).toBe(`attachment; filename="p_ge _x_.html"; filename*=UTF-8''p%C3%A4ge%20_x_.html`);

    const forced = await call(r, 'GET', `/api/sessions/${session.id}/attachments/${image.id}?download`);
    expect(forced.headers['content-disposition']).toMatch(/^attachment;/);
    expect(forced.headers['content-type']).toBe('image/png');
  });

  it('404 for an unknown id, another session\'s, a staged one, a traversal; 401 without the cookie', async () => {
    const r = await setup();
    const one = await startSession(r, 'Hello.');
    const two = await startSession(r, 'Hello again.', { name: 'second-session' });
    const image = await upload(r, one.id, 'shot.png', PNG_1X1);
    const staged = await upload(r, null, 'staged.png', PNG_1X1);
    expect((await call(r, 'GET', `/api/sessions/${two.id}/attachments/${image.id}`)).statusCode).toBe(404);
    expect((await call(r, 'GET', `/api/sessions/${one.id}/attachments/nope`)).statusCode).toBe(404);
    expect((await call(r, 'GET', `/api/sessions/${one.id}/attachments/${staged.id}`)).statusCode).toBe(404);
    expect((await call(r, 'GET', `/api/sessions/${one.id}/attachments/..%2F..%2Fswitchboard.db`)).statusCode).toBe(404);
    expect((await call(r, 'GET', `/api/sessions/..%2F_staged/attachments/${staged.id}`)).statusCode).toBe(404);
    const anonymous = await r.app.inject({ method: 'GET', url: `/api/sessions/${one.id}/attachments/${image.id}`, headers: { host: HOST } });
    expect(anonymous.statusCode).toBe(401);
    // A cleaned-up file is gone for the chat (it shows the placeholder).
    await writeFile(path.join(r.w.root, 'attachments', one.id, 'unrelated'), 'x');
    const service = new AttachmentService({ dataDir: r.w.root, store: r.w.store });
    await service.cleanup();
    expect(await readdir(path.join(r.w.root, 'attachments', one.id))).toEqual([`${image.id}-shot.png`]);
  });
});

describe('a New-session start with attachments (D57)', () => {
  it('staged uploads move into the new session and go with the first message', async () => {
    const r = await setup();
    const image = await upload(r, null, 'mock.png', PNG_1X1);
    expect(await readdir(path.join(r.w.root, 'attachments', STAGED_DIR))).toEqual([`${image.id}-mock.png`]);
    const session = await startSession(r, 'Build this screen.', { attachments: [image.id] });
    await waitForStatus(r.w.store, session.id, ['done']);
    expect(await readdir(path.join(r.w.root, 'attachments', STAGED_DIR))).toEqual([]);
    expect(await readdir(path.join(r.w.root, 'attachments', session.id))).toEqual([`${image.id}-mock.png`]);
    const [first] = await userLines(r, session.id);
    expect(Array.isArray(first)).toBe(true);
    expect((first as Array<Record<string, unknown>>)[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } });
    expect((await r.w.store.attachments.get(image.id ?? ''))?.sessionId).toBe(session.id);
    // Used ids are no longer staged: a second start cannot take them.
    const again = await call(r, 'POST', '/api/sessions', { ...newSession({ task: 'Again.', name: 'again' }), attachments: [image.id] });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ errors: [{ field: 'attachments' }] });
  });

  it('refuses attachments without a first message, and unknown ids, before anything starts', async () => {
    const r = await setup();
    const image = await upload(r, null, 'mock.png', PNG_1X1);
    const empty = await call(r, 'POST', '/api/sessions', { ...newSession({ task: '' }), attachments: [image.id] });
    expect(empty.statusCode).toBe(422);
    const unknown = await call(r, 'POST', '/api/sessions', { ...newSession({ task: 'x' }), attachments: ['nope'] });
    expect(unknown.statusCode).toBe(422);
    expect(await r.w.store.sessions.list({})).toEqual([]);
  });
});

describe('Stop gives the attachments back (D50 + D57)', () => {
  it('a queued message with attachments is withdrawn with them', async () => {
    const r = await setup('ask-2q');
    const session = await startSession(r, 'Ask me two questions.');
    await waitForStatus(r.w.store, session.id, ['need']);
    const image = await upload(r, session.id, 'shot.png', PNG_1X1);
    expect((await call(r, 'POST', `/api/sessions/${session.id}/messages`, { text: 'Also this.', attachments: [image.id] })).statusCode).toBe(202);
    const body = (await call(r, 'POST', `/api/sessions/${session.id}/interrupt`)).json() as InterruptResult;
    expect(body.outcome).toBe('stopped');
    expect(body.withdrawn).toEqual(['Also this.']);
    expect(body.withdrawnAttachments).toEqual([{ id: image.id, name: 'shot.png', size: image.size, kind: 'image', mediaType: 'image/png', delivery: 'inline' }]);
    // Still uploaded: the next message can carry it again.
    expect((await call(r, 'GET', `/api/sessions/${session.id}/attachments/${image.id}`)).statusCode).toBe(200);
  });
});

describe('a hooked terminal session (D48 P4 + D57)', () => {
  it('gets every attachment as a path in the text (hooks carry no images)', async () => {
    const r = await setup();
    const record = await r.w.store.sessions.create({ name: 'term-x', title: 'Terminal', task: '', claudeSessionId: 'c-hooked', status: 'idle', attached: false, cwd: r.w.workspace, root: r.w.workspace, origin: 'terminal', hooked: true });
    await r.w.store.agents.create({ sessionId: record.id, kind: 'main', name: 'main', status: 'idle' });
    const image = await upload(r, record.id, 'shot.png', PNG_1X1);
    expect((await call(r, 'POST', `/api/sessions/${record.id}/messages`, { text: 'See this.', attachments: [image.id] })).statusCode).toBe(202);
    const [pending] = await r.w.store.pendingMessages.pending(record.id);
    const imagePath = path.join(r.w.root, 'attachments', record.id, `${image.id}-shot.png`);
    expect(pending?.text).toBe(`See this.\n\nAttached files:\n- ${imagePath} (${image.size} B)`);
    const event = (await r.w.store.events.list(record.id)).find((e) => (e.payload as UserPayload).type === 'user');
    expect(event?.payload).toMatchObject({ text: 'See this.', sentText: pending?.text, attachments: [{ id: image.id, delivery: 'file' }] });
  });
});

describe('the start\'s cleanup (ASSUMED D57-retention)', () => {
  it('removes attachments older than 30 days, folders of sessions that are gone and files no row owns', async () => {
    const r = await setup();
    const session = await startSession(r, 'Hello.');
    const now = new Date('2026-09-30T12:00:00.000Z');
    const old = new AttachmentService({ dataDir: r.w.root, store: r.w.store, now: () => new Date('2026-08-20T12:00:00.000Z') });
    const fresh = new AttachmentService({ dataDir: r.w.root, store: r.w.store, now: () => now });
    const stale = await old.upload(session.id, { name: 'old.txt', data: b64('old') });
    const kept = await fresh.upload(session.id, { name: 'new.txt', data: b64('new') });
    await mkdir(path.join(r.w.root, 'attachments', 'gone-session'), { recursive: true });
    await writeFile(path.join(r.w.root, 'attachments', 'gone-session', 'x.txt'), 'x');
    await writeFile(path.join(r.w.root, 'attachments', session.id, 'stray.txt'), 'x');

    const { removed } = await fresh.cleanup();
    expect(removed).toBe(2);
    expect(await r.w.store.attachments.get(stale.id ?? '')).toBeNull();
    expect(await r.w.store.attachments.get(kept.id ?? '')).not.toBeNull();
    expect(await readdir(path.join(r.w.root, 'attachments'))).toEqual([session.id]);
    expect(await readdir(path.join(r.w.root, 'attachments', session.id))).toEqual([`${kept.id}-new.txt`]);
  });
});

describe('a transcript prompt with images (Attach, a move, a hooked session: D57)', () => {
  it('stores an image the transcript has the bytes of; lists one without as a placeholder; the chat serves it', async () => {
    const r = await setup();
    const record = await r.w.store.sessions.create({ name: 'moved', title: null, task: '', claudeSessionId: 'c-moved', status: 'idle', attached: true, cwd: r.w.workspace, root: r.w.workspace, origin: 'terminal' });
    const main = await r.w.store.agents.create({ sessionId: record.id, kind: 'main', name: 'main', status: 'idle' });
    const transcript = path.join(r.w.root, 'moved.jsonl');
    const line = (uuid: string, parent: string | null, content: unknown): string =>
      JSON.stringify({ type: 'user', uuid, parentUuid: parent, isSidechain: false, timestamp: '2026-09-30T10:00:00.000Z', message: { role: 'user', content } });
    await writeFile(
      transcript,
      [
        line('u1', null, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 } }, { type: 'text', text: 'What is this?' }]),
        line('u2', 'u1', [{ type: 'image', source: { type: 'file', file_id: 'f_1' } }]),
      ].join('\n'),
    );
    const { importTerminalTurns } = await import('../../../src/server/supervisor/attach.ts');
    const service = new AttachmentService({ dataDir: r.w.root, store: r.w.store });
    await importTerminalTurns({
      store: r.w.store,
      session: record,
      mainAgentId: main.id,
      transcript,
      onEvent: () => undefined,
      fromStart: true,
      saveImage: (sessionId, base64, index) => service.saveTranscriptImage(sessionId, base64, index),
    });
    const users = (await r.w.store.events.list(record.id)).map((event) => event.payload as UserPayload);
    expect(users.map((payload) => payload.text)).toEqual(['What is this?', '']);
    const stored = users[0]?.attachments?.[0];
    expect(stored).toMatchObject({ name: 'image-1.png', kind: 'image', mediaType: 'image/png' });
    expect(users[1]?.attachments).toEqual([{ id: null, name: 'image', size: 0, kind: 'image', mediaType: 'image/png' }]);
    const served = await call(r, 'GET', `/api/sessions/${record.id}/attachments/${stored?.id ?? ''}`);
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload).toEqual(Buffer.from(PNG_1X1, 'base64'));
  });
});
