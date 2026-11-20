import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isRemoteId } from '../../../core/peers.ts';
import type { TurnChange } from '../../../core/turn-changes.ts';
import { useLayout } from '../../shell/useLayout.ts';
import { COMPOSER_INSERT_EVENT } from '../../views/session/ChatTab.tsx';
import { type FileLinks, FileLinksContext } from '../../views/session/file-links.ts';
import { turnBusy } from '../../views/session/needs-you.ts';
import { useDiffCount } from '../../views/session/useDiffScope.ts';
import { BottomSheet, Drawer, EmptyState, IconButton, Tabs, useToast } from '../components/index.ts';
import { AGENT_WORDS } from '../glossary.ts';
import { useV2Router } from '../nav.tsx';
import type { AgentTab, V2Route } from '../routes.ts';
import { markRecent } from '../shared/recent.ts';
import { useShortcut } from '../shell/shortcuts.ts';
import { type ChangesFocus, ChangesPanel } from './ChangesPanel.tsx';
import { isWide, toggledWidth } from './panel-layout.ts';
import { useHeadDiff } from './useHeadDiff.ts';
import { helperFailed } from './helpers-view.ts';
import type { ChangesView } from './changes-view.ts';
import { ChatPane } from './ChatPane.tsx';
import { CliTab } from './CliTab.tsx';
import { splitDock } from './composer-model.ts';
import { openSaveResult } from './dialogs.tsx';
import { leavePanelAddress } from './panel-routes.ts';
import { Dock } from './Dock.tsx';
import { FilesPanel, type OpenFile } from './FilesPanel.tsx';
import { AgentHeader } from './Header.tsx';
import { HelperChat } from './HelperChat.tsx';
import { HelpersPanel, type PanelHelper } from './HelpersPanel.tsx';
import { activeHelperCount, withPendingHelpers } from './helpers-model.ts';
import { SIDE_DEFAULT_WIDTH, SIDE_MIN, SIDE_STEP, SIDE_STEP_BIG, type SideSettings, type SideTab, clampSide, loadSide, saveSide, shownSideTab, sideMax } from './side-settings.ts';
import { SidePanel } from './SidePanel.tsx';
import { ChangesTab, HelpersTab, ResultsTab, TimelineTab } from './tabs.tsx';
import { type TurnChangeLinks, TurnChangesContext, lastRepliesOf } from './turn-changes.ts';
import { useAgent, useFollowFresh } from './useAgent.ts';
import { browserStorage } from './useAgent.ts';
import { useAgentFiles } from './useAgentFiles.ts';
import { useChatRows } from './useChatRows.ts';
import { turnsKey, useTurnChanges } from './useTurnChanges.ts';
import { type ChatViewSettings, columnWidth, loadView, saveView, textMetrics } from './view-settings.ts';
import './agent.css';
import './side-panel.css';

/** The agent view's route. */
export type AgentRoute = Extract<V2Route, { readonly area: 'agent' }>;

/** This browser's chat view settings, remembered. */
function useViewSettings(): readonly [ChatViewSettings, (next: ChatViewSettings) => void] {
  const [view, setView] = useState<ChatViewSettings>(() => loadView(browserStorage()));
  const update = useCallback((next: ChatViewSettings) => {
    setView(next);
    saveView(browserStorage(), next);
  }, []);
  return [view, update];
}

/** D180: the side panel's tab and width, remembered per browser. */
function useSideSettings(): readonly [SideSettings, (next: SideSettings) => void] {
  const [side, setSide] = useState<SideSettings>(() => loadSide(browserStorage()));
  const update = useCallback((next: SideSettings) => {
    setSide(next);
    saveSide(browserStorage(), next);
  }, []);
  return [side, update];
}

/**
 * D131 · lane S · one agent's full view (`/agents/:id…`; the prototype's agent
 * full view and phone chat): the header with its tabs, the chat (or Changes,
 * Results, Timeline, Helpers, or a helper's own chat), the composer dock, and the
 * side panel (Details: ⌘. hides it on a desktop, remembered; a drawer on a tablet;
 * a bottom sheet on a phone).
 *
 * D180 (side panel): on a desktop the panel has tabs for the work (Changes | Files |
 * Helpers, the last only for an agent that has helpers), its left edge is a handle
 * that resizes it, and Details is no tab any more: it opens from the ⓘ at the end of
 * the tab row. Changes, the helpers and a helper's own chat open in the panel next to
 * the chat instead of replacing the chat, and paths in the agent's replies open in
 * Files. A helper's chat keeps its address (`…/helpers/:helperId`); the addresses of
 * Changes and of the helpers' list only open the panel and are left again
 * (`panel-routes.ts`).
 */
