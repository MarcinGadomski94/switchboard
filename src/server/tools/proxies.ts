import { isSiteToolUrl } from '../../core/site-tools.ts';
import type { ToolFrameProvider } from '../providers.ts';
import { switchboardOrigins } from './framing.ts';
import { type ToolProxy, type ToolProxyOptions, startToolProxy } from './proxy.ts';

/** A tool as {@link ToolProxies.sync} needs it. */
export interface ToolTarget {
  readonly id: string;
  /** `null` = not configured: no proxy. D28: a signed-in site (`isSiteToolUrl`) gets none either. */
  readonly url: string | null;
}

/**
 * Where each tool's proxy port is remembered (developer ruling 2026-09-28): a tool
 * keeps its port, so its origin inside the frame (and whatever it stores there,
 * e.g. localStorage) survives Switchboard restarts and URL changes.
 */
export interface ProxyPortMemory {
  get(toolId: string): Promise<number | null>;
  set(toolId: string, port: number): Promise<void>;
}

/** Settings key of a tool's remembered proxy port. */
export function proxyPortSettingKey(toolId: string): string {
  return `tools.proxyPort.${toolId}`;
}

/** A {@link ProxyPortMemory} in the settings table (`tools.proxyPort.<id>`). */
export function settingsProxyPorts(settings: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }): ProxyPortMemory {
  return {
    async get(toolId) {
      const value = await settings.get(proxyPortSettingKey(toolId));
      return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null;
    },
    async set(toolId, port) {
      await settings.set(proxyPortSettingKey(toolId), port);
    },
  };
}

/** Options for {@link ToolProxies}. */
export interface ToolProxiesOptions {
  /** Switchboard's own port: `frame-ancestors` lists `http://127.0.0.1:<port>` and `http://localhost:<port>`. */
  readonly switchboardPort: number;
  /** Remembered ports (main.ts: the settings table); without it every start takes an OS-assigned port. */
  readonly ports?: ProxyPortMemory;
  /** A proxy that could not start (its tool keeps `frameUrl: null`); logged by main.ts. */
  readonly onError?: (error: unknown, toolId: string) => void;
  /** Starts one proxy; tests swap it. Default {@link startToolProxy}. */
  readonly start?: (options: ToolProxyOptions) => Promise<ToolProxy>;
}

/**
 * The framing proxies of the embedded tools (D15, `docs/tools.md` → *Framing
 * proxy*): one {@link ToolProxy} per tool with a URL, each on its own OS-assigned
 * 127.0.0.1 port. main.ts creates it in normal runs (never in demo mode), syncs
 * it with the saved tools before the service listens, and closes it on shutdown;
 * `PUT /api/tools` syncs it with the new list. Syncs run one at a time. D28: a
 * signed-in site (a non-loopback `https:` URL, `docs/frame-helper.md`) gets no
 * proxy: the proxy's origin can never carry the site's login cookies, so the Tool
 * view frames the site directly through the frame helper instead.
 */
export class ToolProxies implements ToolFrameProvider {
  readonly #frameOrigins: readonly string[];
  readonly #onError: (error: unknown, toolId: string) => void;
  readonly #start: (options: ToolProxyOptions) => Promise<ToolProxy>;
  readonly #ports: ProxyPortMemory | null;
  readonly #proxies = new Map<string, ToolProxy>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: ToolProxiesOptions) {
    this.#frameOrigins = switchboardOrigins(options.switchboardPort);
    this.#onError = options.onError ?? (() => undefined);
    this.#start = options.start ?? startToolProxy;
    this.#ports = options.ports ?? null;
  }

  /**
   * Makes the running proxies match `tools`: a tool whose URL is unchanged keeps
   * its proxy (and port); a changed URL restarts it (new port); a tool without a
   * URL, with a site URL (D28), or no longer listed, loses it; a new tool with a
   * local URL gets one. A proxy that
   * fails to start is reported to `onError` and left out. After {@link close} it
   * does nothing.
   */
  sync(tools: readonly ToolTarget[]): Promise<void> {
    const run = this.#queue.then(() => this.#apply(tools));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #apply(tools: readonly ToolTarget[]): Promise<void> {
    if (this.#closed) return;
    const wanted = new Map<string, string>();
    for (const tool of tools) if (tool.url && !isSiteToolUrl(tool.url)) wanted.set(tool.id, tool.url);
    const stopping: Array<Promise<void>> = [];
    for (const [id, proxy] of this.#proxies) {
      if (wanted.get(id) !== proxy.target) {
        this.#proxies.delete(id);
        stopping.push(proxy.close());
      }
    }
    await Promise.all(stopping);
    await Promise.all(
      [...wanted].map(async ([id, url]) => {
        if (this.#proxies.has(id)) return;
        try {
          const proxy = await this.#startOnRememberedPort(id, url);
          if (this.#closed) await proxy.close();
          else this.#proxies.set(id, proxy);
        } catch (error) {
          this.#onError(error, id);
        }
      }),
    );
  }

  /**
   * Starts `id`'s proxy on its remembered port; when there is none, or it is taken
   * now, on an OS-assigned one, which is then remembered (the tool's origin changes
   * only in that case).
   */
  async #startOnRememberedPort(id: string, url: string): Promise<ToolProxy> {
    const remembered = this.#ports ? await this.#ports.get(id) : null;
    let proxy: ToolProxy;
    try {
      proxy = await this.#start({ target: url, frameOrigins: this.#frameOrigins, ...(remembered !== null ? { port: remembered } : {}) });
    } catch (error) {
      if (remembered === null) throw error;
      proxy = await this.#start({ target: url, frameOrigins: this.#frameOrigins });
    }
    if (this.#ports && proxy.port !== remembered) await this.#ports.set(id, proxy.port);
    return proxy;
  }

  /** The URL the Tool view's iframe loads for `toolId` on `hostname` (`127.0.0.1` / `localhost`), or `null` without a running proxy. */
  frameUrl(toolId: string, hostname?: string): string | null {
    return this.#proxies.get(toolId)?.frameUrl(hostname) ?? null;
  }

  /** The running proxy of `toolId`, if any (tests, diagnostics). */
  proxy(toolId: string): ToolProxy | null {
    return this.#proxies.get(toolId) ?? null;
  }

  /** Stops every proxy; later syncs do nothing. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    const proxies = [...this.#proxies.values()];
    this.#proxies.clear();
    await Promise.all(proxies.map((proxy) => proxy.close()));
  }
}
