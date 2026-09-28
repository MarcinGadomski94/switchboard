import { useEffect, useState } from 'react';
import type { Tool } from '../../core/api.ts';
import { isSiteToolUrl } from '../../core/site-tools.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Link, useRouter } from '../router.tsx';
import { urlHost } from '../shell/format.ts';
import type { FrameHelperState } from '../tools/frame-helper.ts';
import { useFrameHelper } from '../tools/useFrameHelper.ts';
import { TOOLBAR_STATE, TOOL_DOT, probeTool, useToolFramingRefused, useToolState } from '../tools/probe.ts';
import { CodebaseMemoryStrip } from './tool/CodebaseMemoryStrip.tsx';
import './tool.css';

/** The embedded tool's iframe permissions (audit 2026-09-28): no `allow-top-navigation`. */
export const TOOL_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';

/**
 * D28: a signed-in site's frame: {@link TOOL_FRAME_SANDBOX} plus the Storage Access
 * API's token, so the frame helper's "Allow" button can ask Safari for the site's
 * cookies (a sandboxed frame may only ask with it).
 */
export const SITE_FRAME_SANDBOX = `${TOOL_FRAME_SANDBOX} allow-storage-access-by-user-activation`;

/** The built-in Codebase Memory tool (0002_default_tools.sql); it gets the dirty-projects strip. */
export const CODEBASE_MEMORY_TOOL_ID = 'cm';

/**
 * The overlay over the frame area: not configured, not reachable (prototype
 * `tool.ov*`), refuses framing (D15 fallback), or a site without a working frame
 * helper (D28).
 */
interface Overlay {
  readonly title: string;
  readonly text: string;
  readonly label: string;
  /** The button's action; an overlay with {@link href} is a link instead. */
  readonly action?: () => void;
  /** Opens this URL in a new tab (D15: the tool's own URL). */
  readonly href?: string;
}

/**
 * Embedded tool (SPEC → Tools; M8.1): the toolbar (dot, name, description, URL
 * field with its state, ↻ Reload, ↗ New tab, Edit), the iframe filling the area,
 * the "isn't configured" (→ Set URL in Settings) and "is not reachable" (→ Retry)
 * overlays, and for Codebase Memory the `.codebase-memory-dirty` strip with
 * "Reindex n now". Opening the view probes the tool through the service; Reload
 * and Retry reload the frame and probe again (prototype `frameN` + `probe`).
 * D15: the iframe loads the tool's framing proxy (`Tool.frameUrl`), so a tool that
 * refuses framing still shows; New tab opens the tool's own URL. Only when no proxy
 * runs and the probe says the tool refuses framing, the overlay offers New tab.
 * D28 (`docs/frame-helper.md`): a signed-in site (a non-loopback `https:` URL) has no
 * proxy; with the frame helper working in this browser the iframe loads the site's
 * own URL, else the overlay says what is missing and offers Open in new tab.
 */
