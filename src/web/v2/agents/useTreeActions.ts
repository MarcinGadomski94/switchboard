import { useCallback } from 'react';
import type { SidebarLayout, SidebarPlaceInput } from '../../../core/sidebar-layout.ts';
import { api } from '../../api/client.ts';
import { teamApi } from '../../team/api.ts';
import { useToast } from '../components/index.ts';
import { AGENTS_WORDS } from '../glossary.ts';
import type { AgentEntry } from './agents-model.ts';
import { type AgentTree, type MoveTarget, checkMove, findFolder } from './tree-model.ts';

/**
 * D131 · lane A · what the folder tree and the rows do to the shared sidebar
 * layout, through the same routes the classic sidebar uses (`/api/sidebar*`), each
 * with Undo: move an agent (drag, Move to folder… / M), pin / unpin, create /
 * rename / delete a folder, fold a folder. A teammate dropped on another crew
 * moves crews (`/api/team/members/{id}/team`).
 */

/** Where a session sits, as a place input that puts it back exactly there. */
export function restoreInput(layout: SidebarLayout, sessionId: string): SidebarPlaceInput {
  const pinnedAt = layout.pinned.indexOf(sessionId);
  if (pinnedAt >= 0) return { sessionId, place: 'pinned', index: pinnedAt };
  const folder = layout.folders.find((f) => f.sessionIds.includes(sessionId));
  if (folder) return { sessionId, place: 'folder', folderId: folder.id, index: folder.sessionIds.indexOf(sessionId) };
  return { sessionId, place: 'loose' };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'It didn’t work. Try again.';
}

/** The tree's actions; each applies the layout the service answers with at once. */
export function useTreeActions(context: { readonly layout: SidebarLayout; readonly tree: AgentTree; readonly apply: (layout: SidebarLayout) => void; readonly shareNote: string }) {
  const toast = useToast();
  const { layout, tree, apply, shareNote } = context;

  const place = useCallback(async (input: SidebarPlaceInput) => apply(await api.placeSidebarSession(input)), [apply]);

  const move = useCallback(
    async (agent: AgentEntry, target: MoveTarget): Promise<boolean> => {
      const check = checkMove(agent, target, layout, tree);
      if (!check.ok) {
        toast({ text: check.reason, tone: 'error' });
        return false;
      }
      try {
        if (check.via === 'crew' && target.kind === 'crew' && agent.crew) {
          const from = agent.crew.id;
          await teamApi.moveToTeam(agent.crew.memberId, target.crewId);
          const crew = tree.crews.find((c) => c.id === target.crewId);
          const memberId = agent.crew.memberId;
          toast({ text: AGENTS_WORDS.movedToCrew(agent.name, crew?.name ?? ''), undo: () => teamApi.moveToTeam(memberId, from) });
          return true;
        }
        const back = restoreInput(layout, agent.id);
        const folder = target.kind === 'folder' ? findFolder(tree, target.folderId) : null;
        await place(target.kind === 'folder' ? { sessionId: agent.id, place: 'folder', folderId: target.folderId } : { sessionId: agent.id, place: 'loose' });
        // Open the folders on the way so the agent shows where it went.
        if (folder) for (const id of [folder.parentId]) if (id) {
          const parent = findFolder(tree, id);
          if (parent?.collapsed) void api.updateSidebarFolder(id, { collapsed: false }).then(apply, () => undefined);
        }
        toast({ text: AGENTS_WORDS.moved(agent.name, folder?.name ?? AGENTS_WORDS.notInFolder, shareNote), undo: () => place(back) });
        return true;
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
        return false;
      }
    },
    [layout, tree, place, toast, apply, shareNote],
  );

  const togglePin = useCallback(
    async (agent: AgentEntry) => {
      const back = restoreInput(layout, agent.id);
      const pinned = back.place === 'pinned';
      try {
        await place(pinned ? { sessionId: agent.id, place: 'loose' } : { sessionId: agent.id, place: 'pinned' });
        toast({ text: pinned ? AGENTS_WORDS.unpinnedToast(agent.name) : AGENTS_WORDS.pinnedToast(agent.name), undo: () => place(back) });
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
      }
    },
    [layout, place, toast],
  );

  const createFolder = useCallback(
    async (name: string, parentId: string | null): Promise<string | null> => {
      try {
        const before = new Set(layout.folders.map((f) => f.id));
        const next = await api.createSidebarFolder(name, parentId);
        apply(next);
        const made = next.folders.find((f) => !before.has(f.id));
        if (parentId) {
          const parent = findFolder(tree, parentId);
          if (parent?.collapsed) void api.updateSidebarFolder(parentId, { collapsed: false }).then(apply, () => undefined);
        }
        const parentName = parentId ? (findFolder(tree, parentId)?.name ?? null) : null;
        if (made) toast({ text: AGENTS_WORDS.folderCreated(made.name, parentName), undo: async () => apply(await api.deleteSidebarFolder(made.id)) });
        return made?.id ?? null;
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
        return null;
      }
    },
    [layout, tree, apply, toast],
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      const folder = findFolder(tree, id);
      if (!folder) return;
      const old = folder.name;
      try {
        apply(await api.updateSidebarFolder(id, { name }));
        toast({ text: AGENTS_WORDS.renamed(name), undo: async () => apply(await api.updateSidebarFolder(id, { name: old })) });
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
      }
    },
    [tree, apply, toast],
  );

  const deleteFolder = useCallback(
    async (id: string) => {
      const stored = layout.folders.find((f) => f.id === id);
      if (!stored) return;
      const parentId = stored.parentId ?? null;
      const siblings = layout.folders.filter((f) => (f.parentId ?? null) === parentId);
      const index = siblings.findIndex((f) => f.id === id);
      const children = layout.folders.filter((f) => f.parentId === id).map((f) => f.id);
      const snapshot = { name: stored.name, collapsed: stored.collapsed, sessionIds: [...stored.sessionIds] };
      try {
        apply(await api.deleteSidebarFolder(id));
        toast({
          text: AGENTS_WORDS.folderDeleted(stored.name),
          undo: async () => {
            const before = new Set((await api.sidebarLayout()).folders.map((f) => f.id));
            let next = await api.createSidebarFolder(snapshot.name, parentId);
            const made = next.folders.find((f) => !before.has(f.id));
            if (!made) return;
            next = await api.moveSidebarFolder(made.id, index, parentId);
            for (const [i, child] of children.entries()) if (next.folders.some((f) => f.id === child)) next = await api.moveSidebarFolder(child, i, made.id);
            for (const [i, sessionId] of snapshot.sessionIds.entries()) next = await api.placeSidebarSession({ sessionId, place: 'folder', folderId: made.id, index: i });
            if (snapshot.collapsed) next = await api.updateSidebarFolder(made.id, { collapsed: true });
            apply(next);
          },
        });
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
      }
    },
    [layout, apply, toast],
  );

  const setCollapsed = useCallback(
    async (id: string, collapsed: boolean) => {
      try {
        apply(await api.updateSidebarFolder(id, { collapsed }));
      } catch (error) {
        toast({ text: errorText(error), tone: 'error' });
      }
    },
    [apply, toast],
  );

  return { move, togglePin, createFolder, renameFolder, deleteFolder, setCollapsed };
}

/** The tree's actions (see {@link useTreeActions}). */
export type TreeActions = ReturnType<typeof useTreeActions>;
