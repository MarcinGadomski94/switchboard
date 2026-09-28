import type { ReactNode } from 'react';
import type { AgentActivity, SessionActivity } from '../../core/api.ts';
import { type ActivityLabel, activityLabel, chatActivityLine, overviewActivityLabel, sessionActivityLabel } from './activity.ts';
import { useTick } from './useActivity.ts';
import './activity.css';

/** The activity clocks tick once a second (from the server's timestamps). */
const TICK_MS = 1_000;

/**
 * The chat's live activity line above the composer (D19; `docs/chat.md` → *Live
 * activity line*): the spinner, the rotating verb / `● Tool: summary` /
 * `Writing…` / `Waiting for you`, the time and, while thinking, `· ↓ n tokens`.
 * Renders nothing while no turn runs, so an idle chat is unchanged.
 */
export function ChatActivityLine({ activity }: { readonly activity: SessionActivity | null }) {
  return activity ? <LiveChatLine activity={activity} /> : null;
}

function LiveChatLine({ activity }: { readonly activity: SessionActivity }) {
  const now = useTick(TICK_MS);
  const line = chatActivityLine(activity, now);
  return (
    <div className="sb-chat-activity" data-testid="chat-activity" data-state={line.state}>
      <span className="sb-activity-glyph" data-glyph={line.glyph} data-testid="chat-activity-glyph" aria-hidden="true">
        {line.glyph === 'spinner' ? null : line.glyph}
      </span>
      <span className="sb-activity-text" data-testid="chat-activity-text">
        {line.text}
      </span>
      <span className="sb-activity-time" data-testid="chat-activity-time">
        {line.time}
      </span>
      {line.tokens ? (
        <span className="sb-activity-tokens" data-testid="chat-activity-tokens">
          {`· ${line.tokens}`}
        </span>
      ) : null}
    </div>
  );
}

function Label({ label, testId, titled = false }: { readonly label: ActivityLabel; readonly testId: string; readonly titled?: boolean }) {
  return (
    <span className="sb-activity-label" data-testid={testId} data-state={label.state} title={titled ? `${label.text} ${label.time}` : undefined}>
      <span className="sb-activity-label-text">{label.text}</span>{' '}
      <span className="sb-activity-label-time" data-testid={`${testId}-time`}>
        {label.time}
      </span>
    </span>
  );
}

/** A running session's action + time for its sidebar row (in place of the mode line, D19). */
export function SessionActivityText({ activity }: { readonly activity: SessionActivity }) {
  const now = useTick(TICK_MS);
  return <Label label={sessionActivityLabel(activity, now)} testId="session-activity" />;
}

/** The sidebar row's second line: the running session's action + time (D19), else `children` (the mode line) unchanged. */
export function SessionActivityOr({ activity, children }: { readonly activity: SessionActivity | null; readonly children: ReactNode }) {
  return activity ? <SessionActivityText activity={activity} /> : <>{children}</>;
}

/** An active agent's action + time for its card's status slot (D19). */
export function AgentActivityText({ entry }: { readonly entry: AgentActivity }) {
  const now = useTick(TICK_MS);
  return <Label label={activityLabel(entry, now)} testId="agent-activity" />;
}

/**
 * An active agent's action + time for the agent overview's Status cell (D21): the
 * card's action with the chat line's `●` / `⏸`, the main agent's thinking as the
 * chat line's verb (`turnStartedAt` = the running turn's start; `null` for a
 * subagent). The whole action is the tooltip, since the cell cuts it with `…`.
 */
export function OverviewActivityText({ entry, turnStartedAt }: { readonly entry: AgentActivity; readonly turnStartedAt: string | null }) {
  const now = useTick(TICK_MS);
  return <Label label={overviewActivityLabel(entry, turnStartedAt, now)} testId="overview-activity" titled />;
}
