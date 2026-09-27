/**
 * Diff tab (SPEC → Session → Diff): file list per solution/branch + unified diff, "Not committed" note. Placeholder from M1.4 (docs/lanes.md); M4.5 fills it.
 */
export function DiffTab({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-diff" data-session-id={sessionId} />;
}
