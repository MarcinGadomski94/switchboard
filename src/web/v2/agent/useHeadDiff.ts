/**
 * D180 · one `head` diff per agent for the side panel: Files' tree signals and changed-line
 * marks, and Changes' **Since last save point**, read it from here (never a second fetch). Read
 * only while the panel shows Files or Changes, and again on the Diff's triggers
 * (`useSessionRefresh`).
 */
import { useCallback } from 'react';
import type { FileDiff } from '../../../core/api.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useSessionRefresh } from '../../views/session/useSessionRefresh.ts';

export interface HeadDiffState {
  /** This agent's `head` diff, `null` until read (or while the panel does not need it). */
  readonly files: readonly FileDiff[] | null;
  readonly error: Error | null;
  readonly reload: () => void;
}

export function useHeadDiff(sessionId: string, enabled: boolean): HeadDiffState {
  const state = useApi(async () => (enabled ? { sessionId, files: await api.sessionDiff(sessionId, undefined, 'head') } : null), [sessionId, enabled]);
  const reloadState = state.reload;
  const reload = useCallback(() => {
    if (enabled) reloadState();
  }, [enabled, reloadState]);
  useSessionRefresh(sessionId, reload);
  // `useApi` keeps its last answer while another agent's loads: only this agent's.
  const files = state.data !== null && state.data.sessionId === sessionId ? state.data.files : null;
  return { files, error: files === null && enabled ? state.error : null, reload };
}
