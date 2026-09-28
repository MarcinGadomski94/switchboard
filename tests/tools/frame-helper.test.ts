import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  BUNDLE_ID,
  EXTENSION_FILES,
  OUTPUT_DIR,
  converterArgs,
  pickScheme,
  safariManifest,
  xcodebuildArgs,
} from '../../tools/frame-helper/build-safari.ts';
import { MAX_FRAME_HELPER_HOSTS, isFrameHelperHost } from '../../src/core/site-tools.ts';
import { HELPER_MESSAGE_SOURCE, PAGE_MESSAGE_SOURCE, SITES_APPLIED_MESSAGE_TYPE, SITES_MESSAGE_TYPE } from '../../src/web/tools/frame-helper.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * D28: the frame helper extension (tools/frame-helper/, docs/frame-helper.md): its
 * manifest stays within the documented scope, the Safari build's manifest form, the
 * service worker's tab-scoped session rules (D28 ruling, narrowed scope) against a
 * fake `chrome` API, and the two content scripts against small fake pages.
 */
const DIR = path.join(REPO_ROOT, 'tools', 'frame-helper');

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DIR, file), 'utf8')) as T;
}

interface Manifest {
  readonly manifest_version: number;
  readonly name: string;
  readonly version: string;
  readonly minimum_chrome_version: string;
  readonly permissions: string[];
  readonly host_permissions: string[];
  readonly background: { service_worker: string };
  readonly content_scripts: Array<{ matches: string[]; js: string[]; run_at: string; all_frames: boolean }>;
  readonly [key: string]: unknown;
}

describe('manifest.json (the scope)', () => {
  it('is a Manifest V3 extension with only declarativeNetRequestWithHostAccess, the hosts it acts on and a service worker; no static rules', async () => {
    const manifest = await json<Manifest>('manifest.json');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Switchboard frame helper');
    expect(manifest.version).toBe('2.0.0');
    // requestDomains needs Chrome 101; an older Chrome would drop the condition and widen the rule to every host in the tab.
    expect(manifest.minimum_chrome_version).toBe('101');
    expect(manifest.permissions).toEqual(['declarativeNetRequestWithHostAccess']);
    expect(manifest.host_permissions).toEqual(['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*']);
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    expect(manifest).not.toHaveProperty('declarative_net_request'); // the static any-loopback rule is gone
    expect(Object.keys(manifest).sort()).toEqual(
      ['background', 'content_scripts', 'description', 'host_permissions', 'manifest_version', 'minimum_chrome_version', 'name', 'permissions', 'version'].sort(),
    );
  });

  it('has the marker + relay on loopback top pages at document_start and the Safari login step in https frames', async () => {
    const manifest = await json<Manifest>('manifest.json');
    expect(manifest.content_scripts).toEqual([
      { matches: ['http://127.0.0.1/*', 'http://localhost/*'], js: ['marker.js'], run_at: 'document_start', all_frames: false },
      { matches: ['https://*/*'], js: ['storage-access.js'], run_at: 'document_idle', all_frames: true },
    ]);
    const referenced = ['manifest.json', manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js)];
    for (const file of referenced) expect((await stat(path.join(DIR, file))).isFile(), file).toBe(true);
    expect([...EXTENSION_FILES].sort()).toEqual([...new Set(referenced)].sort());
    await expect(stat(path.join(DIR, 'rules.json'))).rejects.toThrow();
  });
});

