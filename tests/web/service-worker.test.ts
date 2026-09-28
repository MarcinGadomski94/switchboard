import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * D34: the service worker (`src/web/public/sw.js`, docs/install-app.md) run in a
 * small fake worker scope: install caches only the offline page (and routes every
 * non-navigation past the worker where static routing exists), activate drops old
 * caches, enables navigation preload and claims the pages, and fetch answers only
 * navigations, network first, with the offline page when the network fails.
 */
const PUBLIC_DIR = path.join(REPO_ROOT, 'src', 'web', 'public');
const ORIGIN = 'http://127.0.0.1:4870';

/**
 * The offline page this cache version was made with. offline.html changed? Bump
 * CACHE_VERSION in sw.js (installed apps re-cache the page only for a new worker),
 * then put the new version and hash here.
 */
const OFFLINE_PAGE_PIN = { version: 1, sha256: '760b91e984a4a2205cf728bcd73362406b9226c23bf5e128c7038a8d3beb2d28' };

type Listener = (event: unknown) => void;

/** An extendable event that collects its `waitUntil` promises. */
function extendable(extra: Record<string, unknown> = {}) {
  const pending: Promise<unknown>[] = [];
  return {
    event: { waitUntil: (promise: Promise<unknown>) => pending.push(promise), ...extra },
    done: () => Promise.all(pending),
  };
}

/** Runs sw.js in a fake worker scope; `caches` starts with `existing` cache names. */
async function loadWorker(existing: readonly string[] = []) {
  const code = await readFile(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const listeners: Record<string, Listener[]> = {};
  const calls: string[] = [];
  const stores = new Map<string, Map<string, string>>(existing.map((name) => [name, new Map()]));
  const added: Array<{ cache: string; url: string; mode: string }> = [];
  let network: (request: unknown) => Promise<Response> = async () => new Response('from fetch');
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async add(request: Request) {
          added.push({ cache: name, url: request.url, mode: request.cache });
          store.set(new URL(request.url).pathname, '<p>offline</p>');
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      calls.push(`delete ${name}`);
      return stores.delete(name);
    },
    async match(url: string, options: { cacheName: string }) {
      // Like Cache Storage: a new response for every match.
      const body = stores.get(options.cacheName)?.get(url);
      return body === undefined ? undefined : new Response(body, { headers: { 'content-type': 'text/html' } });
    },
  };
  const self = {
    addEventListener(type: string, listener: Listener) {
      (listeners[type] ??= []).push(listener);
    },
    skipWaiting: async () => void calls.push('skipWaiting'),
    clients: { claim: async () => void calls.push('claim') },
    registration: { navigationPreload: { enable: async () => void calls.push('preload') } },
  };
  // Relative URLs resolve against the worker's origin, as in a browser.
  const WorkerRequest = class extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, ORIGIN), init);
    }
  };
  vm.runInContext(code, vm.createContext({ self, caches, Request: WorkerRequest, Response, fetch: (request: unknown) => network(request), Promise, URL }));
  const dispatch = (type: string, event: unknown): void => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  return {
    code,
    calls,
    added,
    caches: () => [...stores.keys()],
    setNetwork(fn: (request: unknown) => Promise<Response>) {
      network = fn;
    },
    async install(extra: Record<string, unknown> = {}) {
      const { event, done } = extendable(extra);
      dispatch('install', event);
      await done();
    },
    async activate() {
      const { event, done } = extendable();
      dispatch('activate', event);
      await done();
    },
    /** A fetch event; resolves the worker's answer, or `null` when it did not answer. */
    async fetch(request: { mode: string; method?: string; url?: string }, preloadResponse: Promise<Response | undefined> = Promise.resolve(undefined)) {
      let answer: Promise<Response> | null = null;
      const event = {
        request: { method: 'GET', url: `${ORIGIN}/`, ...request },
        preloadResponse,
        respondWith(promise: Promise<Response>) {
          answer = promise;
        },
      };
      dispatch('fetch', event);
      return answer === null ? null : await (answer as Promise<Response>);
    },
  };
}

