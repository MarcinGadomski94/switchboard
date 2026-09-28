import type { ToolFrameProvider } from '../providers.ts';
import { switchboardOrigins } from './framing.ts';
import { type ToolProxy, type ToolProxyOptions, startToolProxy } from './proxy.ts';

/** A tool as {@link ToolProxies.sync} needs it. */
export interface ToolTarget {
  readonly id: string;
  /** `null` = not configured: no proxy. */
  readonly url: string | null;
}

/** Options for {@link ToolProxies}. */
export interface ToolProxiesOptions {
  /** Switchboard's own port: `frame-ancestors` lists `http://127.0.0.1:<port>` and `http://localhost:<port>`. */
  readonly switchboardPort: number;
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
 * `PUT /api/tools` syncs it with the new list. Syncs run one at a time.
 */
export class ToolProxies implements ToolFrameProvider {
  readonly #frameOrigins: readonly string[];
  readonly #onError: (error: unknown, toolId: string) => void;
  readonly #start: (options: ToolProxyOptions) => Promise<ToolProxy>;
  readonly #proxies = new Map<string, ToolProxy>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: ToolProxiesOptions) {
    this.#frameOrigins = switchboardOrigins(options.switchboardPort);
    this.#onError = options.onError ?? (() => undefined);
    this.#start = options.start ?? startToolProxy;
  }

  /**
   * Makes the running proxies match `tools`: a tool whose URL is unchanged keeps
   * its proxy (and port); a changed URL restarts it (new port); a tool without a
   * URL, or no longer listed, loses it; a new tool with a URL gets one. A proxy that
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
    for (const tool of tools) if (tool.url) wanted.set(tool.id, tool.url);
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
          const proxy = await this.#start({ target: url, frameOrigins: this.#frameOrigins });
          if (this.#closed) await proxy.close();
          else this.#proxies.set(id, proxy);
        } catch (error) {
          this.#onError(error, id);
        }
      }),
    );
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
