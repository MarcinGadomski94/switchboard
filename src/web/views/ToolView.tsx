import { useEffect, useState } from 'react';
import type { Tool } from '../../core/api.ts';
import { api } from '../api/client.ts';
import { useApi } from '../api/useApi.ts';
import { Link, useRouter } from '../router.tsx';
import { urlHost } from '../shell/format.ts';
import { TOOLBAR_STATE, TOOL_DOT, probeTool, useToolState } from '../tools/probe.ts';
import { CodebaseMemoryStrip } from './tool/CodebaseMemoryStrip.tsx';
import './tool.css';

/** The embedded tool's iframe permissions (audit 2026-09-28): no `allow-top-navigation`. */
export const TOOL_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads';

/** The built-in Codebase Memory tool (0002_default_tools.sql); it gets the dirty-projects strip. */
export const CODEBASE_MEMORY_TOOL_ID = 'cm';

/** The overlay over the frame area: not configured, or not reachable (prototype `tool.ov*`). */
interface Overlay {
  readonly title: string;
  readonly text: string;
  readonly label: string;
  readonly action: () => void;
}

/**
 * Embedded tool (SPEC → Tools; M8.1): the toolbar (dot, name, description, URL
 * field with its state, ↻ Reload, ↗ New tab, Edit), the iframe filling the area,
 * the "isn't configured" (→ Set URL in Settings) and "is not reachable" (→ Retry)
 * overlays, and for Codebase Memory the `.codebase-memory-dirty` strip with
 * "Reindex n now". Opening the view probes the tool through the service; Reload
 * and Retry reload the frame and probe again (prototype `frameN` + `probe`).
 */
export function ToolView({ toolId }: { readonly toolId: string }) {
  const { navigate } = useRouter();
  const tools = useApi(api.tools);
  const tool: Tool | null = tools.data?.find((candidate) => candidate.id === toolId) ?? null;
  const state = useToolState(tool);
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
      : null;

  return (
    <section className="sb-view sb-tool-view" data-view="tool" data-testid="view-tool" data-tool-id={toolId} data-tool-state={state}>
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
        {url && state !== 'down' ? (
          <iframe
            key={`${tool.id}:${frameN}`}
            src={url}
            title={tool.name}
            // The tool keeps its own origin, scripts, forms, popups and downloads, but cannot navigate Switchboard's tab.
            sandbox={TOOL_FRAME_SANDBOX}
            data-testid="tool-frame"
            data-frame-n={frameN}
          />
        ) : null}
        {overlay ? <OverlayCard dot={dot} overlay={overlay} /> : null}
      </div>
      {tool.id === CODEBASE_MEMORY_TOOL_ID ? <CodebaseMemoryStrip /> : null}
    </section>
  );
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
          <button type="button" className="sb-button sb-tool-overlay-button" data-testid="tool-overlay-action" onClick={overlay.action}>
            {overlay.label}
          </button>
        </div>
      </div>
    </div>
  );
}