export function AgentView({ route }: { readonly route: AgentRoute }) {
  const { navigate } = useV2Router();
  const layout = useLayout();
  const toast = useToast();
  const sessionId = route.id;
  const helperId = route.helperId ?? null;
  const desktop = layout === 'desktop';
  const phone = layout === 'phone';
  // D180: the tabbed panel exists on a desktop (beside the chat) and on a tablet-wide window (as the drawer); a phone keeps Details only.
  const tabbed = !phone;
  const base = `/agents/${encodeURIComponent(sessionId)}`;
  // D180: there the Changes route shows the chat with the panel on Changes, and a helper's chat opens in the panel too (a phone keeps it in the chat's place).
  const panelRoute = tabbed && helperId === null && route.tab === 'changes';
  const helperInPanel = tabbed && helperId !== null;
  const helperFull = helperId !== null && !tabbed;
  const tab: AgentTab = helperId || panelRoute ? 'chat' : route.tab;
  const data = useAgent(sessionId, tab === 'chat' && !helperFull, helperId === null ? (route.eventId ?? null) : null);
  const openAgent = useCallback((id: string) => navigate(`/agents/${encodeURIComponent(id)}`), [navigate]);
  useFollowFresh(sessionId, data.session, openAgent);
  const [view, setView] = useViewSettings();
  const viewRef = useRef(view);
  viewRef.current = view;
  const [side, setSide] = useSideSettings();
  const sideRef = useRef(side);
  sideRef.current = side;
  const [drawer, setDrawer] = useState(false);
  const sideShown = desktop ? !view.sideHidden : drawer;
  const toggleSide = useCallback(() => {
    if (desktop) {
      const hidden = !view.sideHidden;
      setView({ ...view, sideHidden: hidden });
      toast({ text: hidden ? AGENT_WORDS.sidePanelHidden : AGENT_WORDS.sidePanelShown });
    } else setDrawer((open) => !open);
  }, [desktop, view, setView, toast]);
  useShortcut('side-panel', toggleSide);
  useEffect(() => setDrawer(false), [sessionId, layout]);
  // Fix after 2.0: opening an agent puts it first in the rail's Recent.
  useEffect(() => markRecent(sessionId), [sessionId]);

  /** Shows the panel on `next` (unhiding it on a desktop, opening the drawer elsewhere). */
  const openSide = useCallback(
    (next: SideTab): void => {
      setSide({ ...sideRef.current, tab: next });
      if (!desktop) setDrawer(true);
      else if (viewRef.current.sideHidden) setView({ ...viewRef.current, sideHidden: false });
    },
    [setSide, setView, desktop],
  );
  // D180: what Changes shows (one of the Diff's views, since the last review, or one turn).
  const [changesView, setChangesView] = useState<ChangesView>({ kind: 'scope' });
  /** Changes was opened by its route ("Open changes" on the To review strip or card): the view is picked once the agent is loaded. */
  const [openedByRoute, setOpenedByRoute] = useState(false);
  useEffect(() => {
    setChangesView({ kind: 'scope' });
    setOpenedByRoute(false);
  }, [sessionId]);
  /** Leaves an address that only opened something in the panel, without a second history entry for the same page (`panel-routes.ts`). */
  const leaving = useRef(false);
  const leavePanelRoute = useCallback((): void => {
    if (leaving.current) return;
    const state = window.history.state as { readonly from?: unknown } | null;
    if (leavePanelAddress(typeof state?.from === 'string' ? state.from : null, base) === 'back') {
      // The step back arrives later (a popstate): asked once.
      leaving.current = true;
      window.history.back();
    } else navigate(base, { replace: true });
  }, [base, navigate]);
  const helpersAddress = tabbed && helperId === null && route.tab === 'helpers';
  useEffect(() => {
    if (!panelRoute && !helpersAddress) leaving.current = false;
  }, [panelRoute, helpersAddress]);
  useEffect(() => {
    if (!panelRoute) return;
    openSide('changes');
    setOpenedByRoute(true);
    leavePanelRoute();
  }, [panelRoute, openSide, leavePanelRoute]);
  const review = data.session && !data.session.closedAt ? (data.session.review ?? null) : null;
  // D180: opened by its route (the To review strip's or card's Open changes, which picked For review with showReviewScope; the header's Changes): the Diff's own view, not a turn picked before.
  useEffect(() => {
    if (!openedByRoute) return;
    setChangesView({ kind: 'scope' });
    setOpenedByRoute(false);
  }, [openedByRoute]);
  // D180: the helpers. An agent that has (or had) a helper or a run gets the panel's Helpers tab; the header's Helpers tab and every link to a helper's own chat open there, beside the main chat.
  const hasHelpers = (data.session?.agents ?? []).some((agent) => agent.kind !== 'main') || (data.session?.workflows ?? []).length > 0;
  // A helper's own chat keeps its address (`…/helpers/:helperId`): Back closes it, a reload keeps it, and its link opens in a new browser tab as any link does. The panel shows it under Helpers.
  const panelHelper: PanelHelper | null = helperInPanel && helperId !== null ? { id: helperId, eventId: route.eventId ?? null } : null;
  // The Helpers tab is there for an agent with helpers, and whenever the address names one (while the agent's detail still loads; a helper that is gone says so in its place).
  const helpersTab = hasHelpers || helperInPanel;
  useEffect(() => {
    if (helperInPanel) openSide('helpers');
  }, [helperInPanel, helperId, openSide]);
  // The Helpers address itself (a bookmark, a link): the list in the panel. A click on the header's tab goes there without the detour (`onTab`).
  const helpersRoute = helpersAddress && hasHelpers;
  useEffect(() => {
    if (!helpersRoute) return;
    openSide('helpers');
    leavePanelRoute();
  }, [helpersRoute, openSide, leavePanelRoute]);
  const openTurn = useCallback(
    (change: TurnChange): void => {
      setChangesView({ kind: 'turn', change });
      openSide('changes');
    },
    [openSide],
  );

  // D180: the file the Files tab shows, and the files the chat links to. A file belongs to the agent it was opened for: another agent starts with none, without a render in between that would ask for the old file as the new agent's.
  const [opened, setOpened] = useState<{ readonly sessionId: string; readonly file: OpenFile } | null>(null);
  const openFile = opened !== null && opened.sessionId === sessionId ? opened.file : null;
  const setOpenFile = useCallback((file: OpenFile | null): void => setOpened(file === null ? null : { sessionId, file }), [sessionId]);
  // Read again when the agent's turns change, and when the Files tab is opened (not on every event of a running turn).
  // D180: an agent of a paired computer: its files and turn changes are read on its own computer only (the routes are local-only), never asked from here.
  const local = !isRemoteId(sessionId);
  const files = useAgentFiles(sessionId, tabbed && local, `${turnsKey(data)}:${side.tab === 'files' && sideShown ? 'open' : ''}`);
  const openInPanel = useCallback(
    (path: string, line: number | null): void => {
      setOpenFile({ path, line });
      openSide('files');
    },
    [openSide, setOpenFile],
  );
  const links = useMemo<FileLinks | null>(() => (tabbed && files.known.size > 0 ? { known: files.known, open: openInPanel } : null), [tabbed, files.known, openInPanel]);

  // D180: the panel's width (the handle on its left edge).
  const sectionRef = useRef<HTMLElement | null>(null);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const element = sectionRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const sideWidth = clampSide(side.width, viewWidth);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const section = sectionRef.current;
    if (event.button !== 0 || !section) return;
    event.preventDefault();
    const rect = section.getBoundingClientRect();
    let latest = sideWidth;
    // While dragging only the CSS variable moves (no render per pointer move); the width is stored on release.
    const move = (moved: PointerEvent): void => {
      latest = clampSide(rect.right - moved.clientX, rect.width);
      section.style.setProperty('--v2-ag-side', `${latest}px`);
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.classList.remove('v2-ag-resizing');
      setSide({ ...sideRef.current, width: latest });
    };
    document.body.classList.add('v2-ag-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? SIDE_STEP_BIG : SIDE_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = sideWidth + step;
    else if (event.key === 'ArrowRight') next = sideWidth - step;
    else if (event.key === 'Home') next = sideMax(viewWidth);
    else if (event.key === 'End') next = SIDE_MIN;
    else if (event.key === 'Enter') next = SIDE_DEFAULT_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setSide({ ...side, width: clampSide(next, viewWidth) });
  };

  const { rows, lastEventId, fullText } = useChatRows(data);
  const working = data.session !== null && turnBusy(data.session);
  const split = useMemo(() => splitDock(rows, working), [rows, working]);
  // D180: what each turn changed: a chip under the turn's last reply opens Changes on that turn.
  const turnChanges = useTurnChanges(data, tabbed && local);
  // The same set object while the same replies end their turns: a new one would render every reply again on each chat update.
  const lastRepliesKept = useRef<ReadonlySet<number>>(new Set());
  const lastReplies = useMemo(() => {
    const next = lastRepliesOf(split.chat);
    const kept = lastRepliesKept.current;
    if (kept.size === next.size && [...next].every((id) => kept.has(id))) return kept;
    lastRepliesKept.current = next;
    return next;
  }, [split.chat]);
  const turnLinks = useMemo<TurnChangeLinks | null>(() => (tabbed && turnChanges.byEvent.size > 0 ? { byEvent: turnChanges.byEvent, lastReplies, open: openTurn } : null), [tabbed, turnChanges.byEvent, lastReplies, openTurn]);
  // D180: the comments on diff lines go into the message box (the chat's dock), which only exists on the Chat tab.
  const [toCompose, setToCompose] = useState<string | null>(null);
  useEffect(() => {
    if (toCompose === null || tab !== 'chat' || helperFull) return;
    // The dock is a child: its listener is registered before this effect runs.
    window.dispatchEvent(new CustomEvent(COMPOSER_INSERT_EVENT, { detail: { sessionId, text: toCompose } }));
    setToCompose(null);
  }, [toCompose, tab, helperFull, sessionId]);
  const sendComments = useCallback(
    (text: string): void => {
      setToCompose(text);
      if (tab !== 'chat' || helperFull) navigate(base);
    },
    [tab, helperFull, navigate, base],
  );
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);
  const changes = useDiffCount(sessionId, data.session ? data.session.files.length : null, data.session?.review?.since ?? null);
  const counts = { changes, results: data.session?.artifacts.length ?? 0, helpers: activeHelperCount(withPendingHelpers(data.session?.agents ?? [], data.activity?.background), data.session?.workflows ?? []) };
  const helperHref = useCallback((agentId: string) => `${base}/helpers/${encodeURIComponent(agentId)}`, [base]);
  const onTab = (next: AgentTab): void => {
    // D180: Changes and the helpers are in the side panel, next to the chat: their tabs open them there, without a detour through their address.
    if (tabbed && (next === 'changes' || (next === 'helpers' && hasHelpers))) {
      openSide(next);
      if (next === 'changes') setOpenedByRoute(true);
      // From another tab, or from a helper's own chat: back to the agent's own address.
      if (tab !== 'chat' || helperId !== null) navigate(base);
      return;
    }
    navigate(next === 'chat' ? base : `${base}/${next}`);
  };
  const metrics = textMetrics(view.density);
  const style = {
    '--v2-ag-col': columnWidth(view, sideShown && desktop),
    '--v2-ag-fs': `${metrics.size}px`,
    '--v2-ag-lh': String(metrics.lineHeight),
    '--v2-ag-gap': `${metrics.gap}px`,
    '--v2-ag-side': `${sideWidth}px`,
  } as CSSProperties;
  const missing = data.detailError?.status === 404;
  const onSave = (text: string, kind: 'markdown' | 'code', language: string | null): void => openSaveResult({ sessionId, text, kind, language });

  const details = <SidePanel data={data} helperHref={helperHref} helpersElsewhere={tabbed && hasHelpers} folded={tabbed} />;
  // What the panel shows: the remembered tab, or Changes while that one has nothing for this agent.
  const sideTab = shownSideTab(side.tab, { helpers: helpersTab });
  // D180: wide (≥ 760 px) the list sits beside the file or diff; the tablet drawer is narrow.
  const wide = desktop && isWide(sideWidth);
  /** Counts clicks on the tab already shown: Files and Changes go back to their list. */
  const [again, setAgain] = useState<{ readonly tab: SideTab; readonly n: number }>({ tab: 'changes', n: 0 });
  const backTo = (tab: SideTab): number => (again.tab === tab ? again.n : 0);
  // D180: one `head` diff for Files' signals and Changes' Since last save point, read only while one of them shows.
  const head = useHeadDiff(sessionId, tabbed && sideShown && (sideTab === 'files' || sideTab === 'changes'));
  // D180: "View changes" from Files: Changes on that file, Since last save point.
  const [changesFocus, setChangesFocus] = useState<ChangesFocus | null>(null);
  useEffect(() => setChangesFocus(null), [sessionId]);
  const viewChanges = useCallback(
    (path: string): void => {
      setChangesView({ kind: 'scope' });
      setChangesFocus((current) => ({ path, n: (current?.n ?? 0) + 1 }));
      openSide('changes');
    },
    [openSide],
  );
  /** D180: a helper failed: a red dot on the Helpers tab. */
  const failedHelper = helperFailed(data.session?.agents ?? []);
  // The panel's tabs and what they show: beside the chat on a desktop, in the drawer on a tablet-wide window.
  const sideTabs = (
    <Tabs<SideTab>
      label="Side panel"
      value={sideTab}
      onChange={(next) => {
        if (next === sideTab) setAgain((current) => ({ tab: next, n: current.tab === next ? current.n + 1 : 1 }));
        else setSide({ ...side, tab: next });
      }}
      panelId="v2-agent-side-pane"
      testId="v2-agent-side-tabs"
      tabs={[
        { id: 'changes', label: 'Changes', tour: 'v2-side-tabs', ...(changes ? { count: changes } : {}) },
        { id: 'files', label: 'Files' },
        // Only for an agent that has helpers; the count is those at work now, the red dot a failed one.
        ...(helpersTab
          ? [
              {
                id: 'helpers' as const,
                tour: 'v2-side-helpers',
                label: (
                  <>
                    {AGENT_WORDS.helpers}
                    {failedHelper ? <span className="v2-side-dot" role="img" aria-label={AGENT_WORDS.helperFailed} data-testid="v2-side-helpers-failed" /> : null}
                  </>
                ),
                ...(counts.helpers ? { count: counts.helpers } : {}),
              },
            ]
          : []),
        // Details is the ⓘ at the end of the row (its name is for screen readers and the tooltip).
        { id: 'details', icon: 'info', label: <span className="v2-sr">{AGENT_WORDS.details}</span>, title: AGENT_WORDS.details },
      ]}
    />
  );
  const sidePane = (
    <div className="v2-ag-side-pane" id="v2-agent-side-pane" role="tabpanel">
      {sideTab === 'details' ? details : null}
      {sideTab === 'helpers' ? <HelpersPanel data={data} helperHref={helperHref} helper={panelHelper} /> : null}
      {sideTab === 'changes' ? (
        <ChangesPanel
          sessionId={sessionId}
          review={review}
          onOpenFile={(path) => openInPanel(path, null)}
          view={changesView}
          onView={setChangesView}
          turns={turnChanges}
          head={head}
          wide={wide}
          backToList={backTo('changes')}
          focus={changesFocus}
          onSendComments={sendComments}
          sendBlocked={data.blocked ?? (data.closed ? 'This agent is archived: it takes no messages.' : null)}
        />
      ) : null}
      {sideTab === 'files' ? <FilesPanel sessionId={sessionId} files={files} head={head} wide={wide} backToList={backTo('files')} open={openFile} onOpen={setOpenFile} onClose={() => setOpenFile(null)} onViewChanges={viewChanges} /> : null}
    </div>
  );
  return (
    <section ref={sectionRef} className="v2-ag" data-testid="v2-agent-view" data-session-id={sessionId} data-layout={layout} data-density={view.density} data-side={sideShown ? 'shown' : 'hidden'} data-fullwidth={view.fullWidth ? 'true' : undefined} data-tab={tab} style={style}>
      <div className="v2-ag-main">
        {missing ? (
          <EmptyState icon="agents" tone="grey" title="No such agent" text="It was deleted, or it lives on a computer that is not paired any more." />
        ) : (
          <>
            {helperFull ? null : <AgentHeader data={data} tab={tab} onTab={onTab} view={view} onView={setView} sideShown={sideShown} onToggleSide={toggleSide} counts={counts} phone={phone} />}
            <div className="v2-ag-body" id="v2-agent-panel" role="tabpanel">
              {helperFull && helperId ? (
                <HelperChat data={data} helperId={helperId} focusEventId={route.eventId ?? null} />
              ) : tab === 'chat' ? (
                <FileLinksContext.Provider value={links}>
                  <TurnChangesContext.Provider value={turnLinks}>
                    <ChatPane
                      data={data}
                      rows={split.chat}
                      fullText={fullText}
                      // A helper's address may name one of the helper's messages: that one is not the main chat's to find.
                      focusEventId={helperId === null ? (route.eventId ?? null) : null}
                      stick={stick}
                      variant={phone ? 'phone' : 'full'}
                      onSave={onSave}
                      onOpenResult={(id) => navigate(`${base}/results/${encodeURIComponent(id)}`)}
                      helperHref={helperHref}
                    />
                  </TurnChangesContext.Provider>
                  <Dock
                    data={data}
                    queued={split.queued}
                    paused={split.paused}
                    lastEventId={lastEventId}
                    onSent={() => {
                      stick.current = true;
                    }}
                    variant={phone ? 'phone' : 'full'}
                  />
                </FileLinksContext.Provider>
              ) : tab === 'cli' ? (
                // D171: the agent's conversation as the interactive claude (the native CLI) in a terminal.
                <CliTab data={data} phone={phone} />
              ) : (
                <div className="v2-ag-scroll">
                  <div className="v2-ag-col v2-ag-col-wide">
                    {tab === 'changes' ? <ChangesTab sessionId={sessionId} reviewSince={data.session?.review?.since ?? null} /> : null}
                    {tab === 'results' ? <ResultsTab data={data} resultId={route.resultId ?? null} /> : null}
                    {tab === 'timeline' ? <TimelineTab data={data} /> : null}
                    {tab === 'helpers' ? <HelpersTab data={data} helperHref={helperHref} /> : null}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {desktop && sideShown ? (
        <aside className="v2-ag-side v2-ag-side2" aria-label="Side panel" data-testid="v2-agent-side" data-side-tab={sideTab}>
          <div
            className="v2-ag-side-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side panel"
            aria-valuenow={sideWidth}
            aria-valuemin={SIDE_MIN}
            aria-valuemax={sideMax(viewWidth)}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            data-testid="v2-agent-side-handle"
            onPointerDown={startResize}
            onKeyDown={resizeByKey}
            onDoubleClick={() => setSide({ ...side, width: clampSide(SIDE_DEFAULT_WIDTH, viewWidth) })}
          />
          <div className="v2-ag-side-top">
            {sideTabs}
            {/* D180: ⟷ switches the panel between 560 and 820 px (clamped by the room the view has). */}
            <IconButton
              icon={wide ? 'narrow' : 'widen'}
              label={wide ? AGENT_WORDS.panelNarrower : AGENT_WORDS.panelWider}
              onClick={() => setSide({ ...side, width: clampSide(toggledWidth(sideWidth, sideMax(viewWidth)), viewWidth) })}
              data-tour="v2-side-width"
              data-testid="v2-agent-side-width"
            />
            <IconButton icon="x" label={`${AGENT_WORDS.hideSidePanel} (⌘.)`} onClick={toggleSide} data-testid="v2-agent-side-hide" />
          </div>
          {sidePane}
        </aside>
      ) : null}
      {layout === 'tablet' ? (
        <Drawer open={drawer} onClose={() => setDrawer(false)} title={sideTabs} testId="v2-agent-side-drawer">
          <div className="v2-ag-side-drawer" data-testid="v2-agent-side" data-side-tab={sideTab}>
            {sidePane}
          </div>
        </Drawer>
      ) : null}
      {phone ? (
        <BottomSheet open={drawer} onClose={() => setDrawer(false)} title={AGENT_WORDS.details} testId="v2-agent-side-sheet">
          {details}
        </BottomSheet>
      ) : null}
    </section>
  );
}
