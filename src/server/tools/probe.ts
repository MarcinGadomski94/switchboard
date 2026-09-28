import type { ToolProbe } from '../../core/api.ts';
import type { ToolProbeProvider } from '../providers.ts';

/** How long a probe waits for the tool's first response (SPEC → Tools, prototype `probe`). */
export const PROBE_TIMEOUT_MS = 3_000;

/**
 * Probes `url` from the service (M8.1): one `GET`, redirects not followed, and
 * **any** HTTP response within `timeoutMs` counts as `up`, like the prototype's
 * `fetch(url, { mode: 'no-cors' })`, which resolves on every status. A refused
 * connection, a DNS failure, a TLS error or no response in time is `down`. The
 * body is never read. Only URLs saved as tools are ever probed (the route looks
 * the URL up by tool id), and only `http:` / `https:` ones (`tools/validate.ts`).
 */
export async function probeUrl(url: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ToolProbe['state']> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,*/*' },
    });
    await response.body?.cancel().catch(() => undefined);
    return 'up';
  } catch {
    return 'down';
  }
}

/** The real {@link ToolProbeProvider}: {@link probeUrl} with the 3 s timeout. */
export const httpToolProbe: ToolProbeProvider = {
  probe: (url) => probeUrl(url),
};
