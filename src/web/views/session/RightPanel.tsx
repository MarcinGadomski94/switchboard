/**
 * Right panel (SPEC → Session → Right panel): agent cards, terminal tail, handoff card with copy. Placeholder from M1.4 (docs/lanes.md); M4.3 fills it.
 */
export function RightPanel({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-right-panel" data-session-id={sessionId} />;
}
