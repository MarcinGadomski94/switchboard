import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionActivity, SessionDetail } from '../../../core/api.ts';
import { isChat } from '../../../core/chats.ts';
import { type SessionCi } from '../../../core/ci.ts';
import { type SessionMachine, offlineReason } from '../../../core/peers.ts';
import { isClosed } from '../../../core/session-close.ts';
import { useLiveActivity } from '../../activity/useActivity.ts';
import { api } from '../../api/client.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useLiveMachine } from '../../api/useMachines.ts';
import { useThrottled } from '../../api/useThrottled.ts';
import { checkpointsKey, useCheckpoints } from '../../views/session/checkpoints.ts';
import { takeFreshAsked } from '../../views/session/fresh-offer.ts';
import { type SessionData, useSessionData } from '../../views/session/useSessionData.ts';
import type { SessionCheckpoints } from '../../../core/checkpoints.ts';

/** `sessionUpdated` / `event` come in bursts: the detail reloads at most this often (the classic view's pace). */
const RELOAD_MS = 500;

/** Everything the agent view reads of one agent (the classic session view's data, `useSessionData`). */
export interface AgentData extends SessionData {
  readonly sessionId: string;
  readonly session: SessionDetail | null;
  /** The live activity (D19), `null` while no turn runs. */
  readonly activity: SessionActivity | null;
  /** The paired computer it runs on (live state), `undefined` / `null` = this one. */
  readonly machine: SessionMachine | null | undefined;
  /** Why nothing can reach it now (its computer is offline), `null` otherwise. */
  readonly blocked: string | null;
  /** A conversation (D106: read-only thinking partner). */
  readonly conversation: boolean;
  readonly closed: boolean;
  /** D80 save points (the turn reverts), live. */
  readonly checkpoints: SessionCheckpoints | null;
}

/**
 * D131 · lane S · one agent's data, live: the detail and the chat's events
 * (`useSessionData`: cached per tab, paged), reloaded on its `/hub` events like
 * the classic session view, plus the activity, its computer and its save points.
 */
export function useAgent(sessionId: string, wantEvents: boolean, eventId: number | null): AgentData {
  const data = useSessionData(sessionId, wantEvents, eventId);
  const reload = useThrottled(data.reload, RELOAD_MS);
  useHubEvent('sessionUpdated', (session) => {
    if (session.id === sessionId) reload();
  });
  useHubEvent('event', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  useHubEvent('questionBatch', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  useHubEvent('artifactsChanged', (payload) => {
    if (payload.sessionId === sessionId) reload();
  });
  const session = data.detail;
  const activity = useLiveActivity(sessionId, session);
  const machine = useLiveMachine(session?.machine);
  const blocked = offlineReason(machine);
  const status = session?.status ?? '';
  const key = useMemo(() => checkpointsKey(data.events, status), [data.events, status]);
  const checkpoints = useCheckpoints(isChat(session) ? '' : sessionId, key);
  return { ...data, sessionId, session, activity, machine, blocked, conversation: isChat(session), closed: session ? isClosed(session) : false, checkpoints };
}

/**
 * D83 · Fixes after 2.0: once the agent this tab asked to continue with a clean
 * slate (the side panel, the ⋯ menu or the Dock's banner: `markFreshAsked`) has its
 * fresh agent (`continuedTo`), open it, as classic's view does.
 */
export function useFollowFresh(sessionId: string, session: Pick<SessionDetail, 'continuedTo'> | null, open: (id: string) => void): void {
  const target = session?.continuedTo?.sessionId ?? null;
  useEffect(() => {
    if (target && takeFreshAsked(sessionId)) open(target);
  }, [sessionId, target, open]);
}

/** D109 · the agent's watched change requests, live (`ciChanged`); `null` while unknown or on a computer without the watch. */
export function useAgentCi(sessionId: string): SessionCi | null {
  const [ci, setCi] = useState<SessionCi | null>(null);
  const load = useCallback(() => {
    api.sessionCi(sessionId).then(
      (answer) => setCi(answer),
      () => setCi(null),
    );
  }, [sessionId]);
  useEffect(() => {
    setCi(null);
    load();
  }, [load]);
  useHubEvent('ciChanged', (payload) => {
    if (payload.sessionId === sessionId) load();
  });
  return ci;
}

/** The browser's `localStorage`, `null` where it is blocked. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
