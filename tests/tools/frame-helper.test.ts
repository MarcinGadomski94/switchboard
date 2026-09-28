import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  BUNDLE_ID,
  type DnrRule,
  EXTENSION_FILES,
  OUTPUT_DIR,
  converterArgs,
  pickScheme,
  safariManifest,
  safariRules,
  xcodebuildArgs,
} from '../../tools/frame-helper/build-safari.ts';
import { REPO_ROOT } from '../helpers/net.ts';

/**
 * D28: the frame helper extension (tools/frame-helper/, docs/frame-helper.md): its
 * manifest and rule stay within the documented scope, the Safari build's rule and
 * manifest forms, and the two content scripts run against small fake pages.
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
  readonly declarative_net_request: { rule_resources: Array<{ id: string; enabled: boolean; path: string }> };
  readonly content_scripts: Array<{ matches: string[]; js: string[]; run_at: string; all_frames: boolean }>;
  readonly [key: string]: unknown;
}

describe('manifest.json and rules.json (the scope)', () => {
  it('is a Manifest V3 extension with only declarativeNetRequestWithHostAccess and the hosts it acts on', async () => {
    const manifest = await json<Manifest>('manifest.json');
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Switchboard frame helper');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    // initiatorDomains needs Chrome 101; an older Chrome would drop the condition and widen the rule.
    expect(manifest.minimum_chrome_version).toBe('101');
    expect(manifest.permissions).toEqual(['declarativeNetRequestWithHostAccess']);
    expect(manifest.host_permissions).toEqual(['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*']);
    expect(manifest.declarative_net_request.rule_resources).toEqual([{ id: 'loopback_frames', enabled: true, path: 'rules.json' }]);
    expect(Object.keys(manifest).sort()).toEqual(
      ['content_scripts', 'declarative_net_request', 'description', 'host_permissions', 'manifest_version', 'minimum_chrome_version', 'name', 'permissions', 'version'].sort(),
    );
  });

  it('has the marker on loopback top pages at document_start and the Safari login step in https frames', async () => {
    const manifest = await json<Manifest>('manifest.json');
    expect(manifest.content_scripts).toEqual([
      { matches: ['http://127.0.0.1/*', 'http://localhost/*'], js: ['marker.js'], run_at: 'document_start', all_frames: false },
      { matches: ['https://*/*'], js: ['storage-access.js'], run_at: 'document_idle', all_frames: true },
    ]);
    const referenced = ['manifest.json', ...manifest.declarative_net_request.rule_resources.map((r) => r.path), ...manifest.content_scripts.flatMap((c) => c.js)];
    for (const file of referenced) expect((await stat(path.join(DIR, file))).isFile(), file).toBe(true);
    expect([...EXTENSION_FILES].sort()).toEqual([...new Set(referenced)].sort());
  });

  it('has one rule: remove exactly X-Frame-Options and CSP, only for sub_frames initiated by a loopback page', async () => {
    const rules = await json<Array<Record<string, unknown>>>('rules.json');
    expect(rules).toEqual([
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { resourceTypes: ['sub_frame'], initiatorDomains: ['127.0.0.1', 'localhost'] },
      },
    ]);
  });
});

describe('the Safari build (build-safari.ts)', () => {
  it('turns initiatorDomains into domains (Safari matches it on the top page, any port) and changes nothing else', async () => {
    const rules = await json<DnrRule[]>('rules.json');
    const before = JSON.stringify(rules);
    const safari = safariRules(rules);
    expect(JSON.stringify(rules)).toBe(before); // not mutated
    expect(safari).toEqual([{ ...rules[0], condition: { resourceTypes: ['sub_frame'], domains: ['127.0.0.1', 'localhost'] } }]);
    const other: DnrRule = { id: 9, condition: { urlFilter: 'x' } };
    expect(safariRules([other])[0]).toBe(other);
  });

  it("drops Chrome's minimum_chrome_version from Safari's manifest", async () => {
    const manifest = await json<Manifest>('manifest.json');
    const safari = safariManifest(manifest);
    expect(safari).not.toHaveProperty('minimum_chrome_version');
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
    // Chrome writes its indexed ruleset into an unpacked extension's folder on every load.
    expect(ignored).toContain('tools/frame-helper/_metadata/');
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

describe('marker.js (the helper announces itself)', () => {
  async function runMarker(documentElement: FakeElement | null, api: 'chrome' | 'browser' = 'chrome') {
    const code = await readFile(path.join(DIR, 'marker.js'), 'utf8');
    const observers: Array<() => void> = [];
    const listeners: Array<() => void> = [];
    const document = {
      documentElement,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
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
    const runtime = { runtime: { getManifest: () => ({ version: '1.0.0' }) } };
    vm.runInContext(code, vm.createContext({ document, MutationObserver, [api]: runtime }));
    return { document, observers };
  }

  it('sets data-sb-frame-helper to the extension version on <html> (chrome.* and browser.*)', async () => {
    for (const api of ['chrome', 'browser'] as const) {
      const html = new FakeElement('html');
      const { observers } = await runMarker(html, api);
      expect(html.getAttribute('data-sb-frame-helper')).toBe('1.0.0');
      expect(observers).toHaveLength(0);
    }
  });

  it('waits for <html> when the script runs before it exists', async () => {
    const { document, observers } = await runMarker(null);
    expect(observers).toHaveLength(1);
    const html = new FakeElement('html');
    (document as { documentElement: FakeElement | null }).documentElement = html;
    observers[0]!();
    expect(html.getAttribute('data-sb-frame-helper')).toBe('1.0.0');
    expect(observers).toHaveLength(0);
  });
});