export function ToolView({ toolId }: { readonly toolId: string }) {
  const { navigate } = useRouter();
  const tools = useApi(api.tools);
  const tool: Tool | null = tools.data?.find((candidate) => candidate.id === toolId) ?? null;
  const state = useToolState(tool);
  const framingRefused = useToolFramingRefused(tool);
  const site = isSiteToolUrl(tool?.url);
  const helper = useFrameHelper(site);
  const [frameN, setFrameN] = useState(0);

  useEffect(() => {
    if (tool) void probeTool(tool);
    // Probe when the view opens and whenever the tool's URL changes.
  }, [tool?.id, tool?.url]);

  const openSettings = (): void => navigate({ view: 'settings', section: 'tools' });

  if (!tool) {
    return (
      <section className="sb-view sb-tool-view" data-view="tool" data-testid="view-tool" data-tool-id={toolId}>
        {tools.data ? (
          <div className="sb-tool-frame">
            <OverlayCard
              dot={TOOL_DOT.unset}
              overlay={{
                title: 'Unknown tool',
                text: 'There is no tool with this id. Tools are added and removed in Settings.',
                label: 'Open Settings',
                action: openSettings,
              }}
            />
          </div>
        ) : null}
      </section>
    );
  }

  const url = tool.url ?? '';
  const dot = TOOL_DOT[state];
  const retry = (): void => {
    setFrameN((n) => n + 1);
    void probeTool(tool);
  };
  const overlay: Overlay | null = !url
    ? {
        title: `${tool.name} isn't configured`,
        text: `Add the URL where ${tool.name} runs on this PC. It is saved in Switchboard.`,
        label: 'Set URL in Settings',
        action: openSettings,
      }
    : state === 'down'
      ? {
          title: `${urlHost(url)} is not reachable`,
          text: `Start ${tool.name} on this PC and retry. If it runs but refuses to load in a frame (X-Frame-Options / frame-ancestors), use New tab.`,
          label: 'Retry',
          action: retry,
        }
      : site
        ? siteOverlay(url, helper)
        : framingRefused
        ? {
            title: `${urlHost(url)} refuses to load in a frame`,
            text: `${tool.name} runs but refuses to load in a frame (X-Frame-Options / frame-ancestors), use New tab.`,
            label: '↗ New tab',
            href: url,
          }
        : null;
  // D28: a site frames directly once the helper works; a local tool keeps its D15 proxy.
  const showFrame = !!url && state !== 'down' && (site ? helper.status === 'ready' : !framingRefused);

  return (
    <section
      className="sb-view sb-tool-view"
      data-view="tool"
      data-testid="view-tool"
      data-tool-id={toolId}
      data-tool-state={state}
      {...(site ? { 'data-frame-helper': helper.status } : {})}
    >
      <div className="sb-tool-bar" data-testid="tool-toolbar">
        <span className="sb-tool-bar-dot" style={{ background: dot }} />
        <div className="sb-tool-bar-name">{tool.name}</div>
        <div className="sb-tool-bar-desc">{tool.description ?? ''}</div>
        <div className="sb-tool-url" data-testid="tool-url">
          <span className="sb-tool-url-text">{url || 'no URL set'}</span>
          <span className="sb-tool-url-state" style={{ color: dot }} data-testid="tool-state">
            {TOOLBAR_STATE[state]}
          </span>
        </div>
        <div className="sb-tool-actions">
          <button type="button" className="sb-button sb-tool-action" data-testid="tool-reload" onClick={retry}>
            ↻ Reload
          </button>
          <a
            className="sb-tool-action"
            data-testid="tool-new-tab"
            target="_blank"
            rel="noopener"
            {...(url ? { href: url } : { 'aria-disabled': true })}
          >
            ↗ New tab
          </a>
          <Link to={{ view: 'settings', section: 'tools' }} className="sb-tool-action" data-testid="tool-edit">
            Edit
          </Link>
        </div>
      </div>
      <div className="sb-tool-frame">
        {showFrame ? (
          <iframe
            key={`${tool.id}:${frameN}`}
            // D28: a site's own URL (no proxy). D15: a local tool through its loopback framing proxy; its own URL only when none runs.
            src={site ? url : (tool.frameUrl ?? url)}
            title={tool.name}
            // The tool keeps its own origin, scripts, forms, popups and downloads, but cannot navigate Switchboard's tab.
            sandbox={site ? SITE_FRAME_SANDBOX : TOOL_FRAME_SANDBOX}
            data-testid="tool-frame"
            data-frame-mode={site ? 'site' : tool.frameUrl ? 'proxy' : 'plain'}
            data-frame-n={frameN}
          />
        ) : null}
        {overlay ? <OverlayCard dot={dot} overlay={overlay} /> : null}
      </div>
      {tool.id === CODEBASE_MEMORY_TOOL_ID ? <CodebaseMemoryStrip /> : null}
    </section>
  );
}

/**
 * D28: the overlay of a signed-in site while the frame helper does not work here:
 * none while it is being checked (the frame area stays empty), "needs the frame
 * helper" without it, "can't open in a frame in this browser" when it is installed
 * but its header removal does not take effect (Safari today). Both offer the site's
 * own URL in a new tab.
 */
function siteOverlay(url: string, helper: FrameHelperState): Overlay | null {
  const host = siteHost(url);
  if (helper.status === 'absent') {
    return {
      title: `${host} needs the Switchboard frame helper to open here`,
      text: 'Install it once (Chrome and Safari): docs/frame-helper.md',
      label: 'Open in new tab',
      href: url,
    };
  }
  if (helper.status === 'blocked') {
    return {
      title: `${host} can't open in a frame in this browser`,
      text: "The Switchboard frame helper is installed, but this browser didn't let it remove the site's frame headers (Safari's extensions can't yet; in Chrome, give it site access on all sites). See docs/frame-helper.md.",
      label: 'Open in new tab',
      href: url,
    };
  }
  return null;
}

/** A site's host (with its port when it has one), e.g. `acme.atlassian.net`. */
function siteHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return urlHost(url);
  }
}

function OverlayCard({ dot, overlay }: { readonly dot: string; readonly overlay: Overlay }) {
  return (
    <div className="sb-tool-overlay" data-testid="tool-overlay">
      <div className="sb-tool-overlay-card">
        <div className="sb-tool-overlay-title" data-testid="tool-overlay-title">
          <span className="sb-tool-overlay-dot" style={{ background: dot }} />
          {overlay.title}
        </div>
        <div className="sb-tool-overlay-text" data-testid="tool-overlay-text">
          {overlay.text}
        </div>
        <div className="sb-tool-overlay-actions">
          {overlay.href ? (
            <a className="sb-button sb-tool-overlay-button" data-testid="tool-overlay-action" href={overlay.href} target="_blank" rel="noopener">
              {overlay.label}
            </a>
          ) : (
            <button type="button" className="sb-button sb-tool-overlay-button" data-testid="tool-overlay-action" onClick={overlay.action}>
              {overlay.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
