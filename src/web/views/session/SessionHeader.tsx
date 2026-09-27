/**
 * Session header (SPEC → Session): status dot, name, root path, Pause/Resume, ⇄ Continue in terminal / ⇄ Attach here, chips, tabs. Placeholder from M1.4 (docs/lanes.md); M4.1 fills it.
 */
export function SessionHeader({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-header" data-session-id={sessionId} />;
}
