/**
 * `node tools/bench/browser.ts [--minutes 3] [--no-build] [--out <file.json>] [--profile <dir>]`:
 * the browser half of the performance harness (`docs/performance.md`). Headless
 * Chromium (Playwright) against a test server on the synthetic world
 * (`world.ts`), measured through the Chrome DevTools Protocol:
 *
 * 0. **list**: the Inbox open while a live session fires 100 short turns: the page's
 *    `/api` requests and bytes (`GET /api/sessions` apart) and main-thread time
 *    (`--list-only` stops after it);
 * 1. **open**: the big session's chat (≈13k events): time until its newest message
 *    shows and the page is quiet, main-thread time, DOM nodes, JS heap;
 * 2. **typing**: 20 keys in the composer: main-thread time per key;
 * 3. **scroll**: the conversation from the bottom to the top in steps: time per step;
 *    then the big session's Timeline tab (D95 follow-up: its last 50 turns): time, nodes, lanes, elements;
 * 4. **soak**: `--minutes` of a live session streaming turns (`[fake:fire]`) while the
 *    tab switches between the sessions every few seconds: JS heap after a forced GC
 *    each minute (leak = growth that a GC does not take back), DOM nodes, main-thread
 *    busy share.
 *
 * Fake CLIs only, a throwaway data folder, a test port (`SWITCHBOARD_TEST_PORTS`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { type CDPSession, type Page, chromium } from '@playwright/test';
import globalSetup from '../../tests/e2e/global-setup.ts';
import { removeTempDir } from '../../tests/helpers/net.ts';
import { startServer } from '../../tests/helpers/server-process.ts';
import { openStore, storeFile } from '../../src/server/db/store.ts';
import { clientFor, makeBenchWorld, startLiveSession } from './server.ts';
import { appendHistory } from './world.ts';

interface Metrics {
  readonly taskMs: number;
  readonly scriptMs: number;
  readonly layoutMs: number;
  readonly nodes: number;
  readonly heapMb: number;
  readonly listeners: number;
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
  const get = (name: string): number => list.find((m) => m.name === name)?.value ?? 0;
  return {
    taskMs: get('TaskDuration') * 1000,
    scriptMs: get('ScriptDuration') * 1000,
    layoutMs: (get('LayoutDuration') + get('RecalcStyleDuration')) * 1000,
    nodes: get('Nodes'),
    heapMb: get('JSHeapUsedSize') / 1e6,
    listeners: get('JSEventListeners'),
  };
}

/** JS heap after a full GC (MB). */
async function heapAfterGc(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  return (await metrics(cdp)).heapMb;
}

