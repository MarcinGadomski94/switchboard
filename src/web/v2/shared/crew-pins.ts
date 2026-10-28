import { useCallback, useMemo } from 'react';
import { crewPinId } from '../../../core/crew-pins.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useToast } from '../components/index.ts';
import { CREW_WORDS } from '../glossary.ts';
import { crewPinInput, isCrewPinned } from './pinned-model.ts';

/**
 * Fix after 2.0 (2.4.4) · Pin to sidebar / Unpin for a crew (the crews' ⋯ menus): the
 * shared sidebar layout's pins (`GET /api/sidebar`, live on `sidebarLayoutChanged`),
 * written through `POST /api/sidebar/place` like a pinned agent, with Undo.
 */
export function useCrewPins(): { readonly isPinned: (teamId: string) => boolean; readonly toggle: (crew: { readonly id: string; readonly name: string }) => Promise<void> } {
  const layout = useApi(api.sidebarLayout);
  useHubEvent('sidebarLayoutChanged', () => layout.reload());
  const toast = useToast();
  const pinned = useMemo(() => layout.data?.pinned ?? [], [layout.data]);
  const isPinned = useCallback((teamId: string) => isCrewPinned(pinned, teamId), [pinned]);
  const toggle = useCallback(
    async (crew: { readonly id: string; readonly name: string }): Promise<void> => {
      const pin = !isCrewPinned(pinned, crew.id);
      const at = pinned.indexOf(crewPinId(crew.id));
      try {
        await api.placeSidebarSession(crewPinInput(crew.id, pin));
        layout.reload();
        toast({
          text: pin ? CREW_WORDS.pinnedToast(crew.name) : CREW_WORDS.unpinnedToast(crew.name),
          undo: async () => {
            await api.placeSidebarSession(crewPinInput(crew.id, !pin, at));
            layout.reload();
          },
        });
      } catch (error) {
        toast({ text: error instanceof Error && error.message ? error.message : 'It didn’t work. Try again.', tone: 'error' });
      }
    },
    [pinned, layout, toast],
  );
  return { isPinned, toggle };
}
