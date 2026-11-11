import { useCallback, useMemo } from 'react';
import { planPinId } from '../../../core/plan-pins.ts';
import { api } from '../../api/client.ts';
import { useApi } from '../../api/useApi.ts';
import { useHubEvent } from '../../api/useHub.ts';
import { useToast } from '../components/index.ts';
import { PROJECT_WORDS } from '../glossary.ts';
import { isProjectPinned, projectPinInput } from './pinned-model.ts';

/**
 * D161 · Pin to sidebar / Unpin for a project (the Projects list's and the project page's
 * ⋯ menus), as `crew-pins.ts` does for a crew: the shared sidebar layout's pins
 * (`GET /api/sidebar`, live on `sidebarLayoutChanged`), written through
 * `POST /api/sidebar/place` (`plan~<plan id>`), with Undo.
 */
export function useProjectPins(): { readonly isPinned: (planId: string) => boolean; readonly toggle: (plan: { readonly id: string; readonly title: string }) => Promise<void> } {
  const layout = useApi(api.sidebarLayout);
  useHubEvent('sidebarLayoutChanged', () => layout.reload());
  const toast = useToast();
  const pinned = useMemo(() => layout.data?.pinned ?? [], [layout.data]);
  const isPinned = useCallback((planId: string) => isProjectPinned(pinned, planId), [pinned]);
  const toggle = useCallback(
    async (plan: { readonly id: string; readonly title: string }): Promise<void> => {
      const pin = !isProjectPinned(pinned, plan.id);
      const at = pinned.indexOf(planPinId(plan.id));
      try {
        await api.placeSidebarSession(projectPinInput(plan.id, pin));
        layout.reload();
        toast({
          text: pin ? PROJECT_WORDS.pinnedToast(plan.title) : PROJECT_WORDS.unpinnedToast(plan.title),
          undo: async () => {
            await api.placeSidebarSession(projectPinInput(plan.id, !pin, at));
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
