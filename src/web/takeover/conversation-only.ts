import { type TakeoverPreview, staysOnSource } from '../../core/takeover.ts';

/**
 * D158 (`docs/peers.md` → *Conversation only (D158)*): the move dialogs' texts of a
 * **conversation only** move. Pure; shared by the agent's and the crew's dialog.
 */

/** The tick's label. */
export function conversationOnlyLabel(targetName: string): string {
  return `Conversation only (keep the files as they are on ${targetName})`;
}

/** The hint under the tick. */
export function conversationOnlyHint(sourceName: string, targetName: string): string {
  return `Only the chat, its settings, todos and loops move. Nothing is committed, pushed, checked out or compared: the agent continues on whatever ${targetName} has checked out (e.g. its master). Work on ${sourceName} stays there.`;
}

/** One line of the "stays on <computer>" list. */
export function stayLine(entry: { readonly name: string; readonly uncommitted: number; readonly unpushed: number }): string {
  const parts: string[] = [];
  if (entry.uncommitted > 0) parts.push(`${entry.uncommitted} uncommitted file${entry.uncommitted === 1 ? '' : 's'}`);
  if (entry.unpushed > 0) parts.push(`${entry.unpushed} unpushed commit${entry.unpushed === 1 ? '' : 's'}`);
  return `${entry.name}: ${parts.join(', ')}`;
}

/** What the conversation-only panel shows: where it continues, the checkouts it uses as they are, the repos left out there, what stays on the source. */
export function conversationOnlyView(preview: TakeoverPreview): {
  readonly where: string | null;
  readonly used: ReadonlyArray<{ readonly key: string; readonly name: string; readonly path: string }>;
  readonly leftOut: ReadonlyArray<{ readonly key: string; readonly name: string; readonly reason: string }>;
  readonly stays: ReadonlyArray<{ readonly name: string; readonly path: string; readonly line: string }>;
} {
  return {
    where: preview.target.cwd,
    used: preview.target.repos.filter((repo) => repo.action === 'use' && repo.matchedPath !== null).map((repo) => ({ key: repo.key, name: repo.name, path: repo.matchedPath as string })),
    leftOut: preview.target.conversationOnly?.leftOut ?? [],
    stays: staysOnSource(preview.source).map((entry) => ({ name: entry.name, path: entry.path, line: stayLine(entry) })),
  };
}
