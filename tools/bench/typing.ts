/**
 * `node tools/bench/typing.ts [--events 3000] [--throttle 4] [--delay 50] [--no-build] [--out <file.json>] [--profile <dir>] [--only v2|classic]`:
 * typing in the composer of a long chat (`docs/performance.md` → *Typing in a long
 * chat*). Developer report 2026-10-29: "for some chats, it feels like there is a lag
 * when I'm writing in a text box."
 *
 * A live fake-claude session with `--events` events of history (Markdown answers,
 * code blocks, tables, tool calls, subagents: `tools/bench/world.ts`) and a few
 * messages with an image attached, opened in headless Chromium with the CPU
 * throttled (`Emulation.setCPUThrottlingRate`, default 4×, roughly a slower Windows
 * laptop), in the v2 agent view and in the classic session view, at desktop and
 * phone size. For each: a line typed at `--delay` ms per key, then a pause; the
 * probe (`tests/e2e/typing-probe.ts`) gives keystroke → next frame (p50 / p95 /
 * max), Event Timing durations, React commits and components rendered (in the
 * conversation and in total), plus the `/api` requests (draft saves) and `/hub`
 * events typing caused. Then one message is received (`[fake:say]`) while the view
 * is open: the components rendered in the conversation per `/hub` event.
 *
 * Fake CLIs only, a throwaway data folder, a test port (`SWITCHBOARD_TEST_PORTS`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { type Browser, type CDPSession, type Page, chromium } from '@playwright/test';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { armTypingProbe, installTypingProbe, percentile, readTypingProbe } from '../../tests/e2e/typing-probe.ts';
import { removeTempDir } from '../../tests/helpers/net.ts';
import { type ServerProcess, startServer } from '../../tests/helpers/server-process.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { THEME_STORAGE_KEY } from '../../src/web/theme.ts';
import { type BenchClient, clientFor, makeBenchWorld, startLiveSession } from './server.ts';
import { appendHistory } from './world.ts';

const TEXT = 'fix the upload flow so the retries back off, then run the tests again please';

/** A 64×64 PNG of one colour, base64 (made here: no binary fixture). */
function png(): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < 64; y += 1) rows.push(Buffer.from([0, ...Array.from({ length: 64 }, () => [40, 120, 200]).flat()]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PNG = png();

interface Theme {
  readonly name: 'v2' | 'classic';
  readonly path: (id: string) => string;
  readonly input: string;
  readonly chat: string;
  readonly message: string;
}

const THEMES: readonly Theme[] = [
  { name: 'v2', path: (id) => `/agents/${id}`, input: '[data-testid="v2-agent-input"]', chat: '[data-testid="v2-agent-chat"]', message: '[data-testid="v2-agent-chat"] .v2-ag-msg' },
  { name: 'classic', path: (id) => `/sessions/${id}`, input: '[data-testid="chat-input"]', chat: '[data-testid="session-chat"]', message: '[data-testid="session-chat"] [data-testid="chat-message"]' },
];

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
  return (metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000;
}

/** Waits until no main-thread task ran for `quietMs` (under 2 ms of work per 100 ms), at most `timeoutMs`. */
async function quiet(cdp: CDPSession, quietMs = 800, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let last = await taskMs(cdp);
  let since = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = await taskMs(cdp);
    if (now - last > 2) since = Date.now();
    last = now;
    if (Date.now() - since >= quietMs) return;
  }
}

/** Counts the page's `/api` requests by method + route while `run` runs. */
async function countRequests<T>(page: Page, run: () => Promise<T>): Promise<{ result: T; requests: Record<string, number> }> {
  const requests: Record<string, number> = {};
  const onRequest = (request: import('@playwright/test').Request): void => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    const key = `${request.method()} ${url.pathname.replace(/\/api\/sessions\/[^/]+/, '/api/sessions/{id}')}`;
    requests[key] = (requests[key] ?? 0) + 1;
  };
  page.on('request', onRequest);
  try {
    return { result: await run(), requests };
  } finally {
    page.off('request', onRequest);
  }
}

