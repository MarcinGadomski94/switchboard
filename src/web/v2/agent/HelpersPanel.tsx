/**
 * D180 · the side panel's Helpers: the agent's helpers beside the chat, in sections of one-line
 * rows (`helpers-view.ts`):
 *
 * - **Needs you:** failed and waiting helpers, the status word in red or amber; a stopped run that can resume, with Resume run;
 * - **Working:** each running Workflow run (name · phase · "4 of 6") with its working helpers
 *   under it, each with what it does now and for how long; then the working helpers on their own;
 * - **N finished:** one folded row; unfolded, the finished helpers and runs, muted;
 * - **Running apps:** the apps the agent left running, with Keep / Stop.
 *
 * A helper's name is the link to its own chat, which opens here (`…/helpers/:helperId`), next to
 * the main chat; "All helpers" or Esc goes back to the list.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon, Skeleton } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { HelperChat } from './HelperChat.tsx';
import { helperSections } from './helpers-view.ts';
import { HelperLine, StoppedRunLine, useOverview } from './SideExtras.tsx';
import { BackgroundGroup } from './SidePanel.tsx';
import type { AgentData } from './useAgent.ts';

/** The helper whose chat the panel shows (the one the address names), and the message of it to bring into view (a search hit), if any. */
export interface PanelHelper {
  readonly id: string;
  readonly eventId: number | null;
}

export function HelpersPanel({ data, helperHref, helper }: { readonly data: AgentData; readonly helperHref: (agentId: string) => string; readonly helper: PanelHelper | null }) {
  const overview = useOverview(data, { everyHelper: true });
  const sections = useMemo(() => helperSections([...overview.fold.shown, ...overview.fold.earlier]), [overview.fold]);
  const [finishedOpen, setFinishedOpen] = useState(false);
  // The list stays as it was left while a helper's chat is shown in its place: what is unfolded (it is only hidden, not taken away) and how far it is scrolled (a hidden list forgets that).
  const list = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(0);
  const listShown = helper === null;
  useLayoutEffect(() => {
    if (listShown && list.current) list.current.scrollTop = scrolled.current;
  }, [listShown]);
  const href = (item: { readonly id: string; readonly opensChat: boolean }): string | null => (item.opensChat ? helperHref(item.id) : null);
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
          <p className="v2-sr" data-testid="v2-side-helpers-sum">
            {overview.summary}
          </p>
          {sections.needsYou.length > 0 || sections.stoppedRuns.length > 0 ? (
            <section className="v2-sp-hsec" aria-label={AGENT_WORDS.needsYouSection} data-testid="v2-side-helpers-needs">
              <h4 className="v2-ag-files-h">{AGENT_WORDS.needsYouSection}</h4>
              {sections.stoppedRuns.map((item) => (
                <StoppedRunLine key={`run:`} data={data} item={item} />
              ))}
              {sections.needsYou.map((item) => (
                <HelperLine key={item.id} data={data} item={item} href={href(item)} look={item.sessionStatus === 'fail' ? 'failed' : 'waiting'} />
              ))}
            </section>
          ) : null}
          {sections.working.length > 0 ? (
            <section className="v2-sp-hsec" aria-label={AGENT_WORDS.workingSection} data-testid="v2-side-helpers-working">
              <h4 className="v2-ag-files-h">{AGENT_WORDS.workingSection}</h4>
              {sections.working.map((entry) =>
                entry.run ? (
                  <div key={`run:${entry.run.runId}`} data-testid="v2-side-helper-run" data-run-id={entry.run.runId}>
                    <div className="v2-sp-hrow v2-sp-hrun">
                      <Icon name="routine" size="s" />
                      <b className="v2-grow" title={entry.run.name}>
                        {entry.run.name}
                      </b>
                      <span className="v2-sp-hstate v2-muted" title={entry.run.summary || entry.run.statusText}>
                        {entry.run.summary || entry.run.statusText.replace(/^[●✓✕⏸]\s*/u, '')}
                      </span>
                    </div>
                    {entry.helpers.map((item) => (
                      <HelperLine key={item.id} data={data} item={item} href={href(item)} look="working" indent />
                    ))}
                  </div>
                ) : (
                  entry.helpers.map((item) => <HelperLine key={item.id} data={data} item={item} href={href(item)} look="working" />)
                ),
              )}
            </section>
          ) : null}
          {sections.finished.length > 0 ? (
            <section className="v2-sp-hsec" data-testid="v2-side-helpers-finished">
              <button type="button" className="v2-sp-hfold" aria-expanded={finishedOpen} onClick={() => setFinishedOpen((open) => !open)} data-testid="v2-side-helpers-finished-toggle">
                <Icon name={finishedOpen ? 'chev-down' : 'chev'} size="s" />
                {AGENT_WORDS.finished(sections.finishedCount)}
              </button>
              {finishedOpen
                ? sections.finished.map((item) =>
                    item.kind === 'workflow' ? (
                      <div key={`run:${item.runId}`} className="v2-sp-hrow v2-sp-hrun" data-look="finished">
                        <Icon name="routine" size="s" />
                        <span className="v2-grow">{item.name}</span>
                      </div>
                    ) : (
                      <HelperLine key={item.id} data={data} item={item} href={href(item)} look="finished" indent={item.depth === 1} />
                    ),
                  )
                : null}
            </section>
          ) : null}
          {sections.needsYou.length === 0 && sections.stoppedRuns.length === 0 && sections.working.length === 0 && sections.finished.length === 0 ? <p className="v2-muted v2-ag-small v2-ag-files-pad">{AGENT_WORDS.noHelpersText}</p> : null}
          {data.conversation ? null : (
            <section className="v2-ag-helpers2-apps v2-sp-hsec" aria-label={AGENT_WORDS.runningApps}>
              <h4 className="v2-ag-files-h">{AGENT_WORDS.runningApps}</h4>
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