describe('install', () => {
  it('caches only the offline page, fresh from the network, then takes over at once', async () => {
    const worker = await loadWorker();
    await worker.install();
    expect(worker.added).toEqual([{ cache: 'switchboard-offline-v1', url: `${ORIGIN}/offline.html`, mode: 'reload' }]);
    expect(worker.caches()).toEqual(['switchboard-offline-v1']);
    expect(worker.calls).toEqual(['skipWaiting']);
  });

  it('routes every request that is not a navigation straight to the network (static routing)', async () => {
    const worker = await loadWorker();
    const rules: unknown[] = [];
    await worker.install({ addRoutes: async (rule: unknown) => void rules.push(rule) });
    expect(rules).toEqual([{ condition: { not: { requestMode: 'navigate' } }, source: 'network' }]);
    expect(worker.calls).toEqual(['skipWaiting']);
  });

  it('still installs when static routing refuses the rule (rejects or throws)', async () => {
    for (const addRoutes of [async () => Promise.reject(new TypeError('unsupported condition')), () => { throw new TypeError('not now'); }]) {
      const worker = await loadWorker();
      await worker.install({ addRoutes });
      expect(worker.caches()).toEqual(['switchboard-offline-v1']);
      expect(worker.calls).toEqual(['skipWaiting']);
    }
  });
});

describe('activate', () => {
  it('deletes older offline caches only, enables navigation preload, claims the open pages', async () => {
    const worker = await loadWorker(['switchboard-offline-v0', 'someone-else', 'switchboard-offline-v1']);
    await worker.activate();
    expect(worker.caches()).toEqual(['someone-else', 'switchboard-offline-v1']);
    expect(worker.calls).toEqual(['delete switchboard-offline-v0', 'preload', 'claim']);
  });
});

describe('fetch', () => {
  it.each(['cors', 'no-cors', 'same-origin'])('does not intercept a %s request (API, /hub, assets)', async (mode) => {
    const worker = await loadWorker();
    expect(await worker.fetch({ mode, url: `${ORIGIN}/api/sessions` })).toBeNull();
    expect(await worker.fetch({ mode, url: `${ORIGIN}/hub` })).toBeNull();
  });

  it('does not intercept a navigation that is not a GET', async () => {
    const worker = await loadWorker();
    expect(await worker.fetch({ mode: 'navigate', method: 'POST' })).toBeNull();
  });

  it('answers a navigation with the preloaded response, else a fetch', async () => {
    const worker = await loadWorker();
    const preloaded = new Response('preloaded');
    expect(await worker.fetch({ mode: 'navigate' }, Promise.resolve(preloaded))).toBe(preloaded);
    let fetched: unknown = null;
    worker.setNetwork(async (request) => {
      fetched = request;
      return new Response('fetched');
    });
    expect(await (await worker.fetch({ mode: 'navigate', url: `${ORIGIN}/inbox` }))!.text()).toBe('fetched');
    expect(fetched).toMatchObject({ mode: 'navigate', url: `${ORIGIN}/inbox` });
  });

  it('passes HTTP errors through untouched (only a failed network means offline)', async () => {
    const worker = await loadWorker();
    await worker.install();
    const forbidden = new Response('{"error":"forbidden-host"}', { status: 403 });
    expect(await worker.fetch({ mode: 'navigate' }, Promise.resolve(forbidden))).toBe(forbidden);
  });

  it('shows the cached offline page when the network fails', async () => {
    const worker = await loadWorker();
    await worker.install();
    const failed = Promise.reject(new TypeError('Failed to fetch'));
    const answer = await worker.fetch({ mode: 'navigate' }, failed);
    expect(await answer!.text()).toBe('<p>offline</p>');
    worker.setNetwork(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await (await worker.fetch({ mode: 'navigate' }))!.text()).toBe('<p>offline</p>');
  });

  it("falls back to the browser's own error when the offline page is not cached", async () => {
    const worker = await loadWorker();
    const answer = await worker.fetch({ mode: 'navigate' }, Promise.reject(new TypeError('Failed to fetch')));
    expect(answer!.type).toBe('error');
  });
});

describe('cache version', () => {
  it('is bumped whenever offline.html changes', async () => {
    const worker = await loadWorker();
    const version = Number(/const CACHE_VERSION = (\d+);/.exec(worker.code)?.[1]);
    const sha256 = createHash('sha256').update(await readFile(path.join(PUBLIC_DIR, 'offline.html'))).digest('hex');
    expect(
      { version, sha256 },
      'offline.html changed: bump CACHE_VERSION in src/web/public/sw.js, then update OFFLINE_PAGE_PIN in this test',
    ).toEqual(OFFLINE_PAGE_PIN);
  });
});
