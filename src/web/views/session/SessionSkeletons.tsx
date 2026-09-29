import { LOADING_SESSION } from './session-loading.ts';
import './session-loading.css';

/**
 * D45 placeholders (`docs/session-panel.md` → *Loading a session*): skeleton
 * shapes on the SPEC tokens (`--bg-card` fill, `--border-row` line) with a light
 * shimmer, static with `prefers-reduced-motion`. They are decoration only
 * (`aria-hidden`); the view says "Loading session…" once ({@link LoadingNote}).
 */

/** The header's title bar block (in the name's place). */
export function TitleSkeleton() {
  return <span className="sb-skel sb-skel-title" data-testid="skeleton-title" aria-hidden="true" />;
}

/** The header's root line block (in the root path's place). */
export function RootSkeleton() {
  return <span className="sb-skel sb-skel-root" data-testid="skeleton-root" aria-hidden="true" />;
}

/** The chat's bubbles, top to bottom: the side each sits on, like messages (the task first, from the developer). */
const BUBBLES = ['user', 'agent', 'user', 'agent'] as const;

/** Bubble-shaped blocks in the chat's conversation, alternating sides like messages. */
export function ChatSkeleton() {
  return (
    <div className="sb-skel-chat" data-testid="skeleton-chat" aria-hidden="true">
      {BUBBLES.map((side, index) => (
        <span key={index} className="sb-skel sb-skel-bubble" data-testid="skeleton-bubble" data-side={side} data-index={index} />
      ))}
    </div>
  );
}

/** The right panel: the agent overview's block and two agent card blocks. */
export function PanelSkeleton() {
  return (
    <div className="sb-skel-panel" data-testid="skeleton-panel" aria-hidden="true">
      <div className="sb-skel-overview">
        <span className="sb-skel sb-skel-overview-block" data-testid="skeleton-overview" />
      </div>
      <div className="sb-skel-cards">
        <span className="sb-skel sb-skel-card" data-testid="skeleton-card" />
        <span className="sb-skel sb-skel-card" data-testid="skeleton-card" />
      </div>
    </div>
  );
}

/** The loading state's visually hidden text (a status for screen readers). */
export function LoadingNote() {
  return (
    <span className="sb-skel-note" role="status" data-testid="session-loading">
      {LOADING_SESSION}
    </span>
  );
}