describe('the Safari build (build-safari.ts)', () => {
  it("drops Chrome's minimum_chrome_version from Safari's manifest and keeps the rest (the service worker included)", async () => {
    const manifest = await json<Manifest>('manifest.json');
    const safari = safariManifest(manifest);
    expect(safari).not.toHaveProperty('minimum_chrome_version');
    expect(safari['background']).toEqual({ service_worker: 'background.js' });
    expect({ ...safari, minimum_chrome_version: manifest.minimum_chrome_version }).toEqual(manifest);
  });

  it('converts a macOS-only app without prompts or opening Xcode, and builds Debug signed to run locally', () => {
    expect(converterArgs('/x/ext', '/x/project')).toEqual([
      'safari-web-extension-converter',
      '/x/ext',
      '--project-location',
      '/x/project',
      '--app-name',
      'Switchboard Frame Helper',
      '--bundle-identifier',
      'local.switchboard.framehelper',
      '--macos-only',
      '--no-open',
      '--no-prompt',
      '--copy-resources',
    ]);
    expect([APP_NAME, BUNDLE_ID, OUTPUT_DIR]).toEqual(['Switchboard Frame Helper', 'local.switchboard.framehelper', '.frame-helper-safari']);
    const args = xcodebuildArgs('/x/p.xcodeproj', 'Switchboard Frame Helper', '/x/dd');
    expect(args).toEqual(expect.arrayContaining(['-configuration', 'Debug', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM=', 'build']));
    expect(args.slice(0, 6)).toEqual(['-project', '/x/p.xcodeproj', '-scheme', 'Switchboard Frame Helper', '-configuration', 'Debug']);
    expect(pickScheme(['Other', 'Switchboard Frame Helper'])).toBe('Switchboard Frame Helper');
    expect(pickScheme(['X (iOS)', 'X (macOS)'])).toBe('X (macOS)');
    expect(pickScheme(['Only'])).toBe('Only');
    expect(pickScheme([])).toBeNull();
  });

  it('is wired as npm run frame-helper:safari and its output folder is gitignored', async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['frame-helper:safari']).toBe('node tools/frame-helper/build-safari.ts');
    const ignored = (await readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8')).split('\n');
    expect(ignored).toContain('.frame-helper-safari/');
    // Chrome writes generated files (e.g. indexed rulesets) into an unpacked extension's folder when it loads it.
    expect(ignored).toContain('tools/frame-helper/_metadata/');
  });
});

/** One session rule as the worker writes it. */
interface SessionRule {
  readonly id: number;
  readonly priority: number;
  readonly action: unknown;
  readonly condition: { readonly tabIds: number[]; readonly resourceTypes: string[]; readonly requestDomains: string[] };
}

type Listener = (...args: never[]) => unknown;

/** The service worker (background.js) in a vm with a fake `chrome`: session rules, messages and tab events driven by hand. */
async function startWorker(options: { readonly failUpdate?: boolean } = {}) {
  const code = await readFile(path.join(DIR, 'background.js'), 'utf8');
  let rules: SessionRule[] = [];
  const updates: Array<{ removeRuleIds: number[]; addRules: SessionRule[] }> = [];
  const listeners: Record<string, Listener[]> = { message: [], removed: [], updated: [] };
  const event = (name: string) => ({ addListener: (listener: Listener) => listeners[name]!.push(listener) });
  const chrome = {
    runtime: { id: 'helper-id', onMessage: event('message') },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
    declarativeNetRequest: {
      updateSessionRules(change: { removeRuleIds: number[]; addRules: SessionRule[] }): Promise<void> {
        updates.push(change);
        if (options.failUpdate && change.addRules.length > 0) return Promise.reject(new Error('Rule with id 7 is invalid'));
        rules = [...rules.filter((rule) => !change.removeRuleIds.includes(rule.id)), ...change.addRules];
        return Promise.resolve();
      },
    },
  };
  vm.runInContext(code, vm.createContext({ chrome, URL }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    rules: () => rules,
    updates,
    /** Sends `message` as `sender`; resolves the answer (`undefined` when none) and whether the channel stayed open. */
    async send(message: unknown, sender: Record<string, unknown>) {
      let answer: unknown;
      const open = (listeners['message']![0] as (m: unknown, s: unknown, r: (a: unknown) => void) => boolean)(message, sender, (a) => {
        answer = a;
      });
      await settle();
      await settle();
      return { answer, open };
    },
    async removed(tabId: number) {
      (listeners['removed']![0] as (id: number) => void)(tabId);
      await settle();
    },
    async updated(tabId: number, changeInfo: Record<string, unknown>, tab: Record<string, unknown>) {
      (listeners['updated']![0] as (id: number, c: unknown, t: unknown) => void)(tabId, changeInfo, tab);
      await settle();
    },
  };
}

/** Switchboard's top frame in tab `tabId`, as Chrome describes the content script's sender. */
const switchboard = (tabId = 7, url = 'http://127.0.0.1:4870/tools/jira') => ({ id: 'helper-id', frameId: 0, url, tab: { id: tabId, url } });

const sitesMessage = (hosts: unknown) => ({ type: 'frame-helper:sites', hosts });

describe('background.js (tab-scoped session rules, D28 ruling)', () => {
  it("replaces the sender tab's one rule: remove the two headers from sub_frames of exactly the listed hosts, in that tab only", async () => {
    const worker = await startWorker();
    const first = await worker.send(sitesMessage(['127.0.0.1', 'acme.atlassian.net']), switchboard(7));
    expect(first).toEqual({ open: true, answer: { ok: true, hosts: ['127.0.0.1', 'acme.atlassian.net'], error: null } });
    expect(worker.rules()).toEqual([
      {
        id: 7,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds: [7], resourceTypes: ['sub_frame'], requestDomains: ['127.0.0.1', 'acme.atlassian.net'] },
      },
    ]);
    // Another Switchboard tab gets its own rule; a new list replaces the tab's rule (never merges).
    await worker.send(sitesMessage(['localhost', 'grafana.example.com']), switchboard(9, 'http://localhost:4870/'));
    await worker.send(sitesMessage(['127.0.0.1', 'site.test', 'site.test']), switchboard(7));
    expect(worker.rules().map((rule) => [rule.id, rule.condition.tabIds, rule.condition.requestDomains])).toEqual([
      [9, [9], ['localhost', 'grafana.example.com']],
      [7, [7], ['127.0.0.1', 'site.test']], // deduplicated
    ]);
    expect(worker.updates.at(-1)!.removeRuleIds).toEqual([7]);
    // An empty list removes the tab's rule.
    expect((await worker.send(sitesMessage([]), switchboard(7))).answer).toEqual({ ok: true, hosts: [], error: null });
    expect(worker.rules().map((rule) => rule.id)).toEqual([9]);
  });

  it('refuses anything but plain host names, and more than 50; a refused list leaves the tab without rules', async () => {
    const worker = await startWorker();
    const refused = [
      ['*.atlassian.net'],
      ['atlassian.*'],
      ['acme.atlassian.net:443'],
      ['acme.atlassian.net/jira'],
      ['https://acme.atlassian.net'],
      ['Acme.Atlassian.net'],
      ['net'], // a single label would match every .net site
      ['[::1]'],
      ['example.com.'],
      ['-bad.example.com'],
      [''],
      [42],
      [null],
      'site.test',
      undefined,
      Array.from({ length: MAX_FRAME_HELPER_HOSTS + 1 }, (_, i) => `h${i}.example.com`),
    ];
    for (const hosts of refused) {
      await worker.send(sitesMessage(['127.0.0.1', 'site.test']), switchboard(7));
      expect(worker.rules()).toHaveLength(1);
      const { answer } = await worker.send(sitesMessage(hosts), switchboard(7));
      expect(answer, JSON.stringify(hosts)).toMatchObject({ ok: false, hosts: [] });
      expect((answer as { error: string }).error).toMatch(/plain host name|list of host names|at most 50 hosts/);
      expect(worker.rules(), JSON.stringify(hosts)).toEqual([]);
    }
    const fifty = Array.from({ length: MAX_FRAME_HELPER_HOSTS }, (_, i) => `h${i}.example.com`);
    expect((await worker.send(sitesMessage(fifty), switchboard(7))).answer).toMatchObject({ ok: true });
    expect(worker.rules()[0]!.condition.requestDomains).toHaveLength(50);
  });

  it('takes messages only from its own content script in the top frame of a loopback page', async () => {
    const worker = await startWorker();
    const url = 'http://127.0.0.1:4870/';
    const senders: Array<Record<string, unknown>> = [
      { ...switchboard(), id: 'another-extension' },
      { ...switchboard(), frameId: 3 }, // a frame inside the page
      { ...switchboard(), frameId: undefined },
      { id: 'helper-id', frameId: 0, url: 'https://evil.example/', tab: { id: 7 } },
      { id: 'helper-id', frameId: 0, url: 'https://127.0.0.1:4870/', tab: { id: 7 } }, // Switchboard is plain http
      { id: 'helper-id', frameId: 0, url: 'http://127.0.0.1.evil.example/', tab: { id: 7 } },
      { id: 'helper-id', frameId: 0, url: 'http://192.168.1.2:4870/', tab: { id: 7 } },
      { id: 'helper-id', frameId: 0, url }, // no tab (an extension page)
      { id: 'helper-id', frameId: 0, url, tab: { id: -1 } },
    ];
    for (const sender of senders) {
      const { answer } = await worker.send(sitesMessage(['127.0.0.1', 'site.test']), sender);
      expect(answer, JSON.stringify(sender)).toEqual({ ok: false, hosts: [], error: 'only the top frame of a loopback page may ask' });
    }
    expect(worker.updates).toEqual([]);
    // Other messages are not answered at all.
    expect(await worker.send({ type: 'something-else' }, switchboard())).toEqual({ answer: undefined, open: false });
    expect(await worker.send('frame-helper:sites', switchboard())).toEqual({ answer: undefined, open: false });
  });

  it('a new loopback document in the tab (frame-helper:reset) starts without rules', async () => {
    const worker = await startWorker();
    await worker.send(sitesMessage(['127.0.0.1', 'site.test']), switchboard(7));
    await worker.send(sitesMessage(['127.0.0.1', 'site.test']), switchboard(8));
    expect(await worker.send({ type: 'frame-helper:reset' }, switchboard(7, 'http://127.0.0.1:3000/'))).toEqual({ answer: undefined, open: false });
    expect(worker.rules().map((rule) => rule.id)).toEqual([8]);
    // A reset from anything but a loopback top frame is ignored.
    await worker.send({ type: 'frame-helper:reset' }, { ...switchboard(8), frameId: 2 });
    expect(worker.rules().map((rule) => rule.id)).toEqual([8]);
  });

  it("clears a tab's rule when the tab closes or leaves loopback pages; loopback navigations keep it", async () => {
    const worker = await startWorker();
    for (const tabId of [7, 8, 9, 10]) await worker.send(sitesMessage(['127.0.0.1', 'site.test']), switchboard(tabId));
    await worker.removed(7);
    expect(worker.rules().map((rule) => rule.id)).toEqual([8, 9, 10]);
    // Switchboard's own reload and in-app navigation keep the rule.
    await worker.updated(8, { status: 'loading' }, { id: 8, url: 'http://127.0.0.1:4870/tools/jira' });
    await worker.updated(8, { url: 'http://127.0.0.1:4870/settings/tools' }, { id: 8, url: 'http://127.0.0.1:4870/settings/tools' });
    await worker.updated(8, { title: 'Switchboard' }, { id: 8, url: 'https://evil.example/' }); // not a navigation
    expect(worker.rules().map((rule) => rule.id)).toEqual([8, 9, 10]);
    // Another site: gone. A page the helper may not see (its URL hidden): gone too.
    await worker.updated(8, { status: 'loading', url: 'https://evil.example/' }, { id: 8, url: 'https://evil.example/' });
    await worker.updated(9, { status: 'loading' }, { id: 9 });
    await worker.updated(10, { url: 'https://127.0.0.1:4870/' }, { id: 10 });
    expect(worker.rules()).toEqual([]);
  });

  it('when the browser refuses the rule, the answer says so and the tab has no rule', async () => {
    const worker = await startWorker({ failUpdate: true });
    const { answer } = await worker.send(sitesMessage(['127.0.0.1', 'site.test']), switchboard(7));
    expect(answer).toEqual({ ok: false, hosts: [], error: 'Rule with id 7 is invalid' });
    expect(worker.rules()).toEqual([]);
  });

  it('checks host names exactly as the page does (isFrameHelperHost)', async () => {
    const worker = await startWorker();
    const cases = [
      'localhost',
      '127.0.0.1',
      'site.test',
      'acme.atlassian.net',
      'xn--bcher-kva.example',
      'a-b.c-d.example',
      `${'a'.repeat(63)}.example.com`,
      `${'a'.repeat(64)}.example.com`,
      `${'a.'.repeat(126)}bc`, // 254 characters
      `${'a.'.repeat(125)}bcd`, // 253 characters
      'net',
      'LOCALHOST',
      'localhost.',
      '*.example.com',
      'example.com:443',
      '[::1]',
      'a..b',
      'a_b.example.com',
      ' site.test',
    ];
    for (const host of cases) {
      const { answer } = await worker.send(sitesMessage([host]), switchboard(7));
      expect((answer as { ok: boolean }).ok, host).toBe(isFrameHelperHost(host));
    }
  });
});

/** A tiny element: attributes, children, listeners, a shadow root. */
class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, () => void>();
  parent: FakeElement | null = null;
  id = '';
  type = '';
  disabled = false;
  textContent = '';
  shadow: FakeElement | null = null;
  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  attachShadow(): FakeElement {
    this.shadow = new FakeElement('#shadow-root');
    return this.shadow;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  /** Every element under this one (shadow roots included), depth first. */
  all(): FakeElement[] {
    const inside = [...this.children, ...(this.shadow ? [this.shadow] : [])];
    return inside.flatMap((child) => [child, ...child.all()]);
  }
}

interface FramedPage {
  readonly html: FakeElement;
  readonly reloads: number[];
  readonly calls: string[];
  run(): Promise<void>;
}

/** An https page at `host`, framed as described, whose storage access answers are given. */
function framedPage(options: {
  readonly top?: boolean;
  readonly nested?: boolean;
  readonly ancestorOrigins?: string[] | undefined;
  readonly referrer?: string;
  readonly hasAccess?: boolean;
  readonly grant?: boolean;
  readonly noApi?: boolean;
}): FramedPage {
  const html = new FakeElement('html');
  const reloads: number[] = [];
  const calls: string[] = [];
  const window: Record<string, unknown> = {};
  const top = options.top ? window : {};
  window['top'] = top;
  window['parent'] = options.nested ? {} : top;
  const document = {
    documentElement: html,
    referrer: options.referrer ?? '',
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => html.all().find((element) => element.id === id) ?? null,
    ...(options.noApi
      ? {}
      : {
          hasStorageAccess: () => {
            calls.push('hasStorageAccess');
            return Promise.resolve(options.hasAccess ?? false);
          },
          requestStorageAccess: () => {
            calls.push('requestStorageAccess');
            return options.grant ? Promise.resolve() : Promise.reject(new Error('refused'));
          },
        }),
  };
  const location = {
    host: 'acme.atlassian.net',
    ancestorOrigins: options.ancestorOrigins,
    reload: () => reloads.push(Date.now()),
  };
  return {
    html,
    reloads,
    calls,
    async run() {
      const code = await readFile(path.join(DIR, 'storage-access.js'), 'utf8');
      const context = vm.createContext({ window, document, location, URL });
      window['window'] = window;
      vm.runInContext(code, context);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('storage-access.js (the Safari login step)', () => {
  const banner = (page: FramedPage) => page.html.children.find((element) => element.id === 'sb-frame-helper-storage');
  const texts = (element: FakeElement | undefined) => (element?.all() ?? []).map((child) => child.textContent).filter(Boolean);
  const button = (element: FakeElement | undefined, text: string) => element?.all().find((child) => child.tagName === 'button' && child.textContent === text);

  it('framed directly by Switchboard without storage access: the banner; Allow asks and reloads the frame on success', async () => {
    const page = framedPage({ ancestorOrigins: ['http://127.0.0.1:4870'], hasAccess: false, grant: true });
    await page.run();
    const shown = banner(page);
    expect(shown).toBeDefined();
    expect(shown!.getAttribute('style')).toContain('position: fixed');
    expect(shown!.shadow).not.toBeNull(); // a shadow root: the page's CSS cannot reach it
    expect(texts(shown)).toEqual(['Allow acme.atlassian.net to use your login here', 'Allow', '×']);
    button(shown, 'Allow')!.listeners.get('click')!();
    await settle();
    expect(page.calls).toEqual(['hasStorageAccess', 'requestStorageAccess']);
    expect(page.reloads).toHaveLength(1);
  });

  it('when Safari refuses, the banner says so and points at the docs; × dismisses it', async () => {
    const page = framedPage({ ancestorOrigins: ['http://localhost:4930'], hasAccess: false, grant: false });
    await page.run();
    const shown = banner(page);
    button(shown, 'Allow')!.listeners.get('click')!();
    await settle();
    expect(page.reloads).toHaveLength(0);
    expect(texts(shown)).toEqual(['Safari refused; see docs/frame-helper.md (Prevent cross-site tracking)', '×']);
    button(shown, '×')!.listeners.get('click')!();
    expect(banner(page)).toBeUndefined();
  });

  it('without ancestorOrigins it reads the referrer', async () => {
    const page = framedPage({ ancestorOrigins: undefined, referrer: 'http://127.0.0.1:4870/tools/jira', hasAccess: false });
    await page.run();
    expect(banner(page)).toBeDefined();
  });

  it('shows nothing with storage access (Chrome), not framed, framed by another site, nested deeper, or without the API', async () => {
    const cases = [
      framedPage({ ancestorOrigins: ['http://127.0.0.1:4870'], hasAccess: true }),
      framedPage({ top: true, ancestorOrigins: [] }),
      framedPage({ ancestorOrigins: ['https://evil.example'], hasAccess: false }),
      framedPage({ ancestorOrigins: ['https://127.0.0.1.evil.example'], hasAccess: false }),
      framedPage({ ancestorOrigins: ['https://127.0.0.1:4870'], hasAccess: false }), // Switchboard is plain http
      framedPage({ nested: true, ancestorOrigins: ['https://acme.atlassian.net', 'http://127.0.0.1:4870'], hasAccess: false }),
      framedPage({ ancestorOrigins: ['http://127.0.0.1:4870'], noApi: true }),
    ];
    for (const page of cases) await page.run();
    expect(cases.map((page) => banner(page) === undefined)).toEqual([true, true, true, true, true, true, true]);
    expect(cases.map((page) => page.calls)).toEqual([['hasStorageAccess'], [], [], [], [], [], []]);
  });
});

describe('marker.js (the helper announces itself and relays the host list)', () => {
  interface MarkerPage {
    readonly html: FakeElement | null;
    readonly observers: Array<() => void>;
    /** Messages the content script sent to the worker. */
    readonly sent: unknown[];
    /** Messages the content script posted to the page, with their target origin. */
    readonly posted: Array<{ data: unknown; origin: string }>;
    /** Delivers a `message` event to the content script's listener (none when it has not listened). */
    dispatch(data: unknown, from?: { source?: unknown; origin?: string }): Promise<void>;
    readonly listening: boolean;
    setHtml(html: FakeElement): void;
  }

  async function runMarker(
    options: {
      readonly html?: FakeElement | null;
      readonly api?: 'chrome' | 'browser';
      readonly top?: boolean;
      readonly url?: string;
      readonly reply?: (message: { type: string; hosts?: unknown }) => unknown;
    } = {},
  ): Promise<MarkerPage> {
    const code = await readFile(path.join(DIR, 'marker.js'), 'utf8');
    const observers: Array<() => void> = [];
    const sent: unknown[] = [];
    const posted: Array<{ data: unknown; origin: string }> = [];
    const document = {
      documentElement: options.html === undefined ? new FakeElement('html') : options.html,
      addEventListener: (_type: string, listener: () => void) => observers.push(listener),
    };
    class MutationObserver {
      readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(): void {
        observers.push(this.callback);
      }
      disconnect(): void {
        observers.splice(observers.indexOf(this.callback), 1);
      }
    }
    const url = new URL(options.url ?? 'http://127.0.0.1:4870/tools/jira');
    const location = { protocol: url.protocol, hostname: url.hostname, origin: url.origin };
    let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | null = null;
    const window: Record<string, unknown> = {
      addEventListener: (type: string, handler: typeof listener) => {
        if (type === 'message') listener = handler;
      },
      postMessage: (data: unknown, origin: string) => posted.push({ data, origin }),
    };
    window['top'] = options.top === false ? {} : window;
    const reply = options.reply ?? ((message) => (message.type === 'frame-helper:sites' ? { ok: true, hosts: message.hosts, error: null } : undefined));
    const runtime = {
      runtime: {
        getManifest: () => ({ version: '2.0.0' }),
        sendMessage: (message: { type: string; hosts?: unknown }) => {
          sent.push(message);
          const answer = reply(message);
          return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
      },
    };
    vm.runInContext(code, vm.createContext({ document, MutationObserver, window, location, [options.api ?? 'chrome']: runtime }));
    return {
      get html() {
        return document.documentElement;
      },
      observers,
      sent,
      posted,
      get listening() {
        return listener !== null;
      },
      async dispatch(data, from = {}) {
        listener?.({ source: 'source' in from ? from.source : window, origin: from.origin ?? url.origin, data });
        await settle();
        await settle();
      },
      setHtml(html) {
        document.documentElement = html;
      },
    };
  }

  const sites = (hosts: unknown, id = 1) => ({ source: PAGE_MESSAGE_SOURCE, type: SITES_MESSAGE_TYPE, id, hosts });

  it('sets data-sb-frame-helper to the extension version on <html> (chrome.* and browser.*)', async () => {
    for (const api of ['chrome', 'browser'] as const) {
      const page = await runMarker({ api });
      expect(page.html!.getAttribute('data-sb-frame-helper')).toBe('2.0.0');
      expect(page.observers).toHaveLength(0);
    }
  });

  it('waits for <html> when the script runs before it exists', async () => {
    const page = await runMarker({ html: null });
    expect(page.observers).toHaveLength(2); // the MutationObserver and readystatechange
    const html = new FakeElement('html');
    page.setHtml(html);
    page.observers[0]!();
    expect(html.getAttribute('data-sb-frame-helper')).toBe('2.0.0');
  });

  it("tells the worker a new document starts, relays the page's host list and posts the answer back to the page only", async () => {
    const page = await runMarker();
    expect(page.sent).toEqual([{ type: 'frame-helper:reset' }]);
    await page.dispatch(sites(['127.0.0.1', 'site.test'], 4));
    expect(page.sent.at(-1)).toEqual({ type: 'frame-helper:sites', hosts: ['127.0.0.1', 'site.test'] });
    expect(page.posted).toEqual([
      {
        data: { source: HELPER_MESSAGE_SOURCE, type: SITES_APPLIED_MESSAGE_TYPE, id: 4, ok: true, hosts: ['127.0.0.1', 'site.test'], error: null },
        origin: 'http://127.0.0.1:4870',
      },
    ]);
  });

  it("passes the worker's refusal, or its failure, on to the page", async () => {
    const refused = await runMarker({ reply: (m) => (m.type === 'frame-helper:sites' ? { ok: false, hosts: [], error: 'at most 50 hosts' } : undefined) });
    await refused.dispatch(sites(['x.example.com'], 2));
    expect(refused.posted.map((p) => p.data)).toEqual([{ source: HELPER_MESSAGE_SOURCE, type: SITES_APPLIED_MESSAGE_TYPE, id: 2, ok: false, hosts: [], error: 'at most 50 hosts' }]);
    const failed = await runMarker({ reply: (m) => (m.type === 'frame-helper:sites' ? new Error('Could not establish connection.') : undefined) });
    await failed.dispatch(sites(['x.example.com'], 3));
    expect(failed.posted.map((p) => p.data)).toEqual([
      { source: HELPER_MESSAGE_SOURCE, type: SITES_APPLIED_MESSAGE_TYPE, id: 3, ok: false, hosts: [], error: 'Could not establish connection.' },
    ]);
  });

  it('ignores messages from framed windows, other origins, other senders and other types', async () => {
    const page = await runMarker();
    await page.dispatch(sites(['site.test']), { source: {} }); // a framed tool posting to its parent
    await page.dispatch(sites(['site.test']), { origin: 'https://evil.example' });
    await page.dispatch({ ...sites(['site.test']), source: 'someone-else' });
    await page.dispatch({ ...sites(['site.test']), type: 'frame-helper:other' });
    await page.dispatch({ source: HELPER_MESSAGE_SOURCE, type: SITES_APPLIED_MESSAGE_TYPE, id: 1, ok: true, hosts: [] }); // its own answer
    await page.dispatch('frame-helper:sites');
    await page.dispatch(null);
    expect(page.sent).toEqual([{ type: 'frame-helper:reset' }]);
    expect(page.posted).toEqual([]);
  });

  it('talks to the worker only from the top frame of a loopback http page (it still marks the page)', async () => {
    for (const options of [{ top: false }, { url: 'https://127.0.0.1:4870/' }, { url: 'http://example.com/' }, { url: 'http://127.0.0.1.evil.example/' }]) {
      const page = await runMarker(options);
      expect(page.sent, JSON.stringify(options)).toEqual([]);
      expect(page.listening, JSON.stringify(options)).toBe(false);
    }
  });
});
