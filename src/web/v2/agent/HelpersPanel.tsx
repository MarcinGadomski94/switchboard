/**
 * SPIKE · the side panel's Helpers: the agent's helpers, beside the chat. One row per
 * helper (`helpers-view.ts`): the ones at work with what they do now, each Workflow
 * run with its helpers under it, the ones that finished, the older ones folded; and
 * the apps the agent left running. A helper's name is the link to its own chat, which
 * opens here, next to the main chat, instead of taking the chat's place.
 */
import { useLayoutEffect, useRef } from 'react';
import { Skeleton } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { HelperChat } from './HelperChat.tsx';
import { OverviewTable, useOverview } from './SideExtras.tsx';
import { BackgroundGroup } from './SidePanel.tsx';
import type { AgentData } from './useAgent.ts';

/** The helper whose chat the panel shows (the one the address names), and the message of it to bring into view (a search hit), if any. */
export interface PanelHelper {
  readonly id: string;
  readonly eventId: number | null;
}

export function HelpersPanel({ data, helperHref, helper }: { readonly data: AgentData; readonly helperHref: (agentId: string) => string; readonly helper: PanelHelper | null }) {
  const overview = useOverview(data, { everyHelper: true });
  // The list stays as it was left while a helper's chat is shown in its place: what is unfolded (it is only hidden, not taken away) and how far it is scrolled (a hidden list forgets that).
  const list = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(0);
  const listShown = helper === null;
  useLayoutEffect(() => {
    if (listShown && list.current) list.current.scrollTop = scrolled.current;
  }, [listShown]);
  return (
    <>
      {helper ? <HelperChat key={helper.id} data={data} helperId={helper.id} focusEventId={helper.eventId} inPanel /> : null}
      {overview.session ? (
        <div
          className="v2-ag-helpers2"
          ref={list}
          hidden={!listShown}
          onScroll={(event) => {
            if (listShown) scrolled.current = event.currentTarget.scrollTop;
          }}
          data-testid="v2-side-helpers"
        >
          <p className="v2-muted v2-ag-small v2-ag-helpers2-sum" data-testid="v2-side-helpers-sum">
            {overview.summary}
          </p>
          <OverviewTable data={data} helperHref={helperHref} overview={overview} />
          {data.conversation ? null : (
            <section className="v2-ag-helpers2-apps" aria-label={AGENT_WORDS.backgroundApps}>
              <h3>{AGENT_WORDS.backgroundApps}</h3>
              <BackgroundGroup sessionId={data.sessionId} blocked={data.blocked} />
            </section>
          )}
        </div>
      ) : listShown ? (
        <div className="v2-ag-files-pad">
          <Skeleton lines={4} height={14} />
        </div>
      ) : null}
    </>
  );
}
