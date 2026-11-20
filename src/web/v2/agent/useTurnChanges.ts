/**
 * D180 · what each of the agent's turns changed (`GET …/turn-changes`), read again
 * when a turn starts or ends, a review is marked or a revert happens: not on every
 * event of a running turn (each read may snapshot the agent's working trees).
 */
import { useMemo } from 'react';
import type { TurnChange } from '../../../core/turn-changes.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { lastTurnChange } from './turn-changes.ts';
import type { AgentData } from './useAgent.ts';

export interface TurnChangesState {
  /** By the event id of your message that started the turn. */
  readonly byEvent: ReadonlyMap<number, TurnChange>;
  readonly latestTurn: number;
  /** What the last turn changed (the panel's "Last turn"), `null` when it changed nothing. */
  readonly last: TurnChange | null;
}

const NONE: ReadonlyMap<number, TurnChange> = new Map();

/**
 * Changes when the agent's turns do: a turn started or ended, a review began or was
 * marked, a revert happened. What is read per turn (the turn changes, the files the
 * conversation touched) is read again then.
 */
export function turnsKey(data: Pick<AgentData, 'session' | 'checkpoints'>): string {
  const { session, checkpoints } = data;
  return `${checkpoints?.turns.length ?? ''}:${checkpoints?.latestTurn ?? ''}:${checkpoints?.redo?.turn ?? ''}:${session?.status ?? ''}:${session?.review?.since ?? ''}`;
}

export function useTurnChanges(data: AgentData, enabled: boolean): TurnChangesState {
  const { sessionId } = data;
  const key = turnsKey(data);
  const state = useApi(async () => (enabled ? { sessionId, answer: await api.turnChanges(sessionId) } : null), [sessionId, enabled, key]);
  // `useApi` keeps its last answer while another agent's loads (and for good when that load fails): only this agent's counts.
  const answer = state.data !== null && state.data.sessionId === sessionId ? state.data.answer : null;
  const byEvent = useMemo(() => {
    if (!answer) return NONE;
    const map = new Map<number, TurnChange>();
    for (const change of answer.turns) if (change.eventId !== null) map.set(change.eventId, change);
    return map.size === 0 ? NONE : map;
  }, [answer]);
  return useMemo(() => ({ byEvent, latestTurn: answer?.latestTurn ?? 0, last: answer ? lastTurnChange(answer.turns, answer.latestTurn) : null }), [byEvent, answer]);
}
