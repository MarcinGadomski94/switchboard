/**
 * Embedded tool (SPEC → Tools): toolbar, iframe, not-configured / not-reachable
 * overlays. Placeholder from M1.4 (docs/lanes.md); M8.1 fills it.
 */
export function ToolView({ toolId }: { readonly toolId: string }) {
  return <section className="sb-view" data-view="tool" data-testid="view-tool" data-tool-id={toolId} />;
}
