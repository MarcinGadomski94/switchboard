import type { Artifact, ArtifactListItem, Session } from '../../../core/api.ts';

/**
 * D131 · lane X · the agent view's results in the shape lane R's result drawer
 * (`results/ResultDrawer.tsx`) reads: the Results page's row (`ArtifactListItem`)
 * built from the agent's own artifacts, so the agent's Results tab and its chat
 * attachments open the same drawer as the Results page. No React, no network.
 */

/** What of the agent the row needs. */
export type ResultAgent = Pick<Session, 'name' | 'folderPath'> & { readonly displayTitle?: string | undefined; readonly title?: string | null | undefined; readonly machine?: Session['machine'] };

/**
 * One of the agent's results as a Results-page row. `sessionId` is the agent's id
 * as this computer addresses it (a paired computer's agent: its remote id), which
 * the drawer's content routes need; the artifact's own `sessionId` is the owning
 * computer's.
 */
export function resultItemOf(artifact: Artifact, agent: ResultAgent, sessionId: string): ArtifactListItem {
  return {
    ...artifact,
    sessionId,
    sessionName: agent.name,
    sessionTitle: agent.displayTitle ?? agent.title ?? null,
    folder: null,
    folderPath: agent.folderPath ?? null,
    ...(agent.machine ? { machine: agent.machine } : {}),
  };
}

/** The open result of the agent (`/agents/:id/results/:resultId`): `undefined` while the agent loads, `null` when it has no such result. */
export function openResult(artifacts: readonly Artifact[] | null, resultId: string | null): Artifact | null | undefined {
  if (resultId === null) return null;
  if (artifacts === null) return undefined;
  return artifacts.find((artifact) => artifact.id === resultId) ?? null;
}

/** The results the tab shows: newest first, without the ones whose delete waits in its Undo window. */
export function shownResults(artifacts: readonly Artifact[], pending: ReadonlySet<string>): Artifact[] {
  return artifacts.filter((artifact) => !pending.has(artifact.id));
}
