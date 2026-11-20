/**
 * SPIKE · the files an agent's conversation touched (`GET …/files`), and the lookup
 * the chat's links use. Read again when the agent's turns change (`refreshKey`:
 * `turnsKey`, and the Files tab opening), not on every event of a running turn: the
 * server reads the whole conversation for it.
 */
import { useMemo, useRef } from 'react';
import type { AgentFileRef } from '../../../core/agent-files.ts';
import { ApiError, api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import type { FileLinkTarget } from '../../views/session/file-links.ts';

export interface AgentFilesState {
  /** `null` while loading or after an error. */
  readonly files: readonly AgentFileRef[] | null;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  /** Every string the chat may turn into a link → the file. */
  readonly known: ReadonlyMap<string, FileLinkTarget>;
}

const NONE: ReadonlyMap<string, FileLinkTarget> = new Map();

/** What a failed call says: the server's own message when it sent one. */
export function apiErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message !== '') return message;
    return error.message;
  }
  return error instanceof Error ? error.message : 'It didn’t work.';
}

/** The error code a failed call carries (`secret`, `outside`, …), `null` without one. */
export function apiErrorCode(error: unknown): string | null {
  const code = error instanceof ApiError ? (error.body as { error?: unknown } | null)?.error : null;
  return typeof code === 'string' ? code : null;
}

/** What the links' lookup holds, as one string: the lookup changes only when this does. */
export function linksSignature(files: readonly AgentFileRef[] | null): string {
  if (!files) return '';
  return files
    .filter((file) => file.exists)
    .map((file) => `${file.path}\u0000${file.line ?? ''}\u0000${file.mentionedAs.join('\u0001')}`)
    .join('\n');
}

export function useAgentFiles(sessionId: string, enabled: boolean, refreshKey: string): AgentFilesState {
  const state = useApi(async () => (enabled ? { sessionId, list: await api.agentFiles(sessionId) } : null), [sessionId, enabled, refreshKey]);
  // `useApi` keeps its last answer while another agent's loads: never link one agent's chat to another's files.
  const answer = state.data !== null && state.data.sessionId === sessionId ? state.data.list : null;
  const files = answer?.files ?? null;
  const latest = useRef(files);
  latest.current = files;
  // The lookup keeps its identity while it holds the same links: a new one would render (and parse) every reply of the chat again.
  const signature = linksSignature(files);
  const known = useMemo(() => {
    const list = latest.current;
    if (!list || signature === '') return NONE;
    const map = new Map<string, FileLinkTarget>();
    for (const file of list) {
      if (!file.exists) continue;
      const target: FileLinkTarget = { path: file.path, line: file.line };
      map.set(file.path, target);
      for (const written of file.mentionedAs) if (!map.has(written)) map.set(written, target);
    }
    return map.size === 0 ? NONE : map;
  }, [signature]);
  return { files, truncated: answer?.truncated ?? false, error: state.error ? apiErrorText(state.error) : null, reload: state.reload, known };
}