async function measure(browser: Browser, server: ServerProcess, client: BenchClient, sessionId: string, theme: Theme, phone: boolean, options: { throttle: number; delay: number; profile: string | undefined }): Promise<Record<string, unknown>> {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [THEME_STORAGE_KEY, theme.name] as const);
    await installTypingProbe(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${server.baseUrl}${theme.path(sessionId)}`);
    await page.waitForSelector(theme.message, { timeout: 120_000 });
    await page.waitForSelector(theme.input, { timeout: 30_000 });
    await quiet(cdp, 1_500);
    const messages = await page.locator(theme.message).count();
    const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.throttle });
    const input = page.locator(theme.input);
    await input.click();
    await input.fill("");
    await quiet(cdp, 1_500);

    // 1. Typing a line.
    const hub = client.hub('/hub?delta=1');
    if (options.profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    await armTypingProbe(page, theme.chat);
    const before = await taskMs(cdp);
    const start = Date.now();
    const typed = await countRequests(page, async () => {
      await page.keyboard.type(TEXT, { delay: options.delay });
      const typingMs = Date.now() - start;
      // The draft's save after the pause, and whatever follows it.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return typingMs;
    });
    const reading = await readTypingProbe(page);
    const mainMs = (await taskMs(cdp)) - before;
    if (options.profile) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
      await mkdir(options.profile, { recursive: true });
      await writeFile(path.join(options.profile, `typing-${theme.name}-${phone ? 'phone' : 'desktop'}.cpuprofile`), JSON.stringify(profile));
    }
    hub.close();
    const value = await input.inputValue();
    const typing = {
      keys: TEXT.length,
      typedOk: value.endsWith(TEXT),
      wallMs: typed.result,
      latencyMs: { p50: round(percentile(reading.latencies, 50)), p95: round(percentile(reading.latencies, 95)), max: round(percentile(reading.latencies, 100)), n: reading.latencies.length },
      eventTimingMs: { p95: round(percentile(reading.eventDurations, 95)), max: round(percentile(reading.eventDurations, 100)), over16: reading.eventDurations.length },
      mainThreadMsPerKey: round(mainMs / TEXT.length, 2),
      commitsPerKey: round(reading.commits / TEXT.length, 2),
      componentsPerKey: round(reading.rendered / TEXT.length, 1),
      chatCommits: reading.chatCommits,
      inChat: reading.renderedInChat,
      chatLog: reading.chatLog,
      inChatByName: reading.inChatByName,
      byName: Object.fromEntries(Object.entries(reading.byName).slice(0, 12)),
      requests: typed.requests,
      draftPuts: typed.requests['PUT /api/sessions/{id}/drafts/composer'] ?? 0,
      hubEvents: Object.fromEntries([...hub.stats.events.entries()].map(([name, entry]) => [name, entry.count])),
    };

    // 1b. Typing while the agent works: it fires short turns of its own (`[fake:fire]`), each a few `/hub` events.
    await input.fill('');
    await quiet(cdp, 1_000);
    const hubStream = client.hub('/hub?delta=1');
    await client.post(`/api/sessions/${sessionId}/messages`, { text: '[fake:fire 40 120] keep going' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (options.profile) await cdp.send('Profiler.start');
    await armTypingProbe(page, theme.chat);
    const streamBefore = await taskMs(cdp);
    await page.keyboard.type(TEXT, { delay: options.delay });
    const streamReading = await readTypingProbe(page);
    const streamMain = (await taskMs(cdp)) - streamBefore;
    if (options.profile) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
      await writeFile(path.join(options.profile, `streaming-${theme.name}-${phone ? 'phone' : 'desktop'}.cpuprofile`), JSON.stringify(profile));
    }
    hubStream.close();
    const streaming = {
      typedOk: (await input.inputValue()).endsWith(TEXT),
      latencyMs: { p50: round(percentile(streamReading.latencies, 50)), p95: round(percentile(streamReading.latencies, 95)), max: round(percentile(streamReading.latencies, 100)), n: streamReading.latencies.length },
      eventTimingMs: { p95: round(percentile(streamReading.eventDurations, 95)), max: round(percentile(streamReading.eventDurations, 100)), over16: streamReading.eventDurations.length },
      mainThreadMsPerKey: round(streamMain / TEXT.length, 2),
      chatCommits: streamReading.chatCommits,
      inChat: streamReading.renderedInChat,
      hubEvents: Object.fromEntries([...hubStream.stats.events.entries()].map(([name, entry]) => [name, entry.count])),
    };
    // Until the fired turns are over.
    for (let k = 0; k < 300; k += 1) {
      if (((await client.get(`/api/sessions/${sessionId}`)).body as { status?: string }).status !== 'run') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 2. Idle with the view open (the shell's `system` tick every 5 s, timers): what renders in the chat.
    await quiet(cdp, 1_000);
    await armTypingProbe(page, theme.chat);
    const idleBefore = await taskMs(cdp);
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const idleReading = await readTypingProbe(page);
    const idle = { seconds: 11, mainThreadMs: round((await taskMs(cdp)) - idleBefore), commits: idleReading.commits, chatCommits: idleReading.chatCommits, inChat: idleReading.renderedInChat, chatLog: idleReading.chatLog.slice(0, 3) };

    // 3. A message received while the view is open (the composer keeps its text).
    await quiet(cdp, 1_000);
    const hub2 = client.hub('/hub?delta=1');
    await armTypingProbe(page, theme.chat);
    const said = `received ${Date.now()}`;
    await client.post(`/api/sessions/${sessionId}/messages`, { text: `[fake:say ${JSON.stringify(said)}]` });
    await page.waitForFunction((text) => document.body.innerText.includes(text), said, { timeout: 60_000, polling: 100 });
    await quiet(cdp, 1_500);
    const received = await readTypingProbe(page);
    hub2.close();
    const sessionEvents = hub2.stats.events.get('event')?.count ?? 0;
    const receivedReport = {
      hubEvents: Object.fromEntries([...hub2.stats.events.entries()].map(([name, entry]) => [name, entry.count])),
      commits: received.commits,
      chatCommits: received.chatCommits,
      inChat: received.renderedInChat,
      chatLog: received.chatLog.slice(0, 6),
      inChatPerEvent: sessionEvents > 0 ? round(received.renderedInChat / sessionEvents, 1) : null,
      inChatByName: Object.fromEntries(Object.entries(received.inChatByName).slice(0, 10)),
    };
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    return { messages, nodes, typing, streaming, idle, received: receivedReport };
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      events: { type: 'string', default: '3000' },
      throttle: { type: 'string', default: '4' },
      delay: { type: 'string', default: '50' },
      'no-build': { type: 'boolean', default: false },
      out: { type: 'string' },
      profile: { type: 'string' },
      only: { type: 'string' },
      phone: { type: 'string', default: 'both' },
    },
  });
  const teardown = values['no-build'] ? null : await globalSetup();
  const world = await makeBenchWorld('bench-typing', { bigEvents: 50, mediumSessions: 0, mediumEvents: 0, usageReadings: 10, checkpoints: 0 });
  const server = await startServer(world.env, 60_000);
  const browser = await chromium.launch();
  const report: Record<string, unknown> = { events: Number(values.events), throttle: Number(values.throttle), delayMs: Number(values.delay) };
  try {
    const client = await clientFor(world, server);
    const live = await startLiveSession(client, 'typing-session');
    const store = await openStore(storeFile(world.dataDir));
    try {
      const main = (await store.agents.listBySession(live)).find((agent) => agent.kind === 'main');
      if (!main) throw new Error('no main agent');
      const now = Date.now();
      report['appended'] = appendHistory(store, live, main.id, Number(values.events), { seed: 7, startMs: now - 3 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false });
    } finally {
      await store.close();
    }
    // A few messages with an image (the newest turns, so they are in the chat's window).
    for (let i = 0; i < 3; i += 1) {
      const upload = await client.post(`/api/sessions/${live}/attachments`, { name: `shot-${i}.png`, data: PNG });
      if (upload.status !== 201) throw new Error(`upload: ${upload.status} ${JSON.stringify(upload.body)}`);
      const id = (upload.body as { id: string }).id;
      const sent = await client.post(`/api/sessions/${live}/messages`, { text: `Look at screenshot ${i}.`, attachments: [id] });
      if (sent.status >= 300) throw new Error(`send: ${sent.status}`);
      for (let k = 0; k < 100; k += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (((await client.get(`/api/sessions/${live}`)).body as { status?: string }).status === 'done') break;
      }
    }
    const count = await client.get(`/api/sessions/${live}/events?limit=1`);
    report['sessionId'] = live;
    report['status'] = count.status;
    for (const theme of THEMES) {
      if (values.only && values.only !== theme.name) continue;
      for (const phone of [false, true]) {
        if (values.phone === 'no' && phone) continue;
        if (values.phone === 'only' && !phone) continue;
        const key = `${theme.name}-${phone ? 'phone' : 'desktop'}`;
        const result = await measure(browser, server, client, live, theme, phone, { throttle: Number(values.throttle), delay: Number(values.delay), profile: values.profile });
        report[key] = result;
        console.log(`${key}:`, JSON.stringify(result));
      }
    }
  } finally {
    await browser.close();
    await server.stop();
    if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    await removeTempDir(world.tmp);
    await teardown?.();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
