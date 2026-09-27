/**
 * Timeline tab (SPEC → Session → Timeline): lanes per agent, playhead, scrubber, event log + terminal. Placeholder from M1.4 (docs/lanes.md); M4.4 fills it.
 */
export function TimelineTab({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-timeline" data-session-id={sessionId} />;
}
