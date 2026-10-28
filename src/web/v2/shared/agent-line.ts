import type { SessionActivity, SessionListItem } from '../../../core/api.ts';
import { backgroundAppCount, backgroundAppsText } from '../../../core/derive/background.ts';
import { sessionActivityLabel } from '../../activity/activity.ts';
import { STATUS, type V2Status, sessionStatusToV2 } from '../glossary.ts';
import { timeAgo } from './time.ts';

/**
 * D131 · what an agent row says (pure; unit-tested): its v2 status and its
 * one-line activity. The components are `agent-row.tsx`.
 */

/** What a row needs to know about an agent beyond its session. */
export interface AgentRowExtras {
  /** The agent has an open "needs you" item (its ask, question, approval…). */
  readonly ask?: string | null;
  /** The kind of that item, when there is one (`stopped` / `ready` colour the row). */
  readonly askStatus?: V2Status;
  /** New replies since the developer last looked (the lanes decide; none server-side yet). */
  readonly unread?: boolean;
  /** The composer holds an unsent draft. */
  readonly draft?: boolean;
  /** A label for its kind when not a plain agent ("Conversation", "Teammate", "Step"). */
  readonly kindLabel?: string;
}

/** The v2 status of an agent: its open item's (needs / stopped / ready) first, else its session's. */
export function agentStatusOf(session: Pick<SessionListItem, 'status' | 'turnWait'>, extras: Pick<AgentRowExtras, 'ask' | 'askStatus'> = {}): V2Status {
  if (extras.askStatus) return extras.askStatus;
  if (extras.ask) return 'needs';
  return sessionStatusToV2(session.status);
}

/**
 * D143: the background apps an agent that is not working left running (`1 background app`,
 * D127's words): its pending background shells (a dev server, a watcher, a GitHub wait);
 * `null` while it works (a turn, its helper agents) or has none.
 */
export function backgroundAppsOf(status: V2Status, activity: Pick<SessionActivity, 'background'> | null): string | null {
  if (status === 'working') return null;
  return backgroundAppsText(backgroundAppCount(activity));
}

/** D143: the status word with the background apps: `Idle · 1 background app`; `null` without any (the plain word). */
export function statusWithApps(status: V2Status, activity: Pick<SessionActivity, 'background'> | null): string | null {
  const apps = backgroundAppsOf(status, activity);
  return apps ? `${STATUS[status].label} · ${apps}` : null;
}

/** The agent's one-line activity: what it does now (`Running tests` + `0:42`), its ask, or how it ended. */
export interface AgentLine {
  readonly text: string;
  /** The live time (`0:42`) or the age (`25 min ago`). */
  readonly time: string;
  readonly tone: 'blue' | 'amber' | 'red' | 'grey' | 'green';
}

/** {@link AgentLine} for a session (`activity` is the live one from `useLiveActivity`, else the session's). */
export function agentLine(session: Pick<SessionListItem, 'status' | 'lastActivityAt' | 'turnWait'>, activity: SessionActivity | null, extras: Pick<AgentRowExtras, 'ask' | 'askStatus'> = {}, now: number = Date.now()): AgentLine {
  const status = agentStatusOf(session, extras);
  if (extras.ask) return { text: `“${extras.ask}”`, time: '', tone: status === 'stopped' ? 'red' : status === 'ready' ? 'grey' : 'amber' };
  if (activity && (status === 'working' || session.status === 'run')) {
    const label = sessionActivityLabel(activity, now);
    return { text: label.text, time: label.time, tone: 'blue' };
  }
  if (session.turnWait?.ask && status === 'needs') return { text: `“${session.turnWait.ask}”`, time: '', tone: 'amber' };
  const ago = timeAgo(session.lastActivityAt, now);
  // D143: its turn is over, what it left running shows after the word ("Idle · 1 background app").
  const apps = backgroundAppsOf(status, activity);
  const tail = apps ? ` · ${apps}` : '';
  switch (status) {
    case 'done':
      return { text: `Done${ago ? ` ${ago}` : ''}${tail}`, time: '', tone: 'green' };
    case 'stopped':
      return { text: `Stopped${tail}`, time: ago, tone: 'red' };
    case 'paused':
      return { text: `Paused${tail}`, time: ago, tone: 'grey' };
    default:
      return { text: `${STATUS[status].label}${tail}`, time: ago, tone: 'grey' };
  }
}

/** The agent's display name. */
export function agentName(session: Pick<SessionListItem, 'displayTitle' | 'title' | 'name'>): string {
  return session.displayTitle ?? session.title ?? session.name;
}
