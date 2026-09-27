/**
 * Chat tab (SPEC → Session → Chat): messages, tool lines, inline question card, quick replies, composer. Placeholder from M1.4 (docs/lanes.md); M4.2 fills it.
 */
export function ChatTab({ sessionId }: { readonly sessionId: string }) {
  return <div data-testid="session-chat" data-session-id={sessionId} />;
}