/** Waits until no main-thread task ran for `quietMs` (sampled through TaskDuration), at most `timeoutMs`. */
async function quiet(cdp: CDPSession, quietMs = 600, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  let last = (await metrics(cdp)).taskMs;
  let since = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = (await metrics(cdp)).taskMs;
    // Under 2 ms of work per 100 ms counts as quiet (timers, the hub's keep-alive).
    if (now - last > 2) since = Date.now();
    last = now;
    if (Date.now() - since >= quietMs) return;
  }
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function openSession(page: Page, cdp: CDPSession, baseUrl: string, id: string, lastText: string | null): Promise<Record<string, number>> {
  const before = await metrics(cdp);
  const start = Date.now();
  await page.evaluate((url) => {
    // Through the app's router (a client-side navigation), as a click in the sidebar does.
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, `${baseUrl}/sessions/${id}`);
  const shown = await page.waitForFunction(
    (text) => {
      const messages = document.querySelectorAll('[data-testid="session-chat"] [data-testid="chat-message"]');
      if (messages.length === 0) return false;
      return text === null || (messages[messages.length - 1]?.textContent ?? '').includes(text);
    },
    lastText,
    { timeout: 120_000, polling: 50 },
  );
  const shownMs = Date.now() - start;
  // A handle keeps what it points at alive (the heap numbers would count it).
  await shown.dispose();
  await quiet(cdp);
  const after = await metrics(cdp);
  return {
    shownMs,
    settledMs: Date.now() - start,
    mainThreadMs: round(after.taskMs - before.taskMs),
    scriptMs: round(after.scriptMs - before.scriptMs),
    layoutMs: round(after.layoutMs - before.layoutMs),
    nodes: after.nodes,
    chatMessages: await page.locator('[data-testid="session-chat"] [data-testid="chat-message"]').count(),
    heapMb: round(after.heapMb),
  };
}

/**
 * D95 follow-up 2: the HTTP requests (count, bytes) the page makes while a live
 * session fires 100 short turns with the Inbox on screen, `GET /api/sessions` apart,
 * and the main-thread time meanwhile (the sidebar's list and what follows it).
 */
async function listWhileStreaming(page: Page, cdp: CDPSession, client: Awaited<ReturnType<typeof clientFor>>, live: string): Promise<Record<string, unknown>> {
  const requests = new Map<string, { count: number; bytes: number }>();
  const onResponse = (response: import('@playwright/test').Response): void => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const key = url.pathname === '/api/sessions' ? `/api/sessions${url.search}` : url.pathname.replace(/\/api\/sessions\/[^/]+/, '/api/sessions/{id}');
    void response.body().then(
      (body) => {
        const entry = requests.get(key) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += body.length;
        requests.set(key, entry);
      },
      () => undefined,
    );
  };
  await quiet(cdp);
  const before = await metrics(cdp);
  const start = Date.now();
  page.on('response', onResponse);
  const sent = await client.post(`/api/sessions/${live}/messages`, { text: '[fake:fire 100 20] keep going' });
  if (sent.status >= 300) throw new Error(`POST messages: ${sent.status}`);
  // Until the turns are over and the page is quiet.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = ((await client.get(`/api/sessions/${live}`)).body as { status?: string }).status;
    if (status !== 'run' || Date.now() - start > 120_000) break;
  }
  await quiet(cdp, 1_500);
  page.off('response', onResponse);
  const after = await metrics(cdp);
  const all = [...requests.values()].reduce((sum, entry) => ({ count: sum.count + entry.count, bytes: sum.bytes + entry.bytes }), { count: 0, bytes: 0 });
  const list = [...requests.entries()].filter(([key]) => key.startsWith('/api/sessions?') || key === '/api/sessions').reduce((sum, [, entry]) => ({ count: sum.count + entry.count, bytes: sum.bytes + entry.bytes }), { count: 0, bytes: 0 });
  return {
    wallMs: Date.now() - start,
    mainThreadMs: round(after.taskMs - before.taskMs),
    scriptMs: round(after.scriptMs - before.scriptMs),
    apiRequests: all.count,
    apiBytes: all.bytes,
    listRequests: list.count,
    listBytes: list.bytes,
    byRoute: Object.fromEntries([...requests.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { minutes: { type: 'string', default: '3' }, 'no-build': { type: 'boolean', default: false }, out: { type: 'string' }, profile: { type: 'string' }, 'list-only': { type: 'boolean', default: false } },
  });
  if (!values['no-build']) await globalSetup();
  const report: Record<string, unknown> = {};
  const world = await makeBenchWorld('bench-browser');
  const server = await startServer(world.env, 60_000);
  const browser = await chromium.launch();
  try {
    const client = await clientFor(world, server);
    const live = await startLiveSession(client, 'stream-session');
    const store = await openStore(storeFile(world.dataDir));
    try {
      const main = (await store.agents.listBySession(live)).find((agent) => agent.kind === 'main');
      if (!main) throw new Error('no main agent');
      const now = Date.now();
      appendHistory(store, live, main.id, 5_000, { seed: 9, startMs: now - 3 * 86_400_000, endMs: now - 10 * 60_000, liveCron: false });
    } finally {
      await store.close();
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${server.baseUrl}/inbox`);
    await quiet(cdp);
    report['baselineHeapMb'] = round(await heapAfterGc(cdp));

    // 0. The session list while a live session streams 100 short turns (the Inbox open, the sidebar listing every session).
    report['listStream'] = await listWhileStreaming(page, cdp, client, live);
    console.log('list while streaming:', JSON.stringify(report['listStream']));
    if (values['list-only']) return;
    if (values.profile) {
      await mkdir(values.profile, { recursive: true });
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }

    // 1. Open the big session (cold: never opened in this tab).
    const lastBig = await client.get(`/api/sessions/${world.bigSessionId}`);
    const bigTitle = (lastBig.body as { name: string }).name;
    report['openBig'] = await openSession(page, cdp, server.baseUrl, world.bigSessionId, null);
    console.log(`open big (${bigTitle}):`, JSON.stringify(report['openBig']));
    if (values.profile) {
      const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
      await writeFile(path.join(values.profile, 'browser-open-big.cpuprofile'), JSON.stringify(profile));
    }
    report['heapAfterOpenBigMb'] = round(await heapAfterGc(cdp));

    // 2. Typing 20 keys in the composer.
    const input = page.getByTestId('chat-input');
    await input.focus();
    await quiet(cdp);
    {
      const before = await metrics(cdp);
      const start = Date.now();
      await page.keyboard.type('fix the upload please', { delay: 30 });
      await quiet(cdp, 300);
      const after = await metrics(cdp);
      report['typing'] = { keys: 21, mainThreadMsPerKey: round((after.taskMs - before.taskMs) / 21, 2), wallMs: Date.now() - start };
      await input.fill('');
    }
    console.log('typing:', JSON.stringify(report['typing']));

    // 3. Scroll from the bottom to the top in 20 steps.
    {
      await quiet(cdp);
      const before = await metrics(cdp);
      const steps = 20;
      const height = await page.evaluate(() => document.querySelector('[data-testid="session-chat"]')?.scrollHeight ?? 0);
      for (let i = 1; i <= steps; i += 1) {
        await page.evaluate(
          ({ i, steps }) => {
            const el = document.querySelector<HTMLElement>('[data-testid="session-chat"]');
            if (el) el.scrollTop = el.scrollHeight * (1 - i / steps);
          },
          { i, steps },
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await quiet(cdp, 600);
      const after = await metrics(cdp);
      report['scroll'] = { steps, scrollHeightPx: height, mainThreadMsPerStep: round((after.taskMs - before.taskMs) / steps, 2), nodesAtTop: after.nodes };
    }
    console.log('scroll:', JSON.stringify(report['scroll']));

    // 3b. The big session's Timeline tab (it loads every event and draws a lane per agent).
    {
      const before = await metrics(cdp);
      const start = Date.now();
      await page.evaluate((url) => {
        history.pushState({}, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
      }, `${server.baseUrl}/sessions/${world.bigSessionId}/timeline`);
      const lanes = await page.waitForFunction(() => document.querySelectorAll('[data-testid="timeline-lane"]').length > 1, null, { timeout: 120_000, polling: 100 });
      await lanes.dispose();
      await quiet(cdp);
      const after = await metrics(cdp);
      report['timelineBig'] = {
        settledMs: Date.now() - start,
        mainThreadMs: round(after.taskMs - before.taskMs),
        nodes: after.nodes,
        lanes: await page.locator('[data-testid="timeline-lane"]').count(),
        // The renderer's node count above also holds the chat's nodes until a GC; these are the live elements.
        timelineElements: await page.evaluate(() => document.querySelectorAll('[data-testid="session-timeline"] *').length),
        documentElements: await page.evaluate(() => document.getElementsByTagName('*').length),
        heapMb: round(after.heapMb),
      };
    }
    console.log('timeline big:', JSON.stringify(report['timelineBig']));

    // 4. Soak: a live session streams while the tab switches sessions.
    const sessions = [live, world.bigSessionId, ...world.mediumSessionIds];
    const minutes = Number(values.minutes);
    const soak: Array<Record<string, number>> = [];
    const end = Date.now() + minutes * 60_000;
    let minute = 0;
    let switches = 0;
    let fired = 0;
    const firstHeap = round(await heapAfterGc(cdp));
    // The soak's first minute is profiled too (`browser-soak.cpuprofile`).
    if (values.profile) await cdp.send('Profiler.start');
    soak.push({ minute: 0, heapMb: firstHeap, nodes: (await metrics(cdp)).nodes });
    let minuteStart = Date.now();
    let busyStart = (await metrics(cdp)).taskMs;
    while (Date.now() < end) {
      // A burst of turns into the live session, then a switch.
      if (fired % 3 === 0) await client.post(`/api/sessions/${live}/messages`, { text: '[fake:fire 20 200] keep going' }).catch(() => undefined);
      fired += 1;
      const target = sessions[switches % sessions.length] ?? live;
      switches += 1;
      await page.evaluate((url) => {
        history.pushState({}, '', url);
        dispatchEvent(new PopStateEvent('popstate'));
      }, `${server.baseUrl}/sessions/${target}`);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      if (Date.now() - minuteStart >= 60_000) {
        minute += 1;
        if (values.profile && minute === 1) {
          const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
          await writeFile(path.join(values.profile, 'browser-soak.cpuprofile'), JSON.stringify(profile));
        }
        const busy = (await metrics(cdp)).taskMs - busyStart;
        const heap = round(await heapAfterGc(cdp));
        const nodes = (await metrics(cdp)).nodes;
        soak.push({ minute, heapMb: heap, nodes, mainThreadBusyPct: round((busy / (Date.now() - minuteStart)) * 100) });
        console.log(`soak minute ${minute}: heap ${heap} MB, nodes ${nodes}, busy ${round((busy / (Date.now() - minuteStart)) * 100)} %`);
        minuteStart = Date.now();
        busyStart = (await metrics(cdp)).taskMs;
      }
    }
    // Back to a small view: what stays after the sessions are left.
    await page.evaluate((url) => {
      history.pushState({}, '', url);
      dispatchEvent(new PopStateEvent('popstate'));
    }, `${server.baseUrl}/inbox`);
    await quiet(cdp, 1_000, 30_000);
    report['soak'] = {
      minutes,
      switches,
      samples: soak,
      heapOnInboxAfterMb: round(await heapAfterGc(cdp)),
      // Nodes alive in the renderer (attached or not) and the elements in the document.
      nodesOnInboxAfter: (await metrics(cdp)).nodes,
      elementsOnInboxAfter: await page.evaluate(() => document.getElementsByTagName('*').length),
    };
    console.log('soak:', JSON.stringify(report['soak']));
  } finally {
    await browser.close();
    await server.stop();
    if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    await removeTempDir(world.tmp);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
