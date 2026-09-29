import type { ReactNode } from 'react';
import type { AgentActivity, BackgroundTask, SessionActivity } from '../../core/api.ts';
import {
  type ActivityLabel,
  type ChatActivityLine as ChatLine,
  cardActivityLabel,
  chatActivityLine,
  overviewActivityLabel,
  sessionActivityLabel,
  subagentActivityLine,
} from './activity.ts';
import { useTick } from './useActivity.ts';
import './activity.css';

/** The activity clocks tick once a second (from the server's timestamps). */
const TICK_MS = 1_000;

/**
 * The chat's live activity line above the composer (D19; `docs/chat.md` → *Live
 * activity line*): the spinner, the rotating verb / `● Tool: summary` /
 * `Writing…` / `Waiting for you`, the time and, while thinking, `· ↓ n tokens`.
 * D30: while background work runs, `⏳` and the wait (`Waiting for GitHub Actions:
 * …`, `+N more`). Renders nothing while no turn runs and nothing is pending, so an
 * idle chat is unchanged.
 */
export function ChatActivityLine({ activity }: { readonly activity: SessionActivity | null }) {
  return activity ? <LiveChatLine activity={activity} /> : null;
}

function LiveChatLine({ activity }: { readonly activity: SessionActivity }) {
  const now = useTick(TICK_MS);
  return <ChatLineView line={chatActivityLine(activity, now)} />;
}

/**
 * D36: a subagent's chat line above the note that replaces the composer, from its
 * entry in `SessionActivity.agents` (`subagentActivityLine`: its card's words with
 * the chat line's glyphs). Renders nothing while the subagent is not active.
 */
export function SubagentActivityLine({ entry }: { readonly entry: AgentActivity | null }) {
  return entry ? <LiveSubagentLine entry={entry} /> : null;
}

function LiveSubagentLine({ entry }: { readonly entry: AgentActivity }) {
  const now = useTick(TICK_MS);
  return <ChatLineView line={subagentActivityLine(entry, now)} />;
}

function ChatLineView({ line }: { readonly line: ChatLine }) {
  return (
    <div className="sb-chat-activity" data-testid="chat-activity" data-state={line.state}>
      <span className="sb-activity-glyph" data-glyph={line.glyph} data-testid="chat-activity-glyph" aria-hidden="true">
        {line.glyph === 'spinner' ? null : line.glyph}
      </span>
      <span className="sb-activity-text" data-testid="chat-activity-text">
        {line.text}
      </span>
      {line.more ? (
        <span className="sb-activity-more" data-testid="chat-activity-more">
          {line.more}
        </span>
      ) : null}
      <span className="sb-activity-time" data-testid="chat-activity-time">
        {line.time}
      </span>
      {line.tokens ? (
        <span className="sb-activity-tokens" data-testid="chat-activity-tokens">
          {`· ${line.tokens}`}
        </span>
      ) : null}
      {line.stale ? (
        <span className="sb-activity-stale" data-testid="chat-activity-stale">
          {`· ${line.stale}`}
        </span>
      ) : null}
    </div>
  );
}

function Label({ label, testId, titled = false }: { readonly label: ActivityLabel; readonly testId: string; readonly titled?: boolean }) {
  const title = [label.text, label.more, label.time, label.stale].filter(Boolean).join(' ');
  return (
    <span className="sb-activity-label" data-testid={testId} data-state={label.state} title={titled || label.state === 'background' ? title : undefined}>
      <span className="sb-activity-label-text">{label.text}</span>{' '}
      {label.more ? (
        <>
          <span className="sb-activity-label-more" data-testid={`${testId}-more`}>
            {label.more}
          </span>{' '}
        </>
      ) : null}
      <span className="sb-activity-label-time" data-testid={`${testId}-time`}>
        {label.time}
      </span>
      {label.stale ? (
        <>
          {' '}
          <span className="sb-activity-label-stale" data-testid={`${testId}-stale`}>
            {`· ${label.stale}`}
          </span>
        </>
      ) : null}
    </span>
  );
}

/** A running session's action + time for its sidebar row (in place of the mode line, D19; D30: its background wait too). */
export function SessionActivityText({ activity }: { readonly activity: SessionActivity }) {
  const now = useTick(TICK_MS);
  return <Label label={sessionActivityLabel(activity, now)} testId="session-activity" />;
}

/** The sidebar row's second line: the running session's action + time (D19), else `children` (the mode line) unchanged. */
export function SessionActivityOr({ activity, children }: { readonly activity: SessionActivity | null; readonly children: ReactNode }) {
  return activity ? <SessionActivityText activity={activity} /> : <>{children}</>;
}

/**
 * An active agent's action + time for its card's status slot (D19); the main agent
 * (`turnStartedAt` = the running turn's start; `null` for a subagent) thinks with
 * the chat line's rotating verb (D21 ruling). D30: the main agent's background wait
 * reads like the chat line's, from the session's pending tasks (`background`).
 */
export function AgentActivityText({
  entry,
  turnStartedAt,
  background = [],
}: {
  readonly entry: AgentActivity;
  readonly turnStartedAt: string | null;
  readonly background?: readonly BackgroundTask[];
}) {
  const now = useTick(TICK_MS);
  return <Label label={cardActivityLabel(entry, turnStartedAt, now, background)} testId="agent-activity" />;
}

/**
 * An active agent's action + time for the agent overview's Status cell (D21): the
 * card's action with the chat line's `●` / `⏸` (D30: `⏳` before a background
 * wait, from the session's pending tasks, `background`), the main agent's thinking
 * as the chat line's verb (`turnStartedAt` = the running turn's start; `null` for a
 * subagent). The whole action is the tooltip, since the cell cuts it with `…`.
 */
export function OverviewActivityText({
  entry,
  turnStartedAt,
  background = [],
}: {
  readonly entry: AgentActivity;
  readonly turnStartedAt: string | null;
  readonly background?: readonly BackgroundTask[];
}) {
  const now = useTick(TICK_MS);
  return <Label label={overviewActivityLabel(entry, turnStartedAt, now, background)} testId="overview-activity" titled />;
}
