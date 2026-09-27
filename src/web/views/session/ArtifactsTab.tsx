/**
 * Artifacts tab (SPEC → Session → Artifacts): type tag + name + meta rows. Placeholder from M1.4 (docs/lanes.md); M4.6 fills it.
 */
export function ArtifactsTab({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-artifacts" data-session-id={sessionId} />;
}
